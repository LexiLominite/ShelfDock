'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const downloadPath = require.resolve('../desktop/remote-install-download.cjs');
require(downloadPath);
const original = require.cache[downloadPath].exports;
let downloads = [], cancelledDownload = false, downloadStarted = null;
require.cache[downloadPath].exports = {
  ...original,
  readRelease: async options => { downloads.push(options); if (cancelledDownload) await new Promise((resolve, reject) => { const abort = () => reject(new Error('aborted')); if (options.signal.aborted) { abort(); return; } options.signal.addEventListener('abort', abort, { once: true }); downloadStarted?.(); }); return { asset: { name: 'fixture.bin', sha256: 'a'.repeat(64), bytes: Buffer.from('fixture') } }; },
  validateLinuxPackage: async () => true,
  validateWindowsPortable: async () => true,
};
const { RemoteInstaller } = require('../desktop/remote-installer.cjs');
require.cache[downloadPath].exports = original;
function fixture({ os = 'posix', target = 'linux', arch = 'aarch64', edition = 'clean', macInstaller } = {}) {
  const host = { id: 'one', name: 'Studio', user: 'tester', address: 'host.test', port: 22, os };
  const calls = [];
  const service = {
    getState: async () => ({ hosts: [host] }), sshArgs: () => ['-l', 'tester', 'host.test'],
    passwordAuth: { metadata: () => ({ hasSavedPassword: false }) },
    run: async (exe, args) => {
      calls.push({ exe, args });
      const command = args.at(-1);
      if (exe === 'scp') return {};
      const script = command.includes('-EncodedCommand ') ? Buffer.from(command.split('-EncodedCommand ')[1], 'base64').toString('utf16le') : command;
      if (script.includes('DH_TARGET=')) return { stdout: `DH_TARGET=${target};arch=${arch}\n` };
      if (script.includes('DH_STAGE=')) {
        const token = script.match(/\.shelfdock-install-([a-f0-9-]{36})/)[1];
        const stage = target === 'windows' ? `C:\\Users\\tester\\AppData\\Local\\.shelfdock-install-${token}` : `/home/tester/.shelfdock-install-${token}-abc123`;
        return { stdout: 'DH_STAGE=' + (target === 'windows' ? Buffer.from(stage).toString('base64') : stage) + '\n' };
      }
      return { stdout: 'DH_INSTALLED=yes\n' };
    },
  };
  let now = 1000;
  const installer = new RemoteInstaller({ service, productName: edition === 'personal' ? 'LexBridge' : 'ShelfDock', version: '0.7.0', edition, clock: () => now, macInstaller });
  return { installer, host, calls, service, expire: () => { now += 6 * 60 * 1000; } };
}
test('posix probes actual Linux arm64, stages safely and consumes the plan', async () => {
  const f = fixture(); const plan = await f.installer.preview({ hostId: 'one' });
  assert.equal(plan.os, 'linux'); assert.equal(plan.architecture, 'arm64');
  assert.match(plan.destination, /linux-arm64$/);
  const result = await f.installer.install({ planId: plan.id });
  assert.equal(result.operation.status, 'installed'); assert.equal(f.service.remoteInstallation, false);
  assert.equal(downloads.at(-1).arch, 'arm64'); assert.equal(downloads.at(-1).edition, 'public');
  assert.equal(f.calls.filter(c => c.exe === 'scp').length, 2);
  assert.ok(f.calls.some(c => c.args.at(-1).startsWith('rm -rf -- ')));
  assert.ok(f.calls.filter(c => c.exe === 'ssh').every(c => c.args.includes('StrictHostKeyChecking=yes')));
  await assert.rejects(f.installer.install({ planId: plan.id }), /expired|used/);
});
test('Windows x64 installation uses encoded script and exact PE target', async () => {
  const f = fixture({ os: 'windows', target: 'windows', arch: 'AMD64' });
  const plan = await f.installer.preview({ hostId: 'one' });
  assert.equal(plan.architecture, 'x64');
  assert.equal((await f.installer.install({ planId: plan.id })).operation.status, 'installed');
  assert.equal(downloads.at(-1).targetOS, 'windows');
  assert.ok(f.calls.filter(c => c.exe === 'ssh').every(c => c.args.at(-1).startsWith('powershell.exe ')));
});
test('expired, changed identity, unsupported Windows architecture and busy destination reject', async () => {
  const f = fixture(); let plan = await f.installer.preview({ hostId: 'one' }); f.expire();
  await assert.rejects(f.installer.install({ planId: plan.id }), /expired/);
  plan = await f.installer.preview({ hostId: 'one' }); f.host.identityFile = '/new-key';
  assert.equal((await f.installer.install({ planId: plan.id })).operation.status, 'failed');
  assert.equal(f.calls.filter(c => c.exe === 'scp').length, 0);
  const win = fixture({ os: 'windows', target: 'windows', arch: 'ARM64' });
  await assert.rejects(win.installer.preview({ hostId: 'one' }), /x64/);
  f.service.appUpdating = true; await assert.rejects(f.installer.preview({ hostId: 'one' }), /current task/);
});
test('personal preset requires explicit consent', async () => {
  const f = fixture({ edition: 'personal' }); const plan = await f.installer.preview({ hostId: 'one' });
  assert.equal(plan.includesPersonalPreset, true);
  await assert.rejects(f.installer.install({ planId: plan.id }), /Confirm sharing/);
  assert.equal(f.calls.filter(c => c.exe === 'scp').length, 0);
  assert.equal((await f.installer.install({ planId: plan.id, consentPersonalPreset: true })).operation.status, 'installed');
});
test('download cancellation prevents any remote writes and releases service lock', async () => {
  const f = fixture(); const plan = await f.installer.preview({ hostId: 'one' }); cancelledDownload = true;
  const started = new Promise(resolve => { downloadStarted = resolve; });
  const pending = f.installer.install({ planId: plan.id });
  await started; f.installer.cancel();
  assert.equal((await pending).operation.status, 'cancelled'); cancelledDownload = false; downloadStarted = null;
  assert.equal(f.service.remoteInstallation, false); assert.equal(f.calls.filter(c => c.exe === 'scp').length, 0);
});
test('Mac uses existing verified bundle installer and forwards personal consent', async () => {
  let request;
  const macInstaller = { preview: async () => ({ id: 'mac', expiresAt: 999999, includesPersonalPreset: true, architecture: 'Apple Silicon' }), install: async value => { request = value; return { operation: { status: 'installed' } }; } };
  const f = fixture({ target: 'darwin', arch: 'arm64', macInstaller });
  const plan = await f.installer.preview({ hostId: 'one' }); assert.equal(plan.os, 'macos');
  await f.installer.install({ planId: plan.id, consentPersonalPreset: true });
  assert.deepEqual(request, { planId: 'mac', confirmPreset: true });
});
test('cleanup failure retains its owned path after a successful commit', async () => {
  const f = fixture(); const run = f.service.run;
  f.service.run = async (exe, args) => { if (exe === 'ssh' && args.at(-1).startsWith('rm -rf -- ')) throw new Error('lost cleanup reply'); return run(exe, args); };
  const plan = await f.installer.preview({ hostId: 'one' });
  const result = await f.installer.install({ planId: plan.id });
  assert.equal(result.operation.status, 'installed'); assert.equal(result.operation.cleanupPending, true);
  assert.match(result.operation.stagingDirectory, /^\/home\/tester\/\.shelfdock-install-/);
});

