'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPairConsole } = require('../src/public-pair-console');
const { createPublicAssistant } = require('../src/public-assistant');
const { createWeatherStore } = require('../src/weather-store');
const { createWeatherMorning } = require('../src/weather-morning');
const { demo } = require('../scripts/demo');

function fixture(t) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'public-pair-console-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const options = { runtime, random: () => 0, now: () => Date.parse('2026-11-06T04:00:00Z'),
    model: async () => { throw new Error('Explicit commands must not invoke the model'); } };
  return { runtime, options, console: createPairConsole(options) };
}

test('console role switch accepts names and /as, rejects unknown roles and describes its boundary', async t => {
  const { runtime, console: host } = fixture(t);
  assert.equal(host.speaker, '小林');
  assert.equal(host.side, 'owner');
  assert.match(await host.reply('帮助'), /虚构[\s\S]*切换 小周[\s\S]*共同愿望/);
  assert.match(await host.reply('切换 小周'), /当前说话人：小周/);
  assert.equal(host.side, 'friend');
  assert.match(await host.reply('/as stranger'), /请选择/);
  assert.equal(host.side, 'friend');
  await host.reply('/as owner');
  assert.equal(host.speaker, '小林');
  await host.reply('/as 小周');
  assert.equal(host.speaker, '小周');
  assert.match(await createPairConsole({ runtime }).reply('你好'), /双人助手[\s\S]*切换 小周/);
});

test('A adds a place, B sees and marks it, both reopen the same classified shared store', async t => {
  const { runtime, options, console: host } = fixture(t);
  await host.reply('想去箱添加：纸月公园');
  assert.match(await host.reply('切换 小周'), /小林添加了「纸月公园」/);
  assert.match(await host.reply('查看想去箱'), /1\. 纸月公园/);
  assert.match(await host.reply('第一个标记成去过了'), /纸月公园标成去过/);
  const cold = createPairConsole(options);
  assert.match(await cold.reply('去过的地方'), /1\. 纸月公园/);
  assert.doesNotMatch(await cold.reply('查看想去箱'), /1\. 纸月公园/);
  await cold.reply('切换 小周');
  assert.match(await cold.reply('去过的地方'), /1\. 纸月公园/);
  assert.ok(fs.existsSync(path.join(runtime, 'state', 'features', 'shared-place', 'state.json')));
});

test('daily answers remain secret in every response until both roles answer, including after reopening', async t => {
  const { options, console: host } = fixture(t);
  const question = (await host.reply('每日一问')).split('\n')[0];
  assert.doesNotMatch(await host.reply('每日一问答：星星纸船'), /星星纸船|双方答案揭晓：/);
  const cold = createPairConsole(options);
  assert.doesNotMatch(await cold.reply('切换 小周'), /星星纸船/);
  for (const command of ['每日一问', '每日一问揭晓', '每日一问查揭晓', '帮助']) {
    const text = await cold.reply(command);
    assert.doesNotMatch(text, /星星纸船|双方答案揭晓：/);
    if (command !== '帮助') assert.equal(text.split('\n')[0], question);
  }
  assert.match(await cold.reply('每日一问答：月亮小屋'), /小林：星星纸船[\s\S]*小周：月亮小屋/);
  assert.match(await cold.reply('切换 小林'), /小林 本地通知[\s\S]*小林：星星纸船[\s\S]*小周：月亮小屋/);
  assert.match(await cold.reply('每日一问揭晓'), /双方答案揭晓：/);
});

