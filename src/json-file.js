'use strict';

const fs = require('fs');
const path = require('path');

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(content, validate) {
  let value;
  try { value = JSON.parse(content); } catch (cause) {
    throw Object.assign(new SyntaxError('Invalid JSON file', { cause }), { code: 'ERR_INVALID_JSON' });
  }
  if (validate && !validate(value)) {
    throw Object.assign(new Error('Invalid JSON file structure'), { code: 'ERR_INVALID_JSON_STRUCTURE' });
  }
  return value;
}

// Durable data is the default: only an uncreated file may use the fallback.
// Disposable caches must explicitly opt in and report every degraded read.
function readJson(file, fallback = {}, { validate, cache = false, onError } = {}) {
  if (cache && typeof onError !== 'function') throw new TypeError('Cache fallback requires an error reporter');
  try { return parseJson(fs.readFileSync(file, 'utf8'), validate); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (!cache) throw error;
    onError({ code: error.code || 'ERR_JSON_READ' });
    return fallback;
  }
}

// Extracted from record-state's existing same-directory atomic replacement.
// Preflight the existing file too: a save-only caller must not erase bad data.
function writeJsonAtomic(file, value, { validate, skipUnchanged = false, trailingNewline = true } = {}) {
  const text = JSON.stringify(value, null, 2) + (trailingNewline ? '\n' : '');
  parseJson(text, validate);
  try {
    const previous = fs.readFileSync(file, 'utf8');
    parseJson(previous, validate);
    if (skipUnchanged && previous === text) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

module.exports = { isJsonObject, readJson, writeJsonAtomic };
