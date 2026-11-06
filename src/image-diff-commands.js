'use strict';

function parseImageDiffCommand(text, imagePaths = [], side = 'owner') {
  if (side !== 'owner') return null;
  const value = String(text || '').trim();
  if (!imagePaths.length) return value === '取消对比' ? { type: 'cancel' } : null;
  // Keep the existing screenshot-action prefix and its cleanup semantics authoritative.
  if (value.startsWith('提取行动项') || !/对比|差异|第一张|第二张/u.test(value)) return null;
  return { type: 'compare', text: value, imagePaths, replace: value.includes('第一张') };
}

module.exports = { parseImageDiffCommand };
