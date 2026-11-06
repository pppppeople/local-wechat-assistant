'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { refused, unchanged } = require('./feature-result');
const TTL = 10 * 60 * 1000;

// Only temporary image copies live on disk. References and generated text are memory-only.
function createMultiImageNoteStore({ imageDir, provider, now = () => Date.now(),
  schedule = (callback, delay) => setTimeout(callback, delay), cancel = clearTimeout }) {
  let pending = [], failure = null, queue = Promise.resolve();
  // A restarted process cannot recover its memory-only references. Remove owned cache files.
  if (fs.existsSync(imageDir)) {
    for (const name of fs.readdirSync(imageDir)) {
      if (/^note-[a-f0-9-]+\.image$/u.test(name)) fs.rmSync(path.join(imageDir, name), { force: true });
    }
  }
  function release(record) {
    cancel(record.timer);
    fs.rmSync(record.imagePath, { force: true });
  }
  function prune() {
    pending = pending.filter(record => {
      if (now() - record.at < TTL) return true;
      release(record);
      return false;
    });
    if (failure && now() - failure.at >= TTL) failure = null;
  }
  function capture(side, imagePaths) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    prune();
    for (const source of imagePaths) {
      const record = { at: now(), imagePath: path.join(imageDir, `note-${crypto.randomUUID()}.image`) };
      try {
        fs.mkdirSync(imageDir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, record.imagePath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(record.imagePath, 0o600);
        record.timer = schedule(() => {
          pending = pending.filter(item => item !== record);
          release(record);
        }, TTL);
        record.timer?.unref?.();
        pending.push(record);
        if (pending.length > 4) release(pending.shift());
      } catch {
        release(record);
        failure = { at: now() };
      }
    }
    return unchanged('');
  }
  async function apply(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (command?.type !== 'generate') return refused('不支持这个多图笔记操作。');
    prune();
    if (!failure && pending.length < 2) {
      return refused(`还差 ${2 - pending.length} 张截图，请在 10 分钟内继续发截图后说「整理成笔记」。`);
    }
    const batch = pending;
    pending = [];
    // Once selected, expiry cannot remove images while the provider is reading them.
    for (const record of batch) cancel(record.timer);
    try {
      if (failure) { failure = null; return refused('多图笔记生成失败：入站图片暂存失败，请重新发送截图后再试。'); }
      const reply = await provider.generate({ imagePaths: batch.map(record => record.imagePath) });
      if (typeof reply !== 'string' || !reply.trim() || reply.length > 1700) {
        return refused('多图笔记生成失败：模型输出为空或超过单条回复长度，请重新发送截图后再试。');
      }
      return unchanged(reply);
    } catch (error) {
      return refused(`多图笔记生成失败：${error.message || '图片理解或模型调用异常'}。未生成笔记，请重新发送截图后再试。`);
    } finally { for (const record of batch) release(record); }
  }
  function execute(side, command) {
    const result = queue.then(() => apply(side, command));
    queue = result.catch(() => {});
    return result;
  }
  return { capture, execute };
}

module.exports = { createMultiImageNoteStore };
