'use strict';

function parsePhotoQuizCommand(text, imagePaths = []) {
  const value = String(text || '').trim();
  const commands = { '照片猜猜看': 'status', '照片猜猜看状态': 'status', '揭晓照片': 'reveal', '结束照片猜猜看': 'cancel' };
  if (Object.hasOwn(commands, value)) return { type: commands[value] };
  const start = value.match(/^照片出题(?:\s*[:：]\s*([\s\S]*))?$/u);
  if (start) return { type: 'start', answer: (start[1] || '').trim(), imagePaths: [...imagePaths] };
  const guess = value.match(/^照片猜(?:\s*[:：]\s*([\s\S]*))?$/u);
  return guess ? { type: 'guess', answer: (guess[1] || '').trim() } : null;
}
module.exports = { parsePhotoQuizCommand };
