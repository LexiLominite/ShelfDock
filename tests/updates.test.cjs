'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { UpdateManager, compareVersions, parseVersion, assetName, assertURL, requestStream, fetchBuffer, selectRelease, parseChecksums, hashFile, assertAppIdentity, API_URL } = require('../desktop/updates.cjs');
const { validateEntries, extractArchive, identifyInstallation, POSIX_HELPER, WINDOWS_HELPER } = require('../desktop/updates-install.cjs');
const { createPrivateTransport, privateEndpoint, AUTH_HELP } = require('../desktop/updates-gh.cjs');

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const data = Buffer.from('a verified package fixture, never executed');
function release(version = '0.6.0', { platform = 'linux', arch = 'x64', prerelease = false } = {}) {
  const name = assetName(version, platform, arch); const manifest = `${digest(data)}  ${name}\n`;
  return { tag_name: 'v' + version, draft: false, prerelease, body: 'Improved transfers.\n<script>not executable</script>', published_at: '2026-09-28T00:00:00Z', assets: [
    { name, browser_download_url: `https://github.com/LexiLominite/ShelfDock/releases/download/v${version}/${name}`, state: 'uploaded', size: data.length, digest: 'sha256:' + digest(data) },
    { name: 'SHA256SUMS.txt', browser_download_url: `https://github.com/LexiLominite/ShelfDock/releases/download/v${version}/SHA256SUMS.txt`, state: 'uploaded', size: Buffer.byteLength(manifest), digest: 'sha256:' + digest(manifest) }
  ] };
}
function fixtureStream(releases = [release()], overrides = {}) {
  const calls = [];
  const stream = async (url, { signal } = {}) => {
    calls.push(url); signal?.throwIfAborted(); let bytes;
    if (Object.hasOwn(overrides, url)) bytes = overrides[url];
    else if (url === API_URL) bytes = JSON.stringify(releases);
    else if (url.endsWith('SHA256SUMS.txt')) { const value = releases.find(item => url.includes('/' + item.tag_name + '/')); bytes = `${digest(data)}  ${value.assets[0].name}\n`; }
    else bytes = data;
    if (bytes instanceof Error) throw bytes;
    const readable = Readable.from([Buffer.from(bytes)]); readable.headers = { 'content-length': String(Buffer.byteLength(bytes)) }; return readable;
  };
  return { stream, calls };
}
async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-updates-test-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transport = fixtureStream();
  const manager = new UpdateManager({ dataDir: directory, version: '0.5.0', platform: 'linux', arch: 'x64', identify: async () => ({ available: false, reason: 'Fixture has no installed application.' }), stream: transport.stream, ...options });
  await manager.initialized; t.after(() => manager.shutdown()); return { manager, directory, ...transport };
}
test('semantic versions compare numeric releases, prereleases, and build metadata accurately', () => {
  assert.equal(compareVersions('0.10.0', '0.9.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.10'), 1);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
  for (const invalid of ['v1.0.0', '01.2.3', '1.2', '1.2.3-01', '../1.0.0', '1.0.0\n', '99999999999999999.0.0']) assert.equal(parseVersion(invalid), null);
});
test('release selection never downgrades or silently switches to prereleases', () => {
  const options = { version: '0.5.0', platform: 'linux', arch: 'x64', includePrereleases: false };
  assert.equal(selectRelease([release('0.4.9'), release('0.5.0')], options), null);
  assert.equal(selectRelease([release('0.6.0-beta.1'), release('0.7.0', { prerelease: true }), release('0.6.0')], options).version, '0.6.0');
  assert.equal(selectRelease([release('0.6.0'), release('0.10.0')], options).version, '0.10.0');
  assert.equal(selectRelease([{ ...release(), draft: true }], options), null);
});
test('only exact platform and processor assets are chosen', () => {
  assert.equal(assetName('1.0.0', 'darwin', 'x64'), null);
  assert.equal(assetName('1.0.0', 'win32', 'arm64'), null);
  assert.equal(assetName('1.0.0', 'linux', 'arm64'), 'ShelfDock-1.0.0-linux-arm64.tar.gz');
  const selected = selectRelease([release()], { version: '0.5.0', platform: 'darwin', arch: 'arm64', includePrereleases: true });
  assert.equal(selected.asset, null);
});
test('release metadata rejects injected hosts, wrong repository paths and oversized assets', () => {
  const options = { version: '0.5.0', platform: 'linux', arch: 'x64', includePrereleases: true };
  for (const url of ['https://evil.test/update', 'https://github.com/Attacker/ShelfDock/releases/download/v0.6.0/file', 'https://github.com/LexiLominite/ShelfDock/releases/download/v0.6.0/../secret']) {
    const candidate = release(); candidate.assets[0].browser_download_url = url; assert.throws(() => selectRelease([candidate], options), /metadata/);
  }
  const candidate = release(); candidate.assets[0].size = Number.MAX_SAFE_INTEGER; assert.throws(() => selectRelease([candidate], options), /metadata/);
});
test('checksum manifests require one exact flat filename and valid SHA256', () => {
  const name = 'ShelfDock-1.0.0-linux-x64.tar.gz', line = `${digest(data)}  ${name}`;
  assert.equal(parseChecksums(line + '\n', name), digest(data));
  for (const invalid of [line + '\n' + line, line.replace(name, '../' + name), line.replace(name, '/tmp/' + name), 'not a checksum', line.replace(name, name + '\nhttp://evil')]) assert.throws(() => parseChecksums(invalid, name));
});
test('HTTPS allowlist rejects credentials, ports, downgrade, non-GitHub and misleading hostnames', () => {
  for (const url of ['http://github.com/a', 'https://user:password@github.com/LexiLominite/ShelfDock/releases/download/x', 'https://github.com.evil.test/a', 'https://release-assets.githubusercontent.com:8080/a', 'file:///tmp/update', 'https://api.github.com/repos/Attacker/repo/releases', 'https://github.com/LexiLominite/ShelfDock/releases/download/x#hidden']) assert.throws(() => assertURL(url));
  assert.equal(assertURL('https://release-assets.githubusercontent.com/github-production-release-asset/test').protocol, 'https:');
  assert.throws(() => assertURL('https://release-assets.githubusercontent.com/a', { initial: true }));
});
test('redirects are validated before the next request and send no authorization header', async () => {
  const seen = [];
  const request = (url, options, callback) => {
    const emitter = new EventEmitter(); emitter.setTimeout = () => {}; emitter.destroy = error => emitter.emit('error', error);
    seen.push({ url: url.href, headers: options.headers });
    queueMicrotask(() => { const response = Readable.from([]); response.statusCode = 302; response.headers = { location: 'https://evil.test/package' }; callback(response); }); return emitter;
  };
  await assert.rejects(requestStream(API_URL, { request }), /outside official/);
  assert.equal(seen.length, 1); assert.equal(seen[0].headers.Authorization, undefined);
});
test('metadata response is bounded even without Content-Length', async () => {
  const stream = async () => { const value = Readable.from([Buffer.alloc(20), Buffer.alloc(20)]); value.headers = {}; return value; };
  await assert.rejects(fetchBuffer(API_URL, { stream, limit: 30 }), /too large/);
});
test('update checks and downloads default off and persist only explicit choices', async t => {
  const { manager, directory, calls } = await fixture(t); await manager.start(); assert.equal(calls.length, 0);
  assert.deepEqual(manager.snapshot().preferences, { autoCheck: false, autoDownload: false, includePrereleases: true });
  await manager.updatePreferences({ autoCheck: true, autoDownload: true, includePrereleases: false });
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'updates/public/preferences.json'), 'utf8'));
  assert.equal(saved.autoCheck, true); assert.equal(saved.autoDownload, true);
  await manager.updatePreferences({ autoCheck: false }); assert.equal(manager.snapshot().preferences.autoDownload, false);
  await assert.rejects(manager.updatePreferences({ arbitrary: true }), /Invalid/);
});
test('discovery, verified download, restart restoration and file reveal complete end to end', async t => {
  let revealed;
  const { manager, directory, calls, stream } = await fixture(t, { revealFile: file => { revealed = file; } });
  assert.equal((await manager.check()).status, 'available');
  const ready = await manager.download(); assert.equal(ready.status, 'downloaded'); assert.equal(ready.downloaded.sha256, digest(data));
  assert.equal(calls.length, 3); assert.deepEqual(await fs.readFile(manager.downloaded.file), data);
  await manager.revealDownload(); assert.equal(revealed, manager.downloaded.file);
  const restored = new UpdateManager({ dataDir: directory, version: '0.5.0', platform: 'linux', arch: 'x64', stream, identify: async () => ({ available: false }) }); await restored.initialized; t.after(() => restored.shutdown());
  assert.equal(restored.snapshot().status, 'downloaded'); assert.equal(restored.snapshot().downloaded.sha256, digest(data));
});
test('corrupted downloads are deleted and cannot become installable', async t => {
  const candidate = release(); const transport = fixtureStream([candidate], { [candidate.assets[0].browser_download_url]: Buffer.alloc(data.length, 42) });
  const { manager, directory } = await fixture(t, { stream: transport.stream }); await manager.check(); const state = await manager.download();
  assert.equal(state.status, 'available'); assert.match(state.error, /SHA-256/); assert.equal(state.downloaded, null);
  assert.equal((await fs.readdir(path.join(directory, 'updates/public'))).some(name => name.endsWith('.part') || name.endsWith('.tar.gz')), false);
});
test('conflicting GitHub digest and release manifest fail before downloading the binary', async t => {
  const candidate = release(); candidate.assets[0].digest = 'sha256:' + 'a'.repeat(64); const transport = fixtureStream([candidate]);
  const { manager } = await fixture(t, { stream: transport.stream }); await manager.check(); const state = await manager.download();
  assert.match(state.error, /disagree/); assert.equal(transport.calls.length, 2);
});
test('interrupted partial files are removed and changed cached packages are not restored', async t => {
  const { manager, directory, stream } = await fixture(t); await manager.check(); await manager.download();
  await fs.writeFile(manager.downloaded.file, 'tampered'); const part = path.join(directory, 'updates/public/download-' + crypto.randomUUID() + '.part'); await fs.writeFile(part, 'partial');
  const restored = new UpdateManager({ dataDir: directory, version: '0.5.0', platform: 'linux', arch: 'x64', stream, identify: async () => ({ available: false }) }); await restored.initialized; t.after(() => restored.shutdown());
  assert.equal(restored.snapshot().downloaded, null); await assert.rejects(fs.access(part));
});
test('personal edition queries only its private API after explicit action and preserves edition assets', async t => {
  const urls = []; const candidate = release();
  candidate.assets = candidate.assets.map((asset, index) => ({...asset, id: 123 + index, name: asset.name.replace('ShelfDock-', 'LexBridge-personal-'), browser_download_url: asset.browser_download_url.replace('LexiLominite/ShelfDock', 'LexiLominite/LexBridge-private').replace('/ShelfDock-', '/LexBridge-personal-')}));
  const manifest = `${digest(data)}  ${candidate.assets[0].name}\n`; candidate.assets[1].digest = 'sha256:' + digest(manifest);
  const stream = async url => { urls.push(url); const bytes = url.includes('/assets/124') ? manifest : url.includes('/assets/123') ? data : JSON.stringify([candidate]); const response = Readable.from([Buffer.from(bytes)]); response.headers = {}; return response; };
  const opened = []; const { manager } = await fixture(t, {personal: true, stream, openExternal: async url => opened.push(url)});
  await manager.start(); assert.equal(urls.length, 0); await manager.check(); await manager.download();
  assert.equal(manager.state.status, 'downloaded'); assert.ok(urls.every(url => url.startsWith('https://api.github.com/repos/LexiLominite/LexBridge-private/')));
  assert.equal(manager.downloaded.name, 'LexBridge-personal-0.6.0-linux-x64.tar.gz'); await manager.openRelease(); assert.deepEqual(opened, ['https://github.com/LexiLominite/LexBridge-private/releases']);
});
test('in-flight download cancellation removes the partial file and remains retryable', async t => {
  const transport = fixtureStream(); let downloading;
  const started = new Promise(resolve => { downloading = resolve; });
  const stream = async (url, options) => {
    if (url.endsWith('.tar.gz')) {
      const readable = new Readable({ read() {} }); readable.headers = {};
      options.signal.addEventListener('abort', () => readable.destroy(new Error('aborted')), { once: true });
      readable.push(data.subarray(0, 4)); downloading(); return readable;
    }
    return transport.stream(url, options);
  };
  const { manager, directory } = await fixture(t, { stream }); await manager.check(); const operation = manager.download(); await started; await manager.cancel(); const result = await operation;
  assert.equal(result.status, 'available'); assert.match(result.error, /cancelled/); assert.equal(result.downloaded, null);
  assert.equal((await fs.readdir(path.join(directory, 'updates/public'))).some(name => name.endsWith('.part')), false);
});
test('busy installations refuse to restart or stage an update', async t => {
  let quit = 0; const { manager } = await fixture(t, { isBusy: () => 'Stop the live forward first.', quit: () => quit++ });
  await manager.check(); await manager.download(); await assert.rejects(manager.install(), /live forward/); assert.equal(quit, 0);
});
test('archive paths reject traversal, absolute paths, duplicate case, escaping links and links as parents', () => {
  const regular = name => ({ name, type: 'file', size: 1 });
  for (const name of ['../file', '/tmp/file', 'App/../file', 'App/./file', 'App/C:\\file', 'App/file\0x']) assert.throws(() => validateEntries([regular(name)], 'App'));
  assert.throws(() => validateEntries([regular('App/Foo'), regular('App/foo')], 'App'), /duplicate/);
  assert.throws(() => validateEntries([{ name: 'App/link', type: 'symlink', size: 3, link: '../../escape' }], 'App'), /leaves/);
  assert.throws(() => validateEntries([{ name: 'App/link', type: 'symlink', size: 1, link: 'safe' }, regular('App/link/file')], 'App'), /passes through/);
  assert.throws(() => validateEntries([{ name: 'App/file', type: 'hardlink', size: 1 }], 'App'), /unsupported/);
  assert.doesNotThrow(() => validateEntries([{ name: 'App/Framework/Current', type: 'symlink', size: 1, link: 'A' }], 'App'));
});
function zipFile(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.body || ''), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode || 0x81ed) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name); offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
test('ZIP extraction writes regular files before internal symlinks and strips privilege bits', async t => {
  const { directory } = await fixture(t); const archive = path.join(directory, 'test.zip');
  await fs.writeFile(archive, zipFile([{ name: 'App/bin/run', body: 'hello', mode: 0x89ed }, { name: 'App/bin/link', body: 'run', mode: 0xa1ff }]));
  const destination = path.join(directory, 'stage'); await extractArchive({ file: archive, destination, format: 'zip', root: 'App' });
  assert.equal(await fs.readFile(path.join(destination, 'App/bin/link'), 'utf8'), 'hello'); assert.equal((await fs.stat(path.join(destination, 'App/bin/run'))).mode & 0o7000, 0);
});
test('malicious archive is rejected before any path escapes the staging folder', async t => {
  const { directory } = await fixture(t); const archive = path.join(directory, 'malicious.zip'); await fs.writeFile(archive, zipFile([{ name: '../escaped', body: 'not written' }]));
  const destination = path.join(directory, 'stage'); await assert.rejects(extractArchive({ file: archive, destination, format: 'zip', root: 'App' }), /unsafe/);
  await assert.rejects(fs.access(path.join(directory, 'escaped'))); await assert.rejects(fs.access(destination));
});
test('TAR extraction accepts packaged Linux layout and preserves executable mode', async t => {
  const { directory } = await fixture(t); const root = 'ShelfDock-0.6.0-linux-x64'; await fs.mkdir(path.join(directory, root)); await fs.writeFile(path.join(directory, root, 'ShelfDock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const archive = path.join(directory, 'update.tar.gz'); await execFile('tar', ['-czf', archive, '-C', directory, root], {env: {...process.env, COPYFILE_DISABLE: '1'}});
  const extracted = await extractArchive({ file: archive, destination: path.join(directory, 'unpacked'), format: 'tar.gz', root });
  assert.equal(await fs.readFile(path.join(extracted, 'ShelfDock'), 'utf8'), '#!/bin/sh\nexit 0\n'); assert.ok((await fs.stat(path.join(extracted, 'ShelfDock'))).mode & 0o100);
});
test('installation discovery rejects custom executable paths, personal builds and symlinks', async t => {
  assert.equal((await identifyInstallation({ personal: true })).available, false);
  assert.equal((await identifyInstallation({ isPackaged: false })).available, false);
  assert.equal((await identifyInstallation({ isPackaged: true, platform: 'darwin', execPath: '/tmp/Bad.app/Contents/MacOS/Bad' })).available, false);
  const { directory } = await fixture(t); const app = path.join(directory, 'ShelfDock'); await fs.mkdir(path.join(app, 'resources'), { recursive: true }); await fs.writeFile(path.join(app, 'resources/app.asar'), 'fixture');
  const executable = path.join(app, 'ShelfDock'); await fs.writeFile(executable, 'fixture'); assert.equal((await identifyInstallation({ isPackaged: true, platform: 'linux', execPath: executable })).available, true);
  await fs.symlink(app, path.join(directory, 'Linked')); assert.equal((await identifyInstallation({ isPackaged: true, platform: 'linux', execPath: path.join(directory, 'Linked/ShelfDock') })).available, false);
});
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function helperFixture(t, { invalidExecutable = false, waiting = false } = {}) {
  const { directory } = await fixture(t), target = path.join(directory, 'App with spaces'), staged = path.join(directory, 'Stage'), backup = path.join(directory, 'Backup'), result = path.join(directory, 'result.json'), ready = path.join(directory, 'ready'), launched = path.join(directory, 'launched'), oldLaunched = path.join(directory, 'old-launched');
  await fs.mkdir(target); await fs.mkdir(staged); await fs.writeFile(path.join(target, 'ShelfDock'), `#!/bin/sh\nprintf old > ${quote(oldLaunched)}\n`, { mode: 0o755 });
  if (!invalidExecutable) await fs.writeFile(path.join(staged, 'ShelfDock'), `#!/bin/sh\nprintf new > ${quote(launched)}\n`, { mode: 0o755 });
  const stat = await fs.stat(target), script = path.join(directory, 'apply.sh');
  // Use the local host's stat implementation while exercising the Linux launch branch on macOS.
  const helperText = process.platform === 'darwin' ? POSIX_HELPER.replace("stat -c '%d:%i'", "/usr/bin/stat -f '%d:%i'") : POSIX_HELPER;
  await fs.writeFile(script, helperText);
  const parent = waiting ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' }) : null;
  if (parent) t.after(() => parent.kill());
  const child = spawn('/bin/sh', [script, String(parent?.pid || 99999999), target, staged, backup, result, ready, 'linux', `${stat.dev}:${stat.ino}`, 'ShelfDock'], { stdio: 'ignore' });
  t.after(() => child.kill()); const done = new Promise(resolve => child.once('exit', code => resolve(code)));
  return { directory, target, staged, backup, result, ready, launched, oldLaunched, parent, child, done };
}
test('portable apply helper waits for its exact parent, backs up and atomically replaces an app', async t => {
  const value = await helperFixture(t, { waiting: true });
  for (let i = 0; i < 50; i++) { try { await fs.access(value.ready); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  await assert.rejects(fs.access(value.backup)); assert.match(await fs.readFile(path.join(value.target, 'ShelfDock'), 'utf8'), /old-launched/);
  value.parent.kill(); assert.equal(await value.done, 0);
  assert.equal(JSON.parse(await fs.readFile(value.result, 'utf8')).status, 'installed');
  assert.match(await fs.readFile(path.join(value.backup, 'ShelfDock'), 'utf8'), /old-launched/);
  for (let i = 0; i < 500; i++) { try { await fs.access(value.launched); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
  assert.equal(await fs.readFile(value.launched, 'utf8'), 'new');
});
test('portable apply helper rolls back an unlaunchable staged app without removing the old one', async t => {
  const value = await helperFixture(t, { invalidExecutable: true }); assert.equal(await value.done, 1);
  assert.equal(JSON.parse(await fs.readFile(value.result, 'utf8')).status, 'rolled_back'); assert.match(await fs.readFile(path.join(value.target, 'ShelfDock'), 'utf8'), /old-launched/);
});
for (const action of ['revealDownload', 'install']) for (const damage of ['changed', 'missing']) {
  test(`${action} invalidates a ${damage} package and permits only a verified retry`, async t => {
    const candidate = release(), overrides = {}, transport = fixtureStream([candidate], overrides), events = [];
    let revealed = 0, spawned = 0, quit = 0;
    const { manager } = await fixture(t, { stream: transport.stream, onChange: state => events.push(state), identify: async () => ({ available: true, target: '/unused/test-app', identity: '1:2' }), revealFile: () => revealed++, spawnProcess: () => spawned++, quit: async () => quit++ });
    await manager.check(); await manager.download(); const file = manager.downloaded.file, journal = path.join(manager.directory, 'download.json');
    // Equal size ensures changed content is detected by hashing, not just a length check.
    if (damage === 'changed') await fs.writeFile(file, Buffer.alloc(data.length, 42)); else await fs.unlink(file);
    await assert.rejects(manager[action](), /missing or changed.*Download it again/);
    const state = manager.snapshot(); assert.equal(state.status, 'available'); assert.equal(state.downloaded, null); assert.equal(state.canInstall, false); assert.equal(state.canDownload, true); assert.equal(state.progress, null); assert.equal(state.release.version, '0.6.0');
    assert.equal(events.at(-1).status, 'available'); assert.equal(events.at(-1).downloaded, null);
    assert.equal(revealed, 0); assert.equal(spawned, 0); assert.equal(quit, 0);
    await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); await assert.rejects(fs.lstat(journal), { code: 'ENOENT' });
    overrides[candidate.assets[0].browser_download_url] = Buffer.alloc(data.length, 42);
    const rejected = await manager.download(); assert.equal(rejected.downloaded, null); assert.match(rejected.error, /SHA-256/);
    delete overrides[candidate.assets[0].browser_download_url];
    const retried = await manager.download(); assert.equal(retried.status, 'downloaded'); assert.equal(retried.error, ''); assert.equal(retried.downloaded.sha256, digest(data)); assert.deepEqual(await fs.readFile(manager.downloaded.file), data);
    assert.equal(JSON.parse(await fs.readFile(journal, 'utf8')).sha256, digest(data));
    assert.equal(transport.calls.filter(url => url.endsWith('SHA256SUMS.txt')).length, 3);
    assert.equal(transport.calls.filter(url => url.endsWith('.tar.gz')).length, 3);
  });
}
for (const action of ['revealDownload', 'install']) {
  test(`${action} removes cache symlinks without following package or journal targets`, async t => {
    const { manager, directory } = await fixture(t, { identify: async () => ({ available: true, target: '/unused/test-app', identity: '1:2' }) });
    await manager.check(); await manager.download();
    const file = manager.downloaded.file, journal = path.join(manager.directory, 'download.json'), outside = path.join(directory, 'outside-package'), outsideJournal = path.join(directory, 'outside-journal');
    await fs.writeFile(outside, data); await fs.writeFile(outsideJournal, 'retained record');
    await fs.unlink(file); await fs.symlink(outside, file); await fs.unlink(journal); await fs.symlink(outsideJournal, journal);
    await assert.rejects(manager[action](), /missing or changed/);
    assert.deepEqual(await fs.readFile(outside), data); assert.equal(await fs.readFile(outsideJournal, 'utf8'), 'retained record');
    await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); await assert.rejects(fs.lstat(journal), { code: 'ENOENT' });
    assert.equal((await manager.download()).status, 'downloaded'); assert.equal((await fs.lstat(manager.downloaded.file)).isSymbolicLink(), false);
  });
  test(`${action} invalidation never deletes a metadata path outside the owned cache`, async t => {
    const { manager, directory } = await fixture(t, { identify: async () => ({ available: true, target: '/unused/test-app', identity: '1:2' }) });
    await manager.check(); await manager.download(); const outside = path.join(directory, manager.downloaded.name); await fs.writeFile(outside, data); manager.downloaded.file = outside;
    await assert.rejects(manager[action](), /missing or changed/);
    assert.deepEqual(await fs.readFile(outside), data); assert.equal(manager.snapshot().downloaded, null); await assert.rejects(fs.lstat(path.join(manager.directory, 'download.json')), { code: 'ENOENT' });
    assert.equal((await manager.download()).status, 'downloaded');
  });
  test(`${action} invalidates a restored cache and allows retry after refreshing release metadata`, async t => {
    const { manager, directory, stream } = await fixture(t); await manager.check(); await manager.download(); await manager.shutdown();
    const restored = new UpdateManager({ dataDir: directory, version: '0.5.0', platform: 'linux', arch: 'x64', stream, identify: async () => ({ available: true, target: '/unused/test-app', identity: '1:2' }) });
    await restored.initialized; t.after(() => restored.shutdown()); assert.equal(restored.snapshot().status, 'downloaded'); await fs.unlink(restored.downloaded.file);
    await assert.rejects(restored[action](), /Check for updates, then download it again/); assert.equal(restored.snapshot().status, 'available'); assert.equal(restored.snapshot().downloaded, null);
    await restored.check(); assert.equal(restored.snapshot().canDownload, true); const retry = await restored.download(); assert.equal(retry.status, 'downloaded'); assert.equal(retry.downloaded.sha256, digest(data));
  });
}
test('cache invalidation and retry do not follow a replaced cache directory', async t => {
  const { manager, directory, calls } = await fixture(t); await manager.check(); await manager.download();
  const outside = path.join(directory, 'outside-cache'), previous = path.join(directory, 'original-cache'), name = manager.downloaded.name;
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, name), data); await fs.writeFile(path.join(outside, 'download.json'), 'retained record');
  await fs.rename(manager.directory, previous); await fs.symlink(outside, manager.directory);
  await assert.rejects(manager.revealDownload(), /missing or changed/); assert.equal(manager.snapshot().downloaded, null);
  await assert.rejects(manager.download(), /cache changed/); assert.equal(calls.length, 3);
  assert.deepEqual(await fs.readFile(path.join(outside, name)), data); assert.equal(await fs.readFile(path.join(outside, 'download.json'), 'utf8'), 'retained record');
  assert.deepEqual(await fs.readFile(path.join(previous, name)), data); await fs.access(path.join(previous, 'download.json'));
});
test('Windows helper uses literal paths, old/new hashes, process wait and rollback without changing execution policy', () => {
  assert.match(WINDOWS_HELPER, /Get-FileHash -LiteralPath \$p.target/); assert.match(WINDOWS_HELPER, /Get-FileHash -LiteralPath \$p.staged/);
  assert.match(WINDOWS_HELPER, /Get-Process -Id \$p.pid/); assert.match(WINDOWS_HELPER, /Result 'rolled_back'/);
  assert.doesNotMatch(WINDOWS_HELPER, /ExecutionPolicy|Invoke-Expression|EncodedCommand/);
});
test('hashFile matches SHA256 without loading the whole package into a buffer', async t => {
  const { directory } = await fixture(t); const file = path.join(directory, 'package'); await fs.writeFile(file, data); assert.equal(await hashFile(file), digest(data));
});
test('background test mode touches no updater files and never performs network or browser operations', async t => {
  const { directory } = await fixture(t); const absent = path.join(directory, 'do-not-create'); let calls = 0;
  const manager = new UpdateManager({ dataDir: absent, version: '0.5.0', enabled: false, stream: async () => { calls++; }, openExternal: async () => { calls++; } });
  await manager.initialized; await manager.start(); await assert.rejects(manager.check(), /disabled/); await assert.rejects(manager.openRelease(), /disabled/); await assert.rejects(manager.updatePreferences({ autoCheck: true }), /disabled/);
  assert.equal(calls, 0); await assert.rejects(fs.access(absent)); await manager.shutdown();
});
test('a broken updater cache cannot prevent the rest of the app starting', async t => {
  const { directory } = await fixture(t); const root = path.join(directory, 'broken'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'updates'), 'not a folder');
  const manager = new UpdateManager({ dataDir: root, version: '0.5.0' }); await manager.initialized;
  assert.equal(manager.snapshot().status, 'error'); assert.match(manager.snapshot().error, /rest of the app/); await manager.shutdown();
});
test('automatic update consent is scoped to the edition repository', async t => {
  const { manager, directory } = await fixture(t); await manager.updatePreferences({ autoCheck: true, autoDownload: true });
  const personal = new UpdateManager({ dataDir: directory, version: '0.5.0', personal: true, identify: async () => ({ available: false }) }); await personal.initialized;
  assert.equal(personal.snapshot().preferences.autoCheck, false); assert.equal(personal.snapshot().preferences.autoDownload, false); await personal.shutdown();
});
test('chained archive symlinks cannot escape even when each individual target normalizes inside', async t => {
  const { directory } = await fixture(t); const archive = path.join(directory, 'links.zip');
  await fs.writeFile(archive, zipFile([{ name: 'App/one/file', body: 'safe' }, { name: 'App/b', body: '.', mode: 0xa1ff }, { name: 'App/one/a', body: '../b/../outside', mode: 0xa1ff }]));
  const destination = path.join(directory, 'stage'); await assert.rejects(extractArchive({ file: archive, destination, format: 'zip', root: 'App' })); await assert.rejects(fs.access(destination));
});
test('Linux common personal folders are never treated as replaceable applications', async t => {
  const { directory } = await fixture(t); const desktop = path.join(directory, 'Desktop'); await fs.mkdir(path.join(desktop, 'resources'), { recursive: true }); await fs.writeFile(path.join(desktop, 'resources/app.asar'), 'fixture'); await fs.writeFile(path.join(desktop, 'ShelfDock'), 'fixture');
  const result = await identifyInstallation({ platform: 'linux', execPath: path.join(desktop, 'ShelfDock'), isPackaged: true }); assert.equal(result.available, false); assert.match(result.reason, /unrelated files/);
});
test('private transport accepts only fixed repository list and numeric asset endpoints', () => {
  assert.equal(privateEndpoint('https://api.github.com/repos/LexiLominite/LexBridge-private/releases?per_page=100'), 'repos/LexiLominite/LexBridge-private/releases?per_page=100');
  assert.match(privateEndpoint('https://api.github.com/repos/LexiLominite/LexBridge-private/releases/assets/123'), /assets\/123$/);
  for (const url of [API_URL, 'https://api.github.com/repos/LexiLominite/LexBridge-private/releases/assets/../1', 'https://evil.test/repos/LexiLominite/LexBridge-private/releases', 'https://api.github.com/repos/LexiLominite/LexBridge-private/releases?per_page=100&secret=x']) assert.throws(() => privateEndpoint(url));
});
test('private transport uses GitHub CLI with fixed arguments and never captures authentication secrets', async () => {
  const calls = [];
  const spawnProcess = (file, args, options) => {
    calls.push({ file, args, options }); const child = new EventEmitter(); child.stdout = new Readable({ read() {} }); child.stderr = new Readable({ read() {} }); child.kill = () => {};
    queueMicrotask(() => { child.stdout.push('[]'); child.stdout.push(null); child.stderr.push('a private diagnostic which must not be surfaced'); child.stderr.push(null); setImmediate(() => child.emit('close', 0)); }); return child;
  };
  const stream = createPrivateTransport({ findGh: async () => '/trusted/gh', spawnProcess, env: { PATH: '/trusted' } });
  const bytes = await fetchBuffer('https://api.github.com/repos/LexiLominite/LexBridge-private/releases?per_page=100', { stream }); assert.equal(bytes.toString(), '[]');
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.env.GH_PROMPT_DISABLED, '1'); assert.deepEqual(calls[0].args.slice(0, 3), ['api', '--hostname', 'github.com']); assert.equal(calls[0].args.includes('auth'), false);
});
test('missing GitHub CLI produces an actionable private-only setup error', async () => {
  const stream = createPrivateTransport({ findGh: async () => { throw new Error(AUTH_HELP); } });
  await assert.rejects(fetchBuffer('https://api.github.com/repos/LexiLominite/LexBridge-private/releases?per_page=100', { stream }), /gh auth login/);
});
test('private CLI failure does not expose stderr and cancellation terminates only its child', async () => {
  let child, killed = 0;
  const stream = createPrivateTransport({ findGh: async () => '/trusted/gh', spawnProcess: () => {
    child = new EventEmitter(); child.stdout = new Readable({ read() {} }); child.stderr = new Readable({ read() {} }); child.kill = () => { killed++; setImmediate(() => child.emit('close', 1)); }; return child;
  } });
  const controller = new AbortController(); const response = await stream('https://api.github.com/repos/LexiLominite/LexBridge-private/releases/assets/123', { signal: controller.signal });
  const consume = (async () => { for await (const _ of response) {} })(); child.stderr.push('ghp_secret-fixture-never-return'); controller.abort(); await assert.rejects(consume, /cancelled/); assert.ok(killed >= 1);
});
test('private release selection rejects public-edition assets and missing authenticated asset IDs', () => {
  assert.throws(() => selectRelease([release()], { version: '0.5.0', platform: 'linux', arch: 'x64', personal: true, includePrereleases: true }), /metadata/);
  const candidate = release(); candidate.assets[0].name = candidate.assets[0].name.replace('ShelfDock-', 'LexBridge-personal-'); candidate.assets[0].browser_download_url = candidate.assets[0].browser_download_url.replace('LexiLominite/ShelfDock', 'LexiLominite/LexBridge-private').replace('/ShelfDock-', '/LexBridge-personal-');
  assert.throws(() => selectRelease([candidate], { version: '0.5.0', platform: 'linux', arch: 'x64', personal: true, includePrereleases: true }), /asset identifier/);
});
test('rejected async quit cancels the helper and leaves the current portable app intact', async t => {
  const candidate = release('0.6.0', { platform: 'win32' }), transport = fixtureStream([candidate]); let killed = 0;
  const { directory } = await fixture(t); const target = path.join(directory, 'ShelfDock.exe'); await fs.writeFile(target, 'old app');
  const manager = new UpdateManager({ dataDir: directory, version: '0.5.0', platform: 'win32', arch: 'x64', stream: transport.stream, identify: async () => ({ available: true, target, identity: '1:2' }), quit: async () => { throw new Error('Profile save failed.'); }, spawnProcess: (_file, args) => {
    const child = new EventEmitter(); child.unref = () => {}; child.kill = () => { killed++; };
    const plan = JSON.parse(require('node:fs').readFileSync(args[args.indexOf('-Plan') + 1], 'utf8')); require('node:fs').writeFileSync(plan.ready, 'ready'); return child;
  } }); await manager.initialized; t.after(() => manager.shutdown()); await manager.check(); await manager.download(); await assert.rejects(manager.install(), /Profile save failed/);
  assert.equal(manager.state.status, 'downloaded'); assert.equal(killed, 1); assert.equal(await fs.readFile(target, 'utf8'), 'old app'); assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.shelfdock-update-')), false);
});
test('manager download, stage, helper handshake, backup, replacement and quiet relaunch complete on an isolated fixture', async t => {
  const { directory } = await fixture(t); const target = path.join(directory, 'ShelfDock'), archiveRoot = 'ShelfDock-0.6.0-linux-x64', packageFolder = path.join(directory, archiveRoot), marker = path.join(directory, 'new-version-started');
  for (const folder of [target, packageFolder]) { await fs.mkdir(path.join(folder, 'resources'), { recursive: true }); await fs.writeFile(path.join(folder, 'resources/app.asar'), 'fixture asar'); }
  await fs.writeFile(path.join(target, 'ShelfDock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); await fs.writeFile(path.join(packageFolder, 'ShelfDock'), `#!/bin/sh\nprintf launched > ${quote(marker)}\n`, { mode: 0o755 });
  const archive = path.join(directory, 'package.tar.gz'); await execFile('tar', ['-czf', archive, '-C', directory, archiveRoot], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const payload = await fs.readFile(archive), candidate = release(); candidate.assets[0].size = payload.length; candidate.assets[0].digest = 'sha256:' + digest(payload); const manifest = `${digest(payload)}  ${candidate.assets[0].name}\n`; candidate.assets[1].digest = 'sha256:' + digest(manifest);
  const stream = async url => { const bytes = url === API_URL ? JSON.stringify([candidate]) : url.endsWith('SHA256SUMS.txt') ? manifest : payload; const readable = Readable.from([Buffer.from(bytes)]); readable.headers = {}; return readable; };
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' }); t.after(() => parent.kill()); let helper, quitFinished = false;
  const manager = new UpdateManager({ dataDir: directory, version: '0.5.0', platform: 'linux', arch: 'x64', isPackaged: true, execPath: path.join(target, 'ShelfDock'), stream, validateApp: async (bundle, platform, version) => { assert.equal(platform, 'linux'); assert.equal(version, '0.6.0'); assert.equal(await fs.readFile(path.join(bundle, 'resources/app.asar'), 'utf8'), 'fixture asar'); }, spawnProcess: (file, args, options) => {
    const adapted = [...args]; adapted[1] = String(parent.pid);
    if (process.platform === 'darwin') { const sync = require('node:fs'); sync.writeFileSync(adapted[0], sync.readFileSync(adapted[0], 'utf8').replace("stat -c '%d:%i'", "/usr/bin/stat -f '%d:%i'")); }
    helper = spawn(file, adapted, options); t.after(() => helper.kill()); return helper;
  }, quit: async () => { await new Promise(resolve => setTimeout(resolve, 5)); quitFinished = true; parent.kill(); } });
  await manager.initialized; t.after(() => manager.shutdown()); await manager.check(); await manager.download(); const result = await manager.install(); assert.equal(quitFinished, true); assert.equal(result.status, 'installing');
  for (let i = 0; i < 500; i++) { try { await fs.access(marker); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
  assert.equal(await fs.readFile(marker, 'utf8'), 'launched'); const plan = JSON.parse(await fs.readFile(path.join(directory, 'updates/public/install.json'), 'utf8')); assert.equal(await fs.readFile(path.join(plan.backup, 'ShelfDock'), 'utf8'), '#!/bin/sh\nexit 0\n');
  const restarted = new UpdateManager({ dataDir: directory, version: '0.6.0', platform: 'linux', arch: 'x64', isPackaged: true, execPath: path.join(target, 'ShelfDock'), stream }); await restarted.initialized; assert.equal(restarted.snapshot().result.status, 'installed'); await restarted.shutdown();
});
async function installRecordFixture(t, { runningVersion = '0.6.0', helperStatus = 'installed', keepBackup = true } = {}) {
  const { directory, manager } = await fixture(t), id = crypto.randomUUID();
  const journal = path.join(manager.directory, 'install.json'), result = path.join(manager.directory, 'result-' + id + '.json'), ready = path.join(manager.directory, 'ready-' + id), backup = path.join(directory, '.shelfdock-backup-' + id);
  if (keepBackup) { await fs.mkdir(backup); await fs.writeFile(path.join(backup, 'old-app'), 'retained application'); }
  await fs.writeFile(journal, JSON.stringify({ id, repository: 'LexiLominite/ShelfDock', version: '0.6.0', backup }));
  await fs.writeFile(result, JSON.stringify({ status: helperStatus })); await fs.writeFile(ready, 'ready');
  const restarted = new UpdateManager({ dataDir: directory, version: runningVersion, platform: 'linux', arch: 'x64', identify: async () => ({ available: false }) });
  await restarted.initialized; t.after(() => restarted.shutdown()); return { directory, restarted, journal, result, ready, backup };
}
test('a successful install is reported once and its consumed journal is removed without deleting the app backup', async t => {
  const value = await installRecordFixture(t);
  assert.deepEqual(value.restarted.snapshot().result, { status: 'installed', version: '0.6.0', backupRetained: true });
  for (const file of [value.journal, value.result, value.ready]) await assert.rejects(fs.access(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(value.backup, 'old-app'), 'utf8'), 'retained application');
  const nextStart = new UpdateManager({ dataDir: value.directory, version: '0.6.0', platform: 'linux', arch: 'x64', identify: async () => ({ available: false }) });
  await nextStart.initialized; assert.equal(nextStart.snapshot().result, null); await nextStart.shutdown();
});
test('a newer manually installed version clears an older failed journal without showing a stale warning', async t => {
  const value = await installRecordFixture(t, { runningVersion: '0.7.0', helperStatus: 'failed' });
  assert.equal(value.restarted.snapshot().result, null);
  for (const file of [value.journal, value.result, value.ready]) await assert.rejects(fs.access(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(value.backup, 'old-app'), 'utf8'), 'retained application');
});
test('the older app retains a failed update journal for recovery and retry', async t => {
  const value = await installRecordFixture(t, { runningVersion: '0.5.0', helperStatus: 'rolled_back', keepBackup: false });
  assert.deepEqual(value.restarted.snapshot().result, { status: 'rolled_back', version: '0.6.0', backupRetained: false });
  for (const file of [value.journal, value.result, value.ready]) await fs.access(file);
});
test('a helper launch result cannot report a successful upgrade while the older app is running', async t => {
  const value = await installRecordFixture(t, { runningVersion: '0.5.0', helperStatus: 'installed' });
  assert.equal(value.restarted.snapshot().result.status, 'interrupted'); await fs.access(value.journal); await fs.access(value.result);
});
test('automatic downloads leave releases with missing platform packages or checksums available without throwing', async t => {
  for (const missing of ['platform', 'checksum']) {
    const candidate = release('0.6.0', missing === 'platform' ? { platform: 'darwin', arch: 'arm64' } : {});
    if (missing === 'checksum') candidate.assets = candidate.assets.filter(asset => asset.name !== 'SHA256SUMS.txt');
    const transport = fixtureStream([candidate]), { manager } = await fixture(t, { stream: transport.stream });
    await manager.updatePreferences({ autoCheck: true, autoDownload: true });
    const state = await manager.check(); assert.equal(state.status, 'available', missing); assert.equal(state.error, '', missing); assert.equal(state.release.version, '0.6.0', missing); assert.equal(state.canDownload, false, missing); assert.equal(state.downloaded, null, missing); assert.deepEqual(transport.calls, [API_URL], missing);
  }
});
