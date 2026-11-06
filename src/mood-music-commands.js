'use strict';

const { refused, unchanged } = require('./feature-result');

const HELP = '请发送「心情音乐：心情或场景」，例如：心情音乐：放松、心情音乐：专注、心情音乐：开心。只提供文字灵感，不播放音乐。';
const FAILURE = '心情音乐菜单生成失败：模型调用失败或输出不合格，未生成菜单，请重试。';
function parseMoodMusicCommand(text) {
  const value = String(text || '').trim();
  if (value === '心情音乐') return { type: 'help' };
  const match = value.match(/^心情音乐[：:]\s*([\s\S]*)$/u);
  if (!match) return null;
  const mood = match[1].trim();
  return mood ? { type: 'generate', mood } : { type: 'help' };
}
function createMoodMusic({ provider }) {
  return { async execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (command?.type !== 'generate' || !command.mood?.trim()) return refused(HELP);
    try { return unchanged(await provider.generate({ mood: command.mood })); }
    catch { return refused(FAILURE); }
  } };
}

module.exports = { HELP, FAILURE, parseMoodMusicCommand, createMoodMusic };
