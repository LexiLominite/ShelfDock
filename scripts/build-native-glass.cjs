'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const repo = path.resolve(__dirname, '..');
function findNodeHeaders() {
  const candidates = [process.env.SHELFDOCK_NODE_INCLUDE, '/opt/homebrew/include/node', '/usr/local/include/node', path.resolve(path.dirname(process.execPath), '../include/node')].filter(Boolean);
  for (const base of [path.join(os.homedir(), 'Library/Caches/node-gyp'), path.join(os.homedir(), '.cache/node-gyp'), path.join(os.homedir(), '.electron-gyp')]) {
    if (fs.existsSync(base)) for (const version of fs.readdirSync(base).sort().reverse()) candidates.push(path.join(base, version, 'include/node'));
  }
  const found = candidates.find(dir => fs.existsSync(path.join(dir, 'node_api.h')));
  if (!found) throw new Error('Cached Node C API headers are required. Set SHELFDOCK_NODE_INCLUDE to their directory; this build never downloads binaries.');
  return found;
}
function build({test = false, arch = process.arch} = {}) {
  if (process.platform !== 'darwin') return {skipped: true, reason: 'macOS build only'};
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  const output = path.join(repo, 'desktop/native', test ? 'native-glass-harness' : 'shelfdock-glass.node');
  const sdk = execFileSync('xcrun', ['--show-sdk-path'], {encoding: 'utf8'}).trim();
  const args = ['clang++', '-std=c++17', '-fobjc-arc', '-O2', '-arch', arch === 'x64' ? 'x86_64' : 'arm64', '-isysroot', sdk, '-mmacosx-version-min=11.0', '-framework', 'AppKit', path.join(repo, 'desktop/native/glass.mm'), '-o', output];
  if (test) args.push('-DSHELFDOCK_GLASS_TEST=1');
  else args.push('-bundle', '-undefined', 'dynamic_lookup', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=shelfdock_glass', '-I', findNodeHeaders());
  execFileSync('xcrun', args, {stdio: 'inherit', timeout: 60000});
  return {output, arch};
}
if (require.main === module) {
  const result = build({test: process.argv.includes('--test'), arch: process.env.SHELFDOCK_NATIVE_ARCH || process.arch});
  console.log(JSON.stringify(result));
}
module.exports = {build, findNodeHeaders};
