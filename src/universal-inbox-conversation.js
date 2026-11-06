'use strict';

const INBOX_MARKER = /\n?\[\[UNIVERSAL_INBOX:([^\r\n]{2,5200})\]\]\s*$/u;
const ANY_INBOX_MARKER = /\n?\[\[UNIVERSAL_INBOX:[^\r\n]{0,5200}\]\]/gu;

const UNIVERSAL_INBOX_INSTRUCTION = [
  '万能收件箱由外层安全处理器执行。你不能自行声称已经保存、加入、提醒或转发。',
  '当本次文字、链接或图片明显包含可后续处理的地点、活动、票券/预约、公开链接、收藏或礼物灵感时，在正常回复最后追加一行：[[UNIVERSAL_INBOX:[{"kind":"place|ticket|event|link|note|gift","title":"简短标题","placeName":"地点或场馆","eventTime":"YYYY-MM-DD HH:mm或空","tripScope":"self|peer|pair|unknown","url":"公开链接或空","summary":"不超过100字"}]]]。',
  '票券的 tripScope 只在当前内容明确说明行程人时填写：当前用户本人是 self，固定配对的对方是 peer，明确两个人同行是 pair；不能确认时必须写 unknown，不能因“双人票”擅自推断为 pair。',
  '只提取完成后续操作必需的字段；绝不能放入二维码内容、订单号、票号、身份证件、手机号、验证码、密码、Token、Cookie、密钥或本机路径。链接只保留公开页面。',
  '每次最多五个彼此独立的候选；只有一个时数组也只放一个对象。标记必须是最后一行且不能放进代码块。可见回复里不要声称已经执行，也不要重复列处理选项；外层会询问用户。',
].join('\n');

function clean(value, limit) {
  return String(value || '').replace(/[\r\n]+/gu, ' ').trim().slice(0, limit);
}

function publicUrl(value) {
  const raw = clean(value, 500);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().slice(0, 500);
  } catch { return ''; }
}

function extractUniversalInboxCandidate(answer) {
  const text = String(answer || '').trim();
  const match = text.match(INBOX_MARKER);
  if (!match) return { reply: text.replace(ANY_INBOX_MARKER, '').trim(), candidate: null };
  let payload = null;
  try { payload = JSON.parse(match[1]); } catch {}
  const reply = text.slice(0, match.index).trim();
  const rows = (Array.isArray(payload) ? payload : [payload]).slice(0, 5);
  const candidates = rows.map((entry) => {
    const kind = ['place', 'ticket', 'event', 'link', 'note', 'gift'].includes(entry?.kind) ? entry.kind : '';
    const title = clean(entry?.title, 120);
    const combined = JSON.stringify({
      title: entry?.title, placeName: entry?.placeName, eventTime: entry?.eventTime, summary: entry?.summary,
    });
    const sensitive = /(?:密码|口令|验证码|token|cookie|secret|api[ _-]?key|身份证|订单号|票号)\s*[：:=]\s*\S+/iu.test(combined);
    if (!kind || !title || sensitive) return null;
    return {
      kind, title, placeName: clean(entry?.placeName, 160), eventTime: clean(entry?.eventTime, 40),
      ...(kind === 'ticket' && ['self', 'peer', 'pair'].includes(entry?.tripScope) ? { tripScope: entry.tripScope } : {}),
      url: publicUrl(entry?.url), summary: clean(entry?.summary, 200),
    };
  }).filter(Boolean).filter((entry, index, all) => all.findIndex((candidate) => (
    candidate.kind === entry.kind && candidate.title === entry.title && candidate.eventTime === entry.eventTime
      && candidate.tripScope === entry.tripScope
  )) === index);
  return { reply, candidate: candidates[0] || null, candidates };
}

module.exports = { UNIVERSAL_INBOX_INSTRUCTION, extractUniversalInboxCandidate };
