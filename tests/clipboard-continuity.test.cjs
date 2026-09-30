'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { ClipboardSync } = require('../desktop/clipboard-sync.cjs');
const { ClipboardContinuity, INTERVAL_MS, MAX_BACKOFF_MS } = require('../desktop/clipboard-continuity.cjs');
const protocol = require('../desktop/clipboard-sync-protocol.cjs');
const key = crypto.randomBytes(32);
const storage = {
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(value) { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
  decryptString(value) { const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(); },
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error('Synthetic sync fixture timed out'); await delay(5); } }
const event = (text = 'synthetic clipboard', createdAt = Date.now()) => ({ eventId: crypto.randomUUID(), kind: 'text', text, createdAt });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(t, count = 3) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-continuity-'));
  const received = Array.from({ length: count }, () => []), devices = [];
  for (let i = 0; i < count; i++) {
    const device = new ClipboardSync({ dataDir: path.join(directory, String(i)), safeStorage: storage, port: 0, onItem: item => received[i].push(item), connect: peer => net.connect(devices[Number(peer.sshTarget.alias.split('-')[1])].port, '127.0.0.1'), readOwnerBootstrap: async target => devices[Number(target.alias.split('-')[1])].ownerBootstrap });
    devices.push(device);
  }
  t.after(async () => { await Promise.allSettled(devices.map(device => device.shutdown())); await fs.rm(directory, { recursive: true, force: true }); });
  await Promise.all(devices.map(device => device.ready));
  return { directory, devices, received, link: (a, b, options = {}) => devices[a].pairOwnedWith({ hostLabel: `Device ${b}`, localLabel: `Device ${a}`, sshTarget: { alias: `fixture-${b}` }, ...options }) };
}
async function enable(devices) { for (const device of devices) await device.setContinuity(true); }

