'use strict';

const crypto = require('crypto');
const { changed, refused, resultText: featureReply } = require('./feature-result');
const { readRecordState, writeRecordState } = require('./record-state');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function validSide(side) {
  if (!['owner', 'friend'].includes(side)) throw new Error('invalid decision side');
  return side;
}

function otherSide(side) { return validSide(side) === 'owner' ? 'friend' : 'owner'; }
function createId() { return `PD-${Date.now().toString(36).slice(-5)}${crypto.randomBytes(2).toString('hex')}`.toUpperCase(); }

function parseNumbers(value) {
  return [...String(value || '').matchAll(/[1-8]/gu)].map((match) => Number(match[0]));
}

function optionNumbersInText(text, options) {
  const value = String(text || '').normalize('NFKC').toLocaleLowerCase('zh-CN');
  return options.flatMap((option, index) => {
    const label = String(option || '').normalize('NFKC').toLocaleLowerCase('zh-CN').trim();
    return label && value.includes(label) ? [index + 1] : [];
  });
}

function normalizePreference(text, optionCount, optionLabels = []) {
  const value = String(text || '').trim().slice(0, 300);
  const labels = Array.from({ length: optionCount }, (_, index) => optionLabels[index] || '');
  const all = Array.from({ length: optionCount }, (_, index) => index + 1);
  const rejectMatch = value.match(/(?:不要|不想|拒绝)([^。；;]+)/u);
  const rejected = new Set([
    ...parseNumbers(rejectMatch?.[1]),
    ...optionNumbersInText(rejectMatch?.[1], labels),
  ].filter((number) => number <= optionCount));
  const rankingMatch = value.match(/([1-8](?:\s*[>＞]\s*[1-8])+)/u);
  const ranking = rankingMatch ? parseNumbers(rankingMatch[1]).filter((number) => number <= optionCount) : [];
  const preferredMatch = value.match(/(?:首选|最想|第一选择|我选|选)\s*([1-8])/u);
  if (preferredMatch && !ranking.includes(Number(preferredMatch[1]))) ranking.unshift(Number(preferredMatch[1]));
  const preferredWords = value.match(/(?:首选|最想(?:吃|去|看|玩)?|我选|我想(?:吃|去|看|玩)?)([^。；;，,]+)/u);
  for (const number of optionNumbersInText(preferredWords?.[1], labels)) {
    if (!ranking.includes(number)) ranking.push(number);
  }
  const acceptedMatch = value.match(/(?:也?可以|接受)([^。；;]+)/u);
  const accepted = new Set([
    ...parseNumbers(acceptedMatch?.[1]),
    ...optionNumbersInText(acceptedMatch?.[1], labels),
  ].filter((number) => number <= optionCount));
  for (const trailing of value.matchAll(/([1-8](?:\s*[、,，和及]\s*[1-8])*)\s*也?(?:可以|接受)/gu)) {
    for (const number of parseNumbers(trailing[1])) if (number <= optionCount) accepted.add(number);
  }
  for (const [index, label] of labels.entries()) {
    if (!label) continue;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`${escaped}(?:也)?(?:可以|行|能接受)`, 'u').test(value)) accepted.add(index + 1);
  }
  for (const number of ranking) accepted.add(number);
  if (/(?:都行|都可以|全都可以|没有忌口)/u.test(value)) for (const number of all) accepted.add(number);
  for (const number of rejected) accepted.delete(number);
  if (!accepted.size && !rejected.size) throw new Error('请说出选项名称或编号，例如“首选日料，火锅也可以”或“首选2，1也可以”');
  if (!accepted.size && rejected.size) for (const number of all) if (!rejected.has(number)) accepted.add(number);
  return { accepted: [...accepted], rejected: [...rejected], ranking: [...new Set(ranking)], submittedAt: new Date().toISOString() };
}

