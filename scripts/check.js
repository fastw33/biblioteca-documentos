'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function check(directory) {
  for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, file.name);
    if (file.isDirectory()) check(location);
    else if (file.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', location], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const directory of ['src', 'scripts', 'test']) check(path.resolve(__dirname, '..', directory));
console.log('Sintaxis JavaScript verificada.');
