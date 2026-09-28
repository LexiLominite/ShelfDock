'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { MacInstaller, BUNDLE_ID } = require('../desktop/mac-installer.cjs');
const execute = promisify(execFile);
const mac = { skip: process.platform !== 'darwin' };
async function fixture(t, { password = false, preset = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-installer-test-')));
  const home = path.join(root, "Mac user's home"); const app = path.join(root, 'ShelfDock.app');
  await fs.mkdir(home); await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true }); await fs.mkdir(path.join(app, 'Contents/Resources'));
  const architecture = String((await execute('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])).stdout).trim() === '1' ? 'arm64' : 'x64';
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4); header.writeUInt32LE(2, 12);
  await fs.writeFile(path.join(app, 'Contents/MacOS/ShelfDock'), header, { mode: 0o755 });
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string><key>CFBundleShortVersionString</key><string>0.4.1</string><key>CFBundleExecutable</key><string>ShelfDock</string></dict></plist>`;
  await fs.writeFile(path.join(app, 'Contents/Info.plist'), plist);
  await fs.writeFile(path.join(app, 'Contents/Resources/app.asar'), 'fictional packaged app');
  await fs.mkdir(path.join(app, 'Contents/Frameworks/Example.framework/Versions/A'), { recursive: true });
  await fs.writeFile(path.join(app, 'Contents/Frameworks/Example.framework/Versions/A/example'), 'fixture framework');
  await fs.symlink('A', path.join(app, 'Contents/Frameworks/Example.framework/Versions/Current'));
  if (preset) await fs.writeFile(path.join(app, 'Contents/Resources/personal-config.json'), '{"fixture":true}');
  const host = { id: 'fixture', name: 'Fictional Mac', user: 'fixture', address: 'example.invalid', port: 2222, os: 'posix', status: 'ready' };
  const calls = []; const changes = []; let now = 1000; let stage; let hook; let block;
  const remote = async command => {
    calls.push({ kind: 'remote', command });
    if (block) await block;
    if (hook) { const value = await hook(command); if (value !== undefined) return value; }
    const result = await execute('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home }, timeout: 15000 });
    const match = /^DH_STAGE_B64=(.+)$/m.exec(result.stdout); if (match) stage = Buffer.from(match[1], 'base64').toString('utf8');
    return result;
  };
  const upload = async local => { calls.push({ kind: 'upload', local, stage }); await fs.copyFile(local, path.join(stage, 'payload.zip'), constants.COPYFILE_EXCL); };
  const session = { exec: remote, upload };
  const service = {
    getState: async () => ({ hosts: [host] }),
    sshArgs: h => ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', String(h.port), '-l', h.user, h.address],
    run: async (command, args) => { calls.push({ kind: 'transport', command, args }); if (command === 'ssh') return remote(args.at(-1)); if (command === 'scp') return upload(args.at(-2)); throw new Error('Unexpected command: ' + command); },
    passwordAuth: { metadata: () => ({ hasSavedPassword: password }), withPassword: async (h, work) => { calls.push({ kind: 'password', hostId: h.id }); return work(session); } }
  };
  const executor = async (command, args, options) => { calls.push({ kind: 'local', command, args }); return execute(command, args, options); };
  const installer = new MacInstaller({ service, sourceApp: app, platform: 'darwin', arch: architecture, version: '0.4.1', productName: 'ShelfDock', isPackaged: true, clock: () => now, executor, onChange: state => changes.push(state) });
  t.after(async () => { block = null; await installer.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, home, app, host, calls, changes, installer, service, architecture, setNow: value => { now = value; }, setHook: value => { hook = value; }, setBlock: value => { block = value; }, destination: path.join(home, 'Applications/ShelfDock.app') };
}

test('capability is unavailable outside a packaged Mac and never invokes executors', () => {
  for (const options of [{ platform: 'linux', isPackaged: true }, { platform: 'win32', isPackaged: true }, { platform: 'darwin', isPackaged: false }, { platform: 'darwin', isPackaged: true, sourceApp: '/tmp/not-app' }]) {
    const installer = new MacInstaller({ service: {}, sourceApp: '/tmp/ShelfDock.app', arch: 'arm64', ...options, executor: () => assert.fail('No command expected') });
    assert.equal(installer.capabilities().available, false); assert.match(installer.capabilities().reason, /Mac|\.app/); assert.throws(() => installer.preview({ hostId: 'anything' }));
  }
});

test('preview is read-only, names the exact Mac and destination, and never packages or uploads', mac, async t => {
  const f = await fixture(t); const plan = await f.installer.preview({ hostId: f.host.id });
  assert.equal(plan.destination, f.destination); assert.equal(plan.address, 'example.invalid'); assert.equal(plan.user, 'fixture'); assert.equal(plan.canInstall, true); assert.equal(plan.includesPersonalPreset, false); assert.equal(plan.version, '0.4.1');
  await assert.rejects(fs.stat(path.join(f.home, 'Applications')), { code: 'ENOENT' });
  assert.equal(f.calls.filter(c => c.kind === 'upload').length, 0); assert.equal(f.calls.filter(c => c.command === '/usr/bin/ditto').length, 0); assert.equal(f.service.macInstallation, false);
});

test('existing destination is previewed with version and installation cannot overwrite it', mac, async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.destination)); await fs.cp(f.app, f.destination, { recursive: true, verbatimSymlinks: true });
  const plan = await f.installer.preview({ hostId: f.host.id }); assert.equal(plan.existingVersion, '0.4.1'); assert.equal(plan.canInstall, false);
  assert.throws(() => f.installer.install({ planId: plan.id }), /already exists/); assert.equal(f.calls.filter(c => c.kind === 'upload').length, 0);
});

test('key-auth installation preserves app links, verifies payload, commits once, cleans owned staging, and never launches', mac, async t => {
  const f = await fixture(t); const plan = await f.installer.preview({ hostId: f.host.id }); const state = await f.installer.install({ planId: plan.id });
  assert.equal(state.operation.status, 'installed', state.operation.message);
  assert.deepEqual(await fs.readFile(path.join(f.destination, 'Contents/Resources/app.asar')), await fs.readFile(path.join(f.app, 'Contents/Resources/app.asar')));
  assert.equal(await fs.readlink(path.join(f.destination, 'Contents/Frameworks/Example.framework/Versions/Current')), 'A');
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['ShelfDock.app']);
  assert.deepEqual(f.changes.map(s => s.operation.status), ['preparing', 'uploading', 'verifying', 'installed']);
  assert.equal(f.service.macInstallation, false); assert.throws(() => f.installer.install({ planId: plan.id }), /already used/);
  const transports = f.calls.filter(c => c.kind === 'transport');
  for (const c of transports) for (const option of ['StrictHostKeyChecking=yes', 'PermitLocalCommand=no', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'ControlPath=none']) assert.ok(c.args.includes(option), option);
  const scp = transports.find(c => c.command === 'scp'); assert.ok(scp.args.includes('-P')); assert.ok(scp.args.includes('2222')); assert.ok(scp.args.includes('User=fixture')); assert.ok(!scp.args.includes('-l'));
  const archive = f.calls.find(c => c.command === '/usr/bin/ditto'); assert.ok(archive.args.includes('--qtn')); assert.equal(archive.args.at(-2), f.app);
  assert.ok(!f.calls.some(c => /(?:^|\/)open$|launchctl|xattr/.test(c.command || '')));
});

test('saved-password route uses existing session exec/upload and requires explicit personal preset acknowledgement', mac, async t => {
  const f = await fixture(t, { password: true, preset: true }); const plan = await f.installer.preview({ hostId: f.host.id }); assert.equal(plan.includesPersonalPreset, true);
  for (const confirmPreset of [undefined, false, 'true', 1]) assert.throws(() => f.installer.install({ planId: plan.id, confirmPreset }), /Confirm/);
  const state = await f.installer.install({ planId: plan.id, confirmPreset: true }); assert.equal(state.operation.status, 'installed', state.operation.message);
  assert.ok(await fs.stat(path.join(f.destination, 'Contents/Resources/personal-config.json'))); assert.equal(f.calls.filter(c => c.kind === 'transport').length, 0); assert.equal(f.calls.filter(c => c.kind === 'password').length, 2);
});

test('plans expire and endpoint changes cannot redirect installation', mac, async t => {
  const f = await fixture(t); let plan = await f.installer.preview({ hostId: f.host.id }); f.setNow(plan.expiresAt); assert.throws(() => f.installer.install({ planId: plan.id }), /expired/);
  plan = await f.installer.preview({ hostId: f.host.id }); f.host.address = 'other.invalid'; const result = await f.installer.install({ planId: plan.id }); assert.equal(result.operation.status, 'failed'); assert.match(result.operation.message, /connection details changed/); assert.equal(f.calls.filter(c => c.kind === 'upload').length, 0);
});

test('source mutation, external bundle links, and nonmatching Mac architecture are refused before upload', mac, async t => {
  const f = await fixture(t); const plan = await f.installer.preview({ hostId: f.host.id }); await fs.appendFile(path.join(f.app, 'Contents/Resources/app.asar'), 'changed');
  const state = await f.installer.install({ planId: plan.id }); assert.equal(state.operation.status, 'failed'); assert.match(state.operation.message, /source app changed/);
  await fs.symlink(f.home, path.join(f.app, 'Contents/Resources/outside')); await assert.rejects(f.installer.preview({ hostId: f.host.id }), /outside its bundle/); await fs.unlink(path.join(f.app, 'Contents/Resources/outside'));
  f.setHook(command => command.includes('DH_OS=') ? { stdout: 'DH_OS=Darwin\nDH_ARCH=' + (f.architecture === 'arm64' ? 'x86_64' : 'arm64') + '\nDH_EXISTS=no\nDH_HOME_B64=' + Buffer.from(f.home).toString('base64') + '\n' } : undefined);
  await assert.rejects(f.installer.preview({ hostId: f.host.id }), /Apple Silicon.*Intel|Intel.*Apple Silicon/); assert.equal(f.calls.filter(c => c.kind === 'upload').length, 0);
});

test('Linux, symbolic Applications folder, and invalid preview responses are refused without writes', mac, async t => {
  const f = await fixture(t); f.setHook(() => ({ stdout: 'DH_ERROR=OS\n' })); await assert.rejects(f.installer.preview({ hostId: f.host.id }), /not a Mac/);
  f.setHook(null); const elsewhere = path.join(f.root, 'elsewhere'); await fs.mkdir(elsewhere); await fs.symlink(elsewhere, path.join(f.home, 'Applications')); await assert.rejects(f.installer.preview({ hostId: f.host.id }), /symbolic link/); await fs.unlink(path.join(f.home, 'Applications'));
  f.setHook(() => ({ stdout: 'DH_OS=Darwin\nDH_OS=Darwin\n' })); await assert.rejects(f.installer.preview({ hostId: f.host.id }), /ambiguous/); assert.deepEqual(await fs.readdir(elsewhere), []);
});

test('destination created after preview prevents any upload and remains untouched', mac, async t => {
  const f = await fixture(t); const plan = await f.installer.preview({ hostId: f.host.id }); await fs.mkdir(f.destination, { recursive: true }); await fs.writeFile(path.join(f.destination, 'keep'), 'existing');
  const state = await f.installer.install({ planId: plan.id }); assert.equal(state.operation.status, 'failed'); assert.match(state.operation.message, /already exists/); assert.equal(await fs.readFile(path.join(f.destination, 'keep'), 'utf8'), 'existing'); assert.equal(f.calls.filter(c => c.kind === 'upload').length, 0);
});

test('checksum mismatch cleans only owned staging and preserves unrelated destination files', mac, async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.home, 'Applications')); await fs.writeFile(path.join(f.home, 'Applications/keep.txt'), 'unrelated');
  f.setHook(async command => { if (command.includes('actual=$(')) { const upload = f.calls.find(c => c.kind === 'upload'); await fs.appendFile(path.join(upload.stage, 'payload.zip'), 'tampered'); } });
  const plan = await f.installer.preview({ hostId: f.host.id }); const state = await f.installer.install({ planId: plan.id }); assert.equal(state.operation.status, 'failed'); assert.match(state.operation.message, /SHA-256/); assert.deepEqual(await fs.readdir(path.join(f.home, 'Applications')), ['keep.txt']);
});

test('a destination appearing at commit is not overwritten or nested into, and staging is cleaned', mac, async t => {
  const f = await fixture(t); const originalRun = f.service.run;
  f.service.run = async (command, args, opts) => {
    if (command === 'ssh' && args.at(-1).includes('/bin/mv -n')) {
      // Change just the fixed command at its race point inside the scratch remote shell.
      const target = args.at(-1).replace('/bin/mv -n', '/bin/mkdir "$destination"; printf retained > "$destination/keep"; /bin/mv -n');
      return originalRun(command, [...args.slice(0, -1), target], opts);
    }
    return originalRun(command, args, opts);
  };
  const plan = await f.installer.preview({ hostId: f.host.id }); const state = await f.installer.install({ planId: plan.id }); assert.equal(state.operation.status, 'failed'); assert.match(state.operation.message, /without replacing/); assert.deepEqual(await fs.readdir(f.destination), ['keep']); assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['ShelfDock.app']);
});

test('concurrent operations are refused and shutdown waits for the active operation', mac, async t => {
  const f = await fixture(t); let unblock; const blocked = new Promise(resolve => { unblock = resolve; }); f.setBlock(blocked);
  const pending = f.installer.preview({ hostId: f.host.id }); assert.equal(f.service.macInstallation, true); assert.throws(() => f.installer.preview({ hostId: f.host.id }), /Wait/);
  let done = false; const shutdown = f.installer.shutdown().then(() => { done = true; }); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(done, false); unblock(); await pending; await shutdown;
  assert.equal(f.service.macInstallation, false); assert.throws(() => f.installer.preview({ hostId: f.host.id }), /shutting down/);
});

test('transfers, authentication, configuration, forwarding setup, and discovery block installation work', mac, async t => {
  const f = await fixture(t);
  for (const field of ['transferring', 'authenticationSetup', 'configurationImport', 'tunnelSetup', 'scanPromise', 'probePromise', 'macInstallation']) { f.service[field] = true; assert.throws(() => f.installer.preview({ hostId: f.host.id }), /Wait/); f.service[field] = false; }
  assert.equal(f.calls.length, 0);
});

test('an unrelated destination lock is preserved and blocks commit without replacing an app', mac, async t => {
  const f = await fixture(t); const crypto = require('node:crypto');
  const lock = path.join(f.home, 'Applications', '.dropharbor-install-' + crypto.createHash('sha256').update('ShelfDock.app').digest('hex').slice(0, 16) + '.lock');
  await fs.mkdir(lock, { recursive: true }); await fs.writeFile(path.join(lock, '.owner'), 'another-installer');
  const plan = await f.installer.preview({ hostId: f.host.id }); const state = await f.installer.install({ planId: plan.id });
  assert.equal(state.operation.status, 'failed'); assert.match(state.operation.message, /destination lock/); assert.equal(await fs.readFile(path.join(lock, '.owner'), 'utf8'), 'another-installer');
  assert.deepEqual(await fs.readdir(path.dirname(lock)), [path.basename(lock)]);
});

test('unverified staging cleanup is reported without deleting a successfully committed app', mac, async t => {
  const f = await fixture(t); f.setHook(command => { if (command.includes('DH_CLEANED=')) throw new Error('Fixture cleanup transport unavailable'); });
  const plan = await f.installer.preview({ hostId: f.host.id }); const state = await f.installer.install({ planId: plan.id });
  assert.equal(state.operation.status, 'installed'); assert.equal(state.operation.cleanupPending, true); assert.ok(await fs.stat(f.destination)); assert.ok(await fs.stat(state.operation.stagingDirectory)); assert.equal(f.service.macInstallation, false);
});

test('a source app containing private sibling state is never copied outside the app bundle', mac, async t => {
  const f = await fixture(t); const sibling = path.join(f.root, 'private-profile'); await fs.mkdir(sibling); await fs.writeFile(path.join(sibling, 'clipboard.json'), 'fixture private data');
  const plan = await f.installer.preview({ hostId: f.host.id }); const state = await f.installer.install({ planId: plan.id }); assert.equal(state.operation.status, 'installed');
  await assert.rejects(fs.stat(path.join(f.destination, 'private-profile')), { code: 'ENOENT' }); await assert.rejects(fs.stat(path.join(f.home, 'Applications/private-profile')), { code: 'ENOENT' }); assert.equal(await fs.readFile(path.join(sibling, 'clipboard.json'), 'utf8'), 'fixture private data');
});

test('remote architecture is rechecked after preview and before remote staging', mac, async t => {
  const f = await fixture(t); const plan = await f.installer.preview({ hostId: f.host.id });
  f.setHook(() => ({ stdout: 'DH_OS=Darwin\nDH_ARCH=' + (f.architecture === 'arm64' ? 'x86_64' : 'arm64') + '\nDH_EXISTS=no\nDH_HOME_B64=' + Buffer.from(f.home).toString('base64') + '\n' }));
  const result = await f.installer.install({ planId: plan.id }); assert.equal(result.operation.status, 'failed'); assert.match(result.operation.message, /Apple Silicon.*Intel|Intel.*Apple Silicon/); await assert.rejects(fs.stat(path.join(f.home, 'Applications')), { code: 'ENOENT' });
});

test('source bytes are pinned even if a same-size rewrite preserves its modification time', mac, async t => {
  const f = await fixture(t); const file = path.join(f.app, 'Contents/Resources/app.asar'); const stamp = new Date('2020-01-01T00:00:00Z'); await fs.utimes(file, stamp, stamp);
  const before = await fs.stat(file); const plan = await f.installer.preview({ hostId: f.host.id }); await fs.writeFile(file, Buffer.alloc(before.size, 'x')); await fs.utimes(file, stamp, stamp);
  const after = await fs.stat(file); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  const state = await f.installer.install({ planId: plan.id }); assert.equal(state.operation.status, 'failed'); assert.match(state.operation.message, /source app changed/); assert.equal(f.calls.filter(c => c.kind === 'upload').length, 0);
});

test('an SSH reply lost after owned stage creation still triggers token-checked cleanup', mac, async t => {
  const f = await fixture(t); const original = f.service.run;
  f.service.run = async (command, args, options) => { const result = await original(command, args, options); if (command === 'ssh' && args.at(-1).includes("DH_STAGE_B64=")) throw new Error('Fixture stage reply lost'); return result; };
  const plan = await f.installer.preview({ hostId: f.host.id }); const state = await f.installer.install({ planId: plan.id });
  assert.equal(state.operation.status, 'failed'); assert.equal(state.operation.cleanupPending, undefined); assert.deepEqual(await fs.readdir(path.join(f.home, 'Applications')), []); assert.equal(f.calls.filter(c => c.kind === 'upload').length, 0);
});

test('local staging cleanup failure preserves the completed remote installation receipt', mac, async t => {
  const f = await fixture(t); const plan = await f.installer.preview({ hostId: f.host.id }); const original = fs.rm; let failedPath;
  fs.rm = async (file, options) => { if (path.basename(file).startsWith('dropharbor-mac-install-')) { failedPath = file; throw new Error('Fixture local cleanup unavailable'); } return original(file, options); };
  let state;
  try { state = await f.installer.install({ planId: plan.id }); } finally { fs.rm = original; if (failedPath) await original(failedPath, { recursive: true, force: true }); }
  assert.equal(state.operation.status, 'installed'); assert.equal(state.operation.localCleanupPending, true); assert.ok(await fs.stat(f.destination)); assert.equal(f.service.macInstallation, false);
});
