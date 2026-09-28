'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Duplex } = require('node:stream');
const { ClipboardSync } = require('../desktop/clipboard-sync.cjs');
const { buildSshArgs, connectSsh, safeTarget } = require('../desktop/clipboard-sync-ssh.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  return child;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('SSH arguments keep strict trust, disable inherited forwarding, and bound liveness checks', () => {
  const args = buildSshArgs({ alias: 'studio', identityFile: '/tmp/fixture key' });
  assert.deepEqual(args, [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=8',
    '-o', 'ConnectionAttempts=1',
    '-W', '127.0.0.1:47635',
    '-i', '/tmp/fixture key',
    '-o', 'IdentitiesOnly=yes',
    'studio',
  ]);
  assert.deepEqual(buildSshArgs({ user: 'fixture', host: '127.0.0.1', port: 2202 }), [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=8',
    '-o', 'ConnectionAttempts=1',
    '-W', '127.0.0.1:47635',
    '-p', '2202', '-l', 'fixture', '127.0.0.1',
  ]);
  for (const target of [
    { alias: 'studio;touch' },
    { user: 'fixture', host: '-oProxyCommand' },
    { alias: 'studio', identityFile: '-oProxyCommand=bad' },
    { alias: 'studio', identityFile: 17 },
  ]) assert.throws(() => safeTarget(target), /saved machine/);
  assert.throws(() => buildSshArgs({ alias: 'studio' }, 1234), /saved machine/);
});

test('SSH Duplex carries writes and reads both ways and drains stderr without exposing it', async t => {
  const child = fakeChild();
  let spawnCall;
  const stream = connectSsh({ alias: 'fixture' }, (...args) => { spawnCall = args; return child; });
  t.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });

  assert.ok(stream instanceof Duplex);
  assert.notEqual(stream, child.stdout);
  assert.deepEqual(spawnCall, ['ssh', buildSshArgs({ alias: 'fixture' }), { stdio: ['pipe', 'pipe', 'pipe'] }]);

  const sentToSsh = once(child.stdin, 'data');
  const writeDone = new Promise((resolve, reject) => stream.write('client request', error => error ? reject(error) : resolve()));
  assert.equal((await sentToSsh)[0].toString(), 'client request');
  await writeDone;

  const receivedFromSsh = once(stream, 'data');
  child.stdout.write('server response');
  assert.equal((await receivedFromSsh)[0].toString(), 'server response');

  child.stderr.write('private diagnostic text');
  await pause(10);
  assert.equal(child.stderr.readableLength, 0);
  assert.equal(child.stderr.isPaused(), false);

  const ended = once(stream, 'end');
  const closed = once(stream, 'close');
  child.emit('exit', 0, null);
  child.stdout.end();
  child.stderr.end();
  await ended;
  await closed;
  assert.deepEqual(child.signals, []);
});

test('SSH Duplex pauses the child output when its readable side applies backpressure, then resumes', async t => {
  const child = fakeChild();
  const stream = connectSsh({ alias: 'fixture' }, () => child);
  t.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });

  const payload = Buffer.alloc(256 * 1024, 0x5a);
  child.stdout.write(payload);
  const deadline = Date.now() + 1500;
  while (!child.stdout.isPaused() && Date.now() < deadline) await pause(5);
  assert.equal(child.stdout.isPaused(), true, 'SSH output pauses once the Duplex buffer is full');

  let received = 0;
  stream.on('data', chunk => { received += chunk.length; });
  const ended = once(stream, 'end');
  child.emit('exit', 0, null);
  child.stdout.end();
  child.stderr.end();
  await ended;
  assert.equal(received, payload.length);
});

