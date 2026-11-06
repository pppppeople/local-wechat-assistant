'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPublicAssistant } = require('../src/public-assistant');
async function demo() {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-public-demo-'));
  try {
    const assistant = createPublicAssistant({ runtime, model: async () => '这是虚构模型适配器的演示回答。' });
    for (const text of ['记一下 明天买牛奶', '我的待办', '记账 12元 餐饮 示例午餐', '今日账单', '创建习惯：散步', '我的习惯', '你好']) {
      console.log(`> ${text}\n${await assistant.reply(text)}`);
    }
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
}
demo().catch(() => { console.error('Synthetic demo failed'); process.exitCode = 1; });
