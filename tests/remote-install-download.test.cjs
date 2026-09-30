'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateLinuxPackage, validateWindowsPortable, releaseAssetName, readRelease } = require('../desktop/remote-install-download.cjs');

test('Remote Install Download - releaseAssetName', t => {
  assert.equal(releaseAssetName('1.2.3', 'windows', 'x64', 'personal'), 'LexBridge-personal-1.2.3-win-x64.exe');
  assert.equal(releaseAssetName('1.2.3', 'linux', 'arm64', 'public'), 'ShelfDock-1.2.3-linux-arm64.tar.gz');
});

test('Remote Install Download - validateWindowsPortable', t => {
  // Construct a minimal valid fake PE for windows portable validation
  const fakePE = Buffer.alloc(2048);
  Buffer.from(['ProductName', 'ShelfDock', 'ProductVersion', '1.0.0', ''].join('\0'), 'utf16le').copy(fakePE, 512);
  fakePE.write('MZ', 0, 'ascii'); // MZ header
  fakePE.writeUInt32LE(0x40, 0x3c); // PE header offset
  fakePE.writeUInt32BE(0x50450000, 0x40); // PE signature
  fakePE.writeUInt16LE(0x8664, 0x40 + 4); // Machine type x64
  
  // Test valid
  assert.equal(validateWindowsPortable(fakePE, { arch: 'x64', version: '1.0.0', productName: 'ShelfDock', personal: false }), true);
  
  // Test invalid MZ
  const invalidPE = Buffer.alloc(1024);
  assert.throws(() => validateWindowsPortable(invalidPE, { arch: 'x64', version: '1.0.0', productName: 'ShelfDock', personal: false }), /portable executable/);
  
  // Test invalid machine type
  fakePE.writeUInt16LE(0xAA64, 0x40 + 4); // ARM64 is not an x64 portable launcher
  assert.throws(() => validateWindowsPortable(fakePE, { arch: 'x64', version: '1.0.0', productName: 'ShelfDock', personal: false }), /different processor/);

  // Test invalid product name
  fakePE.writeUInt16LE(0x8664, 0x40 + 4); // Fix machine type
  assert.throws(() => validateWindowsPortable(fakePE, { arch: 'x64', version: '1.0.0', productName: 'WrongName', personal: false }), /app edition/);
});