test('legacy defaults remain off, opt-in is atomic and disabling restores both manual receive preferences', async t => {
  const { devices, directory } = await fixture(t, 1); const [sync] = devices;
  assert.equal(sync.state().enabled, false); assert.equal(sync.state().continuity, false);
  await sync.setEnabled(true); await sync.setPaused(true); await sync.setContinuity(true);
  assert.equal(sync.state().enabled, true); assert.equal(sync.state().paused, false); assert.equal(sync.state().receiveMode, 'clipboard');
  await sync.setContinuity(false); assert.equal(sync.state().receiveMode, 'history');
  await sync.setReceiveMode('clipboard'); await sync.setContinuity(true); await sync.setContinuity(false);
  assert.equal(sync.state().receiveMode, 'clipboard');
  const saved = JSON.parse(await fs.readFile(path.join(sync.directory, 'settings.json'), 'utf8'));
  delete saved.continuity; delete saved.continuityReceiveMode;
  await fs.writeFile(path.join(sync.directory, 'settings.json'), JSON.stringify(saved));
  await sync.shutdown();
  const legacy = new ClipboardSync({ dataDir: path.join(directory, '0'), safeStorage: storage, port: 0 });
  await legacy.ready; assert.equal(legacy.state().continuity, false); assert.equal(legacy.state().receiveMode, 'clipboard'); await legacy.shutdown();
});
test('failed Continuity persistence never enables sync or changes the previous manual receive choice', async t => {
  const { devices } = await fixture(t, 1); const [sync] = devices;
  sync.saveSettings = async () => { throw new Error('Synthetic storage failure'); };
  await assert.rejects(sync.setContinuity(true), /could not be saved/);
  assert.equal(sync.state().enabled, false); assert.equal(sync.state().continuity, false); assert.equal(sync.state().receiveMode, 'history');
  assert.equal(sync.server, null); assert.equal(sync.ownerBootstrap, null);
});
for (const boundary of ['disable', 'pause', 'shutdown']) test(`Continuity saving cannot revive a concurrent ${boundary}`, async t => {
  const { devices } = await fixture(t, 1); const [sync] = devices;
  const begun = gate(), hold = gate(), original = sync.saveSettings.bind(sync); let first = true;
  sync.saveSettings = async settings => { if (first) { first = false; begun.release(); await hold.promise; } return original(settings); };
  const pending = sync.setContinuity(true); const rejection = assert.rejects(pending);
  await begun.promise;
  if (boundary === 'disable') await sync.setEnabled(false);
  if (boundary === 'pause') await sync.setPaused(true);
  if (boundary === 'shutdown') await sync.shutdown();
  hold.release(); await rejection;
  assert.equal(sync.state().enabled, false); assert.equal(sync.server, null); assert.equal(sync.ownerBootstrap, null);
});
for (const topology of ['star', 'triangle']) test(`${topology}: text, URL and PNG reach all three synthetic native clipboard callbacks once with ACKs and no echo`, async t => {
  const { devices, received, link } = await fixture(t); await enable(devices);
  await link(0, 1); await link(0, 2); if (topology === 'triangle') await link(1, 2);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const payloads = [{ kind: 'text', text: 'synthetic plain text' }, { kind: 'url', text: 'https://example.com/synthetic' }, { kind: 'png', png }];
  let stamp = Date.now();
  for (let sender = 0; sender < 3; sender++) for (const payload of payloads) {
    const item = { ...event('', ++stamp), ...payload };
    await devices[sender].submitLocal(item);
    await until(() => received.every((items, index) => index === sender || items.some(entry => entry.eventId === item.eventId)));
    await until(() => devices.every(device => device.pending.size === 0));
    for (let receiver = 0; receiver < 3; receiver++) {
      const copies = received[receiver].filter(entry => entry.eventId === item.eventId);
      assert.equal(copies.length, receiver === sender ? 0 : 1);
      if (receiver !== sender) { assert.equal(copies[0].receiveMode, 'clipboard'); assert.equal(copies[0].createdAt, item.createdAt); assert.equal(copies[0][payload.kind === 'png' ? 'png' : 'text'], payload[payload.kind === 'png' ? 'png' : 'text']); }
    }
    await devices[sender].submitLocal(item);
  }
  await delay(50); assert.equal(received.reduce((sum, items) => sum + items.length, 0), 18);
  for (const device of devices) assert.equal(JSON.stringify(device.state()).includes('synthetic plain text'), false);
});
test('Continuity alone enables relay; manual receive, paused peers and send directions retain their choices', async t => {
  const { devices, received, link } = await fixture(t); await enable(devices); await link(0, 1); await link(0, 2);
  await devices[0].setContinuity(false);
  await devices[1].submitLocal(event('manual has no relay')); await until(() => received[0].length === 1); await delay(20); assert.equal(received[2].length, 0);
  await devices[0].setContinuity(true); await devices[0].updatePeer({ id: devices[2].settings.deviceId, paused: true });
  await devices[1].submitLocal(event('paused route')); await until(() => received[0].length === 2); assert.equal(received[2].length, 0);
  await devices[0].updatePeer({ id: devices[2].settings.deviceId, paused: false, direction: 'receive' });
  await devices[1].submitLocal(event('receive only route')); await until(() => received[0].length === 3); assert.equal(received[2].length, 0);
  await devices[0].setContinuity(true);
  assert.equal(devices[0].peers.find(peer => peer.id === devices[2].settings.deviceId).direction, 'receive');
});
test('only fresh latest local content joins a new peer; newer remote content and pause erase the local cache', async t => {
  const { devices, received, link } = await fixture(t); await enable(devices);
  const old = event('old local', Date.now() - 1000), current = event('latest local');
  await devices[0].submitLocal(old); await devices[0].submitLocal(current); await link(0, 1);
  await until(() => received[1].length === 1); assert.equal(received[1][0].eventId, current.eventId);
  const remote = event('new remote', current.createdAt + 1); await devices[1].submitLocal(remote); await until(() => received[0].length === 1);
  assert.equal(devices[0].latestLocal, null); await link(0, 2); await delay(20); assert.equal(received[2].length, 0);
  await devices[0].submitLocal(event('before pause', remote.createdAt + 1)); await devices[0].setPaused(true); await devices[0].setPaused(false);
  assert.equal(devices[0].latestLocal, null);
});
test('older fresh reconnect events enter history without overwriting the newer native clipboard or pending event', async t => {
  const { devices, received, link } = await fixture(t); await enable(devices); await link(0, 1); await link(0, 2);
  const current = event('newest local', Date.now()); await devices[0].submitLocal(current);
  await until(() => received[1].length && received[2].length); received[0].length = 0;
  const old = { v: 1, type: 'item', ...event('delayed older', current.createdAt - 100), originDeviceId: devices[1].settings.deviceId };
  const peer = devices[0].peers.find(item => item.id === devices[1].settings.deviceId);
  assert.equal(await devices[0].acceptItem(peer, old), true);
  assert.equal(received[0][0].receiveMode, 'history'); assert.equal(devices[0].latestLocal.eventId, current.eventId);
  assert.equal(await devices[0].acceptItem(peer, { ...old, eventId: crypto.randomUUID(), createdAt: Date.now() - protocol.FRESH_MS - 1 }), false);
});
test('an awaited incoming callback cannot relay over a newer local event', async t => {
  const { devices, link } = await fixture(t); await enable(devices); await link(0, 1); await link(0, 2);
  const begun = gate(), hold = gate(); devices[0].onItem = async () => { begun.release(); await hold.promise; };
  const peer = devices[0].peers.find(item => item.id === devices[1].settings.deviceId);
  const old = { v: 1, type: 'item', ...event('older incoming'), originDeviceId: peer.id };
  const incoming = devices[0].acceptItem(peer, old); await begun.promise;
  const newer = event('newer local', old.createdAt + 1); await devices[0].submitLocal(newer); hold.release(); await incoming;
  assert.equal(devices[0].newestEvent.eventId, newer.eventId);
  assert.notEqual(devices[0].pending.get(devices[2].settings.deviceId)?.eventId, old.eventId);
});
test('revocation persists encrypted exclusions, refuses aliases and receiver-side owner rejoin, and requires explicit allow again', async t => {
  const { devices, link, directory } = await fixture(t, 2); await enable(devices); await link(0, 1);
  const receiverId = devices[1].settings.deviceId, senderId = devices[0].settings.deviceId;
  await devices[0].revoke(receiverId); await until(() => devices[1].peers.length === 0);
  assert.equal(devices[1].state().excludedPeers[0].id, senderId);
  await assert.rejects(link(0, 1, { automatic: true }), /Allow/);
  devices[0].readOwnerBootstrap = async () => devices[1].ownerBootstrap;
  await assert.rejects(devices[0].pairOwnedWith({ hostLabel: 'Different alias', sshTarget: { alias: 'alternative' }, automatic: true }), /Allow/);
  await devices[0].restoreExcludedPeer(receiverId);
  await assert.rejects(link(0, 1, { automatic: true }), /not ready|accept/);
  await devices[1].restoreExcludedPeer(senderId); await link(0, 1, { automatic: true });
  assert.equal(devices[0].peers.length, 1); await devices[0].revoke(receiverId); await until(() => devices[1].peers.length === 0);
  await devices[0].shutdown();
  const restored = new ClipboardSync({ dataDir: path.join(directory, '0'), safeStorage: storage, port: 0 }); await restored.ready;
  assert.equal(restored.state().excludedPeers[0].id, receiverId); assert.equal(restored.isExcludedTarget({ alias: 'fixture-1', identityFile: '/different/key' }), true);
  const file = await fs.readFile(path.join(restored.directory, 'peers.bin')); assert.equal(file.includes(Buffer.from(receiverId)), false);
  assert.deepEqual(Object.keys(restored.state().excludedPeers[0]).sort(), ['id', 'label']); await restored.shutdown();
});
test('automatic aliases and offline peers never replace directions, paused choices or tokens; local bootstrap is skipped', async t => {
  const { devices, link } = await fixture(t, 2); await enable(devices); await link(0, 1);
  const peer = devices[0].peers[0]; await devices[0].updatePeer({ id: peer.id, paused: true, direction: 'send' }); devices[0].dropSocket(peer);
  let reads = 0; devices[0].readOwnerBootstrap = async () => { reads++; return devices[1].ownerBootstrap; };
  await link(0, 1, { automatic: true }); assert.equal(reads, 0);
  const result = await devices[0].pairOwnedWith({ hostLabel: 'Alias', sshTarget: { alias: 'alternate' }, automatic: true });
  assert.equal(result.linkedPeerId, peer.id); assert.equal(devices[0].peers[0], peer); assert.equal(peer.direction, 'send'); assert.equal(peer.paused, true);
  devices[0].readOwnerBootstrap = async () => devices[0].ownerBootstrap;
  assert.equal((await devices[0].pairOwnedWith({ hostLabel: 'Self', sshTarget: { alias: 'self' }, automatic: true })).skippedSelf, true);
});

