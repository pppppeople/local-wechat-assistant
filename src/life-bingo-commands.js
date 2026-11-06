'use strict';

function parseLifeBingoCommand(text, side = 'owner') {
  if (side !== 'owner') return null;
  const value = String(text || '').trim().normalize('NFKC');
  const commands = { '今日 Bingo': 'board', '今日Bingo': 'board', 'Bingo 战绩': 'stats', 'Bingo战绩': 'stats',
    '抽一张任务卡': 'draw', '换一张任务卡': 'replace', '任务卡完成了': 'finish', '任务卡算了': 'abandon' };
  if (Object.hasOwn(commands, value)) return { type: commands[value] };
  const match = value.match(/^Bingo\s*第\s*([1-9])\s*格完成$/iu);
  return match ? { type: 'check', number: Number(match[1]) } : null;
}

module.exports = { parseLifeBingoCommand };
