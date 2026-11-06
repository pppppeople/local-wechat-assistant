'use strict';

const { changed, refused, unchanged } = require('./feature-result');
const { validateStory } = require('./story-chain-provider');
const MAX_ROUNDS = 8;
const VIEW_LIMIT = 1700;
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
function renderStory(session, truncate = false) {
  const header = `故事设定：${session.setting}\n共 ${session.paragraphs.length} 段`;
  const body = session.paragraphs.join('\n\n');
  if (truncate && header.length + body.length + 2 > VIEW_LIMIT && session.paragraphs.length > 3) {
    return `${header}（全文过长，以下为最近 3 段）\n\n${session.paragraphs.slice(-3).join('\n\n')}`;
  }
  return `${header}\n\n${body || '尚未生成开场。'}`;
}
function createStoryChainStore({ provider }) {
  // One volatile owner session. No ordinary-chat context, files or memory writes.
  let session = null;
  let pending = Promise.resolve();
  let epoch = 0;
  let queuedStarts = 0;
  const claimsAnswer = side => side === 'owner' && (session !== null || queuedStarts > 0);
  async function apply(command) {
    if (command.type === 'start') {
      if (session) return refused('已有进行中的故事，请先发送“结束故事”，不会覆盖当前故事。');
      session = { setting: command.setting.trim(), characters: '', events: '', paragraphs: [], rounds: 0 };
    }
    if (!session) return unchanged('当前没有进行中的故事，请发送“开始故事：<一句话设定>”。');
    if (command.type === 'view') return unchanged(renderStory(session, true));
    if (session.rounds >= MAX_ROUNDS) return refused('已达到 8 轮续写上限，请发送“结束故事”收尾，或“看看故事”。');
    if (command.type === 'continue' && !nonempty(command.direction)) return refused('请发一条文字走向，或发送“结束故事”。');
    const current = session;
    const opening = current.paragraphs.length === 0;
    try {
      const output = validateStory(await provider.generate({ setting: current.setting,
        characters: current.characters, events: current.events, recentParagraphs: current.paragraphs.slice(-3),
        direction: opening ? '' : command.direction, round: opening ? 0 : current.rounds + 1 }));
      if (session !== current) return null;
      current.paragraphs.push(output.sentences.join(''));
      current.characters = output.characters;
      current.events = output.events;
      if (!opening) current.rounds++;
      return changed(`${current.paragraphs.at(-1)}\n\n${current.rounds === MAX_ROUNDS
        ? '已达到 8 轮续写上限，请发送“结束故事”收尾并取回完整故事。'
        : '可以告诉我下一段的走向，或发送“看看故事”／“结束故事”。'}`);
    } catch {
      if (session !== current) return null;
      return refused(`这次故事${opening ? '开场' : '续写'}模型生成失败，设定和已有故事已保留；请${opening ? '发一条文字重试开场' : '重发走向重试'}，或发送“结束故事”。`);
    }
  }
  function execute(side, command) {
    if (side !== 'owner') return Promise.resolve(refused('这个私人助手只供已绑定的本人使用。'));
    if (!command || !['start', 'continue', 'view', 'end'].includes(command.type)) return Promise.resolve(refused('不支持这个故事操作。'));
    if (command.type === 'end') {
      const reply = session ? `${renderStory(session)}\n\n故事已结束，临时状态已清除。` : '当前没有进行中的故事。';
      session = null; epoch++; queuedStarts = 0;
      return Promise.resolve(changed(reply));
    }
    const starting = command.type === 'start';
    if (starting && claimsAnswer(side)) return Promise.resolve(refused('已有进行中的故事，请先发送“结束故事”，不会覆盖当前故事。'));
    if (starting && !nonempty(command.setting)) return Promise.resolve(refused('请发送“开始故事：<一句话设定>”，例如主角、世界观或开局。'));
    if (starting) queuedStarts++;
    const admitted = epoch;
    const result = pending.then(() => admitted === epoch ? apply(command) : null)
      .finally(() => { if (starting && admitted === epoch) queuedStarts--; });
    pending = result.catch(() => {});
    return result;
  }
  return { execute, claimsAnswer };
}
module.exports = { createStoryChainStore };
