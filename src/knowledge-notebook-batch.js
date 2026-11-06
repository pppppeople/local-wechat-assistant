'use strict';

const { changed, refused, unchanged } = require('./feature-result');
const HELP = '用“批量记知识：”单独起首行，随后每行“标题｜内容｜标签”（标签可省略），每批最多 15 条。';

// One bound owner's in-memory session only; confirmed rows use the existing add API.
function createKnowledgeNotebookBatch({ readEntries, add, validTags }) {
  let pending = null;
  return function execute(command) {
    if (command.type === 'batch-cancel') {
      if (!pending) return refused('无待确认批次，未写入知识。');
      pending = null;
      return unchanged('已取消批量记知识，未写入知识。');
    }
    if (command.type === 'batch-confirm') {
      if (!pending) return refused('无待确认批次，未写入知识。');
      const entries = pending;
      pending = null;
      const replies = [];
      let wrote = false;
      for (const entry of entries) {
        try {
          const result = add({ type: 'add', title: entry.title, content: entry.content, tags: entry.tags });
          wrote ||= result.wrote;
          replies.push(`${entry.number}. ${entry.title}：${result.reply}`);
        } catch {
          replies.push(`${entry.number}. ${entry.title}：写入未完成，请检查并恢复存储后核对该条。`);
        }
      }
      const reply = ['批量记知识处理完成，待确认批次已清除；预览标明的无效或重复条目未写入。', ...replies].join('\n');
      return wrote ? changed(reply) : unchanged(reply);
    }
    if (pending) return refused('已有待确认批次，请先发送“确认批量记知识”或“取消批量记知识”，本批未生成预览、未写入。');
    if (command.type === 'batch-too-large' || command.entries?.length > 15) return refused('每次最多 15 条，本批整批拒绝，未生成预览、未写入。');
    if (command.type !== 'batch-preview' || !command.entries?.length) return refused(HELP);
    const existing = new Set(readEntries().map(row => row.title));
    const seen = new Set();
    const accepted = [];
    const rows = command.entries.map((entry, index) => {
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      const content = typeof entry.content === 'string' ? entry.content.trim() : '';
      const tags = entry.tags === undefined ? [] : entry.tags;
      const reasons = [entry.reason, !title && '标题为空', !content && '内容为空', !validTags(tags) && '标签无效',
        existing.has(title) && '标题重复（知识本已有）', seen.has(title) && '标题重复（本批已有）'].filter(Boolean);
      if (!reasons.length) {
        seen.add(title);
        accepted.push({ number: index + 1, title, content, tags: [...tags] });
      }
      return `${index + 1}. 标题：${title || '（空）'}\n内容：${content || '（空）'}\n标签：${validTags(tags) ? tags.join('、') || '无' : '（无效）'}\n${reasons.length ? `跳过：${reasons.join('；')}` : '待确认'}`;
    });
    // Even an all-skipped preview is a batch: explicit confirm/cancel clears it.
    pending = accepted;
    return unchanged(['批量记知识预览（零写入）：', ...rows,
      `待确认 ${accepted.length} 条。发送“确认批量记知识”写入，或“取消批量记知识”。`].join('\n\n'));
  };
}

module.exports = { createKnowledgeNotebookBatch };
