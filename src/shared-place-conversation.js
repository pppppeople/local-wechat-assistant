'use strict';

const SUGGESTION_MARKER = /\n?\[\[SHARED_PLACE_SUGGEST:(\{[^\r\n]{2,500}\})\]\]\s*$/u;
const ANY_SUGGESTION_MARKER = /\n?\[\[SHARED_PLACE_SUGGEST:[^\r\n]{0,500}\]\]/gu;
const ACCEPT_SUGGESTION = /^(?:好|好啊|好呀|可以|行|加吧|加上|放进去|记下来|要|嗯|嗯嗯)[。！!~～]?$/u;
const DECLINE_SUGGESTION = /^(?:不用|不用了|先不|先不用|不加了|算了|别加|不要)[。！!~～]?$/u;

const SHARED_PLACE_SUGGESTION_INSTRUCTION = [
  '想去箱由外层安全处理器执行。你不能自行声称已经加入或删除地点。',
  '如果当前这条日常聊天明显表达了对一个具体、可地图搜索的地点或门店的兴趣，但没有明确要求加入想去箱，可以在正常回复的最后追加一行机器标记：[[SHARED_PLACE_SUGGEST:{"name":"地点全名","reason":"很短的判断理由"}]]。',
  '只有具体地点才允许标记；城市、景点、餐厅或门店可以，抽象活动、菜系、家、公司、当前位置、过去去过的地方、普通路线咨询和否定表达都不要标记。',
  '每次最多一个候选。标记必须是最后一行，不要放进代码块，也不要在可见回复里重复询问是否加入；外层会自然询问并等待用户确认。',
].join('\n');

function normalizeSuggestionName(value) {
  const name = String(value || '').replace(/[。！!？?]+$/gu, '').trim().slice(0, 120);
  if (!name || /^(?:这里|那里|这个地方|那个地方|某个地方|附近|家|公司|单位|学校)$/u.test(name)) return '';
  return name;
}

function extractSharedPlaceSuggestion(answer) {
  const text = String(answer || '').trim();
  const match = text.match(SUGGESTION_MARKER);
  if (!match) return { reply: text.replace(ANY_SUGGESTION_MARKER, '').trim(), suggestion: null };
  let payload = null;
  try { payload = JSON.parse(match[1]); } catch {}
  const name = normalizeSuggestionName(payload?.name);
  const reply = text.slice(0, match.index).trim();
  if (!name) return { reply, suggestion: null };
  return {
    reply,
    suggestion: {
      name,
      reason: String(payload?.reason || '').replace(/[\r\n]+/gu, ' ').trim().slice(0, 120),
    },
  };
}

function suggestionDecision(text) {
  const value = String(text || '').trim();
  if (ACCEPT_SUGGESTION.test(value)) return 'accept';
  if (DECLINE_SUGGESTION.test(value)) return 'decline';
  return '';
}

function mightResolveSharedPlaceSuggestion(text) {
  return Boolean(suggestionDecision(text));
}

module.exports = {
  SHARED_PLACE_SUGGESTION_INSTRUCTION,
  extractSharedPlaceSuggestion,
  mightResolveSharedPlaceSuggestion,
  suggestionDecision,
};
