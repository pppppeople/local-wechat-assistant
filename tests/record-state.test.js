'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { readRecordState, writeRecordState } = require('../src/record-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classified-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'state.json') };
}

test('default and read-only record reads reject corrupt indexes and preserve bytes', t => {
  const { root, file } = fixture(t);
  for (const original of ['{bad', 'null', '[]']) {
    fs.writeFileSync(file, original);
    assert.throws(() => readRecordState(file, null), /Invalid JSON file/);
    assert.throws(() => readRecordState(file, null, true, { readOnly: true }), /Invalid JSON file/);
    assert.throws(() => writeRecordState(file, { items: [] }, ['items']), /Invalid JSON file/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(root), ['state.json']);
  }
});

test('record reads propagate non-ENOENT errors even without strict mode', t => {
  const { root, file } = fixture(t);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
    return read(target, ...args);
  });
  assert.throws(() => readRecordState(file, null), { code: 'EACCES' });
  assert.throws(() => readRecordState(file, null, true, { strict: true }), { code: 'EACCES' });
  assert.deepEqual(fs.readdirSync(root), []);
});

test('invalid record ids and categories fail without writing files', (t) => {
  const { root, file } = fixture(t);
  for (const record of [
    { id: 'GI/1', kind: 'gift' },
    { id: 'GI-1', kind: 'gift idea!' },
  ]) {
    assert.throws(
      () => writeRecordState(file, { items: [record] }, ['items']),
      { message: 'classified record requires a stable id and category' },
    );
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test('failed quarantine reports the rename failure and retains the corrupt original', (t) => {
  const { root, file } = fixture(t);
  const original = '{bad';
  fs.writeFileSync(file, original);
  const now = () => Date.parse('2026-11-03T00:00:00Z');
  const rename = t.mock.method(fs, 'renameSync', (source, target) => {
    assert.equal(source, file);
    assert.equal(target, `${file}.corrupt-2026-11-03T00-00-00-000Z`);
    throw Object.assign(new Error('mock rename denied'), { code: 'EACCES' });
  });
  try {
    assert.throws(() => readRecordState(file, { items: [] }, true, { strict: true, now }), error => {
      assert.match(error.message, /内容损坏，隔离失败：mock rename denied/u);
      assert.doesNotMatch(error.message, /已隔离保全/u);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
    assert.equal(rename.mock.callCount(), 1);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(root), ['state.json']);
  } finally {
    rename.mock.restore();
  }
});

test('keeps legacy state lossless while moving bodies into stable category/month records', (t) => {
  const { root, file } = fixture(t);
  const state = { schemaVersion: 4, drafts: {}, items: [
    { id: 'GI-1', kind: 'gift', title: '保存的礼物', status: 'active', ownerSide: 'owner', createdAt: '2026-10-10T00:00:00Z' },
    { id: 'TK-1', kind: 'ticket', title: '过去的票券', status: 'archived', ownerSide: 'friend', createdAt: '2026-09-01T00:00:00Z' },
  ] };
  fs.writeFileSync(file, JSON.stringify(state));
  assert.deepEqual(readRecordState(file), state);
  writeRecordState(file, state, ['items']);
  const index = JSON.parse(fs.readFileSync(file));
  assert.doesNotMatch(JSON.stringify(index), /保存的礼物|过去的票券/);
  assert.equal(index.items[0].file, 'records/items/gift/2026/10/GI-1.json');
  assert.equal(index.items[1].file, 'records/items/ticket/2026/09/TK-1.json');
  assert.deepEqual(readRecordState(file), state);
  const recordFile = path.join(root, index.items[0].file);
  assert.equal(fs.statSync(recordFile).mode & 0o777, 0o600);
  const inode = fs.statSync(recordFile).ino;
  writeRecordState(file, state, ['items']);
  assert.equal(fs.statSync(recordFile).ino, inode);
  state.items[0].title = '更新后的礼物';
  writeRecordState(file, state, ['items']);
  assert.deepEqual(readRecordState(file), state);
  assert.equal(fs.readdirSync(path.dirname(recordFile)).length, 1);
});

test('redaction overwrites the existing body and feature deletion removes its indexed file', (t) => {
  const { root, file } = fixture(t);
  const state = { notices: [{ id: 'FN-1', kind: 'time_capsule', status: 'pending', capsuleBody: 'SEALED_BODY', createdAt: '2026-10-10T00:00:00Z' }] };
  writeRecordState(file, state, ['notices']);
  const relative = JSON.parse(fs.readFileSync(file)).notices[0].file;
  state.notices[0].capsuleBody = '';
  state.notices[0].status = 'sent';
  writeRecordState(file, state, ['notices']);
  assert.doesNotMatch(fs.readFileSync(path.join(root, relative), 'utf8'), /SEALED_BODY/);
  state.notices = [];
  writeRecordState(file, state, ['notices']);
  assert.equal(fs.existsSync(path.join(root, relative)), false);
});

test('a missing selected body or an escaping path fails closed', (t) => {
  const { root, file } = fixture(t);
  assert.equal(readRecordState(file, null), null);
  writeRecordState(file, { places: [{ id: 'SP-1', name: '地点' }] }, ['places']);
  const index = JSON.parse(fs.readFileSync(file));
  fs.unlinkSync(path.join(root, index.places[0].file));
  assert.throws(() => readRecordState(file), (error) => {
    assert.match(error.message, /内容暂时无法读取/);
    assert.doesNotMatch(error.message, /records\/|\/tmp\/|state.json/);
    return true;
  });
  index.places[0].file = '../credentials/SP-1.json';
  fs.writeFileSync(file, JSON.stringify(index));
  assert.throws(() => readRecordState(file), /内容暂时无法读取/);
});