function normalizeConstraints(text) {
  const value = String(text || '').trim().slice(0, 500);
  if (!value) throw new Error('请说说你的预算、时间、距离偏好或明确不想要的内容');
  const chineseNumber = (raw) => {
    if (/^\d+(?:\.\d+)?万$/u.test(raw)) return Number(raw.slice(0, -1)) * 10000;
    if (/^\d+$/u.test(raw)) return Number(raw);
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0; let current = 0;
    for (const character of raw) {
      if (character in digits) current = digits[character];
      else if (character === '十') { total += (current || 1) * 10; current = 0; }
      else if (character === '百') { total += (current || 1) * 100; current = 0; }
      else if (character === '千') { total += (current || 1) * 1000; current = 0; }
      else if (character === '万') { total = (total + current || 1) * 10000; current = 0; }
    }
    return total + current;
  };
  // Match the whole amount token first, so unsupported forms cannot become a
  // smaller trailing budget (for example 一万五千元 used to become 五千元).
  const amounts = value.matchAll(/(?<![零〇一二两三四五六七八九十百千万亿\d.负+\-])(?:预算|人均|每人)?\s*([零〇一二两三四五六七八九十百千万亿\d.负+\-]+)\s*(元|块)?/gu);
  const budget = [...amounts].find((amount) => {
    const raw = amount[1];
    const legacy = amount[2] && /^[零〇一二两三四五六七八九十百千\d]{1,8}$/u.test(raw);
    const wan = /^\d+(?:\.\d+)?万$/u.test(raw)
      || /^[一二两三四五六七八九十百千]+万(?:[零〇一二两三四五六七八九十百千]+)?$/u.test(raw);
    return legacy || wan;
  });
  const environmentSpecified = /室内|室外|户外/u.test(value);
  const environment = /室内/u.test(value) && !/室外/u.test(value) ? 'indoor'
    : (/室外|户外/u.test(value) && !/室内/u.test(value) ? 'outdoor' : (environmentSpecified ? 'either' : 'unspecified'));
  const distance = /不想(?:太)?远|近一点|附近/u.test(value) ? 'near'
    : (/远一点也行|远点|距离无所谓/u.test(value) ? 'flexible' : 'unspecified');
  const energy = /累|轻松|低精力|不想走/u.test(value) ? 'low'
    : (/体力.{0,4}(?:都行|随便|无所谓)|强度.{0,4}(?:都行|随便|无所谓)/u.test(value) ? 'flexible' : 'unspecified');
  const capture = (pattern) => {
    const result = [];
    for (const match of value.matchAll(pattern)) {
      const item = String(match[1] || '').replace(/^(?:吃|去|看|玩)/u, '').trim().slice(0, 30);
      if (item && !result.includes(item)) result.push(item);
    }
    return result.slice(0, 3);
  };
  const likes = capture(/(?:喜欢|想要|想吃|想去|想看|想玩|偏向)\s*([^，,。；;]{1,30})/gu);
  const dislikes = capture(/(?:不要|不想|拒绝|避开)\s*([^，,。；;]{1,30})/gu);
  if (!budget && environment === 'unspecified' && distance === 'unspecified' && energy === 'unspecified' && !likes.length && !dislikes.length && !/(?:都行|随便|无所谓|都可以)/u.test(value)) {
    throw new Error('我还没提取到可比较的条件，可以说“预算人均150，想近一点，室内外都行，不想吃辣”');
  }
  return { budgetMax: budget ? chineseNumber(budget[1]) : null, environment, distance, energy, likes, dislikes, submittedAt: new Date().toISOString() };
}

function openDecisionOutcome(session) {
  const owner = session.constraints.owner;
  const friend = session.constraints.friend;
  const budgetMax = Number.isFinite(owner.budgetMax) && Number.isFinite(friend.budgetMax)
    ? Math.min(owner.budgetMax, friend.budgetMax) : null;
  const sharedEnvironment = [owner.environment, friend.environment].includes('indoor') && [owner.environment, friend.environment].includes('outdoor') ? 'conflict'
    : owner.environment === friend.environment ? owner.environment
    : ([owner.environment, friend.environment].includes('either')
        && ![owner.environment, friend.environment].includes('unspecified')
      ? [owner.environment, friend.environment].find((item) => item !== 'either') || 'either'
      : 'unspecified');
  const sharedRejects = owner.dislikes.filter((item) => friend.dislikes.some((peerItem) => item.includes(peerItem) || peerItem.includes(item)));
  const privateRejects = [...new Set([...owner.dislikes, ...friend.dislikes])];
  const likes = owner.likes.filter((item) => friend.likes.some((peerItem) => item.includes(peerItem) || peerItem.includes(item)))
    .filter((item) => !privateRejects.some((reject) => item.includes(reject) || reject.includes(item)));
  const near = (owner.distance === 'near' && ['near', 'flexible'].includes(friend.distance))
    || (friend.distance === 'near' && ['near', 'flexible'].includes(owner.distance));
  const lowEnergy = (owner.energy === 'low' && ['low', 'flexible'].includes(friend.energy))
    || (friend.energy === 'low' && ['low', 'flexible'].includes(owner.energy));
  if (sharedEnvironment === 'conflict') {
    return { compatible: false, reply: `双人私密决策 #${session.id} 目前在室内／室外偏好上没有交集。双方原话仍然保密；请各自再说一次愿意放宽的条件。` };
  }
  const condition = [budgetMax ? `预算按人均不超过 ${budgetMax} 元` : '双方未共同设定预算上限', sharedEnvironment === 'indoor' ? '室内优先' : (sharedEnvironment === 'outdoor' ? '室外优先' : (sharedEnvironment === 'either' ? '室内外均可' : '双方未共同指定室内外')), near ? '距离近优先' : '双方未共同指定距离', lowEnergy ? '低体力安排' : '双方未共同指定活动强度', sharedRejects.length ? `双方都明确避开：${sharedRejects.join('、')}` : '没有双方都明确提出的排除项'].join('；');
  const topic = session.title;
  const options = likes.length
    ? likes.slice(0, 3).map((item, index) => `${index + 1}. 围绕“${item}”安排，按共同预算和距离筛选具体地点`)
    : [
        `1. 保守方案：就近选择一个符合共同条件的主要活动`,
        `2. 平衡方案：一个主要活动加一顿饭，中间保留休息时间`,
        `3. 灵活方案：先确定集合区域，到时从附近两个备选里决定`,
      ];
  return { compatible: true, reply: [`双人私密决策 #${session.id} 已整理：${topic}`, `共同条件：${condition}`, '可以共同接受的方案：', ...options, '这里只使用双方条件的交集，不公开任何一方原话或完整偏好。'].join('\n') };
}