test('challenge callback reveals to each local role only after both have answered', async t => {
  const { console: host } = fixture(t);
  await host.reply('来一轮默契挑战');
  assert.doesNotMatch(await host.reply('默契答 B'), /小林：B|默契挑战揭晓：/);
  assert.doesNotMatch(await host.reply('切换 小周'), /小林：B|默契挑战揭晓：/);
  assert.doesNotMatch(await host.reply('来一轮默契挑战'), /小林：B|默契挑战揭晓：/);
  assert.match(await host.reply('默契答 B'), /小周 本地通知[\s\S]*小林：B[\s\S]*小周：B[\s\S]*默契一致/);
  assert.match(await host.reply('切换 小林'), /小林 本地通知[\s\S]*默契一致/);
  await host.reply('切换 小周');
  assert.doesNotMatch(await host.reply('切换 小林'), /默契挑战揭晓：/);
  assert.match(await host.reply('默契战绩'), /共玩 1 轮、默契 1 次/);
});

test('savings accumulates both sides and refuses undo of the other side contribution', async t => {
  const { runtime, options, console: host } = fixture(t);
  await host.reply('共同愿望：周末野餐 200元');
  await host.reply('愿望贡献：30元');
  await host.reply('切换 小周');
  assert.match(await host.reply('愿望贡献：50元'), /40%[\s\S]*已记录：80\.00元[\s\S]*小林贡献：30\.00元[\s\S]*小周贡献：50\.00元/);
  assert.match(await host.reply('撤销愿望贡献：1'), /只能撤销自己的/);
  assert.match(await createPairConsole(options).reply('共同愿望进度'), /40%[\s\S]*已记录：80\.00元/);
  assert.ok(fs.existsSync(path.join(runtime, 'state', 'features', 'pair-savings', 'state.json')));
});

test('personal commands retain owner-only semantics and WeChat assistant cannot switch roles', async t => {
  const { runtime, console: host } = fixture(t);
  await host.reply('记一下 示例私人待办');
  await host.reply('记账 12元 餐饮 示例午餐');
  await host.reply('存临时信息 示例备忘');
  await host.reply('创建习惯：散步');
  await host.reply('切换 小周');
  for (const command of ['我的待办', '今日账单', '临时信息', '我的习惯', '记一下 不应写入']) {
    const reply = await host.reply(command);
    assert.match(reply, /仅供|只供|仅主人可用/);
    assert.doesNotMatch(reply, /示例私人待办|示例午餐|示例备忘|散步/);
  }
  await host.reply('切换 小林');
  assert.match(await host.reply('我的待办'), /示例私人待办/);
  assert.doesNotMatch(await host.reply('我的待办'), /不应写入/);
  assert.match(await host.reply('今日账单'), /12/);
  assert.match(await host.reply('临时信息'), /示例备忘/);
  assert.match(await host.reply('我的习惯'), /散步/);
  const transportAssistant = createPublicAssistant({ runtime });
  await transportAssistant.reply('/as friend');
  assert.match(await transportAssistant.reply('我的待办'), /示例私人待办/);
});

test('npm start entrypoint displays speaker prompts and routes the four pair features on piped input', t => {
  const { runtime } = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'main.js')], {
    env: { PATH: process.env.PATH, WECHAT_ASSISTANT_HOME: runtime }, encoding: 'utf8',
    input: ['想去箱添加：纸月公园', '切换 小周', '查看想去箱', '每日一问',
      '每日一问答：月亮小屋', '/as owner', '每日一问揭晓', '每日一问答：星星纸船',
      '来一轮默契挑战', '默契答 B', '/as friend', '默契答 B',
      '共同愿望：野餐 200元', '愿望贡献：50元', '切换 小林', '愿望贡献：30元'].join('\n') + '\n',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /\[小林\] >[\s\S]*\[小周\] >[\s\S]*1\. 纸月公园/);
  assert.match(result.stdout, /小林：星星纸船[\s\S]*小周：月亮小屋/);
  assert.match(result.stdout, /默契一致/);
  assert.match(result.stdout, /40%[\s\S]*已记录：80\.00元/);
});

