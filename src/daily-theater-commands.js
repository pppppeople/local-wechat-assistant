'use strict';

function parseDailyTheaterCommand(text) {
  const value = String(text || '').trim();
  if (value === '关闭小剧场') return { type: 'disable' };
  if (value === '小剧场设置') return { type: 'settings' };
  if (value === '来一段小剧场') return { type: 'generate' };
  if (value === '开启小剧场') return { type: 'enable', time: '21:00' };
  const enable = value.match(/^开启小剧场\s+([01]\d|2[0-3]):([0-5]\d)$/u);
  if (enable) return { type: 'enable', time: `${enable[1]}:${enable[2]}` };
  const theme = value.match(/^小剧场主题[：:]\s*(.*)$/u);
  if (theme) return theme[1].trim() && theme[1].length <= 200
    ? { type: 'theme', theme: theme[1].trim() } : { type: 'invalid' };
  if (/^开启小剧场\s/u.test(value)) return { type: 'invalid' };
  return null;
}

module.exports = { parseDailyTheaterCommand };
