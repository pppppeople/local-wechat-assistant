'use strict';

const HELP = '原文和回复意图均不能为空。格式：帮我回复这段话：<原文>，我想表达：<意图>（可附加“，风格：礼貌”或“，风格：正式”）。';
function parseReplyComposerCommand(text) {
  const value = String(text || '').trim();
  if (!/^帮我回复这段话(?:：|$)/u.test(value)) return null;
  const body = value.replace(/^帮我回复这段话：?/u, '');
  const separator = '，我想表达：';
  const at = body.indexOf(separator);
  if (at < 0) return { type: 'invalid' };
  let style = '简洁';
  // Only these exact explicit values select a non-default style; never persist it.
  const clean = part => part.replace(/风格：([^\s，。；;\n]*)/gu, (_match, word) => {
    if (word === '礼貌' || word === '正式') style = word;
    return '';
  }).replace(/^[\s，；;]+|[\s，；;]+$/gu, '').trim();
  const original = clean(body.slice(0, at));
  const intent = clean(body.slice(at + separator.length));
  return original && intent ? { type: 'compose', original, intent, style } : { type: 'invalid' };
}

async function executeReplyComposer(side, command, provider) {
  if (side !== 'owner') return { reply: '消息引用回复助手只供已绑定的本人使用，好友不可生成草稿。', wrote: false };
  if (!command || command.type !== 'compose' || !command.original?.trim() || !command.intent?.trim()) {
    return { reply: HELP, wrote: false };
  }
  try {
    const reply = await provider.compose({ original: command.original, intent: command.intent, style: command.style });
    if (typeof reply !== 'string' || !reply.trim()) throw Error('empty composition');
    return { reply, wrote: false };
  } catch {
    return { reply: '模型调用失败，本次未生成回复草稿，请稍后重试。', wrote: false };
  }
}

module.exports = { HELP, parseReplyComposerCommand, executeReplyComposer };
