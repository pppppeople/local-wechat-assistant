'use strict';

function parseDateProposalCommand(text, { bound = false } = {}) {
  if (!bound) return null;
  const value = String(text || '').trim();
  const selected = value.match(/^(?:出行提案[：:]?\s*)?就它了\s*[#＃]?([1-3])$/u);
  if (selected) return { type: 'select', index: Number(selected[1]) };
  const match = value.match(/^出行提案[：:]\s*(.{1,500})$/u);
  if (!match) return value === '出行提案' ? { type: 'help' } : null;
  const parts = match[1].split(/[；;]/u).map(part => part.trim());
  const origins = {};
  let city = '';
  const conditions = [];
  for (const part of parts) {
    const origin = part.match(/^(Owner|好友)出发[：:]\s*(.{1,120})$/iu);
    const region = part.match(/^城市[：:]\s*(.{1,60})$/u);
    if (origin) origins[origin[1].toLowerCase() === 'owner' ? 'owner' : 'friend'] = origin[2].trim();
    else if (region) city = region[1].trim();
    else conditions.push(part);
  }
  const condition = conditions.join('；');
  const category = condition.match(/咖啡馆|咖啡|公园|博物馆|美术馆|书店|电影院|餐厅/u)?.[0] || '';
  return { type: 'propose', condition, category, near: /近|附近/u.test(condition), city, origins };
}

module.exports = { parseDateProposalCommand };
