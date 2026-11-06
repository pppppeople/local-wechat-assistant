'use strict';

function parseChatRecallCommand(text) {
  const value = String(text || '').trim();
  // Leave combined actions and ordinary account-recovery questions to routing.
  if (/[\n；;]/u.test(value) || /(?:记一下|记成待办|记为待办|加到待办|帮我|请你|怎么|如何|为什么|能否|能不能)/u.test(value)) return null;
  let match = value.match(/^找回\s*[：:]?\s*([\s\S]*)$/u);
  if (!match) match = value.match(/^(?:我(?:上次|之前)(?:说的|提过)(?:的)?|(?:上次|之前)那个)\s*([\s\S]*?)(?:是什么来着|是什么|来着|吗|呢)[？?。！!]*$/u);
  if (!match) return null;
  const keyword = match[1]
    .replace(/(?:是什么来着|是什么|来着|吗|呢)[？?。！!]*$/u, '')
    .replace(/^(?:那个|那件)\s*/u, '')
    .replace(/的事(?:情)?$/u, '')
    .replace(/^[\s：:，,「」“”"']+|[\s？?。！!，,「」“”"']+$/gu, '')
    .trim();
  if (/[，,。！？!?]/u.test(keyword)) return null;
  return { type: 'recall', keyword };
}

module.exports = { parseChatRecallCommand };
