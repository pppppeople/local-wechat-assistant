'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-public-tests-'));
const home = path.join(temporary, 'home');
const tmp = path.join(temporary, 'tmp');
fs.mkdirSync(home); fs.mkdirSync(tmp);
// Do not inherit real account/model credentials, HOME or provider settings.
const env = { PATH: process.env.PATH || '', HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
  XDG_DATA_HOME: path.join(home, 'share'), TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.js')).sort().map(name => path.join('tests', name));
try {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=4', ...tests], { cwd: root, env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
