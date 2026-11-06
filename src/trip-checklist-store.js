'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const { changed, refused, unchanged, resultText } = require('./feature-result');
const { validateItems } = require('./trip-checklist-provider');
const { normalizeTemplateName } = require('./trip-checklist-commands');

const text = value => typeof value === 'string' && !!value.trim();
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const id = value => typeof value === 'string' && /^[a-z0-9_-]+$/iu.test(value);
function validateState(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.checklists)
    || state.checklists.filter(list => list?.status === 'active').length > 1
    || new Set(state.checklists.map(list => list?.id)).size !== state.checklists.length
    || state.checklists.some(list => !list || !id(list.id) || !text(list.scenario) || !date(list.createdAt)
      || !['active', 'archived'].includes(list.status)
      || (list.status === 'archived' && !date(list.archivedAt))
      || !Array.isArray(list.items) || list.items.length > 50
      || list.items.some(item => !item || !id(item.id) || !text(item.text) || typeof item.checked !== 'boolean')
      || new Set(list.items.map(item => item.id)).size !== list.items.length)) {
    throw new Error('出门清单存储格式无效');
  }
  // Older checklist-only states have no template collection until their next write.
  if (state.templates !== undefined && (!Array.isArray(state.templates) || state.templates.length > 20
    || new Set(state.templates.map(template => template?.id)).size !== state.templates.length
    || new Set(state.templates.map(template => template?.name)).size !== state.templates.length
    || state.templates.some(template => !template || !id(template.id) || !text(template.name)
      || !date(template.createdAt) || !Array.isArray(template.items) || template.items.length > 50
      || template.items.some(item => !text(item))))) {
    throw new Error('出门清单模板存储格式无效');
  }
}
// All numbered operations use exactly this display order, including checked items.
function orderedItems(list) {
  return [...list.items.filter(item => !item.checked), ...list.items.filter(item => item.checked)];
}
function display(list) {
  const title = `${list.status === 'archived' ? '归档清单' : '出门清单'}：${list.scenario}`;
  return `${title}\n${orderedItems(list).map((item, i) =>
    `${i + 1}. ${item.checked ? '[✓] 已打勾' : '[ ]'} ${item.text}`).join('\n') || '（暂无条目）'}`;
}

function remainingText(list) {
  const remaining = list.items.filter(item => !item.checked);
  return remaining.length ? `仍未带：\n${remaining.map(item => `- ${item.text}`).join('\n')}` : '已全部带齐。';
}

// Resolve every name against the same snapshot: an earlier match cannot remove
// ambiguity for a later name. Exact matches take precedence over containment.
function matchBatch(items, names) {
  const selected = new Set(), already = new Set(), ambiguous = [], missing = [];
  function matches(pool, name) {
    const exact = pool.filter(item => item.text === name);
    return exact.length ? exact : pool.filter(item => item.text.includes(name) || name.includes(item.text));
  }
  for (const name of new Set(names)) {
    // A repeated exact name must not fall through to a different, longer item
    // after its original item was checked (e.g. 充电器 vs 备用充电器).
    const exact = items.filter(item => item.text === name);
    const candidates = exact.length ? exact.filter(item => !item.checked)
      : matches(items.filter(item => !item.checked), name);
    if (candidates.length === 1) selected.add(candidates[0].id);
    else if (candidates.length > 1) ambiguous.push(`${name}（${candidates.map(item => item.text).join('、')}）`);
    else {
      const checked = matches(items.filter(item => item.checked), name);
      if (checked.length === 1) already.add(checked[0].text);
      else if (checked.length > 1) ambiguous.push(`${name}（${checked.map(item => item.text).join('、')}）`);
      else missing.push(name);
    }
  }
  return { selected, already, ambiguous, missing };
}

