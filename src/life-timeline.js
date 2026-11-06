'use strict';

const { readRecordState } = require('./record-state');
const { completedLines } = require('./life-bingo-store');
const LABELS = { todos: '待办', places: '想去箱', purchases: '购物冷静期', focus: '专注', reviews: '决定复盘', bingo: 'Bingo' };
const day = value => {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
  }
  // Producers persist ISO timestamps with an explicit zone. Never infer local time.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10);
};
const clean = value => String(value || '').replace(/[\r\n\t]+/gu, ' ').trim();
function records(file, collection) {
  if (!file) throw new Error('source unavailable');
  const state = readRecordState(file, null, false, { strict: true, readOnly: true });
  if (state?.schemaVersion !== 1 || !Array.isArray(state[collection])) throw new Error('source unavailable');
  return state[collection];
}
const event = (item, time, text) => ({ id: item.id, time, text });
function readTodos(file) {
  return records(file, 'todos').filter(item => item.status === 'done')
    .map(item => event(item, day(item.completedAt) ? item.completedAt : item.dueDate, `完成：${clean(item.text)}`));
}
function readPlaces() {
  // shared-place-box persists only generic updatedAt, also changed by edits/removal.
  // There is no visitedAt or status-transition history. Skip this source entirely;
  // do not read pair content or misrepresent an update date as a visited date.
  return { events: [], note: '无标记已去时间字段，已跳过' };
}
function readPurchases(file) {
  return records(file, 'items').filter(item => ['bought', 'abandoned'].includes(item.status))
    .map(item => event(item, item.decidedAt,
      `${item.status === 'bought' ? '买了' : '放弃'}：${clean(item.item)}（${Number.isSafeInteger(item.amountCents) ? (item.amountCents / 100).toFixed(2) : '金额未知'} 元）`));
}
function readFocus(file) {
  // Only the latest session survives a new start. Cancellation has no actual
  // endedAt; never use its scheduled endsAt as the time it was cancelled.
  return records(file, 'sessions').filter(item => ['finished', 'cancelled'].includes(item.status))
    .map(item => event(item, item.status === 'finished' ? item.endsAt : null,
      `专注结束：${clean(item.goal) || '未设目标'}（${Number.isFinite(Date.parse(item.startedAt)) && Date.parse(item.endsAt) > Date.parse(item.startedAt)
        ? `${Math.round((Date.parse(item.endsAt) - Date.parse(item.startedAt)) / 60000)} 分钟` : '时长未知'}）`));
}
function readReviews(file, now) {
  return records(file, 'cards').flatMap(card => {
    // One card appears once: use its latest recorded review, otherwise its due date.
    // This is a current-state recap, not a reconstructed history of rescheduling.
    const dates = (card.reviews || []).map(review => review.date)
      .filter(date => day(date) && Date.parse(date) <= now).sort((a, b) => Date.parse(b) - Date.parse(a));
    if (!dates.length && day(card.dueAt) && Date.parse(card.dueAt) > now) return [];
    return [event(card, dates[0] || card.dueAt, `${dates.length ? '已复盘' : '到期待复盘'}：${clean(card.decision)}`)];
  });
}
function readBingo(file) {
  return records(file, 'boards').map(board => event(board, board.date,
    `打卡 ${Array.isArray(board.checked) ? board.checked.length : 0}/9 格；${completedLines(board.checked || []).length ? '已达标' : '未达标'}`));
}
function parseLifeTimelineCommand(text, { senderId, ownerId, now = Date.now() } = {}) {
  if (!ownerId || senderId !== ownerId) return null;
  const value = String(text || '').trim();
  const match = value.match(/^(?:(?:给我)?生成([0-9]{1,2}|[一二三四五六七八九十]{1,3})月生活时间轴|看看我([0-9]{1,2}|[一二三四五六七八九十]{1,3})月都做了什么)[。！？!?]?$/u);
  if (value !== '生活时间轴' && !match) return null;
  const current = day(new Date(now).toISOString());
  const token = match && (match[1] || match[2]);
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  const month = token ? (/^\d+$/u.test(token) ? Number(token) : chinese.indexOf(token) + 1) : Number(current.slice(5, 7));
  if (month < 1 || month > 12) return null;
  return { month: `${current.slice(0, 4)}-${String(month).padStart(2, '0')}` };
}
async function lifeTimelineText({ senderId, ownerId, month, files = {}, now = Date.now(), readers = {}, maxLength = 1700 }) {
  if (!ownerId || senderId !== ownerId) return null; // Refuse before any source read.
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) throw new Error('无效月份');
  const adapters = { todos: readTodos, places: readPlaces, purchases: readPurchases, focus: readFocus, reviews: readReviews, bingo: readBingo };
  const counts = {}, notes = [], entries = [];
  let undated = 0;
  for (const [source, adapter] of Object.entries(adapters)) {
    counts[source] = 0;
    try {
      const result = await (readers[source] || adapter)(files[source], now);
      const seen = new Set();
      for (const item of (Array.isArray(result) ? result : result.events)) {
        if (typeof item.id !== 'string' || !item.id) throw new Error('missing record identity');
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const date = day(item.time);
        if (!date) { undated++; continue; }
        if (!date.startsWith(`${month}-`)) continue;
        counts[source]++;
        entries.push({ date, source, id: item.id, text: clean(item.text) });
      }
      if (result.note) notes.push(`${LABELS[source]}：${result.note}`);
    } catch {
      // Discard partial projection of a malformed source, keeping all others.
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].source === source) entries.splice(i, 1);
      counts[source] = 0;
      notes.push(`${LABELS[source]}：暂时读取失败或不可用`);
    }
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  const footer = [`月末小结（各源条数，含截断未展示）：${Object.keys(LABELS).map(key => `${LABELS[key]} ${counts[key]}`).join('；')}`,
    ...(undated ? [`另有 ${undated} 条无时间记录未列入（无法判断所属月份）`] : []), ...notes].join('\n');
  let text = `${month} 生活时间轴（Asia/Shanghai）`;
  if (!entries.length) text += '\n这个月还没有可回顾的记录';
  const dates = [...new Set(entries.map(item => item.date))];
  for (const date of dates) {
    const group = `\n\n${date}\n${entries.filter(item => item.date === date).map(item => `[${LABELS[item.source]}] ${item.text}`).join('\n')}`;
    const truncated = '\n后续日期记录过长，已按日期截断。';
    if (text.length + group.length + footer.length + truncated.length + 2 > maxLength) {
      text += truncated;
      break;
    }
    text += group;
  }
  return `${text}\n\n${footer}`;
}
module.exports = { parseLifeTimelineCommand, lifeTimelineText, readTodos, readPlaces, readPurchases, readFocus, readReviews, readBingo };
