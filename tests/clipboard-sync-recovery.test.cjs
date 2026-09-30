'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ClipboardSync } = require('../desktop/clipboard-sync.cjs');
const protocol = require('../desktop/clipboard-sync-protocol.cjs');

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => Buffer.from(`test-encrypted:${value}`),
    decryptString: value => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith('test-encrypted:')) throw new Error('locked');
      return text.slice('test-encrypted:'.length);
    },
  };
}

const eventId = () => crypto.randomUUID();
const textItem = (originDeviceId, text, createdAt = Date.now(), id = eventId()) => ({
  v: 1,
  type: 'item',
  eventId: id,
  originDeviceId,
  kind: 'text',
  createdAt,
  text,
});

function stopAutomaticRetry(sync) {
  clearInterval(sync.retryTimer);
  sync.retryTimer = null;
}

async function createSync(t, root, name, options = {}) {
  const sync = new ClipboardSync({
    dataDir: path.join(root, name),
    safeStorage: safeStorage(),
    port: 0,
    ...options,
  });
  await sync.ready;
  t.after(() => sync.shutdown().catch(() => {}));
  return sync;
}

async function paired(t, { clock = { value: Date.now() }, onAItem = () => {}, onBItem = () => {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = () => clock.value;
  const a = await createSync(t, root, 'a', { now, onItem: onAItem });
  const b = await createSync(t, root, 'b', { now, onItem: onBItem });
  await a.setEnabled(true);
  await b.setEnabled(true);
  a.connect = () => net.connect(b.port);
  b.connect = () => net.connect(a.port);
  const pairing = await b.beginPairing();
  await a.pairWith({ hostLabel: 'Bee', localLabel: 'Aya', code: pairing.code, direction: 'both', sshTarget: { alias: 'bee' } });
  stopAutomaticRetry(a);
  stopAutomaticRetry(b);
  return { root, a, b, clock, now };
}

async function waitFor(check, description, timeoutMs = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class MemorySocket extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.frames = []; }
  write(frame) { this.frames.push(Buffer.from(frame)); return true; }
  end(frame) { if (frame) this.write(frame); this.ended = true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}

function messagesWritten(socket) {
  const bytes = Buffer.concat(socket.frames);
  return protocol.pushBytes({ buffer: Buffer.alloc(0) }, bytes).messages;
}

async function savedPeers(sync) {
  const encrypted = await fs.readFile(path.join(sync.directory, 'peers.bin'));
  return JSON.parse(sync.safeStorage.decryptString(encrypted)).peers;
}

function readNextFrame(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let state = { buffer: Buffer.alloc(0) };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for a sync response.')), timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
    const finish = (error, message) => { cleanup(); if (error) reject(error); else resolve(message); };
    const onData = chunk => {
      try {
        const decoded = protocol.pushBytes(state, chunk);
        state = decoded.state;
        if (decoded.messages.length) finish(null, decoded.messages[0]);
      } catch (error) { finish(error); }
    };
    const onError = error => finish(error);
    const onClose = () => finish(new Error('Connection closed before a sync response.'));
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose);
  });
}

test('Linux basic_text is unavailable for sync even when Electron reports encryption available', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-basic-text-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = safeStorage();
  storage.getSelectedStorageBackend = () => 'basic_text';
  const sync = await createSync(t, root, 'linux', { platform: 'linux', safeStorage: storage });

  assert.equal(storage.isEncryptionAvailable(), true);
  assert.equal(sync.state().available, false);
  await assert.rejects(sync.setEnabled(true), /secure system secret store/);
  await assert.rejects(sync.beginPairing(), /secure system secret store/);
  assert.equal(sync.server, null);
  assert.equal(sync.peers.length, 0);
});

test('disabled sync refuses pairing actions without starting a listener or opening SSH', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-disabled-pair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let connects = 0;
  const sync = await createSync(t, root, 'off', { connect: () => { connects += 1; throw new Error('should not connect'); } });

  await assert.rejects(sync.beginPairing(), /turn on and resume clipboard sync/i);
  await assert.rejects(sync.pairWith({ code: 'AB234567', sshTarget: { alias: 'peer' } }), /turn on and resume clipboard sync/i);
  assert.equal(sync.server, null);
  assert.equal(sync.port, null);
  assert.equal(connects, 0);
});

test('loading persisted enabled preferences does not start the listener before controller gates run', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-load-listener-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await createSync(t, root, 'device', { port: 0 });
  await first.setEnabled(true);
  await first.shutdown();

  const restored = await createSync(t, root, 'device', { port: 0 });
  assert.equal(restored.state().enabled, true, 'the saved preference is preserved for the controller to inspect');
  assert.equal(restored.server, null);
  assert.equal(restored.port, null);
});

