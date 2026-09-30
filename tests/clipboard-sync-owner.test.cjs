'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { ClipboardSync } = require('../desktop/clipboard-sync.cjs');
const protocol = require('../desktop/clipboard-sync-protocol.cjs');
const { buildBootstrapArgs, readOwnerBootstrap } = require('../desktop/clipboard-sync-ssh.cjs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const secretStoreKey = crypto.randomBytes(32);
const storage = {
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString(s) { const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', secretStoreKey, nonce); const payload = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), payload]); },
  decryptString(b) { const decipher = crypto.createDecipheriv('aes-256-gcm', secretStoreKey, b.subarray(0, 12)); decipher.setAuthTag(b.subarray(12, 28)); return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8'); },
};
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-owner-'));
  let blocked = false;
  const b = new ClipboardSync({ dataDir: path.join(dir, 'b'), safeStorage: storage, port: 0, isBlocked: () => blocked });
  const a = new ClipboardSync({ dataDir: path.join(dir, 'a'), safeStorage: storage, port: 0, connect: () => net.connect(b.port, '127.0.0.1'), readOwnerBootstrap: async () => JSON.parse(await fs.readFile(path.join(b.ownerDirectory, 'bootstrap.json'), 'utf8')) });
  t.after(async () => { await Promise.allSettled([a.shutdown(), b.shutdown()]); await fs.rm(dir, { recursive: true, force: true }); });
  await Promise.all([a.ready, b.ready]); await Promise.all([a.setEnabled(true), b.setEnabled(true)]);
  return { a, b, dir, block: value => { blocked = value; } };
}
const link = a => a.pairOwnedWith({ hostLabel: 'Fixture receiver', sshTarget: { alias: 'fixture' }, direction: 'both' });
test('owner capability is private, fresh, absent from state and consumed independently of manual pairing', async t => {
  const { a, b } = await fixture(t);
  const file = path.join(b.ownerDirectory, 'bootstrap.json');
  const old = JSON.parse(await fs.readFile(file, 'utf8'));
  protocol.validateOwnerBootstrap(old);
  if (process.platform !== 'win32') { assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.equal((await fs.stat(b.ownerDirectory)).mode & 0o777, 0o700); }
  assert.equal(JSON.stringify(b.state()).includes(old.capability), false);
  assert.equal(b.pairing, null); await link(a);
  assert.equal(a.peers[0].id, b.settings.deviceId);
  assert.equal(a.peers[0].token, b.peers[0].token);
  const encrypted = await fs.readFile(path.join(a.directory, 'peers.bin'));
  assert.equal(encrypted.includes(Buffer.from(a.peers[0].token)), false);
  assert.equal(encrypted.includes(Buffer.from(old.capability)), false);
  assert.equal(JSON.parse(storage.decryptString(encrypted)).peers[0].token, a.peers[0].token);
  assert.notEqual(JSON.parse(await fs.readFile(file, 'utf8')).capability, old.capability);
  const wire = { v: 1, type: 'owner-pair', capability: old.capability, receiverDeviceId: b.settings.deviceId, deviceId: crypto.randomUUID(), label: 'Replay', direction: 'both' };
  const socket = await a.open({ sshTarget: { alias: 'fixture' } });
  assert.equal((await a.exchange(socket, wire)).type, 'reject'); socket.destroy();
  await b.setPaused(true); await assert.rejects(fs.access(file));
  await b.setPaused(false); assert.notEqual(JSON.parse(await fs.readFile(file, 'utf8')).capability, old.capability);
  await b.setEnabled(false); await assert.rejects(fs.access(file));
});
test('tools blocking invalidates capability, endpoint binding fails closed, and paused links are preserved', async t => {
  const { a, b, block } = await fixture(t);
  block(true); await b.refreshOwnerBootstrap(); await assert.rejects(fs.access(path.join(b.ownerDirectory, 'bootstrap.json')));
  block(false); await b.refreshOwnerBootstrap();
  const originalRead = a.readOwnerBootstrap;
  a.readOwnerBootstrap = async () => ({ ...await originalRead(), deviceId: crypto.randomUUID() });
  await assert.rejects(link(a)); assert.equal(b.peers.length, 0);
  a.readOwnerBootstrap = originalRead; await link(a);
  await b.updatePeer({ id: a.settings.deviceId, paused: true });
  await assert.rejects(link(a)); assert.equal(b.peers[0].paused, true);
});
test('disable cancels bootstrap retrieval without opening a sync connection', async t => {
  const { a } = await fixture(t); let opened = 0;
  a.connect = () => { opened++; throw new Error('fixture'); };
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  a.readOwnerBootstrap = (_target, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
  const pending = link(a); const rejection = assert.rejects(pending, /cancelled/); await ready; await a.setEnabled(false); await rejection; assert.equal(opened, 0);
});
test('explicit Settings linking succeeds while content is blocked, but sensitive editing blocks linking', async t => {
  const { a, b } = await fixture(t); const received = [];
  a.isBlocked = () => true; b.isBlocked = () => true;
  a.isLinkBlocked = () => false; b.isLinkBlocked = () => false;
  b.onItem = item => received.push(item);
  await b.refreshOwnerBootstrap();
  const linked = await link(a); assert.equal(linked.linkedPeerId, b.settings.deviceId);
  assert.equal(a.canSend(), false); assert.equal(b.canSend(), false);
  await a.submitLocal({ eventId: crypto.randomUUID(), kind: 'text', text: 'synthetic blocked Settings content', createdAt: Date.now() });
  assert.equal(a.pending.size, 0); assert.equal(received.length, 0);
  a.isLinkBlocked = () => true; await assert.rejects(link(a), /Clipboard tools/);
  b.isLinkBlocked = () => true; await b.refreshOwnerBootstrap();
  await assert.rejects(fs.access(path.join(b.ownerDirectory, 'bootstrap.json')));
});
test('pause and resume during owner capability rotation cannot revive the old pairing request', async t => {
  const { a, b } = await fixture(t); const refresh = b.refreshOwnerBootstrap.bind(b);
  let first = true, release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  b.refreshOwnerBootstrap = async rotate => { if (rotate && first) { first = false; started(); await gate; } return refresh(rotate); };
  const pending = link(a); const rejection = assert.rejects(pending);
  await ready; await b.setPaused(true); await b.setPaused(false); release(); await rejection;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(a.peers.length, 0); assert.equal(b.peers.length, 0);
});
test('pause and resume during owner peer persistence cancels and rolls back the saved pairing', async t => {
  const { a, b } = await fixture(t); const save = b.savePeers.bind(b);
  let first = true, release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  b.savePeers = async () => { if (first) { first = false; started(); await gate; } return save(); };
  const pending = link(a); const rejection = assert.rejects(pending);
  await ready; await b.setPaused(true); await b.setPaused(false); release(); await rejection;
  await new Promise(resolve => setTimeout(resolve, 30)); await b.writes;
  assert.equal(a.peers.length, 0); assert.equal(b.peers.length, 0);
  assert.deepEqual(JSON.parse(storage.decryptString(await fs.readFile(path.join(b.directory, 'peers.bin')))).peers, []);
});
test('revocation invalidates fetched bootstrap and capability renews before its bounded expiry', async t => {
  const { a, b } = await fixture(t); await link(a);
  const originalRead = a.readOwnerBootstrap;
  const old = await originalRead();
  await b.revoke(a.settings.deviceId);
  a.readOwnerBootstrap = async () => old;
  await assert.rejects(link(a)); assert.equal(b.peers.length, 0);
  const previous = b.ownerBootstrap;
  const later = Date.now() + protocol.FRESH_MS * 0.75;
  b.now = () => later; await b.refreshOwnerBootstrap();
  assert.notEqual(b.ownerBootstrap.capability, previous.capability);
  assert.equal(b.ownerBootstrap.expiresAt, later + protocol.FRESH_MS);
  await b.shutdown(); await assert.rejects(fs.access(path.join(b.ownerDirectory, 'bootstrap.json')));
});
test('owner protocol has strict shapes, bounded timestamps and no secret echoed in errors', () => {
  const bootstrap = { v: 1, type: 'owner-bootstrap', deviceId: crypto.randomUUID(), capability: 'f'.repeat(64), expiresAt: Date.now() + 10000 };
  assert.throws(() => protocol.validateOwnerBootstrap({ ...bootstrap, arbitrary: true }), /malformed/);
  assert.throws(() => protocol.validateOwnerBootstrap({ ...bootstrap, expiresAt: Date.now() + 999999 }), /fresh/);
  assert.throws(() => protocol.validateOwnerBootstrap({ ...bootstrap, expiresAt: Date.now() - 1 }), /fresh/);
  assert.throws(() => protocol.validateMessage({ v: 1, type: 'owner-pair', receiverDeviceId: bootstrap.deviceId, deviceId: crypto.randomUUID(), capability: bootstrap.capability, direction: 'both', label: 'Fixture', remotePath: '/tmp' }), /malformed/);
  const args = buildBootstrapArgs({ alias: 'fixture' }); assert.equal(args.includes('-W'), false); assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(args.includes('PreferredAuthentications=publickey')); assert.equal(args.some(arg => arg.includes(bootstrap.capability)), false);
});
test('bootstrap stdout is capped and cancellation kills the owned SSH process without surfacing stderr', async () => {
  const children = [];
  const spawnProcess = () => { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { process.nextTick(() => child.emit('close', 1)); return true; }; children.push(child); process.nextTick(() => { child.stderr.write('secret stderr'); child.stdout.write(Buffer.alloc(2049)); }); return child; };
  await assert.rejects(readOwnerBootstrap({ alias: 'fixture' }, { spawnProcess }), error => !error.message.includes('secret'));
  assert.equal(children.length, 2);
});
