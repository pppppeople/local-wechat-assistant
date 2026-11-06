'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPairConsole } = require('../src/public-pair-console');

async function demo({ log = console.log } = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-public-demo-'));
  try {
    const assistant = createPairConsole({ runtime, random: () => 0,
      now: () => Date.parse('2026-11-06T04:00:00Z') });
    log('Two people, one assistant · 双人助手演示。小林、小周及地点均为虚构；无网络请求、无真实资金。');
    async function say(speaker, text) {
      if (assistant.speaker !== speaker) log(await assistant.reply(`切换 ${speaker}`));
      log(`[${assistant.speaker} 视角] > ${text}\n${await assistant.reply(text)}`);
    }
    log('\n第一幕 · 共同想去箱');
    await say('小林', '想去箱添加：纸月公园');
    await say('小周', '查看想去箱');
    await say('小周', '把纸月公园标记为去过');
    await say('小林', '查看想去箱');
    await say('小林', '去过的地方');
    await say('小周', '去过的地方');

    log('\n第二幕 · 双人每日一问（答齐才揭晓）');
    await say('小林', '每日一问');
    await say('小林', '每日一问答：星星纸船');
    await say('小周', '每日一问揭晓');
    await say('小周', '每日一问答：月亮小屋');
    await say('小林', '每日一问揭晓');

    log('\n第三幕 · 默契挑战');
    await say('小林', '来一轮默契挑战');
    await say('小林', '默契答 B');
    await say('小周', '来一轮默契挑战');
    await say('小周', '默契答 B');
    await say('小林', '默契战绩');

    log('\n第四幕 · 共同储蓄（仅文本记账）');
    await say('小林', '共同愿望：周末野餐 200元');
    await say('小林', '愿望贡献：30元');
    await say('小周', '愿望贡献：50元');
    await say('小周', '共同愿望进度');
    await say('小林', '共同愿望进度');
    return { runtime };
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
}
if (require.main === module) demo().catch(() => { console.error('Synthetic pair demo failed'); process.exitCode = 1; });
module.exports = { demo };