function createTripChecklistStore({ stateFile, provider, onOpen = async () => {}, now = () => Date.now() }) {
  let pending = Promise.resolve();
  function load() {
    const state = readRecordState(stateFile, { schemaVersion: 1, checklists: [] }, true,
      { strict: true, now, validate: validateState });
    state.templates ||= [];
    return state;
  }
  function save(state) {
    validateState(state);
    writeRecordState(stateFile, state, ['checklists', 'templates']);
  }
  async function apply(command) {
    if (!command || !['generate', 'list', 'archived', 'check', 'uncheck', 'add', 'delete', 'archive', 'check-batch', 'remaining',
      'template-save', 'template-list', 'template-create', 'template-delete'].includes(command.type)) {
      return refused('不支持这个出门清单操作。');
    }
    const state = load();
    const list = state.checklists.find(entry => entry.status === 'active');
    if (command.type === 'template-list') {
      return unchanged(state.templates.length ? `出门清单模板：\n${state.templates.map(template =>
        `- ${template.name}（${template.items.length} 项）`).join('\n')}` : '暂无出门清单模板。');
    }
    if (command.type.startsWith('template-')) {
      const name = normalizeTemplateName(command.name);
      if (!name) return refused('模板名字不能为空，请在冒号后写下模板名。');
      const template = state.templates.find(entry => entry.name === name);
      if (command.type === 'template-save') {
        if (!list) return refused('暂无进行中的出门清单，不能保存模板。');
        if (template) return refused('已有同名出门清单模板，不会覆盖；请换个名字或先删除原模板。');
        if (state.templates.length >= 20) return refused('出门清单模板最多 20 份，请先删除一些再保存。');
        state.templates.push({ id: crypto.randomUUID(), name, createdAt: new Date(now()).toISOString(),
          items: list.items.map(item => item.text) });
        save(state);
        return changed(`已保存出门清单模板：${name}（${list.items.length} 项）。`);
      }
      if (!template) return refused(`未找到出门清单模板：${name}。`);
      if (command.type === 'template-delete') {
        state.templates = state.templates.filter(entry => entry.id !== template.id);
        save(state);
        return changed(`已删除出门清单模板：${name}。`);
      }
      if (list) return refused('已有一份进行中的出门清单，请先“清单归档”或继续用现有清单（发送“出门清单”查看）。');
      const created = { id: crypto.randomUUID(), scenario: `模板「${name}」`, status: 'active',
        createdAt: new Date(now()).toISOString(),
        items: template.items.map(value => ({ id: crypto.randomUUID(), text: value, checked: false })) };
      state.checklists.push(created);
      save(state);
      return changed(`${display(created)}\n（来自模板：${name}。）`);
    }
    if (command.type === 'archived') {
      const latest = state.checklists.filter(entry => entry.status === 'archived').at(-1);
      return unchanged(latest ? display(latest) : '暂无归档清单。');
    }
    if (command.type === 'generate') {
      if (list) return refused('已有一份进行中的出门清单，请先“清单归档”或继续用现有清单（发送“出门清单”查看）。');
      if (!text(command.scenario)) return refused('请在“出门清单：”后写下出门场景。');
      let items;
      try { items = validateItems(await provider.generate({ scenario: command.scenario.trim() })); }
      catch { return refused('这次没有生成合格的出门清单，整次作废，未保存。请稍后重试。'); }
      const created = { id: crypto.randomUUID(), scenario: command.scenario.trim(), status: 'active',
        createdAt: new Date(now()).toISOString(),
        items: items.map(value => ({ id: crypto.randomUUID(), text: value, checked: false })) };
      state.checklists.push(created);
      save(state);
      return changed(`${display(created)}\n（模型生成的准备建议，请按实际行程核对。）`);
    }
    if (command.type === 'list') {
      if (list) await onOpen();
      return unchanged(list ? display(list) : '暂无进行中的出门清单。');
    }
    if (!list) return refused('暂无进行中的出门清单，请先发送“出门清单：出门场景”生成。');
    if (command.type === 'remaining') return unchanged(remainingText(list));
    if (command.type === 'check-batch') {
      if (!Array.isArray(command.names) || !command.names.length || command.names.some(name => !text(name))) {
        return refused('请写下已带的物品名。');
      }
      const { selected, already, ambiguous, missing } = matchBatch(list.items, command.names);
      const checked = list.items.filter(item => selected.has(item.id));
      for (const item of checked) item.checked = true;
      if (checked.length) save(state);
      const reply = [checked.length ? `已勾选：${checked.map(item => item.text).join('、')}` : '',
        already.size ? `此前已勾选：${[...already].join('、')}` : '',
        ambiguous.length ? `待确认（未自动勾选）：${ambiguous.join('；')}` : '',
        missing.length ? `未找到对应项：${missing.join('、')}` : '', remainingText(list)].filter(Boolean).join('\n');
      return checked.length ? changed(reply) : unchanged(reply);
    }
    if (command.type === 'archive') {
      list.status = 'archived';
      list.archivedAt = new Date(now()).toISOString();
      save(state);
      return changed('出门清单已归档，可发送“看归档清单”回看最近一份。');
    }
    if (command.type === 'add') {
      if (list.items.length >= 50) return refused('每份清单最多 50 项，请先删除一些再追加。');
      if (!text(command.text)) return refused('清单条目不能为空。');
      list.items.push({ id: crypto.randomUUID(), text: command.text.trim(), checked: false });
    } else {
      const items = orderedItems(list);
      if (!Number.isSafeInteger(command.number) || command.number < 1 || command.number > items.length) {
        return refused('清单序号越界，请发送“出门清单”查看当前编号。');
      }
      const item = items[command.number - 1];
      if (command.type === 'delete') list.items = list.items.filter(entry => entry.id !== item.id);
      else {
        const checked = command.type === 'check';
        if (item.checked === checked) return unchanged(`该项已${checked ? '打勾' : '取消打勾'}。\n${display(list)}`);
        item.checked = checked;
      }
    }
    save(state);
    return changed(`已${({ add: '追加', delete: '删除', check: '打勾', uncheck: '取消打勾' })[command.type]}。\n${display(list)}`);
  }
  function execute(side, command) {
    // Refuse every friend operation before any read or model call.
    if (side !== 'owner') return Promise.resolve(refused('这个私人助手只供已绑定的本人使用。'));
    // Generation awaits a model: serialize all commands so a second generation cannot overwrite it.
    const job = pending.then(() => apply(command));
    pending = job.catch(() => {});
    return job;
  }
  async function handle(side, command) { return resultText(await execute(side, command)); }
  function hasActive(side) {
    if (side !== 'owner') return false;
    // Admission must not quarantine or create storage while inspecting ordinary chat.
    try {
      return readRecordState(stateFile, { schemaVersion: 1, checklists: [] }, true,
        { strict: true, readOnly: true, validate: validateState }).checklists.some(list => list.status === 'active');
    } catch { return false; }
  }
  return { execute, handle, hasActive };
}

module.exports = { createTripChecklistStore };
