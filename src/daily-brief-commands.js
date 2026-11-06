'use strict';

function parseDailyBriefCommand(text) {
  return text === '早报' || text === '今天有什么要关注的' ? { type: 'brief' } : null;
}

module.exports = { parseDailyBriefCommand };
