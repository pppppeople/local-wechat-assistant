'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendWechatHttp } = require('../src/wechat-http-send');
const request = { account: { token: 'synthetic', baseUrl: 'https://synthetic.invalid' }, payload: { synthetic: true } };

for (const stage of ['fetch', 'body']) {
  test(`HTTP timeout aborts during ${stage} and remains unconfirmed`, async () => {
    let signal;
    const result = await sendWechatHttp(request, { timeoutMs: 5, fetchImpl: async (_url, options) => {
      signal = options.signal;
      const waitForAbort = () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      if (stage === 'fetch') return waitForAbort();
      return { status: 200, text: waitForAbort };
    } });
    assert.equal(signal.aborted, true);
    assert.equal(result.confirmed, false);
    assert.equal(result.state, 'unconfirmed');
    assert.equal(result.error.name, 'AbortError');
  });
}
