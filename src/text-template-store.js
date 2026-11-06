'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged } = require('./feature-result');
const { HELP, placeholders, variables, fill } = require('./text-template-commands');
const hasText = value => typeof value === 'string' && Boolean(value.trim());
const SESSION_MS = 15 * 60 * 1000;
function validate(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.templates) || state.templates.length > 20
    || state.templates.some(row => !row || typeof row.id !== 'string' || !/^[a-z0-9_-]+$/iu.test(row.id)
      || !hasText(row.name) || row.name !== row.name.trim() || !hasText(row.body)
      || placeholders(row.body).length > 8 || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)))
    || new Set(state.templates.map(row => row.id)).size !== state.templates.length
    || new Set(state.templates.map(row => row.name)).size !== state.templates.length) throw Error('文字模板存储格式无效');
}
function createTextTemplateStore({ stateFile, now = () => Date.now() }) {
  let session = null;
  function hasPending(side) {
    if (side !== 'owner') return false;
    if (session && now() >= session.expiresAt) session = null;
    return Boolean(session);
  }
  function load() {
    if (!fs.existsSync(stateFile) && fs.existsSync(path.dirname(stateFile))
      && fs.readdirSync(path.dirname(stateFile)).some(name => name.startsWith(`${path.basename(stateFile)}.corrupt-`))) {
      throw Error('文字模板存储已隔离，请先恢复索引及正文。');
    }
    return readRecordState(stateFile, { schemaVersion: 1, templates: [] }, true, { strict: true, now, validate });
  }
  const question = () => unchanged(`请填写变量「${session.names[session.values.size]}」的值（只作纯文本；可说“取消”）：`);
  function execute(side, command) {
    if (side !== 'owner') return refused('文字模板仅主人可用，好友不能读取或操作。');
    if (command?.type === 'value') {
      if (!hasPending(side)) return refused('当前没有文字模板填值会话，请重新使用文字模板。');
      if (String(command.value).trim() === '取消') { session = null; return unchanged('已取消文字模板填充，未保存填值或生成结果。'); }
      if (!hasText(command.value)) return question();
      session.values.set(session.names[session.values.size], command.value);
      session.expiresAt = now() + SESSION_MS;
      if (session.values.size < session.names.length) return question();
      const result = fill(session.body, session.values);
      session = null;
      return unchanged(result);
    }
    if (!command || !['save', 'list', 'use', 'delete'].includes(command.type)
      || command.type !== 'list' && !hasText(command.name)
      || command.type === 'save' && !hasText(command.body)) return refused(HELP);
    if (command.type === 'save' && placeholders(command.body).length > 8) return refused('单个模板最多 8 个变量占位符，本次未保存。');
    const state = load();
    const save = () => { validate(state); writeRecordState(stateFile, state, ['templates']); };
    if (command.type === 'list') return unchanged(state.templates.length
      ? `文字模板列表：\n${state.templates.map(row => `${row.name}：${variables(row.body).join('、') || '无变量'}`).join('\n')}`
      : '暂无文字模板。');
    const name = command.name.trim();
    const row = state.templates.find(item => item.name === name);
    if (command.type === 'save') {
      if (row) return refused('已存在同名文字模板，不会覆盖，本次未保存。');
      if (state.templates.length >= 20) return refused('文字模板最多 20 个，本次未保存。');
      state.templates.push({ id: crypto.randomUUID(), name, body: command.body, createdAt: new Date(now()).toISOString() });
      save(); return changed(`已保存文字模板：${name}`);
    }
    if (!row) return refused(`文字模板「${name}」不存在。`);
    if (command.type === 'delete') {
      state.templates = state.templates.filter(item => item !== row); save();
      return changed(`已删除文字模板：${name}`);
    }
    const names = variables(row.body);
    if (!names.length) return unchanged(row.body);
    session = { body: row.body, names, values: new Map(), expiresAt: now() + SESSION_MS };
    return question();
  }
  return { execute, hasPending };
}
module.exports = { createTextTemplateStore };
