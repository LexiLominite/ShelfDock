'use strict';
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (process.platform !== 'darwin') { console.log('Native glass fixture is macOS-only.'); process.exit(0); }
const {build} = require('./build-native-glass.cjs');
build();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfdock-native-glass-'));
try {
  execFileSync(require('electron'), [path.resolve(__dirname, '../tests/native-glass/electron.cjs')], {
    env: {...process.env, SHELFDOCK_GLASS_TEST_PROFILE: profile}, stdio: 'inherit', timeout: 20000
  });
} finally { fs.rmSync(profile, {recursive: true, force: true}); }