test('spawn and stream errors reach callers, and nonzero SSH exit fails the stream', async t => {
  const spawnFailure = new Error('injected spawn failure');
  const failedToSpawn = connectSsh({ alias: 'fixture' }, () => { throw spawnFailure; });
  const spawnError = once(failedToSpawn, 'error');
  assert.equal((await spawnError)[0], spawnFailure);

  const childErrorProcess = fakeChild();
  const childErrorStream = connectSsh({ alias: 'fixture' }, () => childErrorProcess);
  t.after(() => { childErrorProcess.stdin.destroy(); childErrorProcess.stdout.destroy(); childErrorProcess.stderr.destroy(); });
  const childError = once(childErrorStream, 'error');
  childErrorProcess.emit('error', new Error('injected child process error'));
  assert.match((await childError)[0].message, /injected child process error/);
  assert.equal(childErrorProcess.signals[0], 'SIGTERM');
  childErrorProcess.emit('exit', 1, 'SIGTERM');
  childErrorProcess.stdout.destroy();
  childErrorProcess.stderr.destroy();
  childErrorProcess.emit('close', 1, 'SIGTERM');

  const child = fakeChild();
  const stream = connectSsh({ alias: 'fixture' }, () => child);
  t.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const streamError = once(stream, 'error');
  child.stdin.destroy(new Error('injected stdin failure'));
  assert.match((await streamError)[0].message, /injected stdin failure/);
  assert.equal(child.signals[0], 'SIGTERM');
  child.emit('exit', 1, 'SIGTERM');
  child.stdout.destroy();
  child.stderr.destroy();
  child.emit('close', 1, 'SIGTERM');

  const exitedChild = fakeChild();
  const exitedStream = connectSsh({ alias: 'fixture' }, () => exitedChild);
  t.after(() => { exitedChild.stdin.destroy(); exitedChild.stdout.destroy(); exitedChild.stderr.destroy(); });
  const exitError = once(exitedStream, 'error');
  exitedChild.emit('exit', 23, null);
  assert.match((await exitError)[0].message, /code 23/);
  exitedChild.stdout.destroy();
  exitedChild.stderr.destroy();
  exitedChild.emit('close', 23, null);
});

test('synchronous and next-tick spawn failures cross ClipboardSync.open as unreachable without an uncaught error or timeout', { timeout: 5000 }, async t => {
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() };
  const verifyFailure = async (name, spawnProcess) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `shelfdock-${name}-`));
    let child;
    const sync = new ClipboardSync({
      dataDir: root,
      safeStorage,
      platform: 'darwin',
      port: 0,
      connect: peer => connectSsh(peer.sshTarget, (...args) => spawnProcess(value => { child = value; }, ...args)),
    });
    t.after(async () => {
      await sync.shutdown();
      if (child) {
        child.emit('exit', 1, 'SIGTERM');
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.emit('close', 1, 'SIGTERM');
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    await sync.ready;
    await sync.setEnabled(true);
    const peer = { id: 'fixture-peer', token: 'ab'.repeat(32), sshTarget: { alias: 'fixture' }, paused: false };
    sync.peers.push(peer);
    const started = Date.now();
    await assert.rejects(sync.ensureSocket(peer), /not ready for clipboard sync/);
    assert.ok(Date.now() - started < 1000, 'a failed spawn is rejected promptly rather than waiting for the protocol timeout');
    assert.equal(peer.socket, undefined);
    return { child, sync };
  };

  await verifyFailure('sync-spawn-error', () => { throw new Error('sync spawn error'); });
  const asyncFailure = await verifyFailure('async-spawn-error', (remember, command, args, options) => {
    const child = fakeChild();
    remember(child);
    process.nextTick(() => child.emit('error', new Error('next-tick spawn error')));
    return child;
  });
  assert.deepEqual(asyncFailure.child.signals, ['SIGTERM']);
  asyncFailure.child.emit('exit', 1, 'SIGTERM');
  asyncFailure.child.stdout.destroy();
  asyncFailure.child.stderr.destroy();
  asyncFailure.child.emit('close', 1, 'SIGTERM');
});

test('destroy stops its SSH child and escalates within a bounded grace period', async t => {
  const child = fakeChild();
  const stream = connectSsh({ alias: 'fixture' }, () => child);
  t.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const closed = once(stream, 'close');
  stream.destroy();
  await closed;
  assert.deepEqual(child.signals, ['SIGTERM']);

  await pause(850);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  child.emit('exit', null, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');

  const quickChild = fakeChild();
  const quickStream = connectSsh({ alias: 'fixture' }, () => quickChild);
  quickStream.destroy();
  quickChild.emit('exit', 0, null);
  quickChild.stdout.end();
  quickChild.stderr.end();
  quickChild.emit('close', 0, null);
  await pause(850);
  assert.deepEqual(quickChild.signals, ['SIGTERM'], 'exit clears the escalation timer');
});
