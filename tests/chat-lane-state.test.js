'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPairDailyQuestionStore } = require('../src/pair-daily-question-store');
const { createPairChallengeStore } = require('../src/pair-challenge-store');
const { createSharedPlaceBox } = require('../src/shared-place-box');
const { createWeatherStore } = require('../src/weather-store');
const { createWeatherCommands } = require('../src/weather-commands');
const { captureChatLaneState } = require('../src/chat-lane-state');
const { createPublicAssistant } = require('../src/public-assistant');
const { createPairConsole } = require('../src/public-pair-console');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-lane-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).sort().filter(file => fs.statSync(path.join(root, file)).isFile())
    .map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
}
test('active host probes are read-only on empty, active, expired and corrupt state, preserving originals', async t => {
  let clock = Date.parse('2026-01-02T01:00:00Z');
  const root = fixture(t), options = name => ({ stateFile: path.join(root, name, 'state.json'), now: () => clock });
  const daily = createPairDailyQuestionStore({ ...options('daily'), getBinding: () => 'synthetic-pair' });
  const challenge = createPairChallengeStore({ ...options('challenge'), random: () => 0 });
  const place = createSharedPlaceBox({ ...options('place'), provider: { available: false } });
  const weather = createWeatherStore(options('weather'));
  const probes = [['daily', () => daily.hasPending()], ['challenge', () => challenge.hasPending('owner')],
    ['place', () => place.hasLanePending('owner')], ['weather', () => weather.hasPending('owner')]];
  const capture = () => captureChatLaneState({ probes, item: { hasAttachment: false } });
  assert.equal(capture().pending, false); assert.deepEqual(snapshot(root), {});
  daily.handle('owner', { type: 'answer', answer: '合成纸船' });
  challenge.handle('owner', { type: 'start' });
  await place.handle('owner', { type: 'add', name: '纸月公园' });
  await place.handle('owner', { type: 'list' });
  weather.waitForCity('owner', { kind: 'query', days: [0, 1] });
  // Active records must be created through each store before corrupting them.
  // A status-only daily query is read-only and does not create a state folder.
  for (const name of ['daily', 'challenge', 'place', 'weather']) assert.ok(fs.existsSync(options(name).stateFile), name);
  const active = snapshot(root);
  assert.equal(capture().pending, true); assert.deepEqual(snapshot(root), active);
  clock += 25 * 3600000;
  assert.equal(capture().pending, false); assert.deepEqual(snapshot(root), active);
  for (const [name, read] of probes) {
    const folder = { daily: 'daily', challenge: 'challenge', place: 'place', weather: 'weather' }[name];
    const file = options(folder).stateFile;
    fs.writeFileSync(file, 'synthetic corrupt bytes');
    const original = snapshot(root);
    assert.throws(read);
    assert.equal(captureChatLaneState({ probes: [[name, read]], item: { hasAttachment: false } }).known, false);
    assert.deepEqual(snapshot(root), original);
  }
});
test('weather pending errors and unavailable custom probes force real host L2', async t => {
  const root = fixture(t), logs = [];
  const host = createPublicAssistant({ runtime: root, log: line => logs.push(line),
    laneProbes: () => [['enabled-extension', () => { throw Error('synthetic confidential detail'); }]],
    model: async (_text, options) => { assert.equal(options.schema, undefined); return '基线回答'; } });
  assert.equal(await host.reply('你好'), '基线回答');
  assert.match(logs.at(-1), /state_unknown/); assert.doesNotMatch(logs.join('\n'), /confidential|你好/);
});
test('custom weather stores without a boolean read-only probe fail closed without calling pending', () => {
  for (const hasPending of [undefined, () => undefined, () => 'false']) {
    let pendingCalls = 0;
    const weather = createWeatherCommands({ store: { hasPending, pending() { pendingCalls++; return null; } } });
    const state = captureChatLaneState({ probes: [['weather', () => weather.hasPending('owner')]], item: { hasAttachment: false } });
    assert.equal(state.known, false);
    assert.equal(pendingCalls, 0);
  }
});
test('malformed history cannot admit fast lanes or be overwritten by a new reply', async t => {
  for (const content of ['synthetic corrupt bytes', JSON.stringify({ '["local-console","owner","owner"]': { updatedAt: new Date().toISOString(), turns: 'invalid' } })]) {
    const root = fixture(t), file = path.join(root, 'state/chat/threads.json');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    const logs = [];
    const host = createPublicAssistant({ runtime: root, log: line => logs.push(line), model: async (_text, options) => {
      assert.equal(options.schema, undefined); return '基线回答';
    } });
    await assert.rejects(host.reply('你好'));
    assert.match(logs.at(-1), /state_unknown/); assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});
test('challenge, place list and pending weather block fast admission in actual console wiring', async t => {
  for (const command of ['来一轮默契挑战', '查看想去箱', '天气']) {
    const logs = [];
    const host = createPairConsole({ runtime: fixture(t), log: line => logs.push(line),
      model: async (_text, options) => options.schema?.properties.needs_tool ? '{"reply":"合成回答","needs_tool":false}' : '基线回答' });
    await host.reply(command);
    if (command === '查看想去箱') {
      await host.reply('想去箱添加：纸月公园'); await host.reply('查看想去箱');
    }
    await host.reply('你好');
    // Pending weather may consume the greeting as a bad city; no model is also
    // a safe result. Other active pair features must explicitly classify L2.
    if (logs.length) assert.match(logs.at(-1), /"lane":"L2"/);
  }
});