test('an item received after sync is disabled is rejected without invoking delivery', async t => {
  const delivered = [];
  const { b } = await paired(t, { onBItem: item => delivered.push(item) });
  const peer = b.peers[0];
  await b.setEnabled(false);
  const socket = new MemorySocket();

  await b.receive(socket, peer, textItem(peer.id, 'must-not-arrive'));

  assert.deepEqual(delivered, []);
  assert.equal(messagesWritten(socket)[0]?.type, 'reject');
  assert.equal(messagesWritten(socket)[0]?.reason, 'paused');
});

test('failed async delivery stays pending and unacknowledged, then succeeds on retry', async t => {
  const attempts = [];
  const { a, b } = await paired(t, { onBItem: async item => {
    attempts.push(item);
    if (attempts.length === 1) throw new Error('synthetic storage failure');
  } });
  const peer = a.peers[0];
  const event = textItem(a.settings.deviceId, 'retry-after-save-error');

  await a.submitLocal(event);
  await waitFor(() => attempts.length === 1, 'first async delivery attempt');
  assert.equal(a.pending.get(peer.id)?.eventId, event.eventId, 'the sender retains the item until an ack arrives');
  assert.equal(b.seen.has(event.eventId), false, 'failed delivery is not marked seen');
  assert.match(b.state().error || '', /could not be saved/i);

  await a.retry();
  await waitFor(() => !a.pending.has(peer.id), 'acknowledgement after successful retry');
  assert.equal(attempts.length, 2);
  assert.equal(b.seen.has(event.eventId), true);
});

test('a peer is not approved when saving its credentials fails', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-save-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = await createSync(t, root, 'a', { port: 0 });
  const b = await createSync(t, root, 'b', { port: 0 });
  await a.setEnabled(true);
  await b.setEnabled(true);
  a.connect = () => net.connect(b.port);
  b.connect = () => net.connect(a.port);
  stopAutomaticRetry(a);
  stopAutomaticRetry(b);
  const pairing = await b.beginPairing();
  b.savePeers = async () => { throw new Error('synthetic disk failure'); };

  await assert.rejects(a.pairWith({ hostLabel: 'Bee', localLabel: 'Aya', code: pairing.code, direction: 'both', sshTarget: { alias: 'bee' } }), /did not accept clipboard pairing/i);
  assert.equal(b.peers.some(peer => peer.id === a.settings.deviceId), false);
  assert.equal(a.peers.length, 0);
  assert.equal(b.state().pairing, null, 'a failed one-time attempt consumes the code rather than exposing an unsaved peer');
  assert.match(b.state().error || '', /paired computer could not be saved/i);
});

test('failed removal stays visible and paused, then a successful retry removes the persisted peer', async t => {
  const { b } = await paired(t);
  const peer = b.peers[0];
  const realSavePeers = b.savePeers.bind(b);
  b.savePeers = async () => { throw new Error('synthetic disk failure'); };

  await assert.rejects(b.revoke(peer.id), /retry Remove before restarting/i);
  assert.equal(b.peers.some(item => item.id === peer.id), true, 'a failed removal remains visible for retry');
  assert.equal(b.state().peers.find(item => item.id === peer.id)?.paused, true);
  assert.match(b.state().error || '', /paused for this session/i);
  assert.equal((await savedPeers(b)).some(item => item.id === peer.id), true, 'the existing on-disk record is not mistaken for a successful removal');

  b.savePeers = realSavePeers;
  await b.revoke(peer.id);
  assert.equal(b.peers.some(item => item.id === peer.id), false);
  assert.deepEqual(await savedPeers(b), [], 'the successful retry commits the removal to the encrypted file');
});

test('initiator disable during delayed peer persistence rolls back the file before rejecting pairing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-pair-initiator-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = await createSync(t, root, 'a', { port: 0 });
  const b = await createSync(t, root, 'b', { port: 0 });
  await a.setEnabled(true);
  await b.setEnabled(true);
  a.connect = () => net.connect(b.port);
  b.connect = () => net.connect(a.port);
  stopAutomaticRetry(a); stopAutomaticRetry(b);
  const pairing = await b.beginPairing();
  const realSavePeers = a.savePeers.bind(a);
  let releaseSave;
  let markSaveStarted;
  const saveStarted = new Promise(resolve => { markSaveStarted = resolve; });
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  let firstSave = true;
  a.savePeers = async () => {
    if (firstSave) { firstSave = false; markSaveStarted(); await saveGate; }
    return realSavePeers();
  };

  const pairingAttempt = a.pairWith({ hostLabel: 'Bee', localLabel: 'Aya', code: pairing.code, direction: 'both', sshTarget: { alias: 'bee' } });
  const pairingRejected = assert.rejects(pairingAttempt, /paused or disabled/i);
  await saveStarted;
  await a.setEnabled(false);
  releaseSave();
  await pairingRejected;

  assert.equal(a.peers.length, 0);
  assert.deepEqual(await savedPeers(a), [], 'the initiator removes the record written by the delayed save');
});

