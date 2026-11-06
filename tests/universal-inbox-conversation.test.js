'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractUniversalInboxCandidate } = require('../src/universal-inbox-conversation');

const marker = (payload) => `[[UNIVERSAL_INBOX:${JSON.stringify(payload)}]]`;

test('handles missing input, malformed payloads, invalid rows and misplaced inbox markers', () => {
  assert.deepEqual(extractUniversalInboxCandidate(undefined), { reply: '', candidate: null });
  assert.deepEqual(extractUniversalInboxCandidate(123), { reply: '123', candidate: null });
  assert.deepEqual(extractUniversalInboxCandidate('  普通文本  '), { reply: '普通文本', candidate: null });
  for (const raw of ['{bad}', 'null', '42', '[]', '{}', '[null,42,{}, {"kind":"unknown","title":"x"}, {"kind":"note","title":"  "}]']) {
    assert.deepEqual(extractUniversalInboxCandidate(`答复\n[[UNIVERSAL_INBOX:${raw}]]`), {
      reply: '答复', candidate: null, candidates: [],
    });
  }
  assert.deepEqual(extractUniversalInboxCandidate(`前${marker({ kind: 'note', title: '笔记' })}后`), {
    reply: '前后', candidate: null,
  });
});

test('cleans and bounds fields and preserves explicit self or peer scope only on tickets', () => {
  const candidate = extractUniversalInboxCandidate(marker({
    kind: 'note', title: ` \r\n${'t'.repeat(121)} `, placeName: 'p'.repeat(161),
    eventTime: 'e'.repeat(41), summary: 's'.repeat(201), tripScope: 'self', ignored: 'value',
  })).candidate;
  assert.deepEqual(candidate, {
    kind: 'note', title: 't'.repeat(120), placeName: 'p'.repeat(160),
    eventTime: 'e'.repeat(40), summary: 's'.repeat(200), url: '',
  });
  assert.equal(extractUniversalInboxCandidate(marker({ kind: 'note', title: ' A\r\nB ' })).candidate.title, 'A B');
  for (const tripScope of ['self', 'peer', 'unknown', 'SELF']) {
    const result = extractUniversalInboxCandidate(marker({ kind: 'ticket', title: '票', tripScope })).candidate;
    assert.equal(result.tripScope, ['self', 'peer'].includes(tripScope) ? tripScope : undefined);
  }
});

test('examines only the first five rows before validation and deduplication', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ kind: 'note', title: `条目${index}` }));
  const extracted = extractUniversalInboxCandidate(marker(rows));
  assert.deepEqual(extracted.candidates.map((row) => row.title), rows.slice(0, 5).map((row) => row.title));
  assert.strictEqual(extracted.candidate, extracted.candidates[0]);
  assert.deepEqual(extractUniversalInboxCandidate(marker([null, null, null, null, null, rows[5]])).candidates, []);
  assert.equal(extractUniversalInboxCandidate(marker([rows[0], rows[0], rows[0], rows[0], rows[0], rows[5]])).candidates.length, 1);
});

test('deduplicates by normalized kind, title, event time and ticket scope, retaining the first row', () => {
  const base = { kind: 'ticket', title: ' 标题 ', eventTime: ' 时间 ', tripScope: 'self', placeName: '甲', summary: '先' };
  const extracted = extractUniversalInboxCandidate(marker([
    base,
    { ...base, title: '标题', eventTime: '时间', placeName: '乙', summary: '后', url: 'https://example.com/different' },
    { ...base, eventTime: '次日' },
    { ...base, tripScope: 'peer' },
    { ...base, kind: 'event' },
  ]));
  assert.equal(extracted.candidates.length, 4);
  assert.equal(extracted.candidate.placeName, '甲');
  assert.equal(extracted.candidate.summary, '先');
  assert.deepEqual(extracted.candidates.map(({ kind, eventTime, tripScope }) => [kind, eventTime, tripScope]), [
    ['ticket', '时间', 'self'], ['ticket', '次日', 'self'], ['ticket', '时间', 'peer'], ['event', '时间', undefined],
  ]);
});

test('normalizes HTTP URLs, strips fragments and rejects invalid or unsupported URL schemes', () => {
  for (const [url, expected] of [
    ['  HTTP://EXAMPLE.COM:80/a#fragment  ', 'http://example.com/a'],
    ['https://example.com', 'https://example.com/'],
    ['', ''], ['not a url', ''], ['/relative', ''],
    ['file:fixtures/example', ''], ['ftp://example.com/a', ''], ['javascript:alert(1)', ''],
  ]) {
    assert.equal(extractUniversalInboxCandidate(marker({ kind: 'link', title: '链接', url })).candidate.url, expected);
  }
  const longUrl = `https://example.com/${'a'.repeat(600)}`;
  assert.equal(extractUniversalInboxCandidate(marker({ kind: 'link', title: '链接', url: longUrl })).candidate.url, longUrl.slice(0, 500));
});

test('filters recognized sensitive fields before truncation and enforces the marker size boundary', () => {
  for (const field of ['title', 'placeName', 'eventTime', 'summary']) {
    for (const secret of ['密码：hidden', '口令=hidden', 'TOKEN: hidden', 'Cookie=hidden', 'secret: hidden', 'api-key=hidden', '身份证：hidden', '订单号:hidden', '票号=hidden']) {
      assert.equal(extractUniversalInboxCandidate(marker({ kind: 'note', title: '笔记', [field]: secret })).candidate, null, `${field}: ${secret}`);
    }
  }
  assert.equal(extractUniversalInboxCandidate(marker({ kind: 'note', title: '笔记', summary: `${'a'.repeat(201)}密码：hidden` })).candidate, null);
  const payload = JSON.stringify({ kind: 'gift', title: '礼物' });
  assert.ok(extractUniversalInboxCandidate(`[[UNIVERSAL_INBOX:${payload.padEnd(5200)}]] \n`).candidate);
  const oversized = `[[UNIVERSAL_INBOX:${payload.padEnd(5201)}]]`;
  assert.deepEqual(extractUniversalInboxCandidate(oversized), { reply: oversized, candidate: null });
  const multiline = '[[UNIVERSAL_INBOX:{\n"kind":"note","title":"笔记"}]]';
  assert.deepEqual(extractUniversalInboxCandidate(multiline), { reply: multiline, candidate: null });
});
