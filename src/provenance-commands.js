'use strict';

function parseProvenanceQuestion(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const patterns = [
    /^(?:你)?为什么(?:会)?知道(?:这个|这件事|这些)?[：:,，\s]*([\s\S]*?)[？?。]?$/u,
    /^(?:这个|这件事|这条信息)?(?:是)?(?:从)?哪(?:里|儿)知道的[？?。]?$/u,
    /^(?:这个|这件事|这条信息)(?:的)?来源是什么[？?。]?$/u,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    return { type: 'explain_provenance', query: String(match[1] || '').trim() };
  }
  return null;
}

module.exports = { parseProvenanceQuestion };
