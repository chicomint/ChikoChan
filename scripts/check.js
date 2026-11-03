'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const directory of ['.', 'lib', 'scripts', 'test']) {
  for (const filename of fs.readdirSync(path.join(__dirname, '..', directory))) {
    if (!filename.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', directory, filename)], { stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = 1;
  }
}