test('demo runs five actual pair scenes with both viewpoints and removes its runtime', async () => {
  const lines = [];
  const { runtime } = await demo({ log: text => lines.push(text) });
  assert.equal(fs.existsSync(runtime), false);
  const scenes = lines.join('\n').split(/\n第[一二三四五]幕 · /u).slice(1);
  assert.equal(scenes.length, 5);
  for (const scene of scenes) {
    assert.match(scene, /\[小林 视角\]/);
    assert.match(scene, /\[小周 视角\]/);
  }
  assert.match(scenes[0], /小周 视角[\s\S]*1\. 纸月公园[\s\S]*标成去过/);
  const question = scenes[1];
  const beforeSecondAnswer = question.split('[小周 视角] > 每日一问答：')[0];
  assert.doesNotMatch(beforeSecondAnswer, /小林：星星纸船|双方答案揭晓：/);
  assert.match(question, /小林：星星纸船[\s\S]*小周：月亮小屋/);
  assert.match(scenes[2], /小林 本地通知[\s\S]*默契一致/);
  assert.match(scenes[2], /小周 本地通知[\s\S]*默契一致/);
  assert.match(scenes[3], /40%[\s\S]*已记录：80\.00元/);
  assert.match(scenes[4], /天气.*每日早报（模拟）/);
  assert.match(scenes[4], /先选一个天气城市[\s\S]*苏州｜2026-11-06 今日/);
  assert.match(scenes[4], /小林 模拟发送[\s\S]*2026-11-07 08:00[\s\S]*苏州｜2026-11-07 今日[\s\S]*2026-11-08 明日预告[\s\S]*带伞/);
  assert.equal(scenes[4].split('[小林 模拟发送]').length, 2);
  assert.match(scenes[4], /模拟天气数据（离线 stub，非真实预报）/);
});

test('demo cleans temporary files even when output fails partway through', async t => {
  let runtime;
  const mkdir = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (...args) => { runtime = mkdir(...args); return runtime; });
  let lines = 0;
  await assert.rejects(demo({ log: () => { if (++lines === 4) throw new Error('synthetic output failure'); } }), /synthetic output failure/);
  assert.ok(runtime);
  assert.equal(fs.existsSync(runtime), false);
});

// Use the actual public consumers and weather components, stubbing only the provider/model.
function weatherHost(t, kind, side) {
  const { runtime, options } = fixture(t);
  const store = createWeatherStore({ runtime, env: {} });
  const calls = [], modelCalls = [];
  let at = Date.parse('2026-11-06T08:00:00+08:00');
  const now = () => at;
  const provider = {
    attribution: '离线模拟天气',
    async searchPlace(name) { return [{ name, adcode: 'demo-city' }]; },
    async weather(place, date) {
      calls.push([place.name, date]);
      return { date, dayWeather: '晴' };
    },
  };
  const create = kind === 'console' ? createPairConsole : createPublicAssistant;
  const host = create({ ...options, now, weatherStore: store, weatherProvider: provider,
    model: async text => { modelCalls.push(text); return '普通问答回落'; } });
  return { store, provider, calls, modelCalls, host, now,
    setTime: time => { at = Date.parse(time); },
    async selectRole() { if (kind === 'console') await host.reply(`/as ${side}`); },
    say: text => kind === 'console' ? host.reply(text) : host.reply(text, side) };
}

