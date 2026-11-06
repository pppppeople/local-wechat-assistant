'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const ROUND_TTL_MS = 24 * 60 * 60 * 1000;
const INPUT_TTL_MS = 10 * 60 * 1000;
const SIDES = ['owner', 'friend'];
const normalizeAnswer = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
const validAnswer = value => typeof value === 'string' && value.length <= 200 && Boolean(normalizeAnswer(value));
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const other = side => side === 'owner' ? 'friend' : 'owner';
const HELP = '未建题：请显式输入「照片出题：答案」（1–200 字）并附一张图，或随后在 10 分钟内发送一张图。';

function validateState(state) {
  if (state?.schemaVersion !== 1 || typeof state.binding !== 'string' || !Array.isArray(state.rounds)
    || state.rounds.filter(r => r.status === 'active').length > 1) throw new Error('照片猜猜看存储格式无效');
  const ids = new Set();
  for (const r of state.rounds) {
    if (!r || !/^[a-z0-9-]+$/iu.test(r.id) || ids.has(r.id) || !SIDES.includes(r.createdBy)
      || !['active', 'matched', 'revealed', 'cancelled', 'expired'].includes(r.status)
      || !validAnswer(r.answer) || !timestamp(r.createdAt) || !timestamp(r.expiresAt)
      || Date.parse(r.expiresAt) - Date.parse(r.createdAt) !== ROUND_TTL_MS
      || !(r.endedAt === null || timestamp(r.endedAt)) || r.file !== `${r.id}.image`
      || !['sealed', 'pending', 'claimed', 'sent', 'failed', 'unavailable'].includes(r.delivery)) throw new Error('照片猜猜看题目格式无效');
    ids.add(r.id);
  }
}

