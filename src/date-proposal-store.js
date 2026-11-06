'use strict';

const crypto = require('crypto');
const { readRecordState, writeRecordState } = require('./record-state');
const VIEW_TTL_MS = 15 * 60 * 1000;
const HELP = '请用「出行提案：咖啡馆；城市：甲城；Owner出发：箱内地点名；好友出发：箱内地点名」。出发点仅接受想去箱内唯一同名地点，不读取实时定位。选定请回复「就它了 1」。';
function placeProjection(place, source) {
  return { name: String(place.name).slice(0, 120), address: String(place.address || '').slice(0, 300),
    provider: String(place.provider || ''), providerId: String(place.providerId || ''),
    longitude: place.longitude, latitude: place.latitude, city: String(place.city || ''),
    category: String(place.category || ''), tags: Array.isArray(place.tags) ? place.tags.map(String).slice(0, 8) : [],
    attribution: String(place.attribution || ''), source };
}
function createDateProposalStore({ stateFile, readPlaces, provider, now = () => Date.now() }) {
  const views = new Map();
  let generating = false;
  const load = () => readRecordState(stateFile, { proposals: [] }, true, { strict: true });
  const save = state => writeRecordState(stateFile, state, ['proposals']);
  const eta = value => Number.isFinite(value) ? `步行约${Math.ceil(value / 60)}分钟` : '路线未核';
  async function propose(side, command) {
    if (generating) return '已有出行提案正在查询，请稍后再试。';
    generating = true;
    try {
      const places = readPlaces().filter(place => place?.name && ['active', 'visited'].includes(place.status));
      const origins = {};
      for (const who of ['owner', 'friend']) {
        const matches = places.filter(place => place.name === command.origins?.[who]);
        if (matches.length === 1) origins[who] = placeProjection(matches[0], 'origin');
      }
      const matchesCategory = place => !command.category || `${place.name} ${place.category || ''} ${(place.tags || []).join(' ')}`.includes(command.category.replace('咖啡馆', '咖啡'));
      let pool = places.filter(matchesCategory).map(place => placeProjection(place, place.status === 'active' ? '想去箱未去地点' : '想去箱去过地点'));
      const city = command.city || (origins.owner?.city && origins.owner.city === origins.friend?.city ? origins.owner.city : '');
      if (provider.canSearch && provider.canRoute && command.category && city) {
        const found = await provider.search(command.category, city);
        pool.push(...found.filter(place => place?.name && matchesCategory(place)).map(place => placeProjection(place, '地图 POI')));
      }
      if (city) pool = pool.filter(place => place.city === city || place.address.includes(city));
      const seen = new Set();
      pool = pool.filter(place => {
        const key = place.providerId ? `${place.provider}:${place.providerId}` : `${place.name}|${place.address}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, 12);
      const candidates = [];
      for (const place of pool) {
        const times = {};
        for (const who of ['owner', 'friend']) {
          const route = provider.canRoute && origins[who] ? await provider.route(origins[who], place) : null;
          times[who] = typeof route?.durationSeconds === 'number' && Number.isFinite(route.durationSeconds) && route.durationSeconds > 0 ? route.durationSeconds : null;
        }
        candidates.push({ ...place, times });
      }
      const priority = place => place.source === '想去箱未去地点' ? 0 : 1;
      const cost = place => Object.values(place.times).every(Number.isFinite) ? Math.max(place.times.owner, place.times.friend) : Infinity;
      candidates.sort((a, b) => priority(a) - priority(b) || (command.near ? cost(a) - cost(b) : 0));
      const selected = candidates.slice(0, 3);
      views.delete(side);
      if (!selected.length) return '当前来源没有符合可核类别／城市的地点，没有生成提案。' + HELP;
      // Origins, raw condition and provider payload are deliberately not persisted.
      views.set(side, { candidates: selected, createdAt: now(), selectedId: null });
      return ['出行提案（候选建议，选定不代表双方已确认出行）：',
        ...selected.map((place, index) => `${index + 1}. ${place.name}${place.address ? `（${place.address}）` : ''}\nOwner：${eta(place.times.owner)}；好友：${eta(place.times.friend)}\n理由：来自${place.source}${place.category ? `，类别：${place.category}` : ''}${place.attribution ? `；数据：${place.attribution}` : ''}。`),
        selected.length < 3 ? `仅有 ${selected.length} 个可核候选，不补造地点。` : '',
        '未去地点优先；“近”仅按双方可核步行时长中较长者排序，路线缺失排后；安静、预算、评分、营业状态及其他条件未核。',
        (!origins.owner || !origins.friend) ? '出发地点缺少或同名不唯一；相应路线未核。' : '',
        (!provider.canSearch || !provider.canRoute) ? '当前地图缺少完整 POI＋路线能力，仅使用已保存地点。' : (!city ? '没有明确城市，本次不查询新 POI。' : ''),
        '15 分钟内回复「就它了 1／2／3」；仅选定时保存一条记录。'].filter(Boolean).join('\n');
    } finally { generating = false; }
  }
  async function handle(side, command) {
    if (!['owner', 'friend'].includes(side)) throw new Error('invalid date proposal side');
    if (command?.type === 'help') return HELP;
    if (command?.type === 'propose') return propose(side, command);
    if (command?.type !== 'select') throw new Error('不支持的出行提案命令');
    const view = views.get(side);
    if (!view || now() - view.createdAt >= VIEW_TTL_MS) { views.delete(side); return '出行提案已过期或不存在，请重新生成。'; }
    if (view.selectedId) return '这一轮提案已选定，未重复保存。';
    const candidate = view.candidates[command.index - 1];
    if (!candidate) return '没有这个候选编号，请按刚才的提案编号选择。';
    const state = load();
    const { longitude, latitude, ...place } = candidate;
    const record = { id: crypto.randomUUID(), kind: 'date_proposal', createdAt: new Date(now()).toISOString(),
      selectedBy: side, status: 'selected', place, provenance: { sourceType: 'explicit_date_proposal_selection', ownerSide: side, visibility: 'fixed_pair' } };
    state.proposals.push(record);
    save(state);
    view.selectedId = record.id;
    return `已选定「${place.name}」，保存了 1 条出行提案记录。这是本方选定，尚不代表双方确认；未创建双人决定、预约或提醒。`;
  }
  function deleteSide(side) {
    if (!['owner', 'friend'].includes(side)) throw new Error('invalid date proposal side');
    views.delete(side);
    const state = load();
    state.proposals = state.proposals.filter(record => record.selectedBy !== side);
    save(state);
  }
  return { handle, deleteSide };
}
module.exports = { createDateProposalStore, VIEW_TTL_MS };
