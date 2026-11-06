'use strict';

const { refused, unchanged } = require('./feature-result');
const { renderComparison } = require('./copy-comparison-provider');

const HELP = '请发送“对比文案”后附 2 到 4 个非空版本，用“版本一”“版本二”等显式标记分隔，例如：\n对比文案\n版本一：第一份原文\n版本二：第二份原文。仅对比，不改写、不代发。';
function parseCopyComparisonCommand(text) {
  const value = String(text || '').trim();
  const match = value.match(/^对比文案(?:\s*[:：]\s*|\s+|(?=版本)|$)([\s\S]*)$/u);
  if (!match) return null;
  const body = match[1];
  const markers = [...body.matchAll(/(?:^|\s)版本([一二三四五六七八九十]+|\d+)[ \t]*[:：]?[ \t]*/gu)];
  if (markers.length < 2 || markers.length > 4 || body.slice(0, markers[0].index).trim()) return { type: 'invalid' };
  const versions = markers.map((marker, index) => ({
    label: `版本${marker[1]}`,
    text: body.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? body.length).trim(),
  }));
  if (versions.some(version => !version.text) || new Set(versions.map(version => version.label)).size !== versions.length) {
    return { type: 'invalid' };
  }
  return { type: 'compare', versions };
}
function createCopyComparison({ provider }) {
  return { async execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (command?.type !== 'compare') return refused(HELP);
    try { return unchanged(renderComparison(await provider.compare({ versions: command.versions }))); }
    catch { return refused('文案对比失败：模型调用失败或输出格式无效，未生成对比结果，请重试。'); }
  } };
}

module.exports = { HELP, parseCopyComparisonCommand, createCopyComparison };
