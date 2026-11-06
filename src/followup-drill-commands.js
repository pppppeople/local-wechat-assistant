'use strict';

const REFUSAL = '专业系统 英文会议追问训练仅主人可用，好友不能读取或参与训练。';
function parseFollowupDrillCommand(text, active = false) {
  const value = String(text || '').trim();
  if (value === '结束追问') return { type: 'end' };
  const start = value.match(/^追问训练\s*[:：]\s*(.*)$/su);
  if (start) return { type: 'start', scene: start[1].trim() };
  if (value === '追问训练') return { type: 'start', scene: '' };
  return active && value ? { type: 'answer', text: value } : null;
}

module.exports = { parseFollowupDrillCommand, REFUSAL };