test('receiver disable during delayed accept persistence rejects pairing and rolls back the encrypted file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-pair-receiver-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = await createSync(t, root, 'a', { port: 0 });
  const b = await createSync(t, root, 'b', { port: 0 });
  await a.setEnabled(true);
  await b.setEnabled(true);
  a.connect = () => net.connect(b.port);
  b.connect = () => net.connect(a.port);
  stopAutomaticRetry(a); stopAutomaticRetry(b);
  const pairing = await b.beginPairing();
  const realSavePeers = b.savePeers.bind(b);
  let releaseSave;
  let markSaveStarted;
  const saveStarted = new Promise(resolve => { markSaveStarted = resolve; });
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  let firstSave = true;
  b.savePeers = async () => {
    if (firstSave) { firstSave = false; markSaveStarted(); await saveGate; }
    return realSavePeers();
  };

  const pairingAttempt = a.pairWith({ hostLabel: 'Bee', localLabel: 'Aya', code: pairing.code, direction: 'both', sshTarget: { alias: 'bee' } });
  const pairingRejected = assert.rejects(pairingAttempt, /did not accept clipboard pairing|not ready/i);
  await saveStarted;
  await b.setEnabled(false);
  releaseSave();
  await pairingRejected;
  await waitFor(() => !b.peers.some(peer => peer.id === a.settings.deviceId), 'receiver pairing rollback');
  await b.writes;

  assert.equal(b.peers.some(peer => peer.id === a.settings.deviceId), false);
  assert.deepEqual(await savedPeers(b), [], 'the receiver removes its post-save cancelled peer from disk');
});

test('failed disable and pause preference writes fail closed for the running session', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-settings-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sync = await createSync(t, root, 'device', { port: 0 });
  await sync.setEnabled(true);
  const realSaveSettings = sync.saveSettings.bind(sync);
  sync.saveSettings = async () => { throw new Error('synthetic disk failure'); };

  await assert.rejects(sync.setEnabled(false), /off for this session.*could not be saved/i);
  assert.equal(sync.state().enabled, false);
  assert.equal(sync.server, null);

  sync.saveSettings = realSaveSettings;
  await sync.setEnabled(true);
  sync.saveSettings = async () => { throw new Error('synthetic disk failure'); };
  await assert.rejects(sync.setPaused(true), /paused for this session.*could not be saved/i);
  assert.equal(sync.state().paused, true);
  assert.equal(sync.server !== null, true, 'pause closes peer sockets but leaves the loopback listener instance allocated');
});

test('reconnect delivers a fresh pending item and drops it once it is stale', async t => {
  const received = [];
  const clock = { value: Date.now() };
  const { root, a, b, now } = await paired(t, { clock, onBItem: item => received.push(item) });
  const peer = a.peers[0];

  await b.shutdown();
  const reconnected = await createSync(t, root, 'b', { now, onItem: item => received.push(item), port: 0 });
  await reconnected.setEnabled(true);
  stopAutomaticRetry(reconnected);
  a.dropSocket(peer);
  a.connect = () => { throw new Error('peer temporarily offline'); };

  const fresh = textItem(a.settings.deviceId, 'deliver-after-reconnect', now());
  await a.submitLocal(fresh);
  assert.equal(a.pending.get(peer.id)?.eventId, fresh.eventId);

  a.connect = () => net.connect(reconnected.port);
  peer.retryAt = 0;
  await a.retry();
  await waitFor(() => received.some(item => item.eventId === fresh.eventId), 'fresh item after reconnect');
  await waitFor(() => !a.pending.has(peer.id), 'fresh item acknowledgement');

  a.dropSocket(peer);
  a.connect = () => { throw new Error('peer temporarily offline'); };
  const stale = textItem(a.settings.deviceId, 'expire-while-offline', now());
  await a.submitLocal(stale);
  assert.equal(a.pending.get(peer.id)?.eventId, stale.eventId);
  clock.value += 120001;
  peer.retryAt = 0;
  await a.retry();

  assert.equal(a.pending.has(peer.id), false, 'an expired item is removed from the one-item pending slot');
  assert.equal(received.some(item => item.eventId === stale.eventId), false);
});

test('a valid token with a tampered hello device ID is rejected', async t => {
  const { a, b } = await paired(t);
  const expected = b.peers.find(peer => peer.id === a.settings.deviceId);
  const existingSocket = expected.socket;
  const stranger = net.connect(b.port);
  const response = readNextFrame(stranger);
  stranger.write(protocol.encodeFrame({ v: 1, type: 'hello', deviceId: crypto.randomUUID(), token: expected.token }));

  const reply = await response;
  assert.deepEqual({ type: reply.type, reason: reply.reason }, { type: 'reject', reason: 'auth' });
  assert.equal(expected.socket, existingSocket, 'a failed identity check does not replace the authenticated connection');
  stranger.destroy();
});
