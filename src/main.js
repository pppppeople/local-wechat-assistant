'use strict';
const readline = require('node:readline');
const { setTimeout: sleep } = require('node:timers/promises');
const { loadPublicConfig } = require('./public-config');
const { createPublicModel } = require('./public-model');
const { createPublicAssistant } = require('./public-assistant');
const { createPublicWechat } = require('./public-wechat');
const { createPairConsole } = require('./public-pair-console');

async function main(args = process.argv.slice(2)) {
  const config = loadPublicConfig();
  const log = line => console.error(`[${new Date().toISOString()}] ${line}`);
  const options = { runtime: config.runtime, model: createPublicModel(config.model), fallbackConfig: config.fallback, log };
  if (args.includes('--wechat')) {
    const assistant = createPublicAssistant(options);
    const transport = createPublicWechat({ account: config.account, runtime: config.runtime, assistant, log });
    try { for (;;) { await transport.pollOnce({ waitForIdle: false }); await sleep(1000); } }
    finally { assistant.close(); }
  }
  const assistant = createPairConsole(options);
  console.log('双人助手 · Two people, one assistant. 小林与小周均为虚构角色。输入“帮助”查看命令；Ctrl-D 退出。');
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, crlfDelay: Infinity });
  const prompt = () => { input.setPrompt(`[${assistant.speaker}] > `); input.prompt(); };
  prompt();
  try { for await (const line of input) {
    try { console.log(await assistant.reply(line)); }
    catch { console.error('操作失败，未确认完成；请检查自己的配置或本地状态。'); }
    prompt();
  } } finally { assistant.close(); }
}
if (require.main === module) main().catch(() => { console.error('启动或传输停止：配置无效、网络失败或操作结果未确认。请检查自己的配置及私有运行目录。'); process.exitCode = 1; });
module.exports = { main };