test('cancelled unresolved preview cannot produce a later install plan', async () => {
  const f = fixture(); let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  const original = f.service.run;
  f.service.run = (exe, args, options) => new Promise(resolve => { finish = () => resolve(original(exe,args,options)); started(); });
  const preview = f.installer.preview({ hostId: 'one' });
  const rejected = assert.rejects(preview, /abort/i);
  await began; f.installer.cancel(); finish(); await rejected;
  assert.equal(f.installer.plans.size, 0); assert.equal(f.service.remoteInstallation, false);
  f.service.run = original;
  assert.equal((await f.installer.preview({ hostId: 'one' })).canInstall, true);
});
test('key SCP cancellation aborts the active child and still runs unstalled cleanup', async () => {
  const f = fixture(); const run = f.service.run; let started; let uploadOptions;
  const uploading = new Promise(resolve => { started = resolve; });
  f.service.run = async (exe, args, options) => {
    if (exe !== 'scp') return run(exe, args, options);
    uploadOptions = options;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('SCP aborted'));
      if (options.signal.aborted) { abort(); return; }
      options.signal.addEventListener('abort', abort, { once: true }); started();
    });
  };
  const plan = await f.installer.preview({ hostId: 'one' });
  const pending = f.installer.install({ planId: plan.id }); await uploading;
  assert.equal(uploadOptions.timeout, 10 * 60 * 1000);
  const cancelling = f.installer.cancel(); assert.equal(cancelling.operation.status, 'cancelling');
  const result = await pending;
  assert.equal(uploadOptions.signal.aborted, true); assert.equal(result.operation.status, 'cancelled');
  assert.ok(f.calls.some(call => call.exe === 'ssh' && call.args.at(-1).startsWith('rm -rf -- ')));
  assert.ok(!f.calls.some(call => call.exe === 'ssh' && call.args.at(-1).startsWith('sh ')));
  assert.equal(result.operation.cleanupPending, undefined); assert.equal(f.service.remoteInstallation, false);
});
test('saved-password cancellation destroys only its SFTP stream and keeps SSH available for cleanup', async () => {
  const { Writable } = require('node:stream');
  const f = fixture(); const run = f.service.run; let started; let ended = 0; let output;
  const uploading = new Promise(resolve => { started = resolve; });
  const session = {
    exec: command => run('ssh', [command]),
    client: { sftp: callback => callback(null, {
      createWriteStream: () => { output = new Writable({ write(chunk, encoding, callback) { started(); } }); return output; },
      end: () => { ended++; },
    }) },
  };
  f.service.passwordAuth.metadata = () => ({ hasSavedPassword: true });
  f.service.passwordAuth.withPassword = (host, work) => work(session);
  const plan = await f.installer.preview({ hostId: 'one' });
  const pending = f.installer.install({ planId: plan.id }); await uploading; f.installer.cancel();
  const result = await pending;
  assert.equal(output.destroyed, true); assert.equal(ended, 1); assert.equal(result.operation.status, 'cancelled');
  assert.ok(f.calls.some(call => call.args.at(-1).startsWith('rm -rf -- ')));
  assert.equal(result.operation.cleanupPending, undefined); assert.equal(f.service.remoteInstallation, false);
});
