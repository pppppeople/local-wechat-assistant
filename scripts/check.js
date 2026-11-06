'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const dir of ['src', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(path.join(root, dir))) {
    if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(root, dir, file)], { stdio: 'inherit' });
  }
}
console.log('JavaScript syntax checks passed');
