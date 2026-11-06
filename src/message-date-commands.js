'use strict';

function parseMessageDateCommand(text) {
  const value = String(text || '').trim();
  const extract = value.match(/^提取(?:日期|期限)[：:]\s*([\s\S]*)$/u);
  if (extract) return { type: 'extract', text: extract[1] };
  if (value === '都存') return { type: 'confirm_all' };
  if (value === '存') return { type: 'confirm_selected', numbers: [] };
  const selected = value.match(/^存\s*(\d+(?:\s*[、,，]\s*\d+)*)$/u);
  return selected ? { type: 'confirm_selected', numbers: [...new Set(selected[1].split(/[、,，]/u).map(Number))] } : null;
}

module.exports = { parseMessageDateCommand };
