'use strict';
const path = require('node:path');
const { readJson, writeJsonAtomic, isJsonObject } = require('./json-file');
const { loadPublicConfig } = require('./public-config');
const SIDES = ['owner', 'friend'];
const CITY_REPLY_TTL_MS = 24 * 60 * 60 * 1000;
const emptyRole = () => ({ city: '', morningEnabled: true, morningPrompted: false,
  resumeDate: '', attemptDate: '', sentDate: '', status: '' });
const validDate = value => value === '' || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
function validRole(role) {
  return isJsonObject(role) && typeof role.city === 'string' && role.city.length <= 60
    && !/[\r\n]/u.test(role.city) && typeof role.morningEnabled === 'boolean'
    && typeof role.morningPrompted === 'boolean'
    && ['resumeDate', 'attemptDate', 'sentDate'].every(key => validDate(role[key]))
    && ['', 'claimed', 'sent', 'failed', 'unavailable', 'expired'].includes(role.status)
    && (role.pending === undefined || isJsonObject(role.pending)
      && ['query', 'morning'].includes(role.pending.kind) && Array.isArray(role.pending.days)
      && role.pending.days.length > 0 && role.pending.days.every(day => [0, 1, 2].includes(day))
      && ['createdAt', 'expiresAt'].every(key => role.pending[key] === undefined || Number.isFinite(role.pending[key])));
}
// Only settings, pending city queries and delivery status; no forecast/chat history.
function createWeatherStore({ stateFile, runtime, env = process.env, now = () => Date.now() } = {}) {
  const file = stateFile || path.resolve(runtime || loadPublicConfig(env).runtime,
    env.WEATHER_STATE_FILE || 'state/features/weather/state.json');
  const valid = state => isJsonObject(state) && state.schemaVersion === 1
    && isJsonObject(state.roles) && Object.keys(state.roles).length === 2
    && SIDES.every(side => validRole(state.roles[side]));
  const load = () => readJson(file, { schemaVersion: 1, roles: { owner: emptyRole(), friend: emptyRole() } }, { validate: valid });
  const save = state => writeJsonAtomic(file, state, { validate: valid });
  function role(state, side) {
    if (!SIDES.includes(side)) throw Error('天气身份无效');
    return state.roles[side];
  }
  function update(side, change) { const state = load(); change(role(state, side)); save(state); }
  const get = side => role(load(), side);
  function expirePending(entry) {
    const pending = entry.pending;
    // Undated legacy questions have no reliable lifetime; do not renew them.
    if (pending && (pending.createdAt === undefined || pending.expiresAt === undefined || now() >= pending.expiresAt)) {
      delete entry.pending;
      return true;
    }
    return false;
  }
  return {
    stateFile: file,
    city: side => get(side).city,
    hasPending(side) {
      const entry = get(side);
      expirePending(entry); // Read-only projection; no expiry write here.
      return Boolean(entry.pending);
    },
    pending(side) {
      const state = load(), entry = role(state, side);
      if (expirePending(entry)) save(state);
      return entry.pending || null;
    },
    waitForCity(side, pending) {
      update(side, entry => {
        expirePending(entry);
        if (pending.kind === 'query' || !entry.pending) {
          const createdAt = now();
          entry.pending = { ...pending, createdAt, expiresAt: createdAt + CITY_REPLY_TTL_MS };
        }
      });
    },
    setCity(side, city, { resumeDate } = {}) {
      update(side, entry => { entry.city = city; delete entry.pending; if (resumeDate) entry.resumeDate = resumeDate; });
    },
    morningAllowed(side, date) { const entry = get(side); return entry.morningEnabled && (!entry.resumeDate || date >= entry.resumeDate); },
    setMorning: (side, enabled) => update(side, entry => { entry.morningEnabled = enabled; }),
    morningPrompted: side => get(side).morningPrompted,
    markMorningPrompted: side => update(side, entry => { entry.morningPrompted = true; }),
    attempted(side, date) { const entry = get(side); return entry.attemptDate === date || entry.sentDate === date; },
    claim(side, date) {
      const state = load(), entry = role(state, side);
      if (entry.attemptDate === date || entry.sentDate === date) return false;
      entry.attemptDate = date; entry.status = 'claimed'; save(state); return true;
    },
    finish(side, date, status) {
      update(side, entry => { entry.status = status; if (status === 'sent') entry.sentDate = date; });
    },
  };
}
module.exports = { createWeatherStore, CITY_REPLY_TTL_MS };