test('public host and console display all resolution failures without model fallback, preserve state, then accept retry', async t => {
  for (const kind of ['host', 'console']) {
    for (const side of ['owner', 'friend']) {
      for (const type of ['city_reply', 'query']) {
        for (const fails of ['empty', 'throw', 'wrong-city']) {
          const f = weatherHost(t, kind, side);
          await f.selectRole();
          const sends = [];
          const morning = createWeatherMorning({ store: f.store, weather: f.host.weather, now: f.now, sides: [side],
            send: async (...args) => sends.push(args) });
          if (type === 'city_reply') await morning.tick();
          else await f.say('后天天气');
          const before = fs.readFileSync(f.store.stateFile, 'utf8');
          const search = f.provider.searchPlace;
          f.provider.searchPlace = async () => {
            if (fails === 'throw') throw Error('synthetic provider outage');
            return fails === 'empty' ? [] : [{ name: '别的地方', adcode: 'demo-city' }];
          };
          const text = type === 'city_reply' ? '纸月城' : '纸月城明天天气';
          assert.equal(f.host.weather.selectInput(side, text).type, type);
          const reply = await f.say(text);
          assert.equal(reply, '解析不了这个天气城市，请换个城市名再试；原设置未修改。\n看用法回：天气说明', `${kind}/${side}/${type}/${fails}`);
          assert.equal(fs.readFileSync(f.store.stateFile, 'utf8'), before);
          assert.deepEqual(f.calls, []);
          f.provider.searchPlace = search;
          const retry = await f.say(text);
          assert.match(retry, new RegExp(`^已设置${side === 'owner' ? '小林' : '小周'}的天气城市：纸月城。`));
          assert.equal(f.store.city(side), '纸月城'); assert.equal(f.store.pending(side), null);
          assert.equal(f.store.city(side === 'owner' ? 'friend' : 'owner'), '');
          if (type === 'city_reply') {
            assert.match(retry, /次日/); assert.deepEqual(f.calls, []);
            await morning.tick(); assert.equal(sends.length, 1);
            f.setTime('2026-11-07T08:00:00+08:00'); await morning.tick(); assert.equal(sends.length, 2);
          } else {
            assert.match(retry, /纸月城｜2026-11-07 明日/);
            assert.deepEqual(f.calls, [['纸月城', '2026-11-07']]);
          }
          assert.deepEqual(f.modelCalls, []);
        }
      }
    }
  }
});

test('public city queries leave manuals, work with no/query/morning pending, and retain next-day briefings', async t => {
  for (const kind of ['host', 'console']) {
    for (const side of ['owner', 'friend']) {
      for (const pending of [null, 'query', 'morning']) {
        const f = weatherHost(t, kind, side); await f.selectRole();
        const sends = [];
        const morning = createWeatherMorning({ store: f.store, weather: f.host.weather, now: f.now, sides: [side],
          send: async (...args) => sends.push(args) });
        if (pending === 'morning') await morning.tick();
        if (pending === 'query') await f.say('后天天气');
        await f.say('天气说明');
        assert.match(await f.say('1'), /苏州天气/);
        const text = pending ? '纸月城明天天气' : '纸月城天气';
        const reply = await f.say(text);
        assert.match(reply, new RegExp(`^已设置${side === 'owner' ? '小林' : '小周'}的天气城市：纸月城。`));
        assert.deepEqual(f.calls.map(call => call[1]), pending ? ['2026-11-07'] : ['2026-11-06', '2026-11-07']);
        assert.equal(reply.split('看用法回：天气说明').length, 2);
        assert.equal(f.store.pending(side), null); assert.equal(f.store.city(side), '纸月城');
        assert.equal(f.host.weather.selectInput(side, '1'), null);
        if (pending === 'morning') {
          await morning.tick(); assert.equal(sends.length, 1);
          f.setTime('2026-11-07T08:00:00+08:00'); await morning.tick(); assert.equal(sends.length, 2);
        }
        assert.deepEqual(f.modelCalls, []);
      }
    }
  }
});

test('public console pending weather preserves pair/personal commands and lets weather-bearing prose reach normal routing', async t => {
  const f = weatherHost(t, 'console', 'owner');
  await f.say('天气'); await f.say('天气说明');
  assert.match(await f.say('查看想去箱'), /想去箱/);
  assert.equal(f.host.weather.selectInput('owner', '1'), null);
  await f.say('天气说明'); await f.say('记一下 示例待办');
  assert.match(await f.say('我的待办'), /示例待办/);
  assert.equal(f.host.weather.selectInput('owner', '1'), null);
  assert.equal(await f.say('纸月城天气然后转告好友'), '普通问答回落');
  assert.deepEqual(f.modelCalls, ['纸月城天气然后转告好友']);
  assert.equal(f.store.city('owner'), ''); assert.equal(f.store.pending('owner').kind, 'query');
  assert.deepEqual(f.calls, []);
});
