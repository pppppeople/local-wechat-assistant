'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { describeTimestamp } = require('./friend-relay-commands');
const MAX_PHOTOS = 100;
const MAX_BYTES = 200 * 1024 * 1024;
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.image'];
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.nextNumber) || state.nextNumber < 1
    || !Array.isArray(state.photos) || state.photos.length > MAX_PHOTOS) throw new Error('照片存储格式无效');
  const ids = new Set(), numbers = new Set();
  for (const item of state.photos) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(item.id) || ids.has(item.id)
      || !Number.isSafeInteger(item.number) || item.number < 1 || item.number >= state.nextNumber || numbers.has(item.number)
      || typeof item.note !== 'string' || typeof item.timeText !== 'string' || !timestamp(item.createdAt)
      || (item.resendAt !== null && !timestamp(item.resendAt))
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || !EXTENSIONS.some(ext => item.file === `${item.id}${ext}`)) throw new Error('照片记录格式无效');
    ids.add(item.id); numbers.add(item.number);
  }
}

function createPhotoVaultStore({ stateFile, imageDir = path.join(path.dirname(stateFile), 'images'), now = () => Date.now() }) {
  const load = () => readRecordState(stateFile, { schemaVersion: 1, nextNumber: 1, photos: [] }, true,
    { strict: true, now, validate: validateState });
  const save = state => { validateState(state); writeRecordState(stateFile, state, ['photos']); };
  const imagePath = item => path.join(imageDir, item.file);
  function handle(side, command) {
    if (side !== 'owner') return '定时照片仅主人可用。';
    if (!command || command.type === 'invalid') return '未存入：请附上一张照片，每次只存一张。';
    const state = load();
    if (command.type === 'list') return state.photos.length ? state.photos.map(item =>
      `第 ${item.number} 张：${item.note || '无备注'}\n存入：${describeTimestamp(item.createdAt)}（Asia/Shanghai）\n${item.resendAt ? `定时回送：${describeTimestamp(item.resendAt)}（Asia/Shanghai）` : '未设定时回送'}`
    ).join('\n\n') : '还没有托付保管的照片。';
    if (command.type === 'send' || command.type === 'delete') {
      const item = state.photos.find(entry => entry.number === command.number);
      if (!item) return '没有这个照片编号。';
      if (command.type === 'send') return { imagePath: imagePath(item) };
      fs.rmSync(imagePath(item), { force: true });
      state.photos = state.photos.filter(entry => entry !== item); save(state);
      return `已删除第 ${item.number} 张照片及助手侧副本。`;
    }
    if (command.type !== 'add') throw new Error('不支持的照片命令');
    if (state.photos.length >= MAX_PHOTOS) return '照片已达 100 张上限，请先删除照片。';
    if (command.imagePaths?.length !== 1 || typeof command.note !== 'string' || typeof command.timeText !== 'string'
      || (command.resendAt !== null && (!timestamp(command.resendAt) || Date.parse(command.resendAt) <= now()))) return '未存入：照片或回送时间无效。';
    const source = command.imagePaths[0];
    const stat = fs.statSync(source);
    if (!stat.isFile()) return '未存入：附件不是照片文件。';
    fs.mkdirSync(imageDir, { recursive: true, mode: 0o700 });
    // Include unmanaged residual copies too, so failed writes cannot evade the byte cap.
    const used = fs.readdirSync(imageDir).reduce((sum, file) => sum + fs.statSync(path.join(imageDir, file)).size, 0);
    if (used + stat.size > MAX_BYTES) return '未存入：照片副本总大小超过 200MB 上限，请先删除照片。';
    const id = crypto.randomUUID(), ext = path.extname(source).toLowerCase();
    const item = { id, number: state.nextNumber, file: `${id}${EXTENSIONS.includes(ext) ? ext : '.image'}`,
      note: command.note, createdAt: new Date(now()).toISOString(), resendAt: command.resendAt,
      timeText: command.timeText, bytes: stat.size };
    const target = imagePath(item);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    try {
      fs.chmodSync(target, 0o600);
      if (fs.statSync(target).size !== stat.size) throw new Error('附件复制期间发生变化');
    } catch (error) { fs.rmSync(target, { force: true }); throw error; }
    // Preserve the copy on uncertain index/body write failure for recovery.
    state.nextNumber++; state.photos.push(item); save(state);
    return `已存入第 ${item.number} 张照片，助手侧副本已保管。${item.resendAt ? `定时回送：${describeTimestamp(item.resendAt)}（Asia/Shanghai）。` : command.timeUnparsed ? '时间未能解析，只存照片，未设定时。' : '未设定时回送。'}`;
  }
  async function tick(deliver) {
    const state = load();
    const item = state.photos.find(entry => entry.resendAt && Date.parse(entry.resendAt) <= now());
    if (!item) return false;
    const dueAt = item.resendAt;
    // Clear the pending schedule before dispatch, just like focus-session's claim.
    item.resendAt = null; save(state);
    await deliver(imagePath(item), `photo-vault-${item.id}-${Date.parse(dueAt)}`);
    return true;
  }
  return { handle, tick };
}

module.exports = { createPhotoVaultStore, MAX_PHOTOS, MAX_BYTES };
