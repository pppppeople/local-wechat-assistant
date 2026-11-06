'use strict';

function parseScreenshotActionCommand(text, imagePaths = []) {
  const value = String(text || '');
  if (imagePaths.length && value.startsWith('提取行动项')) return { type: 'extract', text: value, imagePaths };
  if (value === '都加入待办') return { type: 'confirm_all' };
  if (value === '算了') return { type: 'discard' };
  const match = value.match(/^加入第(\d+(?:[、,，]\d+)*)项$/u);
  return match ? { type: 'confirm_selected', numbers: [...new Set(match[1].split(/[、,，]/u).map(Number))] } : null;
}

module.exports = { parseScreenshotActionCommand };
