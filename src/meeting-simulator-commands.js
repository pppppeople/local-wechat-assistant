'use strict';

function parseMeetingSimulatorCommand(text, active = false) {
  const value = String(text || '').trim();
  if (value === '结束模拟') return { type: 'end' };
  const start = value.match(/^模拟(?:英文)?会议\s*[:：]\s*(.*)$/su);
  if (start) return { type: 'start', scene: start[1].trim() };
  if (/^模拟(?:英文)?会议$/u.test(value)) return { type: 'start', scene: '' };
  return active && value ? { type: 'answer', text: String(text) } : null;
}

module.exports = { parseMeetingSimulatorCommand };