function openDecisionResult(session) { return openDecisionOutcome(session).reply; }

function createPairDecisionStore({ stateFile, now = () => Date.now(), onNotice = () => {},
  sideNames = { owner: 'Owner', friend: '好友' } }) {
  function load() {
    const state = readRecordState(stateFile, { schemaVersion: 2, sessions: [] });
    state.schemaVersion = 2;
    state.sessions = Array.isArray(state.sessions) ? state.sessions : [];
    for (const session of state.sessions) {
      if (session.status === 'collecting' && new Date(session.expiresAt || 0).getTime() <= now()) session.status = 'expired';
    }
    return state;
  }
  function save(state) { writeRecordState(stateFile, state, ['sessions']); }
  function visibleSessions(state) { return state.sessions.filter((session) => !['cancelled', 'expired'].includes(session.status)); }
  function optionsText(session) { return session.options.map((option, index) => `${index + 1}. ${option}`).join('\n'); }
  function preferenceExample(session) {
    if (session.options.length === 2) return `首选${session.options[0]}，${session.options[1]}也可以`;
    return `首选${session.options[1]}，${session.options[0]}也可以，不要${session.options[2]}`;
  }

  function create(side, input) {
    validSide(side);
    const title = String(input.title || '').trim().slice(0, 120);
    const options = [...new Set((input.options || []).map((item) => String(item || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 8);
    const mode = input.mode === 'constraints' || options.length === 0 ? 'constraints' : 'options';
    if (!title || (mode === 'options' && options.length < 2)) throw new Error('双人决策需要一个问题和至少两个候选');
    const state = load();
    if (visibleSessions(state).filter((session) => session.status === 'collecting').length >= 5) throw new Error('同时进行的双人决策最多五个');
    const timestamp = new Date(now()).toISOString();
    const session = {
      id: createId(), title, options, mode, createdBy: side, status: 'collecting', preferences: {}, constraints: {},
      createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(now() + SESSION_TTL_MS).toISOString(),
      provenance: { sourceType: 'explicit_pair_decision', ownerSide: side, visibility: 'fixed_pair_result_only', createdAt: timestamp },
    };
    state.sessions.push(session);
    save(state);
    if (mode === 'constraints') {
      const prompt = '请私下告诉我你的条件，例如预算、想室内还是室外、能接受的距离，以及明确不想要什么。最多说三四点就够。';
      onNotice(otherSide(side), `${sideNames[side] || '对方'}发起了双人私密决策 #${session.id}：${title}\n${prompt}\n我只会保存标准化条件，最后只公布双方交集。`, `pair-decision-created|${session.id}`);
      return `双人私密决策 #${session.id} 已发起：${title}\n${prompt}\n我只会保存标准化条件，最后只公布双方交集。`;
    }
    const example = preferenceExample(session);
    onNotice(otherSide(side), `${sideNames[side] || '对方'}发起了一个双人私密决策 #${session.id}：${title}\n${optionsText(session)}\n可以直接回复“${example}”，也可以带上编号“决策 ${session.id}：${example}”。双方都提交后，我只公布交集和结果，不公开任何一方原话。`, `pair-decision-created|${session.id}`);
    return `双人私密决策 #${session.id} 已发起：${title}\n${optionsText(session)}\n可以直接回复“${example}”，也可以带上编号“决策 ${session.id}：${example}”。我只会向双方公布交集和结果。`;
  }

  function findSession(state, side, id = '') {
    const normalized = String(id || '').toUpperCase();
    if (normalized) return state.sessions.find((session) => session.id === normalized && session.status === 'collecting');
    return state.sessions.filter((session) => session.status === 'collecting'
      && !(session.mode === 'constraints' ? session.constraints?.[side] : session.preferences?.[side]))
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
  }

  function optionDecisionOutcome(session) {
    const owner = session.preferences.owner;
    const friend = session.preferences.friend;
    const common = owner.accepted.filter((number) => friend.accepted.includes(number)
      && !owner.rejected.includes(number) && !friend.rejected.includes(number));
    const score = (preference, number) => {
      const rank = preference.ranking.indexOf(number);
      return rank >= 0 ? rank : 20 + preference.accepted.indexOf(number);
    };
    common.sort((left, right) => score(owner, left) + score(friend, left) - score(owner, right) - score(friend, right));
    if (!common.length) return { compatible: false, reply: `双人私密决策 #${session.id} 暂时没有共同接受的选项。双方原话仍然保密；可以各自重新提交一次，放宽一个可接受选项。` };
    return { compatible: true, reply: [`双人私密决策 #${session.id} 已有结果：${session.title}`,
      `最大交集：${common.map((number) => `${number}. ${session.options[number - 1]}`).join('；')}`,
      `推荐先选：${common[0]}. ${session.options[common[0] - 1]}`,
      '这里只公布共同可接受的结果，不公开任何一方原话或完整偏好。'].join('\n') };
  }

  function submitResult(side, input) {
    validSide(side);
    const state = load();
    const session = findSession(state, side, input.id);
    if (!session) return refused('现在没有等你填写的双人私密决策。');
    if (session.mode === 'constraints') {
      session.constraints = session.constraints || {};
      session.constraints[side] = normalizeConstraints(input.preferenceText);
      session.updatedAt = new Date(now()).toISOString();
      if (!session.constraints.owner || !session.constraints.friend) {
        save(state);
        return changed(`已经保存你对 #${session.id} 的标准化条件。还在等对方提交；你的原话不会写进共享记录，也不会发给对方。`);
      }
      const decision = openDecisionOutcome(session);
      const result = decision.reply;
      if (!decision.compatible) {
        session.constraints = {};
      } else {
        session.status = 'resolved'; session.result = result; session.resolvedAt = new Date(now()).toISOString();
      }
      save(state);
      onNotice(otherSide(side), result, `pair-decision-result|${session.id}|${session.resolvedAt || session.updatedAt}`);
      return changed(result);
    }
    session.preferences[side] = normalizePreference(input.preferenceText, session.options.length, session.options);
    session.updatedAt = new Date(now()).toISOString();
    if (!session.preferences.owner || !session.preferences.friend) {
      save(state);
      return changed(`已经保存你对 #${session.id} 的私密选择。还在等对方提交；你的原话和完整偏好不会发给对方。`);
    }
    const decision = optionDecisionOutcome(session);
    const result = decision.reply;
    if (!decision.compatible) {
      delete session.preferences.owner;
      delete session.preferences.friend;
    } else {
      session.status = 'resolved';
      session.result = result;
      session.resolvedAt = new Date(now()).toISOString();
    }
    save(state);
    onNotice(otherSide(side), result, `pair-decision-result|${session.id}|${session.resolvedAt || session.updatedAt}`);
    return changed(result);
  }
  function submit(side, input) { return featureReply(submitResult(side, input)); }

  function hasPending(side) {
    validSide(side);
    const state = load();
    save(state);
    return Boolean(findSession(state, side));
  }

  function list(side) {
    validSide(side);
    const state = load();
    save(state);
    const sessions = visibleSessions(state).slice(-10).reverse();
    if (!sessions.length) return '现在没有双人私密决策。';
    return ['双人私密决策：', ...sessions.map((session) => {
      const own = (session.mode === 'constraints' ? session.constraints?.[side] : session.preferences?.[side]) ? '你已提交' : '等你提交';
      const status = session.status === 'resolved' ? '已出结果' : own;
      return `• #${session.id}｜${session.title}｜${status}${session.result ? `\n${session.result}` : ''}`;
    })].join('\n');
  }

  function cancel(side, id) {
    validSide(side);
    const state = load();
    const session = state.sessions.find((entry) => entry.id === String(id || '').toUpperCase()
      && entry.createdBy === side && entry.status === 'collecting');
    if (!session) throw new Error('没有找到由你发起且仍在进行的决策');
    session.status = 'cancelled';
    session.preferences = {};
    session.constraints = {};
    session.updatedAt = new Date(now()).toISOString();
    save(state);
    onNotice(otherSide(side), `双人私密决策 #${session.id} 已由发起人取消。`, `pair-decision-cancelled|${session.id}`);
    return `已经取消双人私密决策 #${session.id}。`;
  }

  function deleteSide() {
    const state = load();
    const removed = state.sessions.length;
    state.sessions = [];
    save(state);
    return { removed };
  }

  return { cancel, create, deleteSide, hasPending, list, submit, submitResult };
}

module.exports = { SESSION_TTL_MS, createPairDecisionStore, normalizeConstraints, normalizePreference, openDecisionResult };
