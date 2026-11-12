'use strict';

const crypto = require('crypto');
const { changed, readResult, refused, resultText, unchanged } = require('./feature-result');
const { readRecordState, writeRecordState } = require('./record-state');
const { suggestionDecision } = require('./shared-place-conversation');
const { targetDate } = require('./shared-place-commands');
const { clockText, createDayPlan, estimateVisitMinutes, travelMinutes } = require('./shared-place-day-planner');

const MAX_PLACES = 200;
const PENDING_TTL_MS = 15 * 60 * 1000;
const SUGGESTION_TTL_MS = 15 * 60 * 1000;
const VIEW_TTL_MS = 15 * 60 * 1000;

function initialState(value = {}) {
  return {
    schemaVersion: 1,
    places: Array.isArray(value.places) ? value.places : [],
    pending: value.pending && typeof value.pending === 'object' ? value.pending : {},
    suggestions: value.suggestions && typeof value.suggestions === 'object' ? value.suggestions : {},
    views: value.views && typeof value.views === 'object' ? value.views : {},
    lastReferences: value.lastReferences && typeof value.lastReferences === 'object' ? value.lastReferences : {},
  };
}

function validSide(side) {
  if (!['owner', 'friend'].includes(side)) throw new Error('invalid shared place side');
  return side;
}

function sideName(side) {
  return side === 'owner' ? 'Owner' : '好友';
}

function normalizedName(value) {
  return String(value || '').toLocaleLowerCase('zh-CN').replace(/[\s·•・,，.。()（）-]/g, '');
}

function createId() {
  return `SP-${Date.now().toString(36).slice(-5)}${crypto.randomBytes(2).toString('hex')}`.toUpperCase();
}

function navUrl(place) {
  if (!Number.isFinite(place.longitude) || !Number.isFinite(place.latitude)) return '';
  return `https://uri.amap.com/marker?position=${place.longitude},${place.latitude}&name=${encodeURIComponent(place.name)}&src=owner-shared-place-box`;
}

function weatherLooksWet(weather) {
  return /雨|雪|雷|雹/u.test(`${weather.dayWeather}${weather.nightWeather}`);
}

function placeSetting(place) {
  const text = `${(place.tags || []).join(' ')} ${place.category || ''}`;
  if (/室内|博物馆|美术馆|商场|书店|影院|展览|咖啡|餐饮|剧院|室内游乐/u.test(text)) return 'indoor';
  if (/户外|公园|景区|古镇|街区|海滩|山|露营|动物园|植物园/u.test(text)) return 'outdoor';
  return 'mixed';
}

function numericWeatherValue(value) {
  const match = String(value || '').match(/-?\d+(?:\.\d+)?/u);
  return match ? Number(match[0]) : NaN;
}

function recommendationLabel(score) {
  if (score >= 85) return '很推荐';
  if (score >= 70) return '推荐';
  if (score >= 55) return '可以去';
  return '不太推荐';
}

function weatherHasStrongWind(weather) {
  const windPower = numericWeatherValue(weather.dayPower);
  if (Number.isFinite(windPower)) return windPower >= 6;
  const speedMatch = String(weather.windText || '').match(/(\d+(?:\.\d+)?)\s*km\/h/iu);
  return speedMatch ? Number(speedMatch[1]) >= 40 : false;
}

function scorePlaceForWeather(place, weather, energy = 'balanced') {
  const setting = placeSetting(place);
  const wet = weatherLooksWet(weather);
  const dayTemp = numericWeatherValue(weather.dayTemp);
  let score = 72;
  const reasons = [];

  if (wet) {
    if (setting === 'indoor') {
      score += 18;
      reasons.push('有降雨，室内活动更稳');
    } else if (setting === 'outdoor') {
      score -= 22;
      reasons.push('有降雨，户外体验会受影响');
    } else {
      score -= 5;
      reasons.push('有降雨，最好准备室内备选');
    }
  } else if (/晴/u.test(`${weather.dayWeather}${weather.nightWeather}`)) {
    if (setting === 'outdoor') {
      score += 15;
      reasons.push('天气晴，适合户外活动');
    } else {
      score += 5;
      reasons.push('天气晴朗，出行条件不错');
    }
  } else {
    reasons.push('天气整体可出行');
  }

  if (Number.isFinite(dayTemp) && dayTemp >= 35) {
    if (setting === 'indoor') {
      score += 12;
      reasons.push('高温下室内更舒服');
    } else if (setting === 'outdoor') {
      score -= 18;
      reasons.push('高温会明显影响户外体验');
    } else {
      score -= 8;
      reasons.push('高温时注意避晒降温');
    }
  } else if (Number.isFinite(dayTemp) && dayTemp >= 32) {
    if (setting === 'indoor') {
      score += 5;
      reasons.push('偏热，室内更省力');
    } else if (setting === 'outdoor') {
      score -= 8;
      reasons.push('偏热，户外要注意防晒补水');
    }
  }

  if (weatherHasStrongWind(weather) && setting === 'outdoor') {
    score -= 10;
    reasons.push('风力偏强，户外体验扣分');
  }
  if (energy === 'low') {
    if (setting === 'indoor') score += 4;
    if (setting === 'outdoor') score -= 3;
  } else if (energy === 'weatherproof') {
    if (setting === 'indoor') score += 5;
    if (setting === 'outdoor') score -= 5;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, label: recommendationLabel(score), reason: reasons.join('；') };
}

