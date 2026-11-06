'use strict';

function parseChatTodoCommand(text) {
  const value = String(text || '');
  const trigger = value.match(/^把([\s\S]*?)(?:记成待办|记为待办|加到待办)/u);
  if (trigger) {
    const keyword = trigger[1].replace(/刚才说的|刚刚说的|上面说的|上面|刚才|刚刚/gu, '').trim();
    return { type: 'extract', keyword };
  }
  const control = value.trim();
  if (control === '都记下来') return { type: 'confirm_all' };
  if (control === '算了') return { type: 'discard' };
  const match = control.match(/^记第\s*(\d+(?:\s*[、,，]\s*\d+)*)\s*个$/u);
  return match ? { type: 'confirm_selected', numbers: [...new Set(match[1].split(/[、,，]/u).map(Number))] } : null;
}

module.exports = { parseChatTodoCommand };
