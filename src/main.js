'use strict';
const readline = require('node:readline');
const { setTimeout: sleep } = require('node:timers/promises');
const { loadPublicConfig } = require('./public-config');
const { createPublicModel } = require('./public-model');
const { createPublicAssistant } = require('./public-assistant');
const { createPublicWechat } = require('./public-wechat');

async function main(args = process.argv.slice(2)) {
  const config = loadPublicConfig();
  const assistant = createPublicAssistant({ runtime: config.runtime, model: createPublicModel(config.model) });
  if (args.includes('--wechat')) {
    const transport = createPublicWechat({ account: config.account, runtime: config.runtime, assistant });
    for (;;) { await transport.pollOnce(); await sleep(1000); }
  }
  console.log('Local assistant. 输入“帮助”查看命令；Ctrl-D 退出。');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    try { console.log(await assistant.reply(line)); }
    catch { console.error('操作失败，未确认完成；请检查自己的配置或本地状态。'); }
  }
}
if (require.main === module) main().catch(() => { console.error('启动或传输停止：配置无效、网络失败或操作结果未确认。请检查自己的配置及私有运行目录。'); process.exitCode = 1; });
module.exports = { main };