function fakeSync() {
  const sync = { ready: Promise.resolve(), peers: [], excludedPeers: [], enabled: false, blocked: false, cancelled: 0, state() { return { continuity: this.enabled, peers: this.peers.map(peer => ({ ...peer, status: peer.socket ? 'connected' : 'offline' })), excludedPeers: this.excludedPeers }; }, canLink() { return this.enabled && !this.blocked; }, canSend() { return this.canLink(); }, hasTarget(target) { return this.peers.some(peer => peer.sshTarget?.alias === target.alias); }, isExcludedTarget(target) { return this.excludedPeers.some(peer => peer.sshTarget?.alias === target.alias); }, cancelAutomaticOwnerRequests() { this.cancelled++; } };
  return sync;
}
const host = (id, extra = {}) => ({ id, name: `Device ${id}`, status: 'ready', ...extra });
test('coordinator opt-out and privacy blocking perform zero host reads or owner-link operations', async () => {
  const sync = fakeSync(); let reads = 0, links = 0;
  const coordinator = new ClipboardContinuity({ sync, getHosts: async () => { reads++; return [host('a')]; }, targetForHost: h => ({ alias: h.id }), linkHost: async () => { links++; } });
  await coordinator.start(); assert.equal(coordinator.timer.hasRef(), false); await coordinator.tick();
  assert.equal(reads, 0); assert.equal(links, 0);
  sync.enabled = true; sync.blocked = true; await coordinator.tick(); assert.equal(reads, 0); await coordinator.shutdown();
});
test('coordinator selects unique ready saved routes and serializes links with bounded quiet exponential backoff', async () => {
  const sync = fakeSync(); sync.enabled = true; let clock = 0, active = 0, maxActive = 0, calls = 0;
  const hosts = [host('a'), host('same', { route: 'a' }), host('b'), host('not-ready', { status: 'checking' }), host('offline', { status: 'offline' })];
  const coordinator = new ClipboardContinuity({ sync, now: () => clock, getHosts: async () => hosts, targetForHost: h => ({ alias: h.route || h.id }), linkHost: async () => { calls++; active++; maxActive = Math.max(maxActive, active); await delay(1); active--; throw new Error('sensitive SSH stderr'); } });
  await Promise.all([coordinator.tick(), coordinator.tick(), coordinator.tick()]); assert.equal(calls, 2); assert.equal(maxActive, 1);
  assert.equal(coordinator.state().devices.length, 2); assert.equal(JSON.stringify(coordinator.state()).includes('sensitive'), false);
  await coordinator.tick(); assert.equal(calls, 2);
  for (let i = 0; i < 9; i++) { clock += MAX_BACKOFF_MS; await coordinator.tick(); }
  for (const attempt of coordinator.attempts.values()) { assert.equal(attempt.failures, 6); assert.ok(attempt.nextAt - clock <= MAX_BACKOFF_MS); }
  assert.equal(INTERVAL_MS, 30000); await coordinator.shutdown();
});
test('coordinator cancels a mutation sequence and bounds host and peer candidates at 32', async () => {
  const sync = fakeSync(); sync.enabled = true; const begun = gate(), hold = gate(); let calls = 0;
  const coordinator = new ClipboardContinuity({ sync, getHosts: async () => Array.from({ length: 80 }, (_, i) => host(String(i))), targetForHost: h => ({ alias: h.id }), linkHost: async () => { calls++; begun.release(); await hold.promise; return {}; } });
  const pending = coordinator.start(); await begun.promise; coordinator.stop(); hold.release(); await pending;
  assert.equal(calls, 1); assert.equal(sync.cancelled, 1); assert.equal(coordinator.state().devices.length, 0);
  sync.peers = Array.from({ length: 32 }, (_, i) => ({ id: `peer-${i}`, sshTarget: { alias: `peer-${i}` } }));
  await coordinator.start(); assert.equal(calls, 1); assert.equal(coordinator.state().devices.length, 32); await coordinator.shutdown();
});
test('coordinator tracks alias identity without re-pairing and allows a removed identity to reconnect after explicit restore', async () => {
  const sync = fakeSync(); sync.enabled = true; let calls = 0;
  const peer = { id: crypto.randomUUID(), label: 'Linked computer', direction: 'send', paused: true, sshTarget: { alias: 'original' } }; sync.peers.push(peer);
  const coordinator = new ClipboardContinuity({ sync, getHosts: async () => [host('alternate')], targetForHost: h => ({ alias: h.id }), linkHost: async () => { calls++; if (!sync.peers.length) sync.peers.push(peer); return { linkedPeerId: peer.id }; } });
  await coordinator.tick(); await coordinator.tick(); assert.equal(calls, 1); assert.equal(coordinator.state().devices[0].status, 'paused');
  sync.peers = []; sync.excludedPeers = [{ id: peer.id, label: peer.label }]; await coordinator.tick(); assert.equal(calls, 1); assert.equal(coordinator.state().devices[0].status, 'excluded');
  sync.excludedPeers = []; await coordinator.tick(); assert.equal(calls, 2); await coordinator.shutdown();
});

