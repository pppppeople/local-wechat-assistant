'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { validateDiff, formatDiff } = require('./image-diff-provider');
const TTL = 30 * 60 * 1000;

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.pending) || state.pending.length > 1
    || state.pending.some(record => !record || typeof record.id !== 'string'
      || !/^[a-z0-9_-]+$/iu.test(record.id) || !['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.image'].some(ext => record.file === `${record.id}${ext}`)
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)))) {
    throw new Error('截图对比暂存格式无效');
  }
}
function createImageDiffStore({ stateFile, imageDir = path.join(path.dirname(stateFile), 'images'),
  provider, now = () => Date.now() }) {
  let queue = Promise.resolve();
  function save(state) {
    validateState(state);
    writeRecordState(stateFile, state, ['pending']);
  }
  function clear(state) {
    const pending = state.pending[0];
    if (!pending) return;
    fs.rmSync(path.join(imageDir, pending.file), { force: true });
    state.pending = [];
    save(state);
  }
  async function apply(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (!command || !['compare', 'cancel'].includes(command.type)) return refused('不支持这个截图对比操作。');
    const state = readRecordState(stateFile, { schemaVersion: 1, pending: [] }, true,
      { strict: true, now, validate: validateState });
    const expired = Boolean(state.pending[0] && now() - Date.parse(state.pending[0].createdAt) >= TTL);
    if (expired) clear(state);
    if (command.type === 'cancel') {
      const hadPending = Boolean(state.pending.length);
      clear(state);
      return hadPending || expired ? changed('已取消对比，暂存图片已清除。') : unchanged('当前没有待对比的第一张。');
    }
    if (!Array.isArray(command.imagePaths) || command.imagePaths.length !== 1) {
      return refused('截图对比每次请只发一张图片。');
    }
    const previous = state.pending[0];
    if (!previous || command.replace) {
      const id = crypto.randomUUID();
      const sourceExt = path.extname(command.imagePaths[0]).toLowerCase();
      const ext = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(sourceExt) ? sourceExt : '.image';
      const record = { id, file: `${id}${ext}`, createdAt: new Date(now()).toISOString() };
      const target = path.join(imageDir, record.file);
      fs.mkdirSync(imageDir, { recursive: true, mode: 0o700 });
      try {
        fs.copyFileSync(command.imagePaths[0], target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, 0o600);
        state.pending = [record];
        save(state);
      } catch (error) {
        fs.rmSync(target, { force: true });
        throw error;
      }
      if (previous) fs.rmSync(path.join(imageDir, previous.file), { force: true });
      return changed(`${expired ? '原第一张已过期并清除，本张作为新的第一张。' : previous ? '已替换原第一张。' : ''}已存为第一张，再发第二张`);
    }
    // A missing managed file is a storage failure, not a retryable model output failure.
    const first = path.join(imageDir, previous.file);
    fs.accessSync(first, fs.constants.R_OK);
    let diff;
    try {
      diff = validateDiff(await provider.compare({ text: command.text, imagePaths: [first, command.imagePaths[0]] }));
    } catch {
      return refused('这次对比失败或模型输出不合格，整次结果已作废；第一张仍保留，请在暂存有效期内重发第二张重试。');
    }
    clear(state);
    return changed(formatDiff(diff));
  }
  function execute(side, command) {
    const result = queue.then(() => apply(side, command));
    queue = result.catch(() => {});
    return result;
  }
  return { execute };
}

module.exports = { createImageDiffStore };
