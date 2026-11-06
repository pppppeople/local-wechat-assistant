'use strict';
const { shanghaiClock } = require('./weather-commands');
function morningMinute(time = '08:00') {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new Error('WEATHER_MORNING_TIME 必须为 HH:MM');
  const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute;
}
// Host owns the timer and transport. send(side, text, clientId) must confirm
// acceptance or throw. A claimed/uncertain send is never replayed automatically.
function createWeatherMorning({ store, weather, send, sides = ['owner', 'friend'],
  time = process.env.WEATHER_MORNING_TIME || '08:00', now = () => Date.now(), log = () => {} }) {
  const scheduled = morningMinute(time);
  if (typeof send !== 'function') throw new TypeError('Weather morning requires a host send callback');
  if (!sides.length || sides.some(side => !['owner', 'friend'].includes(side))) throw Error('天气身份无效');
  let busy = false;
  const inWindow = clock => clock.minute >= scheduled && clock.minute < Math.max(720, scheduled + 1);
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const side of sides) {
        let date, claimed = false;
        try {
          const clock = shanghaiClock(now()); date = clock.date;
          if (!inWindow(clock) || store.attempted(side, date) || !store.morningAllowed(side, date)) continue;
          if (!store.city(side) && store.morningPrompted(side)) continue;
          // Persist before provider work too, so unavailable data cannot spam on restart.
          if (!store.claim(side, date)) continue;
          claimed = true;
          const result = await weather.briefing(side);
          if (result.skip || !result.ok) { store.finish(side, date, 'unavailable'); continue; }
          const current = shanghaiClock(now());
          if (current.date !== date || !inWindow(current)) { store.finish(side, date, 'expired'); continue; }
          if (result.needsCity) store.markMorningPrompted(side);
          await send(side, result.reply, `weather-morning:${side}:${date}`);
          store.finish(side, date, 'sent');
        } catch {
          if (claimed) {
            try { store.finish(side, date, 'failed'); } catch { /* Durable claim still prevents replay. */ }
          }
          log(`weather morning failed role=${side}; no automatic replay today`);
        }
      }
    } finally { busy = false; }
  }
  return { tick };
}
module.exports = { morningMinute, createWeatherMorning };
