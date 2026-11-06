'use strict';

function parseDebateCommand(text) {
  const value = String(text || '').trim();
  // Paired decisions retain their existing route, including malformed commands.
  if (/(?:双人|私密)(?:决策|投票)/u.test(value)) return null;
  let body;
  const prefix = value.match(/^(?:辩论一下|辩论赛)\s*[：:]\s*([\s\S]*)$/u);
  const suffix = value.match(/^(?:纠结)?([\s\S]*?)[，,\s]*辩论一下[。！!？?]?$/u);
  if (prefix) body = prefix[1];
  else if (suffix) body = suffix[1];
  else if (/^(?:辩论一下|辩论赛)[。！!？?]?$/u.test(value)) body = '';
  else return null;
  let preference = '';
  const tail = body.match(/[，,\s]*我更看重([\s\S]*)$/u);
  if (tail) {
    preference = tail[1].replace(/[。！!？?]+$/u, '').trim();
    body = body.slice(0, tail.index);
  }
  const options = body.split(/还是|或者|\bvs\b/iu)
    .map(part => part.replace(/^[，,\s]+|[，,。！!？?\s]+$/gu, '').trim());
  if (options.length !== 2 || options.some(option => !option) || options[0] === options[1]
    || (tail && !preference)) return { type: 'invalid' };
  return { type: 'debate', options, preference };
}

module.exports = { parseDebateCommand };
