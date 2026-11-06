'use strict';

const fs = require('fs');
const path = require('path');
const { isJsonObject, readJson, writeJsonAtomic } = require('./json-file');

function quarantine(file, error, now = () => Date.now()) {
  const base = `${file}.corrupt-${new Date(now()).toISOString().replace(/[^a-zA-Z0-9-]/g, '-')}`;
  let target = base;
  let suffix = 0;
  while (fs.existsSync(target)) target = `${base}-${++suffix}`;
  try { fs.renameSync(file, target); } catch (renameError) {
    throw new Error(`已保存的内容损坏，隔离失败：${renameError.message}`, { cause: error });
  }
  throw new Error(`已保存的内容损坏，已隔离保全：${target}。本次操作未执行。`, { cause: error });
}

function readIndex(file, fallback = {}, options = {}) {
  try { return readJson(file, fallback, { validate: isJsonObject }); } catch (error) {
    if (!options.readOnly && options.strict
      && ['ERR_INVALID_JSON', 'ERR_INVALID_JSON_STRUCTURE'].includes(error.code)) {
      quarantine(file, error, options.now);
    }
    throw error;
  }
}

function recordFile(stateFile, collection, reference) {
  const relative = String(reference.file || '');
  if (!relative.startsWith(`records/${collection}/`) || path.isAbsolute(relative)
    || relative.split(/[\\/]/u).includes('..') || !relative.endsWith('.json')
    || path.basename(relative, '.json') !== String(reference.id)) {
    throw new Error('classified record path is invalid');
  }
  return path.join(path.dirname(stateFile), relative);
}

function readRecordState(file, fallback = {}, retry = true, options = {}) {
  const index = readIndex(file, fallback, options);
  function validated(state) {
    if (options.validate) {
      try { options.validate(state); } catch (error) {
        if (options.readOnly) throw error;
        quarantine(file, error, options.now);
      }
    }
    return state;
  }
  if (!index || index._recordState?.version !== 1) return validated(index);
  const state = { ...index };
  try {
    for (const collection of index._recordState.collections) {
      state[collection] = (index[collection] || []).map((reference) => {
        const record = JSON.parse(fs.readFileSync(recordFile(file, collection, reference), 'utf8'));
        if (String(record.id) !== String(reference.id)) throw new Error('classified record identity is invalid');
        return record;
      });
    }
  } catch (error) {
    // The supported release CLI and resident broker can overlap an expiry write.
    // A superseded index may refer to an already removed body; retry that index once.
    if (retry && JSON.stringify(readIndex(file, fallback, options)) !== JSON.stringify(index)) {
      return readRecordState(file, fallback, false, options);
    }
    if (options.readOnly) throw error;
    if (options.strict) quarantine(file, error, options.now);
    throw new Error('已保存的内容暂时无法读取，请稍后重试。', { cause: error });
  }
  delete state._recordState;
  return validated(state);
}

function writeJson(file, value) {
  writeJsonAtomic(file, value, { skipUnchanged: true });
}

function relativeRecordFile(collection, record) {
  const id = String(record.id || '');
  const type = String(record.kind || (collection === 'jobs' ? record.mode : '') || collection);
  if (!/^[a-z0-9_-]+$/iu.test(id) || !/^[a-z0-9_-]+$/iu.test(type)) {
    throw new Error('classified record requires a stable id and category');
  }
  const date = String(record.createdAt || '').match(/^(\d{4})-(\d{2})-/u);
  const period = date ? `${date[1]}/${date[2]}` : 'undated';
  return `records/${collection}/${type}/${period}/${id}.json`;
}

function writeRecordState(file, state, collections) {
  const previous = readIndex(file);
  const index = { ...state, _recordState: { version: 1, collections } };
  const files = new Set();
  const writes = [];
  for (const collection of collections) {
    if (!/^[a-z0-9_-]+$/iu.test(collection)) throw new Error('classified collection is invalid');
    index[collection] = (state[collection] || []).map((record) => {
      const relative = relativeRecordFile(collection, record);
      if (files.has(relative)) throw new Error('duplicate classified record identity');
      files.add(relative);
      writes.push([path.join(path.dirname(file), relative), record]);
      return { id: record.id, status: record.status, file: relative };
    });
  }
  try {
    for (const [target, record] of writes) writeJson(target, record);
    writeJson(file, index);
    // Only remove formerly indexed records dropped by the feature's existing
    // deletion/expiry policy. Historical snapshots and backups are never scanned.
    for (const collection of previous._recordState?.collections || []) {
      for (const reference of previous[collection] || []) {
        if (!files.has(reference.file)) fs.rmSync(recordFile(file, collection, reference), { force: true });
      }
    }
  } catch (error) {
    throw new Error('保存时遇到问题，暂时无法确认完成，请稍后重试。', { cause: error });
  }
}

module.exports = { readRecordState, writeRecordState };
