'use strict';

function parseTodoBreakdownCommand(text) {
  const value = String(text || '').trim();
  const match = value.match(/^拆解待办[：:]\s*([\s\S]*)$/u)
    || value.match(/^把\s*([\s\S]+?)\s*拆解成待办$/u);
  if (match) return { type: 'generate', text: match[1].trim() };
  if (value === '确认拆解') return { type: 'confirm' };
  if (value === '取消拆解') return { type: 'discard' };
  return null;
}

module.exports = { parseTodoBreakdownCommand };
