'use strict';

const { formatInspection, DISCLAIMER } = require('./screenshot-sensitive-provider');
function parseScreenshotSensitiveCommand(text, imagePaths = []) {
  return String(text || '').trim() === '检查敏感信息' ? { type: 'inspect', imagePaths } : null;
}
function sensitiveReply(text) { return `${text}\n\n${DISCLAIMER}`; }
const REFUSAL = sensitiveReply('截图敏感信息检查员仅主人可用，好友不能使用。');
function createScreenshotSensitiveCommands({ provider }) {
  return { async execute(side, command) {
    if (side !== 'owner') return REFUSAL;
    if (!command?.imagePaths?.length) return sensitiveReply('请主人带图片发送「检查敏感信息」，单张即可。');
    try { return formatInspection(await provider.inspect({ imagePaths: command.imagePaths })); }
    catch { return sensitiveReply('敏感信息检查失败，本次没有可用结果，请重新带图发送「检查敏感信息」。'); }
  } };
}
module.exports = { parseScreenshotSensitiveCommand, createScreenshotSensitiveCommands, REFUSAL };
