'use strict';

function parseDailyWrapupCommand(text) {
  return String(text || '').trim() === '收工总结' ? { type: 'summary' } : null;
}

module.exports = { parseDailyWrapupCommand };