// All paths stay inside this private adapter. Only deliverImage receives a path,
// after a terminal reveal; public callers receive strings only.
function createPhotoQuizStore({ stateFile, imageDir = path.join(path.dirname(stateFile), 'images'),
  now = () => Date.now(), getBinding = () => 'local', deliverImage = null, onNotice = () => {},
  sideNames = { owner: 'Owner', friend: '好友' } }) {
  const pending = new Map();
  function save(state) { validateState(state); writeRecordState(stateFile, state, ['rounds']); }
  function load() {
    if (!fs.existsSync(stateFile) && fs.existsSync(path.dirname(stateFile))
      && fs.readdirSync(path.dirname(stateFile)).some(name => name.startsWith(`${path.basename(stateFile)}.corrupt-`))) {
      throw new Error('照片猜猜看存储已隔离，请先恢复索引及记录，不能从空状态继续。');
    }
    const binding = getBinding();
    if (typeof binding !== 'string' || !binding) throw new Error('缺少配对绑定');
    const state = readRecordState(stateFile, { schemaVersion: 1, binding, rounds: [] }, true,
      { strict: true, now, validate: validateState });
    if (state.binding !== binding) throw new Error('照片猜猜看绑定已变化，请先恢复或清理旧配对存储');
    let changed = false;
    for (const r of state.rounds) if (r.status === 'active' && now() >= Date.parse(r.expiresAt)) {
      r.status = 'expired'; r.endedAt = r.expiresAt; changed = true;
    }
    if (changed) save(state);
    return state;
  }
  function hasInput(side) {
    const input = pending.get(side);
    if (!input || input.until <= now()) { pending.delete(side); return false; }
    return true;
  }
  function captureCommand(side, imagePaths, text = '') {
    // Only an image-only follow-up consumes the explicit prepared answer.
    if (!imagePaths.length || String(text).trim() || !hasInput(side)) return null;
    const input = pending.get(side); pending.delete(side);
    if (input.binding !== getBinding()) return { type: 'start', answer: '', imagePaths };
    return { type: 'start', answer: input.answer, imagePaths };
  }
  async function handle(side, command) {
    if (!SIDES.includes(side)) throw new Error('invalid photo quiz side');
    if (!command || !['start', 'guess', 'reveal', 'cancel', 'status'].includes(command.type)) throw new Error('不支持的照片猜猜看命令');
    const state = load(), active = state.rounds.find(r => r.status === 'active');
    const round = active || state.rounds.at(-1);
    if (command.type === 'start') {
      if (active) return '已有进行中的照片题，请出题人先揭晓或结束。';
      if (!validAnswer(command.answer)) { pending.delete(side); return HELP; }
      if (!command.imagePaths?.length) {
        pending.set(side, { answer: command.answer.trim(), until: now() + INPUT_TTL_MS, binding: state.binding });
        return '答案已暂存，尚未建题。请在 10 分钟内发送一张图片（不附其他文字）；重启后需重新输入答案。';
      }
      if (command.imagePaths.length !== 1) return '未建题：每题只能提交一张图片。';
      const source = command.imagePaths[0];
      if (!fs.statSync(source).isFile()) return '未建题：附件不是图片文件。';
      const id = crypto.randomUUID();
      fs.mkdirSync(imageDir, { recursive: true, mode: 0o700 });
      const target = path.join(imageDir, `${id}.image`);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
      state.rounds.push({ id, createdBy: side, createdAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + ROUND_TTL_MS).toISOString(), endedAt: null,
        answer: command.answer.trim(), file: `${id}.image`, status: 'active', delivery: 'sealed' });
      save(state); pending.delete(side);
      onNotice(other(side), '已出题待猜。可用「照片猜：答案」作答，24 小时内有效；揭晓前不展示原图。', `photo-quiz-created|${id}`);
      return '已出题待猜。对方可用「照片猜：答案」作答，24 小时内有效；揭晓前不展示原图。';
    }
    if (command.type === 'cancel') pending.delete(side);
    if (!round) return '当前没有照片题。';
    if (command.type === 'status') return `照片猜猜看：${round.status === 'active' ? '已出题待猜' : { matched: '已猜中', revealed: '已揭晓', cancelled: '已结束', expired: '已过期' }[round.status]}\n出题人：${sideNames[round.createdBy]}\n剩余：${round.status === 'active' ? Math.ceil((Date.parse(round.expiresAt) - now()) / 60000) : 0} 分钟\n是否已猜中：${round.status === 'matched' ? '是' : '否'}`;
    if (round.status === 'expired') return '本题已过期，已归档为过期状态，不能猜测或揭晓。';
    if (round.status !== 'active') return '本轮已经结束。';
    if (command.type === 'guess') {
      if (round.createdBy === side) return '出题人不能猜自己的题。';
      if (!validAnswer(command.answer)) return '请用「照片猜：答案」输入有效猜测（1–200 字）。';
      if (normalizeAnswer(command.answer) !== normalizeAnswer(round.answer)) return '没猜中，本题仍在进行。';
      round.status = 'matched';
    } else {
      if (round.createdBy !== side) return '只有出题人可以揭晓或结束本轮。';
      round.status = command.type === 'reveal' ? 'revealed' : 'cancelled';
    }
    round.endedAt = new Date(now()).toISOString();
    round.delivery = round.status === 'cancelled' ? 'sealed' : 'pending';
    save(state);
    if (round.status === 'cancelled') {
      onNotice(other(side), '本轮照片猜猜看已由出题人放弃结束，未公布答案或原图。', `photo-quiz-cancelled|${round.id}`);
      return '已放弃并结束本轮，未公布答案或原图。';
    }
    const result = `${round.status === 'matched' ? '猜对了！' : '已手动揭晓。'}答案：${round.answer}。本轮已结束。`;
    onNotice(other(side), result, `photo-quiz-result|${round.id}`);
    // Claim durably before one existing-channel send attempt. No uncertain replay.
    if (!deliverImage) {
      round.delivery = 'unavailable'; save(state);
      return `${result}\n原图尚未发送：猜题方图片发送入口未接通。`;
    }
    round.delivery = 'claimed'; save(state);
    try {
      const sent = await deliverImage(other(round.createdBy), path.join(imageDir, round.file));
      round.delivery = sent === false ? 'unavailable' : 'sent';
    } catch { round.delivery = 'failed'; }
    // Re-load after async delivery to preserve a newly created round.
    const latest = load(); Object.assign(latest.rounds.find(r => r.id === round.id), { delivery: round.delivery }); save(latest);
    return `${result}\n${round.delivery === 'sent' ? '原图已通过既有发送路径发给猜题方。' : '原图未确认送达：发送入口不可用或发送失败，不自动重试。'}`;
  }
  function deleteSide(side) {
    if (!SIDES.includes(side)) throw new Error('invalid photo quiz side');
    const state = load(), records = [...state.rounds];
    state.rounds = []; save(state); pending.clear();
    for (const r of records) fs.rmSync(path.join(imageDir, r.file), { force: true });
    return { removed: records.length };
  }
  return { handle, captureCommand, hasInput, deleteSide, expire: () => { load(); } };
}
module.exports = { createPhotoQuizStore, normalizeAnswer, ROUND_TTL_MS, INPUT_TTL_MS };
