'use strict';

const fs = require('fs');
const path = require('path');

function acquireWorkerLock(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'worker.lock');
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    try { process.kill(pid, 0); return null; }
    catch (probeError) { if (probeError.code !== 'ESRCH') return null; }
    fs.unlinkSync(file);
    return acquireWorkerLock(root);
  }
  return () => fs.unlinkSync(file);
}


module.exports = { acquireWorkerLock };