function weatherSummary(weather, label) {
  const windText = weather.windText || (weather.dayWind ? `${weather.dayWind}风${weather.dayPower}级` : '');
  const temperature = weather.nightTemp !== undefined && weather.dayTemp !== undefined
    ? `，${weather.nightTemp}～${weather.dayTemp}℃`
    : '';
  return `${weather.city || ''}${label}${weather.dayWeather || '天气未知'}${weather.nightWeather && weather.nightWeather !== weather.dayWeather ? `转${weather.nightWeather}` : ''}${temperature}${windText ? `，${windText}` : ''}`;
}

function durationText(seconds) {
  const minutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ''}` : `${minutes}分钟`;
}

function straightLineMeters(left, right) {
  if (![left.latitude, left.longitude, right.latitude, right.longitude].every(Number.isFinite)) return Infinity;
  const radians = (value) => value * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceText(meters) {
  if (!Number.isFinite(meters)) return '';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}公里` : `${Math.max(1, Math.round(meters))}米`;
}

function sharedPlaceHelp() {
  return `这是我们两个人共用的“想去箱”～\n\n• 把示例街区放进想去箱\n• 下次去示例街区，帮我记一下\n• 把甲省域省博物馆加到出行清单里\n• 示例街区先不去了，删掉吧\n• 查看想去箱（只列还没去的；去过的已隐藏）\n• 去过的地方（一次查看全部已去地点）\n• 把示例街区恢复为想去\n• 看完列表后直接说“第一个标记成去过了”或“删除第一个”\n• 把示例街区标记为去过\n• 今天去哪 / 周六去哪\n• 以示例园区为主，再搭两个附近地方\n\n日常聊天里如果听起来可能想去某个具体地点，我会先问要不要加入；只有你回复“加吧”才会真正写入。地点候选和最近展示的列表都在 15 分钟后失效，只在各自会话内使用，不读取或展示对方聊天、长期记忆或常用地址。`;
}

