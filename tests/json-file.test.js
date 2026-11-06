'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isJsonObject, readJson, writeJsonAtomic } = require('../src/json-file');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'state.json') };
}

test('uncreated JSON initializes atomically with owner-only permissions', t => {
  const { file } = fixture(t);
  assert.deepEqual(readJson(file, []), []);
  assert.equal(fs.existsSync(file), false);
  writeJsonAtomic(file, { saved: true });
  assert.deepEqual(readJson(file), { saved: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp-${process.pid}`), false);
});

test('durable read and save reject corrupt JSON or shape and preserve the original', t => {
  const { root, file } = fixture(t);
  for (const original of ['{broken', 'null', '[]']) {
    fs.writeFileSync(file, original);
    assert.throws(() => readJson(file, {}, { validate: isJsonObject }), /Invalid JSON file/);
    assert.throws(() => writeJsonAtomic(file, {}, { validate: isJsonObject }), /Invalid JSON file/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(root), ['state.json']);
  }
});

test('non-ENOENT read failures block reads and writes rather than initialize', t => {
  const { root, file } = fixture(t);
  const read = fs.readFileSync;
  const failure = Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw failure;
    return read(target, ...args);
  });
  assert.throws(() => readJson(file, {}), error => error === failure);
  assert.throws(() => writeJsonAtomic(file, {}), error => error === failure);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('explicit disposable cache fallback reports degradation without logging contents', t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, '{SYNTHETIC_CACHE_CONTENT');
  assert.throws(() => readJson(file, {}, { cache: true }), /requires an error reporter/);
  const errors = [];
  assert.deepEqual(readJson(file, {}, { cache: true, onError: error => errors.push(error) }), {});
  assert.deepEqual(errors, [{ code: 'ERR_INVALID_JSON' }]);
  assert.doesNotMatch(JSON.stringify(errors), /SYNTHETIC_CACHE_CONTENT/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{SYNTHETIC_CACHE_CONTENT');
});

test('failed atomic replacement leaves the previous JSON intact', t => {
  const { file } = fixture(t);
  writeJsonAtomic(file, { revision: 1 });
  const original = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('synthetic rename denied'), { code: 'EACCES' }); });
  assert.throws(() => writeJsonAtomic(file, { revision: 2 }), { code: 'EACCES' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
