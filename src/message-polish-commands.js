'use strict';

const STYLES = ['正式', '简洁', '轻松', '默认'];
const HELP = '请发送“润色：<原文>”生成草稿。';
function parseMessagePolishCommand(text) {
  const value = String(text || '').trim();
  if (value === '润色清除') return { type: 'clear' };
  const style = value.match(/^润色风格(?:\s*[:：]\s*(.*))?$/su);
  if (style) return { type: 'style', style: (style[1] || '').trim() };
  const polish = value.match(/^润色\s*[:：]\s*(.*)$/su);
  if (polish) return { type: 'polish', text: polish[1].trim() };
  if (value === '润色') return { type: 'polish', text: '' };
  // Claim only bounded editing requests; unrelated text retains its existing route.
  if (/^(?:(?:请|帮我)?再(?:简洁|简短|正式|轻松|委婉|柔和|客气|自然|口语化)(?:一?点|一些)?|(?:语气|措辞)再(?:软|柔和|委婉|客气|正式|轻松)(?:一?点|一些)?)[。！!]?$/u.test(value)) {
    return { type: 'refine', instruction: value };
  }
  return null;
}

module.exports = { parseMessagePolishCommand, STYLES, HELP };