function createSharedPlaceBox({ stateFile, provider, now = () => Date.now(), onPlaceAdded = async () => {} }) {
  let operation = Promise.resolve();
  function load() {
    const state = initialState(readRecordState(stateFile, {}));
    const cutoff = now() - PENDING_TTL_MS;
    for (const side of Object.keys(state.pending)) {
      if (new Date(state.pending[side]?.createdAt || 0).getTime() < cutoff) delete state.pending[side];
    }
    const suggestionCutoff = now() - SUGGESTION_TTL_MS;
    for (const side of Object.keys(state.suggestions)) {
      if (new Date(state.suggestions[side]?.createdAt || 0).getTime() < suggestionCutoff) delete state.suggestions[side];
    }
    const viewCutoff = now() - VIEW_TTL_MS;
    for (const side of Object.keys(state.views)) {
      if (new Date(state.views[side]?.createdAt || 0).getTime() < viewCutoff) delete state.views[side];
    }
    return state;
  }

  function save(state) {
    writeRecordState(stateFile, state, ['places']);
  }

  function activePlaces(state) {
    return state.places.filter((place) => place.status !== 'archived' && place.status !== 'removed');
  }

  function hasPendingSuggestion(side) {
    validSide(side);
    const state = load();
    save(state);
    return Boolean(state.suggestions[side]);
  }

  function intentContext(side) {
    validSide(side);
    const state = load();
    const view = state.views[side];
    const pending = state.pending[side];
    const current = activePlaces(state);
    const places = view?.placeIds?.map((id, offset) => {
      const place = current.find((item) => item.id === id);
      return place ? {
        index: offset + 1, name: place.name, status: place.status,
        area: place.district || place.city || '', addedBy: sideName(place.addedBy),
      } : null;
    }).filter(Boolean) || [];
    const candidates = (pending?.candidates || []).slice(0, 3).map((candidate, offset) => ({
      index: offset + 1, name: String(candidate.name || '').slice(0, 120),
      address: String(candidate.address || '').slice(0, 180),
    }));
    save(state);
    return {
      enabled: places.length > 0 || candidates.length > 0,
      places, pending: candidates,
      viewToken: places.length ? String(view.createdAt || '') : '',
      pendingToken: candidates.length ? String(pending.createdAt || '') : '',
    };
  }

  async function applyIntentResult(side, intent, contextTokens = {}, userText = '') {
    const current = intentContext(side);
    if (!intent || !['select', 'visited', 'restore', 'remove', 'list', 'recommend'].includes(intent.action)) {
      throw new Error('想去箱语义操作无效');
    }
    if (intent.action === 'select') {
      if (!current.pendingToken || current.pendingToken !== contextTokens.pendingToken) {
        return refused('刚才待选的地点已经变化或过期了，请重新说一次要加入的地点。');
      }
      if (!current.pending.some((item) => item.index === Number(intent.index))) {
        return refused('你选的编号不在刚才的地点候选里。');
      }
      return handleResult(side, { type: 'select', index: Number(intent.index) });
    }
    if (!current.viewToken || current.viewToken !== contextTokens.viewToken) {
      return refused('刚才的想去箱列表已经变化或过期了，请重新查看想去箱后再说。');
    }
    if (['visited', 'restore', 'remove'].includes(intent.action)) {
      const indices = intent.action === 'visited' && Array.isArray(intent.indices) ? intent.indices : [Number(intent.index)];
      if (!indices.length || indices.length > 30 || !indices.every((index) => Number.isInteger(index) && current.places.some((item) => item.index === index))) {
        return refused('你说的地点不在刚才那份想去箱列表里。');
      }
      return handleResult(side, intent.action === 'visited' && Array.isArray(intent.indices)
        ? { type: 'visited', indices } : { type: intent.action, index: Number(intent.index) });
    }
    if (intent.action === 'list') return handleResult(side, { type: 'list' });
    const query = String(userText || '').trim().slice(0, 300);
    const energy = /不想太累|少走|省力|轻松|低能量/u.test(query)
      ? 'low' : (/不怕下雨|雨天|室内/u.test(query) ? 'weatherproof' : 'balanced');
    return handleResult(side, {
      type: 'recommend', ...targetDate(query), focus: '', energy, query,
    });
  }

  function findMatches(state, query) {
    const needle = normalizedName(query);
    if (!needle) return [];
    const current = activePlaces(state);
    const exact = current.filter((place) => normalizedName(place.name) === needle);
    if (exact.length) return exact;
    return current.filter((place) => normalizedName(place.name).includes(needle) || needle.includes(normalizedName(place.name)));
  }

  function inspect(side, query) {
    validSide(side);
    const matches = findMatches(load(), query);
    if (matches.length !== 1) return { reply: matches.length ? '箱子里有几个同名或相似地点，请说完整名称。' : '想去箱里没有找到这个地点，请说具体名称。', continue: false, wrote: false };
    const id = matches[0].id;
    const snapshot = () => {
      const place = activePlaces(load()).find((item) => item.id === id);
      if (!place) throw Error('这个地点已经移除，未执行后续操作');
      const data = { name: place.name, status: place.status, address: place.address || '', area: place.district || place.city || '' };
      const reply = `想去箱：${data.name}\n状态：${data.status === 'visited' ? '已去过' : '未去过'}${data.address || data.area ? `\n地点：${data.address || data.area}` : ''}`;
      return { data, reply, shareableText: reply, continue: true, wrote: false, recheck: snapshot };
    };
    return snapshot();
  }

  function addCandidate(state, side, candidate, note = '', sourceType = 'explicit_place_command') {
    if (activePlaces(state).length >= MAX_PLACES) throw new Error(`想去箱最多放 ${MAX_PLACES} 个地点`);
    const duplicate = activePlaces(state).find((place) => (candidate.providerId && place.providerId === candidate.providerId)
      || normalizedName(place.name) === normalizedName(candidate.name));
    if (duplicate) return { place: duplicate, duplicate: true };
    const timestamp = new Date(now()).toISOString();
    const place = {
      id: createId(),
      provider: candidate.provider || 'unresolved',
      providerId: String(candidate.providerId || ''),
      name: String(candidate.name || '').slice(0, 120),
      address: String(candidate.address || ''),
      province: String(candidate.province || ''),
      city: String(candidate.city || ''),
      district: String(candidate.district || ''),
      adcode: String(candidate.adcode || ''),
      longitude: Number.isFinite(candidate.longitude) ? candidate.longitude : null,
      latitude: Number.isFinite(candidate.latitude) ? candidate.latitude : null,
      category: String(candidate.category || ''),
      tags: Array.isArray(candidate.tags) ? candidate.tags.slice(0, 8) : [],
      attribution: String(candidate.attribution || '').slice(0, 120),
      note: String(note || '').slice(0, 200),
      addedBy: side,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      peerNoticeState: 'pending',
      provenance: {
        sourceType,
        ownerSide: side,
        visibility: 'fixed_pair',
        createdReason: sourceType === 'conversation_suggestion'
          ? '日常对话识别到地点候选后，由用户明确确认加入'
          : (sourceType === 'universal_inbox' ? '用户从万能收件箱明确加入想去箱' : '用户通过自然语言明确加入想去箱'),
        reshareAllowed: true,
        createdAt: timestamp,
      },
    };
    state.places.push(place);
    state.lastReferences[side] = { type: 'place', id: place.id, createdAt: timestamp };
    return { place, duplicate: false };
  }

  async function queuePeerNotice(state, side, place) {
    if (place.peerNoticeState !== 'pending') return { queued: false, retried: false };
    const retried = Boolean(place.peerNoticeLastAttemptAt);
    place.peerNoticeLastAttemptAt = new Date(now()).toISOString();
    save(state);
    try {
      await onPlaceAdded({ side, place: { ...place } });
      place.peerNoticeState = 'queued';
      place.peerNoticeQueuedAt = new Date(now()).toISOString();
      delete place.peerNoticeLastError;
      save(state);
      return { queued: true, retried };
    } catch (error) {
      place.peerNoticeLastError = String(error.message || error).slice(0, 120);
      save(state);
      return { queued: false, retried };
    }
  }

  async function add(side, command) {
    const state = load();
    delete state.suggestions[side];
    if (!provider.available) {
      const result = addCandidate(state, side, { name: command.name }, command.note, command.sourceType);
      save(state);
      const peerNotice = await queuePeerNotice(state, side, result.place);
      if (result.duplicate) {
        return unchanged(peerNotice.queued
          ? `${result.place.name}已经在想去箱里啦，刚刚也补排了对方通知。`
          : `${result.place.name}已经在想去箱里啦。`);
      }
      return changed(`先把${result.place.name}放进我们共用的想去箱啦～ 当前还没配置地图服务，所以暂时只保存名字；配置好后才能核对具体门店、天气和附近联动。${peerNotice.queued ? '\n通知对方的消息也已经排上啦。' : '\n不过通知暂时没排上；再说一次相同的添加命令，我会重试。'}`);
    }
    const candidates = await provider.searchPlace(command.name);
    if (!candidates.length) return refused(`我暂时没找到“${command.name}”。可以补上城市或区名再试，比如“乙城丙城区＋地点名”。`);
    if (candidates.length > 1) {
      state.pending[side] = {
        candidates, note: command.note || '', sourceType: command.sourceType || 'explicit_place_command',
        createdAt: new Date(now()).toISOString(),
      };
      save(state);
      return refused([`搜到几个同名或相近地点，你想放哪一个？`, ...candidates.map((candidate, index) => `${index + 1}. ${candidate.name}${candidate.address ? `｜${candidate.address}` : ''}`), `回复“想去箱选1”就行。`, `地点数据：${candidates[0].attribution || provider.attribution || provider.providerName || '地图服务'}`].join('\n'));
    }
    const result = addCandidate(state, side, candidates[0], command.note, command.sourceType);
    save(state);
    const peerNotice = await queuePeerNotice(state, side, result.place);
    if (result.duplicate) {
      return unchanged(peerNotice.queued
        ? `${result.place.name}已经在想去箱里啦，刚刚也补排了对方通知。`
        : `${result.place.name}已经在想去箱里啦。`);
    }
    return changed(`已经把${result.place.name}放进我们共用的想去箱啦～${result.place.address ? `\n${result.place.address}` : ''}${result.place.attribution ? `\n地点数据：${result.place.attribution}` : ''}${peerNotice.queued ? '\n通知对方的消息也已经排上啦。' : '\n不过通知暂时没排上；再说一次相同的添加命令，我会重试。'}`);
  }

  async function select(side, command) {
    const state = load();
    const pending = state.pending[side];
    if (!pending) return refused('现在没有等待你确认的地点。先说“把某个地方放进想去箱”吧。');
    const candidate = pending.candidates[Number(command.index) - 1];
    if (!candidate) return refused('只能选择刚才列出的 1～3。');
    const result = addCandidate(state, side, candidate, pending.note, pending.sourceType);
    delete state.pending[side];
    save(state);
    const peerNotice = await queuePeerNotice(state, side, result.place);
    if (result.duplicate) {
      return unchanged(peerNotice.queued
        ? `${result.place.name}已经在想去箱里啦，刚刚也补排了对方通知。`
        : `${result.place.name}已经在想去箱里啦。`);
    }
    return changed(`好，已经把${result.place.name}放进我们共用的想去箱啦～${result.place.attribution ? `\n地点数据：${result.place.attribution}` : ''}${peerNotice.queued ? '\n通知对方的消息也已经排上啦。' : '\n不过通知暂时没排上；再说一次相同的添加命令，我会重试。'}`);
  }

  function suggest(side, command) {
    const state = load();
    const name = String(command.name || '').trim().slice(0, 120);
    if (!name) return refused('');
    if (findMatches(state, name).length) {
      delete state.suggestions[side];
      save(state);
      return refused('');
    }
    state.suggestions[side] = {
      name,
      reason: String(command.reason || '').replace(/[\r\n]+/gu, ' ').trim().slice(0, 120),
      createdAt: new Date(now()).toISOString(),
    };
    save(state);
    return refused(`听起来你可能会想去「${name}」。要把它放进我们俩的想去箱吗？回“加吧”就行，不想加就回“不用了”。`);
  }

  async function resolveSuggestion(side, command) {
    const decision = suggestionDecision(command.text);
    if (!decision) return refused(null);
    const state = load();
    const pendingSuggestion = state.suggestions[side];
    if (!pendingSuggestion) return refused(null);
    delete state.suggestions[side];
    save(state);
    if (decision === 'decline') return changed('好，那这次不放进想去箱。');
    return add(side, {
      type: 'add', name: pendingSuggestion.name, note: '', sourceType: 'conversation_suggestion',
    });
  }

  function explain(side, query = '') {
    validSide(side);
    const state = load();
    const value = String(query || '').trim();
    let place = value ? findMatches(state, value)[0] : null;
    if (!place) {
      const reference = state.lastReferences[side];
      if (reference?.type === 'place') place = activePlaces(state).find((item) => item.id === reference.id);
    }
    if (!place && !value) {
      place = activePlaces(state).sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
    }
    if (!place) return null;
    state.lastReferences[side] = { type: 'place', id: place.id, createdAt: new Date(now()).toISOString() };
    save(state);
    const owner = sideName(place.provenance?.ownerSide || place.addedBy);
    const sourceType = place.provenance?.sourceType;
    const reason = place.provenance?.createdReason || '这是较早的想去箱记录；只能确认加入人和记录时间，不能补写当时的聊天原文';
    const date = String(place.provenance?.createdAt || place.createdAt || '').slice(0, 10) || '时间未知';
    return `我知道「${place.name}」是因为它在 ${date} 被${owner}加入了双方共享的想去箱。${reason}。\n可见范围：仅 Owner 和好友；来源类型：${sourceType || '旧版想去箱记录'}。这不是从另一方的私人聊天或长期记忆里读到的。`;
  }

  function list(side, status) {
    const state = load();
    const current = activePlaces(state);
    if (status === 'visited') {
      const visited = current.filter((place) => place.status === 'visited');
      // This complete history list restores by name, so it must not leave a
      // previous active list's numbered mutation context behind.
      delete state.views[side];
      save(state);
      const lines = visited.length
        ? [`想去箱（去过的 ${visited.length} 个）：`, ...visited.map((place, index) => `${index + 1}. ${place.name}`)]
        : ['还没有标记去过的地方'];
      lines.push('发送「把<地点名>恢复为想去」可把地点移回未去列表');
      return lines.join('\n');
    }
    if (!current.length) {
      delete state.views[side];
      save(state);
      return '我们的想去箱现在还是空的。直接说“把某个地方放进想去箱”就能开始啦。';
    }
    const active = current.filter((place) => place.status === 'active');
    const visited = current.filter((place) => place.status === 'visited');
    const visitedHint = visited.length ? `另有 ${visited.length} 个去过的地方不在此列表，发送「去过的地方」可一次查看` : '';
    if (!active.length) {
      delete state.views[side];
      save(state);
      return ['想去箱里的地点都去过啦，已隐藏；说地点名称可查看详情或恢复。', visitedHint].filter(Boolean).join('\n');
    }
    const displayed = active.slice(0, 30);
    state.views[side] = { placeIds: displayed.map((place) => place.id), createdAt: new Date(now()).toISOString() };
    save(state);
    const lines = [`想去箱（还没去的 ${active.length} 个）：`];
    displayed.forEach((place, index) => {
      lines.push(`${index + 1}. ${place.name}`);
    });
    if (active.length > 30) lines.push(`还有 ${active.length - 30} 个地点没有展开。`);
    lines.push('可以直接说“第一个标记成去过了”“删除第一个”或“把第二个删掉”。');
    if (visitedHint) lines.push(visitedHint);
    return lines.join('\n');
  }

  function updateStatus(side, command, status) {
    const state = load();
    let matches;
    if (Array.isArray(command.indices) || Number.isInteger(command.index)) {
      const indices = Array.isArray(command.indices) ? [...new Set(command.indices)] : [command.index];
      if (!indices.length || indices.length > 30 || indices.some((index) => !Number.isInteger(index) || index < 1 || index > 30)) return refused('地点编号必须在 1 到 30 之间。');
      const view = state.views[side];
      if (!view) return refused('我知道你想标记列表里的地点，但刚才那份列表已经过期了。再说一次“查看想去箱”，然后直接说“第一个标记成去过了”就行。');
      matches = [];
      for (const index of indices) {
        const placeId = view.placeIds[index - 1];
        if (!placeId) return refused(`刚才的列表没有第 ${index} 个地点，这次没有修改任何地点。`);
        const referenced = activePlaces(state).find((place) => place.id === placeId);
        if (!referenced) return refused('刚才那条地点已经发生变化了。重新“查看想去箱”后再标记，避免改错。');
        matches.push(referenced);
      }
    } else if (Array.isArray(command.names)) {
      if (!command.names.length || command.names.length > 30) return refused('请明确要标记的地点名称。');
      matches = [];
      for (const name of [...new Set(command.names)]) {
        const found = findMatches(state, name);
        if (found.length !== 1) return refused(found.length
          ? `箱子里有几个相近地点，请说完整一点：${found.slice(0, 3).map((item) => item.name).join('、')}。这次没有修改任何地点。`
          : `想去箱里没有找到“${name}”，这次没有修改任何地点。`);
        if (!matches.some((item) => item.id === found[0].id)) matches.push(found[0]);
      }
    } else {
      matches = findMatches(state, command.name);
    }
    if (!matches.length) return refused(`想去箱里没有找到“${command.name}”。`);
    if (!Array.isArray(command.indices) && !Array.isArray(command.names) && matches.length > 1) return refused(`箱子里有几个相近地点，请说完整一点：${matches.slice(0, 3).map((item) => item.name).join('、')}。`);
    const timestamp = new Date(now()).toISOString();
    for (const place of matches) {
      place.status = status;
      place.updatedAt = timestamp;
    }
    delete state.views[side];
    save(state);
    return changed(status === 'visited' ? `好，${matches.map((place) => place.name).join('、')}${matches.length > 1 ? '都' : ''}标成去过啦～\n之后发送「去过的地方」可以一次查看全部去过的地方` : `${matches[0].name}重新放回想去清单啦。`);
  }

  function remove(side, command) {
    const state = load();
    let matches;
    if (Number.isInteger(command.index)) {
      const view = state.views[side];
      if (!view) return refused('我知道你想删列表里的地点，但刚才那份列表已经过期了。再说一次“查看想去箱”，然后直接说“删除第一个”就行。');
      const placeId = view.placeIds[command.index - 1];
      if (!placeId) return refused(`刚才的列表没有第 ${command.index} 个地点。`);
      const referenced = activePlaces(state).find((place) => place.id === placeId);
      if (!referenced) return refused('刚才那条地点已经发生变化了。重新“查看想去箱”后再删，避免删错。');
      matches = [referenced];
    } else {
      matches = findMatches(state, command.name);
    }
    if (!matches.length) return refused(`想去箱里没有找到“${command.name}”。`);
    if (matches.length > 1) return refused(`箱子里有几个相近地点，请说完整一点：${matches.slice(0, 3).map((item) => item.name).join('、')}。`);
    const place = matches[0];
    if (place.addedBy !== side) return refused(`${place.name}是${sideName(place.addedBy)}放进来的，先让对方删除比较稳；你可以先把它标成去过。`);
    place.status = 'removed';
    place.updatedAt = new Date(now()).toISOString();
    delete state.views[side];
    save(state);
    return changed(`已经把${place.name}从想去箱拿掉了。`);
  }

  async function collectWeather(active, command) {
    const weatherCache = new Map();
    const entries = [];
    for (const place of active) {
      let weather = null;
      let weatherError = '';
      if (provider.available && Number.isFinite(place.longitude) && Number.isFinite(place.latitude)) {
        const weatherKey = place.adcode || `${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}`;
        if (!weatherCache.has(weatherKey)) {
          try {
            weatherCache.set(weatherKey, { weather: await provider.weather(place, command.date), error: '' });
          } catch (error) {
            weatherCache.set(weatherKey, { weather: null, error: error.message || '天气服务暂时不可用' });
          }
        }
        ({ weather, error: weatherError } = weatherCache.get(weatherKey));
      } else if (!provider.available) weatherError = '地图服务还没配置好';
      else weatherError = '地点坐标还没有解析';
      entries.push({
        place,
        weather,
        weatherError,
        rating: weather ? scorePlaceForWeather(place, weather, command.energy) : null,
      });
    }
    return entries;
  }

  async function weather(side, command) {
    const state = load();
    const active = activePlaces(state).filter((place) => place.status === 'active');
    if (!active.length) return '想去箱里没有还没去的地点可查询天气。';
    const entries = await collectWeather(active, command);
    const latest = load();
    latest.views[side] = { placeIds: entries.map((entry) => entry.place.id), createdAt: new Date(now()).toISOString() };
    save(latest);
    const available = entries.filter((entry) => entry.weather).length;
    const lines = [`${command.label}未去过地点的天气（共 ${entries.length} 个，已取得 ${available} 个）：`];
    entries.forEach(({ place, weather: forecast, weatherError }, index) => {
      lines.push(`${index + 1}. ${place.name}：${forecast ? weatherSummary(forecast, command.label) : `暂不可用（${weatherError}）`}`);
    });
    const reportTimes = [...new Set(entries.map((entry) => entry.weather?.reportTime).filter(Boolean))];
    if (reportTimes.length) lines.push(`天气数据截至：${reportTimes.sort().at(-1)}`);
    lines.push(`数据：${provider.attribution || provider.providerName || '地图与天气服务'}`);
    return lines.join('\n');
  }

  async function recommendAll(side, active, command) {
    const entries = await collectWeather(active, command);
    entries.sort((left, right) => (right.rating?.score ?? -1) - (left.rating?.score ?? -1)
      || new Date(left.place.createdAt).getTime() - new Date(right.place.createdAt).getTime());
    const latestState = load();
    latestState.views[side] = {
      placeIds: entries.map((entry) => entry.place.id),
      createdAt: new Date(now()).toISOString(),
    };
    save(latestState);

    const lines = [];
    let plan = null;
    let planEntries = [];
    const focusPlace = command.focus ? findMatches(load(), command.focus).find((place) => place.status === 'active') : null;
    const eligible = entries.filter((entry) => Number.isFinite(entry.place.longitude) && Number.isFinite(entry.place.latitude));
    let candidates = eligible.slice(0, 12);
    const focusEntry = focusPlace ? eligible.find((entry) => entry.place.id === focusPlace.id) : null;
    if (focusEntry && !candidates.includes(focusEntry)) candidates = [...candidates.slice(0, 11), focusEntry];
    if (provider.available && typeof provider.routeMatrix === 'function' && candidates.length) {
      try {
        const matrix = await provider.routeMatrix(candidates.map((entry) => entry.place));
        const maxLegMinutes = command.energy === 'low' ? 60 : 90;
        plan = createDayPlan(candidates, matrix, { focusId: focusPlace?.id || '', maxLegMinutes });
        if (plan) {
          planEntries = plan.entries;
          lines.push(`${command.label}的一日路线建议（先不算从家出发和返程）：`);
          lines.push(`只组合同省地点，单段驾车不超过 ${maxLegMinutes} 分钟。`);
          if (plan.entries.length === 1) lines.push('箱里暂时没有适合同天联动的近距离地点，这一站更适合单独玩。');
          let elapsed = 0;
          let lunchAdded = false;
          plan.entries.forEach((entry, index) => {
            if (index > 0) {
              const fromMatrixIndex = plan.matrixIndexes[index - 1];
              const toMatrixIndex = plan.matrixIndexes[index];
              const route = matrix[fromMatrixIndex]?.[toMatrixIndex];
              const minutes = travelMinutes(matrix, fromMatrixIndex, toMatrixIndex);
              lines.push(`   ↓ 驾车估算 ${minutes}分钟（${distanceText(route?.distanceMeters)}）`);
              elapsed += minutes;
            }
            if (!lunchAdded && index > 0 && elapsed >= 120) {
              lines.push(`   ${clockText(elapsed)}–${clockText(elapsed + 60)} 午饭 / 休息`);
              elapsed += 60;
              lunchAdded = true;
            }
            const visitMinutes = estimateVisitMinutes(entry.place);
            const weatherRating = entry.rating ? `${entry.rating.score}/100` : '评分暂缺';
            lines.push(`${index + 1}. ${clockText(elapsed)}–${clockText(elapsed + visitMinutes)} ${entry.place.name}（游玩约${durationText(visitMinutes * 60)}，天气 ${weatherRating}）`);
            elapsed += visitMinutes;
          });
          if (plan.totals.meal && !lunchAdded) {
            lines.push(`   ${clockText(elapsed)}–${clockText(elapsed + 60)} 午饭 / 休息`);
            elapsed += 60;
          }
          lines.push(`预留机动 45 分钟；地点间交通约${plan.totals.travel ? durationText(plan.totals.travel * 60) : '0分钟'}，整天约${durationText(plan.totals.total * 60)}。`);
          lines.push('实际开放时间、排队和路况临出发前再确认；上面的交通只计算地点之间。');
        }
      } catch {}
    }
    if (!plan) {
      lines.push(`这次还拿不到可靠的本地交通时间，所以不编造一日路线；先把${command.label}所有地点按天气适配度列出来。`);
    }
    lines.push('', `${command.label}想去箱全部地点（共 ${entries.length} 个）：`);
    const plannedIds = new Set(planEntries.map((entry) => entry.place.id));
    entries.forEach((entry, index) => {
      const { place, weather, weatherError, rating } = entry;
      lines.push('', `${index + 1}. ${place.name}${plannedIds.has(place.id) ? '｜今日路线' : '｜备选'}｜${rating ? `${rating.score}/100 ${rating.label}` : '评分暂缺'}`);
      lines.push(`天气：${weather ? weatherSummary(weather, command.label) : `暂时不可用（${weatherError}）`}`);
      lines.push(`理由：${rating ? `${rating.reason}${plannedIds.has(place.id) ? '；已纳入当天路线' : plan ? '；受当天时间和地点间交通限制，留作备选' : ''}` : '没有可靠天气数据，所以不凭空评分'}`);
      lines.push(`地址：${place.address || [place.province, place.city, place.district].filter(Boolean).join('') || '暂未解析'}`);
      lines.push(`地图：${navUrl(place) || '暂不可用'}`);
    });
    const best = entries.find((entry) => entry.rating);
    if (!plan) lines.push('', best
      ? `天气上更适合：${best.place.name}（${best.rating.score}/100）。${best.rating.reason}。`
      : `目前不能可靠地告诉你${command.label}天气和推荐指数，所以先不硬选；上面的地点已经全部列出。`);
    const reportTimes = [...new Set(entries.map((entry) => entry.weather?.reportTime).filter(Boolean))];
    if (reportTimes.length) lines.push(`天气数据截至：${reportTimes.sort().at(-1)}`);
    lines.push(`数据：${provider.attribution || provider.providerName || '地图与天气服务'}`);
    return lines.join('\n');
  }

  async function recommend(side, command) {
    const state = load();
    save(state);
    const active = activePlaces(state).filter((place) => place.status === 'active');
    if (!active.length) return '想去箱里还没有没去过的地方。先放几个地点进来，我才能帮你们搭路线～';
    const focusMatches = command.focus ? findMatches(state, command.focus).filter((place) => place.status === 'active') : [];
    if (command.focus && !focusMatches.length) return `想去箱里没有找到“${command.focus}”。先把它放进箱子，或者换一个箱子里已有的地点。`;
    if (!command.focus || typeof provider.routeMatrix === 'function') return recommendAll(side, active, command);
    const ordered = focusMatches;
    const main = ordered.find((place) => Number.isFinite(place.longitude) && Number.isFinite(place.latitude)) || ordered[0];
    if (!provider.available || !Number.isFinite(main.longitude) || !Number.isFinite(main.latitude)) {
      return `我可以先从箱子里挑${main.name}，但目前地图服务还没配置好，所以不能可靠地告诉你${command.label}天气、真实路线和附近联动。\n\n备选还有：${ordered.filter((place) => place.id !== main.id).slice(0, 2).map((place) => place.name).join('、') || '暂时没有'}。`;
    }
    let weather;
    try {
      weather = await provider.weather(main, command.date);
    } catch (error) {
      return `我先推荐${main.name}，但${command.label}的天气暂时没查到：${error.message}。为了不乱说，我这次不按天气给结论。${navUrl(main) ? `\n地图：${navUrl(main)}` : ''}`;
    }
    const wet = weatherLooksWet(weather);
    const maxLinkedDistance = command.energy === 'low' ? 3000 : 15000;
    const sharedNearby = active.filter((place) => place.id !== main.id && Number.isFinite(place.longitude) && Number.isFinite(place.latitude))
      .map((place) => ({ ...place, sharedBoxPlace: true, straightDistanceMeters: straightLineMeters(main, place) }))
      .filter((place) => place.straightDistanceMeters <= maxLinkedDistance)
      .sort((left, right) => left.straightDistanceMeters - right.straightDistanceMeters);
    let discoveredNearby = [];
    try { discoveredNearby = await provider.nearby(main, command.energy === 'low' ? 1500 : 2500); } catch {}
    const seen = new Set(sharedNearby.map((place) => place.providerId || normalizedName(place.name)));
    let nearby = [...sharedNearby, ...discoveredNearby.filter((place) => {
      const key = place.providerId || normalizedName(place.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })];
    if (wet || command.energy === 'weatherproof') nearby.sort((left, right) => Number(right.tags.includes('室内')) - Number(left.tags.includes('室内')) || Number(left.straightDistanceMeters || Infinity) - Number(right.straightDistanceMeters || Infinity));
    const links = [];
    for (const candidate of nearby.slice(0, 2)) {
      let route = null;
      try { route = await provider.walkingRoute(main, candidate); } catch {}
      links.push({ candidate, route });
    }
    const windText = weather.windText || (weather.dayWind ? `${weather.dayWind}风${weather.dayPower}级` : '');
    const weatherText = `${weather.city}${command.label}${weather.dayWeather}${weather.nightWeather && weather.nightWeather !== weather.dayWeather ? `转${weather.nightWeather}` : ''}，${weather.nightTemp}～${weather.dayTemp}℃${windText ? `，${windText}` : ''}`;
    const reason = wet
      ? `${main.tags.includes('室内') ? '它以室内活动为主，雨天更稳' : '有降雨可能，记得带伞并给户外部分留退路'}`
      : `${command.energy === 'low' ? '先按少走路的方式排' : '天气条件可以，按主地点加附近一站来排'}`;
    const lines = [`我更推荐${main.name}。${weatherText}；${reason}。`];
    if (links.length) {
      lines.push('', '附近可以顺手搭：');
      for (const { candidate, route } of links) {
        const fallbackDistance = candidate.sharedBoxPlace && Number.isFinite(candidate.straightDistanceMeters)
          ? `，直线约${distanceText(candidate.straightDistanceMeters)}，实际路线以地图为准`
          : '，路线时间暂时没查到';
        lines.push(`• ${candidate.name}${candidate.sharedBoxPlace ? '（也在想去箱里）' : ''}${route ? `，步行约${durationText(route.durationSeconds)}（${Math.round(route.distanceMeters)}米）` : fallbackDistance}`);
      }
    } else lines.push('', '附近联动暂时没查到合适结果，这次先把主地点玩舒服。');
    if (weather.reportTime) lines.push('', `天气发布时间：${weather.reportTime}`);
    lines.push(`地图：${navUrl(main)}`);
    lines.push(`数据：${provider.attribution || provider.providerName || '地图与天气服务'}`);
    return lines.join('\n');
  }

  function status() {
    const state = load();
    save(state);
    const providerStatus = !provider.available
      ? '不可用'
      : (provider.fullCapabilities ? `${provider.providerName || '地图服务'}完整模式` : `${provider.providerName || '公开服务'}基础模式；高德 Key 配置后可增加周边 POI 和步行路线`);
    return `双人想去箱：${activePlaces(state).filter((place) => place.status === 'active').length} 个想去地点，${activePlaces(state).filter((place) => place.status === 'visited').length} 个去过地点。地图和天气：${providerStatus}。`;
  }

  function deleteSide(side) {
    validSide(side);
    const state = load();
    const removed = state.places.filter((place) => place.addedBy === side && place.status !== 'removed').length;
    state.places = state.places.filter((place) => place.addedBy !== side);
    delete state.pending[side];
    delete state.suggestions[side];
    delete state.views[side];
    save(state);
    return { removed };
  }

  async function runCommand(side, command) {
    validSide(side);
    if (!command || typeof command !== 'object') throw new Error('想去箱命令格式不正确');
    if (command.type === 'help') return sharedPlaceHelp();
    if (command.type === 'status') return status();
    if (command.type === 'list') return list(side, command.status);
    if (command.type === 'add') return add(side, command);
    if (command.type === 'select') return select(side, command);
    if (command.type === 'remove') return remove(side, command);
    if (command.type === 'visited') return updateStatus(side, command, 'visited');
    if (command.type === 'restore') return updateStatus(side, command, 'active');
    if (command.type === 'recommend') return recommend(side, command);
    if (command.type === 'weather') return weather(side, command);
    if (command.type === 'suggest') return suggest(side, command);
    if (command.type === 'resolve_suggestion') return resolveSuggestion(side, command);
    throw new Error('不支持的想去箱操作');
  }

  function handleResult(side, command) {
    const next = operation.then(() => runCommand(side, command)).then(readResult);
    operation = next.catch(() => {});
    return next;
  }

  async function handle(side, command) { return resultText(await handleResult(side, command)); }
  async function applyIntent(side, intent, contextTokens, userText) { return resultText(await applyIntentResult(side, intent, contextTokens, userText)); }

  function readUnvisitedCount(side) {
    validSide(side);
    const state = initialState(readRecordState(stateFile, {}, true, { strict: true, readOnly: true }));
    return activePlaces(state).filter((place) => place.status === 'active').length;
  }
  function readDrawPlaces(side) {
    validSide(side);
    const state = initialState(readRecordState(stateFile, {}, true, { strict: true, readOnly: true }));
    return activePlaces(state).map(({ name, status }) => ({ name, status }));
  }
  function readOwnerUnvisitedItems(side) {
    if (side !== 'owner') throw Error('这个私人助手只供已绑定的本人使用。');
    const state = initialState(readRecordState(stateFile, {}, true, { strict: true, readOnly: true }));
    return state.places.filter(place => place.addedBy === 'owner' && place.status === 'active'
      && (!place.provenance?.ownerSide || place.provenance.ownerSide === 'owner'))
      .map(({ id, name }) => ({ id, name }));
  }
  function hasLanePending(side) {
    validSide(side);
    const state = readRecordState(stateFile, {}, true, { readOnly: true });
    if (state.places !== undefined && !Array.isArray(state.places)) throw Error('Invalid place records');
    return ['pending', 'suggestions', 'views'].some(key => {
      if (state[key] === undefined) return false;
      if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw Error('Invalid place state');
      const value = state[key][side];
      if (!value) return false;
      const at = Date.parse(value.createdAt);
      if (!Number.isFinite(at)) throw Error('Invalid place pending time');
      return now() - at < PENDING_TTL_MS;
    });
  }
  return { applyIntent, applyIntentResult, deleteSide, explain, inspect, handle, handleResult, hasPendingSuggestion, hasLanePending, intentContext, status, readUnvisitedCount, readDrawPlaces, readOwnerUnvisitedItems };
}

module.exports = { createSharedPlaceBox, sharedPlaceHelp };
