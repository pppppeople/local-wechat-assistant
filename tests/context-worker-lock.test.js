'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { acquireWorkerLock } = require('../src/context-worker-lock');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-worker-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'worker.lock') };
}

test('acquires exclusively, releases, and permits the next worker', (t) => {
  const { root, file } = fixture(t);

  const release = acquireWorkerLock(root);
  assert.equal(typeof release, 'function');
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  assert.equal(acquireWorkerLock(root), null);

  release();
  assert.equal(fs.existsSync(file), false);

  const nextRelease = acquireWorkerLock(root);
  assert.equal(typeof nextRelease, 'function');
  nextRelease();
  assert.equal(fs.existsSync(file), false);
});

test('removes an expired lock and acquires it for the current worker', async (t) => {
  const { root, file } = fixture(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const stalePid = child.pid;
  await once(child, 'exit');

  fs.writeFileSync(file, String(stalePid), { mode: 0o600 });
  const release = acquireWorkerLock(root);

  assert.equal(typeof release, 'function');
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  release();
  assert.equal(fs.existsSync(file), false);
});
