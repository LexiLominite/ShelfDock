'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { ClipboardSync } = require('../desktop/clipboard-sync.cjs');
const { buildSshArgs } = require('../desktop/clipboard-sync-ssh.cjs');
const { encodeFrame } = require('../desktop/clipboard-sync-protocol.cjs');

const storage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`enc:${value}`),
  decryptString: value => {
    const text = Buffer.isBuffer(value) ? value.toString() : String(value);
    if (!text.startsWith('enc:')) throw new Error('locked');
    return text.slice(4);
  },
});

const eventId = () => crypto.randomUUID();
const waitFor = list => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out waiting for a clipboard item')), 3000);
  const check = () => {
    if (list.length) { clearTimeout(timer); resolve(list[0]); return; }
    setTimeout(check, 15);
  };
  check();
});

async function paired(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-'));
  const received = { a: [], b: [] };
  const a = new ClipboardSync({ dataDir: path.join(root, 'a'), safeStorage: storage(), port: 0, onItem: item => received.a.push(item) });
  const b = new ClipboardSync({ dataDir: path.join(root, 'b'), safeStorage: storage(), port: 0, onItem: item => received.b.push(item) });
  t.after(async () => { await Promise.allSettled([a.shutdown(), b.shutdown()]); await fs.rm(root, { recursive: true, force: true }); });
  await a.ready; await b.ready;
  await a.setEnabled(true); await b.setEnabled(true);
  a.connect = () => net.connect(b.port);
  b.connect = () => net.connect(a.port);
  const pairing = await b.beginPairing();
  await a.pairWith({ hostLabel: 'Bee', localLabel: 'Aya', code: pairing.code, direction: 'both', sshTarget: { alias: 'bee' } });
  return { a, b, received, root };
}

test('fresh sync is disabled and a secure store is required before listening', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const locked = new ClipboardSync({ dataDir: root, safeStorage: { isEncryptionAvailable: () => false }, port: 0 });
  await locked.ready;
  assert.equal(locked.state().enabled, false);
  await assert.rejects(locked.setEnabled(true), /secure system secret store/);
  await assert.rejects(locked.beginPairing(), /secure system secret store/);
  await assert.rejects(fs.access(path.join(root, 'clipboard-sync', 'peers.bin')));
});

test('paired computers exchange text once in each direction and ignore echoes, duplicates, and stale items', async t => {
  const { a, b, received } = await paired(t);
  const first = eventId();
  await a.submitLocal({ eventId: first, kind: 'text', text: 'sync-sample-text', createdAt: Date.now() });
  const item = await waitFor(received.b);
  assert.equal(item.text, 'sync-sample-text');
  assert.equal(item.receiveMode, 'history');
  assert.equal(item.originLabel, 'Aya');
  await b.submitLocal({ eventId: first, kind: 'text', text: 'sync-sample-text', createdAt: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(received.a.length, 0, 'a received event is not sent back');
  await a.submitLocal({ eventId: first, kind: 'text', text: 'sync-sample-text', createdAt: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(received.b.length, 1, 'the same event is delivered once');
  const second = eventId();
  const third = eventId();
  await a.submitLocal({ eventId: second, kind: 'text', text: 'from-a', createdAt: Date.now() });
  await b.submitLocal({ eventId: third, kind: 'text', text: 'from-b', createdAt: Date.now() });
  await waitFor(received.a);
  const started = Date.now();
  while (!received.b.some(entry => entry.eventId === second)) {
    if (Date.now() - started > 3000) throw new Error('timed out waiting for the second clipboard item');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(received.a[0].text, 'from-b');
  assert.equal(received.b.filter(entry => entry.eventId === second)[0].text, 'from-a');
  await a.submitLocal({ eventId: eventId(), kind: 'text', text: 'old', createdAt: Date.now() - 121000 });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(received.b.some(entry => entry.text === 'old'), false);
  const serialized = JSON.stringify(a.state()) + JSON.stringify(b.state());
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('sync-sample-text'), false);
});

test('pause, revoke, malformed frames, and unknown tokens do not deliver clipboard contents', async t => {
  const { a, b, received } = await paired(t);
  await b.setPaused(true);
  await a.submitLocal({ eventId: eventId(), kind: 'text', text: 'while-paused', createdAt: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(received.b.length, 0);
  await b.setPaused(false);
  const socket = net.connect(b.port);
  socket.on('error', () => {});
  socket.write(Buffer.from('nope'));
  const stranger = net.connect(b.port);
  stranger.on('error', () => {});
  stranger.write(encodeFrame({ v: 1, type: 'hello', deviceId: crypto.randomUUID(), token: 'ab'.repeat(32) }));
  await new Promise(resolve => setTimeout(resolve, 100));
  socket.destroy();
  stranger.destroy();
  assert.equal(received.b.length, 0);
  await b.revoke(b.peers[0].id);
  await a.submitLocal({ eventId: eventId(), kind: 'text', text: 'after-revoke', createdAt: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(received.b.length, 0);
  assert.equal(b.peers.length, 0);
});

test('saved peers survive restart without enabling themselves into a send of old text', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new ClipboardSync({ dataDir: root, safeStorage: storage(), port: 0 });
  await first.ready;
  await first.setEnabled(true);
  await first.setReceiveMode('clipboard');
  await first.shutdown();
  const restored = new ClipboardSync({ dataDir: root, safeStorage: storage(), port: 0 });
  await restored.ready;
  assert.equal(restored.state().enabled, true);
  assert.equal(restored.state().receiveMode, 'clipboard');
  await restored.shutdown();
});

test('ssh tunnel arguments stay on the local ShelfDock port and reject shell syntax', () => {
  assert.deepEqual(buildSshArgs({ alias: 'studio' }).slice(-3), ['-W', '127.0.0.1:47635', 'studio']);
  assert.equal(buildSshArgs({ user: 'alex', host: 'bee.local', port: 22 }).includes('StrictHostKeyChecking=no'), false);
  for (const target of [{ alias: 'bee;rm' }, { user: 'alex', host: '-oProxyCommand' }, { alias: 'ok', identityFile: '-oEvil' }]) assert.throws(() => buildSshArgs(target), /saved machine/);
});
