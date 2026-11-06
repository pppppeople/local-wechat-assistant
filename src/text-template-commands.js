'use strict';

const HELP = '请用“保存文字模板 <名称>：<模板正文>”（名称和正文不能为空）、“文字模板列表”、“使用文字模板 <名称>”或“删除文字模板 <名称>”；变量写作 {{变量名}}，收集中可说“取消”。';
const PLACEHOLDER = /\{\{([^{}\r\n]+)\}\}/gu;
function placeholders(body) {
  return [...body.matchAll(PLACEHOLDER)].filter(match => match[1].trim());
}
function variables(body) { return [...new Set(placeholders(body).map(match => match[1].trim()))]; }
function fill(body, values) {
  // A callback keeps $&, $' and placeholder-looking values literal. One pass only.
  return body.replace(PLACEHOLDER, (token, name) => name.trim() ? values.get(name.trim()) : token);
}
function parseTextTemplateCommand(input) {
  const text = String(input || '').trim();
  if (text === '文字模板列表') return { type: 'list' };
  const save = text.match(/^保存文字模板\s+([^：:]*?)[：:]([\s\S]*)$/u);
  if (save) return { type: 'save', name: save[1].trim(), body: save[2] };
  const action = text.match(/^(使用文字模板|删除文字模板)\s+([\s\S]*)$/u);
  if (action) return { type: action[1] === '使用文字模板' ? 'use' : 'delete', name: action[2].trim() };
  return /^(?:保存文字模板|文字模板列表|使用文字模板|删除文字模板)/u.test(text) ? { type: 'invalid' } : null;
}
module.exports = { HELP, placeholders, variables, fill, parseTextTemplateCommand };
