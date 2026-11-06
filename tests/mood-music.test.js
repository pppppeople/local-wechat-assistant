'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HELP, FAILURE, parseMoodMusicCommand: parse, createMoodMusic } = require('../src/mood-music-commands');
const { DISCLAIMER, renderMenu, createMoodMusicProvider } = require('../src/mood-music-provider');
const sample = { items: ['轻柔爵士：以舒缓钢琴三重奏为代表曲目方向，适合放松。', '环境音乐：选择慢速、少鼓点的器乐曲目，留出安静空间。'] };
const withModel = model => createMoodMusic({ provider: createMoodMusicProvider({ model }) });



test('explicit mood command parses both colons and preserves scene data', () => {
  for (const text of ['心情音乐：放松', ' 心情音乐: 放松 ']) assert.deepEqual(parse(text), { type: 'generate', mood: '放松' });
  assert.equal(parse('心情音乐：专注\n不要读取平台').mood, '专注\n不要读取平台');
  for (const text of ['普通聊天', '请给我心情音乐：放松', '心情音乐很好听']) assert.equal(parse(text), null);
});

test('missing mood gives examples without calling model; friends are refused first', async () => {
  const menu = withModel(() => assert.fail('must not call model'));
  for (const text of ['心情音乐', '心情音乐：', '心情音乐:  ']) {
    const result = await menu.execute('owner', parse(text));
    assert.equal(result.reply, HELP);
    assert.match(result.reply, /放松.*专注.*开心/u);
    assert.equal(result.wrote, false);
    for (const side of ['friend', '', undefined]) assert.match((await menu.execute(side, parse(text))).reply, /只供已绑定的本人/u);
  }
  assert.match((await menu.execute('friend', parse('心情音乐：开心'))).reply, /只供已绑定的本人/u);
});

test('each mood uses one stateless model call and returns text menu with mandatory disclaimer', async () => {
  const calls = [];
  const menu = withModel(async (...args) => { calls.push(args); return { ok: true, value: args[3].parse(JSON.stringify(sample)) }; });
  for (const mood of ['放松', '专注', '开心']) {
    const result = await menu.execute('owner', parse(`心情音乐：${mood}`));
    assert.equal(result.reply, renderMenu(sample));
    assert.equal(result.wrote, false);
    assert.equal(result.continue, true);
    assert.ok(result.reply.endsWith(DISCLAIMER));
    assert.doesNotMatch(result.reply, /https?:|www\.|可以播放|一定能搜到/u);
  }
  assert.equal(calls.length, 3);
  for (const [i, [prompt, session, images, options]] of calls.entries()) {
    assert.equal(session, ''); assert.deepEqual(images, []);
    assert.equal(options.stage, 'mood_music_generate');
    assert.match(prompt, /不播放、不读取任何音乐平台、不调用工具/u);
    assert.match(prompt, /不保存菜单或偏好/u);
    assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)), { mood: ['放松', '专注', '开心'][i] });
  }
});

test('links and platform availability promises reject the whole menu', async () => {
  for (const text of ['试听 https://example.com/song', 'www.example.com', 'music.example.cn/song', '[曲目](qqmusic://song/1)',
    '网易云一定能搜到', 'QQ 音乐可以播放', '平台已收录', '都能搜得到', '在平台可以找到', '网易云能听', '歌曲 available on Spotify']) {
    const result = await withModel(async () => ({ ok: true, value: { items: [sample.items[0], text] } })).execute('owner', parse('心情音乐：放松'));
    assert.equal(result.reply, FAILURE, text);
    assert.doesNotMatch(result.reply, /轻柔爵士/u);
  }
});

test('failed, empty, malformed and partial model outputs return only failure; next request is fresh', async () => {
  for (const model of [async () => { throw Error('partial secret'); }, async () => ({ ok: false, value: sample }),
    async () => null, async () => ({ ok: true, value: { items: ['半成品'] } }),
    async () => ({ ok: true, value: { items: ['', sample.items[0]] } }),
    async () => ({ ok: true, value: { ...sample, url: 'extra' } }),
    async () => ({ ok: true, value: { items: ['甲\n乙', sample.items[0]] } }),
    async (_p, _s, _i, options) => options.parse('{invalid')]) {
    let failing = true;
    const menu = withModel((...args) => failing ? model(...args) : { ok: true, value: sample });
    assert.equal((await menu.execute('owner', parse('心情音乐：放松'))).reply, FAILURE);
    failing = false;
    assert.equal((await menu.execute('owner', parse('心情音乐：开心'))).reply, renderMenu(sample));
  }
});