const { Readable } = require('node:stream');
function releaseFixture({ personal = false, tamper = false, badURL = false } = {}) {
  const data = Buffer.from('pinned release bytes');
  const name = releaseAssetName('0.7.0', 'linux', 'arm64', personal ? 'personal' : 'public');
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const repo = personal ? 'LexiLominite/LexBridge-private' : 'LexiLominite/ShelfDock';
  const manifest = Buffer.from(hash + '  ' + name + '\n');
  const candidate = { tag_name: 'v0.7.0', draft: false, prerelease: false, assets: [name, 'SHA256SUMS.txt'].map((n, index) => ({ id: 100 + index, name: n, state: 'uploaded', size: index ? manifest.length : data.length, browser_download_url: `https://github.com/${repo}/releases/download/v0.7.0/${n}` })) };
  if (badURL) candidate.assets[0].browser_download_url = 'https://evil.test/payload';
  const calls = [];
  const stream = async url => { calls.push(url); let body = url.endsWith('?per_page=100') ? Buffer.from(JSON.stringify([candidate])) : url.endsWith('SHA256SUMS.txt') || url.endsWith('/101') ? manifest : tamper ? Buffer.from('tampered bytes') : data; const result = Readable.from([body]); result.headers = {}; return result; };
  return { stream, calls, data };
}
test('pinned public release uses fixed repository, checksum and target asset', async () => {
  const fixture = releaseFixture();
  const result = await readRelease({ targetOS: 'linux', arch: 'arm64', edition: 'public', version: '0.7.0', stream: fixture.stream });
  assert.deepEqual(result.asset.bytes, fixture.data);
  assert.ok(fixture.calls.every(url => url.includes('LexiLominite/ShelfDock/')));
});
test('private release fetches only GitHub API asset endpoints on sender', async () => {
  const fixture = releaseFixture({ personal: true });
  await readRelease({ targetOS: 'linux', arch: 'arm64', edition: 'personal', version: '0.7.0', stream: fixture.stream });
  assert.ok(fixture.calls.every(url => url.startsWith('https://api.github.com/repos/LexiLominite/LexBridge-private/releases')));
});
test('mismatched hash and substituted repository URL reject before installation', async () => {
  for (const options of [{ tamper: true }, { badURL: true }]) {
    const fixture = releaseFixture(options);
    await assert.rejects(readRelease({ targetOS: 'linux', arch: 'arm64', edition: 'public', version: '0.7.0', stream: fixture.stream }), /checksum|metadata/);
  }
});
test('PE identity requires exact product and version, not only a matching processor', () => {
  const bytes = Buffer.alloc(1024); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0',64); bytes.writeUInt16LE(0x8664,68);
  assert.throws(() => validateWindowsPortable(bytes, { arch: 'x64', version: '0.7.0', productName: 'ShelfDock', personal: false }), /identity/);
});

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
test('Linux archive validates actual ASAR identity and ELF architecture for x64 and arm64', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-install-archive-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const arch of ['x64', 'arm64']) {
    const name = `ShelfDock-0.7.0-linux-${arch}`;
    const bundle = path.join(dir, name); await fs.mkdir(path.join(bundle, 'resources'), { recursive: true });
    const pkg = Buffer.from(JSON.stringify({ name: 'shelfdock', version: '0.7.0', productName: 'ShelfDock' }));
    const header = Buffer.from(JSON.stringify({ files: { 'package.json': { offset: '0', size: pkg.length } } }));
    const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12);
    await fs.writeFile(path.join(bundle, 'resources/app.asar'), Buffer.concat([prefix, header, pkg]));
    const elf = Buffer.alloc(64); elf.writeUInt32BE(0x7f454c46); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18);
    await fs.writeFile(path.join(bundle, 'ShelfDock'), elf, { mode: 0o755 });
    const archive = path.join(dir, arch + '.tar.gz'); await run('tar', ['--format=ustar', '-czf', archive, '-C', dir, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const bytes = await fs.readFile(archive);
    assert.equal(await validateLinuxPackage(bytes, { version: '0.7.0', arch, productName: 'ShelfDock', personal: false }), true);
    await assert.rejects(validateLinuxPackage(bytes, { version: '0.7.1', arch, productName: 'ShelfDock', personal: false }), /unsafe path/);
    const staging = path.join(dir, 'script-' + arch); const home = path.join(dir, 'home-' + arch); const bin = path.join(dir, 'bin-' + arch);
    await fs.mkdir(staging); await fs.mkdir(home); await fs.mkdir(bin);
    await fs.copyFile(path.join(__dirname, '../installers/install.sh'), path.join(staging, 'install.sh'));
    await fs.copyFile(archive, path.join(staging, 'payload.tar.gz'));
    await fs.writeFile(path.join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo ${arch === 'arm64' ? 'aarch64' : 'x86_64'};; esac\n`, { mode: 0o755 });
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const scriptArgs = [path.join(staging, 'install.sh'), 'ShelfDock', 'public', 'payload.tar.gz', hash, '0.7.0', arch];
    const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH };
    const installed = await run('sh', scriptArgs, { env }); assert.match(installed.stdout, /DH_INSTALLED=yes/);
    assert.equal((await fs.stat(path.join(home, 'Applications', name, 'ShelfDock'))).isFile(), true);
    await assert.rejects(run('sh', scriptArgs, { env }), /already exists/);
    assert.ok(!(await fs.readdir(path.join(home, 'Applications'))).some(name => name.startsWith('.')));
    const launcher = path.join(home, '.local/share/applications', `ShelfDock-0.7.0-${arch}.desktop`);
    assert.match(await fs.readFile(launcher, 'utf8'), /\[Desktop Entry\]/);
    assert.match(await fs.readFile(launcher, 'utf8'), /Exec=".*ShelfDock"/);
    const rollbackHome = path.join(dir, 'rollback-' + arch); await fs.mkdir(rollbackHome);
    await fs.writeFile(path.join(bin, 'ln'), '#!/bin/sh\necho "Synthetic launcher publication failure" >&2\nexit 1\n', { mode: 0o755 });
    await assert.rejects(run('sh', scriptArgs, { env: { ...env, HOME: rollbackHome } }), /Synthetic launcher/);
    assert.deepEqual(await fs.readdir(path.join(rollbackHome, 'Applications')), []);
    assert.deepEqual(await fs.readdir(path.join(rollbackHome, '.local/share/applications')), []);


  }
});

test('electron-builder x86 portable launcher retains exact product/version checks for x64 assets', () => {
  const bytes = Buffer.alloc(2048); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0',64); bytes.writeUInt16LE(0x014c,68);
  Buffer.from(['ProductName','ShelfDock','ProductVersion','0.7.0',''].join('\0'), 'utf16le').copy(bytes,512);
  assert.equal(validateWindowsPortable(bytes, { arch: 'x64', version: '0.7.0', productName: 'ShelfDock', personal: false }), true);
  assert.throws(() => validateWindowsPortable(bytes, { arch: 'x64', version: '0.7.1', productName: 'ShelfDock', personal: false }), /identity/);
});
