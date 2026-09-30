'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { providers, LINUX_INSPECT } = require('../desktop/remote-desktop-providers.cjs');
const { ProcessStream, hardening, portNumber } = require('../desktop/remote-desktop-ssh.cjs');

test('Remote Desktop Providers', async t => {
  // Linux X11
  const linux = providers['linux-x11'];
  
  // Mock service
  let execCalls = [];
  const service = {
    remoteDesktopExec: async (host, cmd, opts) => {
      execCalls.push({ cmd, opts });
      if (cmd.includes('provider=linux-x11')) {
        return { stdout: 'provider=linux-x11\ndistribution=ubuntu\ninstalled=no\nelevated=yes\ntype=x11\ndisplay=:0\nauth=/mock/auth\n' };
      }
      return { stdout: '' };
    },
    run: async () => ({ stdout: '' }),
    sshArgs: () => []
  };
  
  const host = { id: 'linux-1', os: 'linux' };
  const inspectRes = await linux.inspect(service, host);
  assert.equal(inspectRes.available, true);
  assert.equal(inspectRes.installed, false);
  assert.equal(inspectRes.canInstall, true);

  const previewRes = linux.preview(inspectRes);
  assert.equal(previewRes.available, true);

  const plan = {
    owner: '00000000-0000-0000-0000-000000000000',
    port: 5900,
    info: { facts: inspectRes.facts }
  };

  const applyRes = await linux.apply(service, host, plan, { password: 'secret' });
  assert.equal(applyRes.owner, plan.owner);
  assert.equal(applyRes.port, 5900);
  
  // Verify VNC clipboard is disabled (-nosel -noprimary -noclipboard)
  const applyCall = execCalls.find(c => c.opts?.stdin === 'secret\n');
  assert.ok(applyCall.cmd.includes('-nosel -noprimary -noclipboard'));

  // Test Mac Screen Sharing
  execCalls = [];
  const mac = providers['mac-screen-sharing'];
  const macService = {
    run: async (cmd, args) => ({ stdout: 'installed=yes\n' }),
    sshArgs: () => []
  };
  const macInspect = await mac.inspect(macService, host);
  assert.equal(macInspect.available, true);

  // Test Windows TightVNC
  execCalls = [];
  const win = providers['windows-tightvnc'];
  const winService = {
    run: async () => ({ stdout: 'installed=yes\n' }),
    sshArgs: () => []
  };
  const winInspect = await win.inspect(winService, host);
  assert.equal(winInspect.available, true);
});

test('Remote Desktop SSH options and Port Validation', t => {
  assert.throws(() => portNumber(22), /between 1024 and 65535/);
  assert.equal(portNumber(5900), 5900);
  
  assert.ok(hardening.includes('StrictHostKeyChecking=yes'));
  assert.ok(hardening.includes('ClearAllForwardings=yes'));
});

test('provider selection probes kernel for saved POSIX machines', async () => {
  const { providerFor } = require('../desktop/remote-desktop-providers.cjs');
  const service = { remoteDesktopExec: async (_host, command) => { assert.equal(command, 'uname -s'); return { stdout: 'Darwin\n' }; } };
  assert.equal(await providerFor({ os: 'posix', name: 'Linux workstation' }, service), 'mac-screen-sharing');
  service.remoteDesktopExec = async () => ({ stdout: 'Linux\n' });
  assert.equal(await providerFor({ os: 'posix', name: 'MacBook' }, service), 'linux-x11');
});

test('key SSH stdin carries secrets only through the private pipe and bounds failures', async () => {
  const { desktopExec } = require('../desktop/remote-desktop-ssh.cjs');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const service = { sshArgs: () => ['-o', 'BatchMode=yes', 'saved-host'] };
  const secret = 'vnc-very-private'; let input = '', child;
  const spawnProcess = (_cmd, args, options) => {
    assert.equal(args.join(' ').includes(secret), false); assert.equal(options.shell, false); assert.ok(args.includes('StrictHostKeyChecking=yes'));
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin.on('data', bytes => { input += bytes.toString(); });
    child.stdin.on('finish', () => { child.stdout.write('ready=yes'); child.emit('close', 0); }); return child;
  };
  const result = await desktopExec(service, {}, 'read secret; printf ready=yes', { stdin: secret + '\n', spawnProcess });
  assert.equal(input, secret + '\n'); assert.equal(result.stdout, 'ready=yes');
});

test('password SSH stdin supports cancellation and discards remote stderr', async () => {
  const { desktopExec } = require('../desktop/remote-desktop-ssh.cjs'); const { PassThrough } = require('node:stream');
  let channel; const controller = new AbortController();
  const service = { passwordAuth: { metadata: () => ({ hasSavedPassword: true }), withPassword: (_host, operation) => operation({ client: { exec: (_command, callback) => { channel = new PassThrough(); channel.stderr = new PassThrough(); callback(null, channel); } } }) } };
  const pending = desktopExec(service, {}, 'read secret', { stdin: 'secret\n', signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /cancelled/); assert.equal(channel.destroyed, true);
});

test('SSH stdin rejects oversized output and timeouts without reflecting secrets', async () => {
  const { execWithInput } = require('../desktop/remote-desktop-ssh.cjs');
  const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
  const fixture = callback => {
    const completion = new EventEmitter(), input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
    const child = { kill: () => completion.emit('close', 1) };
    callback(null, { child, input, output, errors, completion }); return { input, output, errors };
  };
  const secret = 'NEVER-SURFACE-THIS';
  const tooMuch = execWithInput(ready => { const streams = fixture(ready); streams.errors.write(secret); streams.output.write(Buffer.alloc(101)); }, { stdin: secret, maxBuffer: 100 });
  await assert.rejects(tooMuch, error => /too much output/.test(error.message) && !error.message.includes(secret));
  const timedOut = execWithInput(ready => fixture(ready), { stdin: secret, timeout: 5 });
  await assert.rejects(timedOut, error => /timed out/.test(error.message) && !error.message.includes(secret));
});
