'use strict';

// Same process-local, lazily expired pattern as text-template's 15-minute session.
const SESSION_MS = 15 * 60 * 1000;
function createFeatureManual({ now = () => Date.now(), ttlMs = SESSION_MS } = {}) {
  const features = new Map(), sessions = new Map();
  function register({ triggerWord, aliases = [], intro, sections }) {
    if (!triggerWord || !intro || !sections?.length) throw Error('说明书缺少触发词、简介或章节');
    const feature = { triggerWord, aliases, intro, sections };
    for (const word of [triggerWord, ...aliases]) {
      if (features.has(word)) throw Error(`说明书触发词重复：${word}`);
      features.set(word, feature);
    }
    return feature;
  }
  function footer(triggerWord, reply) {
    const line = `看用法回：${triggerWord}`;
    return reply.endsWith(line) ? reply : `${reply}\n${line}`;
  }
  function select(side, input, { isCommand = false } = {}) {
    const text = String(input || '').trim();
    if (!['owner', 'friend'].includes(side)) return null;
    let session = sessions.get(side);
    if (session && now() >= session.expiresAt) { sessions.delete(side); session = null; }
    const feature = features.get(text);
    if (feature) {
      sessions.set(side, { feature, expiresAt: now() + ttlMs });
      return footer(feature.triggerWord, [feature.intro,
        ...feature.sections.map((section, index) => `${index + 1} ${section.title}`)].join('\n'));
    }
    if (!session) return null;
    if (isCommand) { sessions.delete(side); return null; }
    const sections = session.feature.sections;
    let index = /^\d+$/u.test(text) ? Number(text) - 1 : sections.findIndex(section =>
      [section.title, ...(section.keywords || [])].includes(text));
    let part = 0;
    if (text === '继续' && session.next) ({ index, part } = session.next);
    if (!sections[index]) { sessions.delete(side); return null; }
    const section = sections[index];
    const parts = Array.isArray(section.body) ? section.body : [section.body];
    session.next = part + 1 < parts.length ? { index, part: part + 1 } : null;
    session.expiresAt = now() + ttlMs;
    return footer(session.feature.triggerWord, `${index + 1} ${section.title}\n${parts[part]}${session.next ? '\n回「继续」看下半节' : ''}`);
  }
  return { register, footer, select, exit: side => sessions.delete(side) };
}
module.exports = { createFeatureManual, SESSION_MS };