test('simultaneous automatic owner links converge to one authenticated token and reconnect', async t => {
  const { devices, link, received } = await fixture(t, 2); await enable(devices);
  const outcomes = await Promise.allSettled([link(0, 1, { automatic: true }), link(1, 0, { automatic: true })]);
  assert.ok(outcomes.some(outcome => outcome.status === 'fulfilled'));
  await until(() => devices.every(device => device.peers.length === 1));
  assert.equal(devices[0].peers[0].token, devices[1].peers[0].token);
  for (const device of devices) device.dropSocket(device.peers[0]);
  // Give either initiating side a synthetic saved loopback route for reconnection.
  devices[0].peers[0].sshTarget = { alias: 'fixture-1' };
  await devices[0].submitLocal(event('authenticated after simultaneous reconnect'));
  await until(() => received[1].length === 1);
  assert.equal(received[1][0].receiveMode, 'clipboard');
  await until(() => devices[0].pending.size === 0);
});
test('offline Continuity pending events reconnect once, expire within TTL and clear at disable boundaries', async t => {
  const { devices, received, link } = await fixture(t, 2); await enable(devices); await link(0, 1);
  const sender = devices[0], peer = sender.peers[0], original = sender.connect;
  sender.dropSocket(peer); sender.connect = async () => { throw new Error('Synthetic offline'); };
  const fresh = event('fresh reconnect'); await sender.submitLocal(fresh); assert.equal(sender.pending.get(peer.id).eventId, fresh.eventId);
  sender.connect = original; peer.retryAt = 0; await sender.flush(peer); await until(() => received[1].length === 1);
  await until(() => sender.pending.size === 0);
  sender.dropSocket(peer); sender.connect = async () => { throw new Error('Synthetic offline'); };
  const pending = event('expires before reconnect', fresh.createdAt + 1); await sender.submitLocal(pending);
  sender.now = () => pending.createdAt + protocol.FRESH_MS + 1; peer.retryAt = 0; sender.connect = original;
  await sender.flush(peer); assert.equal(sender.pending.size, 0); assert.equal(received[1].length, 1);
  sender.latestLocal = pending; await sender.setEnabled(false); assert.equal(sender.latestLocal, null); assert.equal(sender.pending.size, 0);
});
test('new peer bootstrap cannot replay stale cached local content', async t => {
  const { devices, received, link } = await fixture(t, 2); await enable(devices);
  const cached = event('synthetic stale cache'); await devices[0].submitLocal(cached);
  devices[0].now = () => cached.createdAt + protocol.FRESH_MS + 1;
  // Pair manually so simulated clock skew only affects cached-event freshness,
  // rather than rejecting the owner's independently generated fresh capability.
  const code = (await devices[1].beginPairing()).code;
  await devices[0].pairWith({ hostLabel: 'New receiver', sshTarget: { alias: 'fixture-1' }, code });
  await delay(20); assert.equal(received[1].length, 0); assert.equal(devices[0].latestLocal, null);
});
