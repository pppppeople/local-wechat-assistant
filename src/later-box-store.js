'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { describeTimestamp } = require('./friend-relay-commands');
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.image'];
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.nextNumber) || state.nextNumber < 1
    || !Array.isArray(state.items) || state.items.length > 200
    || state.items.filter(item => item?.kind === 'image').length > 50) throw new Error('稍后箱存储格式无效');
  const numbers = new Set(), ids = new Set();
  for (const item of state.items) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id) || ids.has(item.id)
      || !Number.isSafeInteger(item.number) || item.number < 1 || item.number >= state.nextNumber || numbers.has(item.number)
      || !['text', 'link', 'image'].includes(item.kind) || typeof item.content !== 'string'
      || (!item.content && item.kind !== 'image') || typeof item.note !== 'string' || !timestamp(item.createdAt)
      || (item.resendAt !== null && !timestamp(item.resendAt)) || typeof item.read !== 'boolean'
      || typeof item.reminded !== 'boolean' || (item.reminded && (!item.read || !item.resendAt))
      || (item.kind === 'image' ? !EXTENSIONS.some(ext => item.file === `${item.id}${ext}`) : item.file !== null)) {
      throw new Error('稍后箱记录格式无效');
    }
    numbers.add(item.number); ids.add(item.id);
  }
}

function createLaterBoxStore({ stateFile, imageDir = path.join(path.dirname(stateFile), 'images'),
  now = () => Date.now(), random = Math.random }) {
  const load = () => readRecordState(stateFile, { schemaVersion: 1, nextNumber: 1, items: [] }, true,
    { strict: true, now, validate: validateState });
  function save(state) { validateState(state); writeRecordState(stateFile, state, ['items']); }
  const format = item => `第 ${item.number} 条${item.read ? '（已读）' : '（未读）'}：${item.kind === 'image' ? '图片已存。' : ''}${item.content}${item.note ? `\n备注：${item.note}` : ''}`;
  function handle(side, command) {
    if (side !== 'owner') return '稍后箱仅主人可用。';
    if (!command || command.type === 'invalid') return '未存入：请提供文字或链接，图片每次只存一张。';
    const state = load();
    if (command.type === 'list' || command.type === 'search' || command.type === 'random') {
      let items = state.items.filter(item => command.type === 'search'
        ? `${item.content}\n${item.note}`.includes(command.keyword) : command.all || !item.read);
      if (command.type === 'random' && items.length) items = [items[Math.floor(random() * items.length)]];
      return items.length ? items.map(format).join('\n\n') : '稍后箱没有符合条件的条目。';
    }
    if (command.type === 'read' || command.type === 'delete') {
      const item = state.items.find(entry => entry.number === command.number);
      if (!item) return '没有这个稍后箱编号。';
      if (command.type === 'read') { item.read = true; save(state); return `第 ${item.number} 条已标记已读。`; }
      // Remove managed copy first; a filesystem failure leaves the indexed entry recoverable.
      if (item.file) fs.rmSync(path.join(imageDir, item.file), { force: true });
      state.items = state.items.filter(entry => entry !== item); save(state);
      return `已删除第 ${item.number} 条${item.file ? '及图片副本' : ''}。`;
    }
    if (command.type !== 'add') throw new Error('不支持的稍后箱命令');
    if (state.items.length >= 200) return '稍后箱已达 200 条上限，请先删除条目。';
    if (command.kind === 'image' && state.items.filter(item => item.kind === 'image').length >= 50) {
      return '稍后箱图片副本已达 50 个上限，请先删除图片条目。';
    }
    if (!['text', 'link', 'image'].includes(command.kind) || typeof command.content !== 'string'
      || (!command.content && command.kind !== 'image') || typeof command.note !== 'string'
      || (command.resendAt !== null && (!timestamp(command.resendAt) || Date.parse(command.resendAt) <= now()))
      || (command.kind === 'image' && command.imagePaths?.length !== 1)) return '未存入：条目或重发时间无效。';
    const id = crypto.randomUUID();
    const ext = command.kind === 'image' ? path.extname(command.imagePaths[0]).toLowerCase() : '';
    const item = { id, number: state.nextNumber, kind: command.kind, content: command.content, note: command.note,
      createdAt: new Date(now()).toISOString(), resendAt: command.resendAt, read: false, reminded: false,
      file: command.kind === 'image' ? `${id}${EXTENSIONS.includes(ext) ? ext : '.image'}` : null };
    const target = item.file && path.join(imageDir, item.file);
    try {
      if (target) {
        fs.mkdirSync(imageDir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(command.imagePaths[0], target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
      }
      state.nextNumber++; state.items.push(item); save(state);
    } catch (error) { if (target) fs.rmSync(target, { force: true }); throw error; }
    return `已存入稍后箱第 ${item.number} 条。${item.resendAt ? `重发时间：${describeTimestamp(item.resendAt)}（Asia/Shanghai）。` : command.timeUnparsed ? '时间未能解析，未设提醒；原提醒文字已保留在备注。' : '未设提醒。'}`;
  }
  async function tick(deliver) {
    // One item per scan; each scan reloads state before the synchronous claim/save.
    const state = load();
    const item = state.items.find(entry => entry.resendAt && !entry.reminded && Date.parse(entry.resendAt) <= now());
    if (!item) return false;
    item.reminded = true; item.read = true; save(state);
    await deliver(`稍后箱到期重发：\n${format(item)}`, `later-box-${item.id}`,
      item.file ? { imagePath: path.join(imageDir, item.file), number: item.number } : null);
    return true;
  }
  return { handle, tick };
}

module.exports = { createLaterBoxStore };
