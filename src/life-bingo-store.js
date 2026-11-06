'use strict';

const { readRecordState, writeRecordState } = require('./record-state');
const { LIFE_BINGO_POOL } = require('./life-bingo-pool');

const LINES = Object.freeze([
  [1, 2, 3], [4, 5, 6], [7, 8, 9], [1, 4, 7], [2, 5, 8], [3, 6, 9], [1, 5, 9], [3, 5, 7],
].map(Object.freeze));
const completedLines = checked => LINES.filter(line => line.every(number => checked.includes(number)));
const dateKey = time => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(time));
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const unique = items => new Set(items).size === items.length;

function validateState(state) {
  const fail = () => { throw new Error('Bingo 存储格式无效'); };
  if (state?.schemaVersion !== 1 || !Array.isArray(state.boards) || !Array.isArray(state.achievedDates)
    || !unique(state.achievedDates) || !state.achievedDates.every(validDate)
    || !Number.isSafeInteger(state.cardCompleted) || state.cardCompleted < 0
    || !(state.card === null || typeof state.card === 'string' && state.card.length > 0)) fail();
  if (!unique(state.boards.map(board => board?.date))) fail();
  for (const board of state.boards) {
    if (!board || !validDate(board.date) || board.id !== board.date || board.createdAt !== `${board.date}T00:00:00+08:00`
      || !['active', 'settled'].includes(board.status) || !Array.isArray(board.tasks) || board.tasks.length !== 9
      || !unique(board.tasks) || !board.tasks.every(task => typeof task === 'string' && task.length > 0)
      || !Array.isArray(board.checked) || !unique(board.checked)
      || !board.checked.every(number => Number.isInteger(number) && number >= 1 && number <= 9)
      || (completedLines(board.checked).length > 0) !== state.achievedDates.includes(board.date)) fail();
  }
  if (state.boards.filter(board => board.status === 'active').length > 1
    || state.achievedDates.some(date => !state.boards.some(board => board.date === date))) fail();
}

function createLifeBingoStore({ stateFile, now = () => Date.now(), random = Math.random }) {
  const load = () => readRecordState(stateFile,
    { schemaVersion: 1, boards: [], achievedDates: [], card: null, cardCompleted: 0 }, true,
    { strict: true, now, validate: validateState });
  function save(state) { validateState(state); writeRecordState(stateFile, state, ['boards']); }
  function pick(items) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Bingo 随机源无效');
    return items[Math.floor(value * items.length)];
  }
  const monthCount = (state, today) => state.achievedDates.filter(date => date.startsWith(today.slice(0, 7))).length;
  function render(board) {
    const lines = completedLines(board.checked);
    return [`今日 Bingo（${board.date}，Asia/Shanghai）`,
      ...[0, 3, 6].map(start => board.tasks.slice(start, start + 3).map((task, offset) => {
        const number = start + offset + 1;
        return `${board.checked.includes(number) ? '✅' : '⬜'}${number} ${task}`;
      }).join(' ｜ ')),
      `已连线：${lines.length ? lines.map(line => line.join('–')).join('、') : '暂无'}`,
      '完成后说「Bingo 第 N 格完成」。'].join('\n');
  }
  function handle(side, command) {
    if (side !== 'owner') return '今日生活 Bingo 仅主人可用。';
    if (!command || !['board', 'check', 'stats', 'draw', 'replace', 'finish', 'abandon'].includes(command.type)) {
      throw new Error('不支持的 Bingo 命令');
    }
    if (command.type === 'check' && (!Number.isInteger(command.number) || command.number < 1 || command.number > 9)) {
      return '请用「Bingo 第 N 格完成」，N 为 1–9。';
    }
    const state = load();
    const today = dateKey(now());
    const settlements = [];
    for (const board of state.boards) {
      if (board.status === 'active' && board.date < today) {
        board.status = 'settled';
        settlements.push(`${board.date} 结算：${completedLines(board.checked).length ? '已达标' : '未达标'}。`);
      }
    }
    // Generate only when first viewing/checking today's board; card operations are independent.
    let board = state.boards.find(item => item.date === today);
    if (['board', 'check'].includes(command.type) && !board) {
      if (state.boards.some(item => item.date > today)) throw new Error('Bingo 时钟早于已有盘面，请核对时间');
      const available = [...LIFE_BINGO_POOL], tasks = [];
      while (tasks.length < 9) { const task = pick(available); tasks.push(task); available.splice(available.indexOf(task), 1); }
      board = { id: today, date: today, createdAt: `${today}T00:00:00+08:00`, status: 'active', tasks, checked: [] };
      state.boards.push(board);
    }
    let reply;
    switch (command.type) {
      case 'board': reply = render(board); break;
      case 'check': {
        const duplicate = board.checked.includes(command.number);
        if (!duplicate) board.checked.push(command.number);
        const achieved = completedLines(board.checked).length > 0;
        if (achieved && !state.achievedDates.includes(today)) state.achievedDates.push(today);
        reply = `${duplicate ? '这一格已打卡。' : `第 ${command.number} 格已完成。`}${achieved ? `恭喜，今日达标！本月达标 ${monthCount(state, today)} 天。` : ''}\n${render(board)}`;
        break;
      }
      case 'stats': reply = `Bingo 战绩（${today.slice(0, 7)}）：本月达标 ${monthCount(state, today)} 天；任务卡完成总数 ${state.cardCompleted} 张。`; break;
      case 'draw':
      case 'replace':
        if (command.type === 'draw' && state.card) { reply = `已有进行中的任务卡：${state.card}。`; break; }
        if (command.type === 'replace' && !state.card) { reply = '没有进行中的任务卡，可以说「抽一张任务卡」。'; break; }
        state.card = pick(LIFE_BINGO_POOL.filter(task => task !== state.card));
        reply = `任务卡：${state.card}\n可说「任务卡完成了」「换一张任务卡」或「任务卡算了」。`;
        break;
      case 'finish':
        reply = state.card ? `任务卡完成，做得好！累计完成 ${++state.cardCompleted} 张。` : '没有进行中的任务卡。';
        state.card = null;
        break;
      case 'abandon': reply = state.card ? '已放弃这张任务卡，不计完成数。' : '没有进行中的任务卡。'; state.card = null; break;
    }
    save(state);
    return [...settlements, reply].join('\n');
  }
  return { handle };
}

module.exports = { createLifeBingoStore, completedLines };
