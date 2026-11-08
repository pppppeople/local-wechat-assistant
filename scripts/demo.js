'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWeatherStore } = require('../src/weather-store');
const { createWeatherMorning } = require('../src/weather-morning');
const { createPairConsole } = require('../src/public-pair-console');

async function demo({ log = console.log } = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-public-demo-'));
  try {
    let at = Date.parse('2026-11-06T04:00:00Z');
    const now = () => at;
    const weatherStore = createWeatherStore({ runtime, env: {}, now });
    const weatherProvider = {
      attribution: '模拟天气数据（离线 stub，非真实预报）',
      async searchPlace(name) { return name === '苏州' ? [{ name, adcode: 'demo-city' }] : []; },
      async weather(_place, date) { return { date, dayWeather: '小雨', nightWeather: '多云',
        dayTemp: '20', nightTemp: '12', dayWind: '北', dayPower: '3-4', nightWind: '东', nightPower: '1-3' }; },
    };
    const assistant = createPairConsole({ runtime, random: () => 0, now, weatherProvider, weatherStore, weatherMorningTime: '08:00' });
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
    log('\n第五幕 · 天气 + 每日早报（模拟）');
    await say('小林', '天气');
    await say('小林', '苏州');
    await say('小林', '开启天气早报');
    await say('小周', '天气说明');
    at = Date.parse('2026-11-07T00:00:00Z');
    const morning = createWeatherMorning({ store: weatherStore, weather: assistant.weather, now,
      time: '08:00', sides: ['owner'], send: async (_side, text) => {
        log(`[小林 模拟发送] 2026-11-07 08:00（上海时间）\n${text}`);
      } });
    await morning.tick();
    await morning.tick();
    return { runtime };
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
}
if (require.main === module) demo().catch(() => { console.error('Synthetic pair demo failed'); process.exitCode = 1; });
module.exports = { demo };
