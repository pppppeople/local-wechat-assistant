'use strict';

function parsePairPlaceVoteCommand(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  const commands = { 发起地点投票: 'start', 地点投票: 'status', 地点投票状态: 'status',
    查看地点投票: 'status', 揭晓地点投票: 'reveal', 地点投票帮助: 'help' };
  if (Object.hasOwn(commands, value)) return { type: commands[value] };
  const vote = value.match(/^地点投票(?:[：:]\s*|\s+)([^\r\n]+)$/u);
  if (vote) return { type: 'vote', choice: vote[1].trim() };
  // Malformed commands stay on the bounded feature route, never ordinary planning.
  return /^(?:发起地点投票|地点投票|查看地点投票|揭晓地点投票)/u.test(value) ? { type: 'help' } : null;
}

module.exports = { parsePairPlaceVoteCommand };
