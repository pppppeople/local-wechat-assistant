'use strict';

const { refused, unchanged } = require('./feature-result');
const { parseKnowledgeLinkCommand, HELP } = require('./knowledge-link-commands');

function createKnowledgeLink({ notebook, provider, random = Math.random }) {
  return { async execute(side, command) {
    if (side !== 'owner') return refused('这个私人助手只供已绑定的本人使用。');
    if (command?.type !== 'link' || Object.keys(command).some(key => !['type', 'tag'].includes(key))
      || command.tag !== undefined && (typeof command.tag !== 'string'
        || parseKnowledgeLinkCommand(`串联知识：${command.tag}`).type !== 'link')) return refused(HELP);
    let pool;
    const tag = command.tag?.trim();
    const scope = tag ? `抽取范围：标签「${tag}」（精确匹配，不区分大小写）` : '抽取范围：全部知识条目';
    try {
      pool = notebook.readEntries('owner');
      if (tag) pool = pool.filter(row => row.tags.some(value => value.toLocaleLowerCase() === tag.toLocaleLowerCase()));
    } catch {
      return refused('知识串联失败：无法读取知识本，未生成串联，未修改任何条目。');
    }
    if (!pool.length) return unchanged(`${scope}\n${tag ? '该标签下无知识条目，请先添加该标签的知识条目。' : '知识本为空，请先添加知识条目。'}`);
    const display = rows => rows.map((row, i) => `卡片 ${i + 1}：${row.title}\n原文要点（完整原文）：\n${row.content}`).join('\n\n');
    if (pool.length === 1) return unchanged(`${scope}\n仅有 1 条，无法串联。\n\n${display(pool)}`);
    // Sample without replacement from the full read-only pool, never list/search display caps.
    const first = Math.floor(random() * pool.length);
    const second = (first + 1 + Math.floor(random() * (pool.length - 1))) % pool.length;
    const cards = [pool[first], pool[second]].map(({ title, content }) => ({ title, content }));
    const originals = `${scope}\n\n${display(cards)}`;
    try { return unchanged(`${originals}\n\n${await provider.generate(cards)}`); }
    catch { return refused(`${originals}\n\n知识串联失败：模型调用失败或返回格式异常，未生成串联结论；以上仅展示抽中卡片原文。`); }
  } };
}

module.exports = { createKnowledgeLink };
