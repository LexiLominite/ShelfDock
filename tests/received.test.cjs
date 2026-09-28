'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { ReceivedManager, RECEIPT_NAME, MAX_MANIFEST_BYTES, validateManifest, encodeManifest } = require('../desktop/received.cjs');
const { DriftService } = require('../desktop/service.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-received-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const desktopDir = path.join(directory, 'receiver', 'Desktop'); await fs.mkdir(desktopDir, { recursive: true });
  const dataDir = path.join(directory, 'receiver-data'); const opened = [];
  const service = new DriftService({ dataDir: path.join(directory, 'shelf'), homeDir: path.join(directory, 'receiver'), platform: 'linux', execFile: async () => { throw new Error('No network should be used.'); } });
  const manager = new ReceivedManager({ dataDir, desktopDir, service, openPath: async folder => { opened.push(folder); return ''; } });
  await manager.initialized;
  t.after(() => { manager.stop(); clearTimeout(service.clearUndoTimer); });
  return { directory, desktopDir, dataDir, manager, service, opened };
}
function manifest(extra = {}) {
  return { version: 1, id: crypto.randomUUID(), senderLabel: 'Travel laptop', sentAt: '2026-09-28T12:34:56.000Z', items: [{ name: 'note.txt', kind: 'text', size: 5 }], ...extra };
}
async function batch(desktopDir, receipt = manifest(), { complete = true, payload = true } = {}) {
  const folderName = 'Drift-2026-09-28T12-34-56-000Z-' + crypto.randomBytes(4).toString('hex');
  const folder = path.join(desktopDir, folderName); await fs.mkdir(folder);
  if (payload) for (const item of receipt.items) {
    if (item.kind === 'folder') await fs.mkdir(path.join(folder, item.name));
    else await fs.writeFile(path.join(folder, item.name), 'hello');
  }
  if (complete) await fs.writeFile(path.join(folder, RECEIPT_NAME), JSON.stringify(receipt));
  return { folder, folderName, receipt };
}

test('only completed batches are found, unread is durable, and reusing files never sends or deletes them', async t => {
  const { manager, service, desktopDir, dataDir, opened } = await fixture(t);
  const ready = await batch(desktopDir, manifest({ items: [{ name: 'note.txt', kind: 'text', size: 5 }, { name: 'assets', kind: 'folder', size: 0 }] }));
  await batch(desktopDir, manifest(), { complete: false });
  await batch(desktopDir, manifest(), { payload: false });
  let state = await manager.refresh();
  assert.equal(state.received.length, 1); assert.equal(state.unreadCount, 1); assert.equal(state.received[0].senderLabel, 'Travel laptop');
  assert.equal(state.received[0].available, true); assert.ok(!JSON.stringify(state).includes(desktopDir));
  assert.deepEqual((await manager.refresh()).received, state.received, 'refresh deduplicates the same completed receipt');
  const id = state.received[0].id;
  await assert.rejects(manager.addToShelf({ id, names: ['../secret'] }), /Choose items/);
  const shelf = await manager.addToShelf({ id, names: ['note.txt'] });
  assert.equal(shelf.items.length, 1); assert.equal(shelf.enqueuedItemIds.length, 1); assert.equal(shelf.history.length, 0);
  assert.equal((await manager.getState()).unreadCount, 0);
  await manager.openFolder({ id }); assert.deepEqual(opened, [await fs.realpath(ready.folder)]);
  await service.removeItem(shelf.items[0].id); assert.equal(await fs.readFile(path.join(ready.folder, 'note.txt'), 'utf8'), 'hello');
  const reloaded = new ReceivedManager({ dataDir, desktopDir }); state = await reloaded.refresh();
  assert.equal(state.received.length, 1); assert.equal(state.unreadCount, 0);
  assert.equal((await fs.stat(path.join(dataDir, 'received.json'))).mode & 0o777, 0o600);
});

test('unsafe paths, control text, duplicate names, oversized files, and symlink markers never enter Received', async t => {
  const { manager, desktopDir, directory } = await fixture(t);
  for (const name of ['../outside', '/absolute', 'C:\\file', 'child/file', 'child\\file', '.', '..', 'line\nname', RECEIPT_NAME]) {
    await batch(desktopDir, manifest({ items: [{ name, kind: 'file', size: 1 }] }), { payload: false });
  }
  await batch(desktopDir, manifest({ senderLabel: 'trusted\u202eexe' }), { payload: false });
  await batch(desktopDir, manifest({ items: [{ name: 'same', kind: 'file', size: 1 }, { name: 'SAME', kind: 'file', size: 1 }] }), { payload: false });
  const large = await batch(desktopDir, manifest(), { complete: false });
  await fs.writeFile(path.join(large.folder, RECEIPT_NAME), ' '.repeat(MAX_MANIFEST_BYTES + 1));
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, RECEIPT_NAME), encodeManifest(manifest())); await fs.writeFile(path.join(outside, 'note.txt'), 'hello');
  const linkedMarker = await batch(desktopDir, manifest(), { complete: false });
  await fs.symlink(path.join(outside, RECEIPT_NAME), path.join(linkedMarker.folder, RECEIPT_NAME));
  const linkedFile = await batch(desktopDir); await fs.unlink(path.join(linkedFile.folder, 'note.txt'));
  await fs.symlink(path.join(outside, 'note.txt'), path.join(linkedFile.folder, 'note.txt'));
  await fs.symlink(outside, path.join(desktopDir, 'Drift-2026-09-28T12-34-56-000Z-aaaaaaaa'));
  assert.equal((await manager.refresh()).received.length, 0);
});

test('manifest schema strips unknown metadata and refuses unbounded or invalid values', () => {
  const result = validateManifest(manifest({ address: 'private.invalid', localPath: '/private/data' }));
  assert.equal(result.address, undefined); assert.equal(result.localPath, undefined);
  for (const value of [null, [], manifest({ version: 2 }), manifest({ id: '../../x' }), manifest({ items: [] }), manifest({ items: Array(501).fill({ name: 'item', kind: 'file', size: 1 }) }), manifest({ items: [{ name: 'item', kind: 'file', size: Infinity }] }), manifest({ senderLabel: 'x'.repeat(65) })]) assert.throws(() => validateManifest(value));
  assert.throws(() => encodeManifest(manifest({ items: Array.from({ length: 500 }, (_, index) => ({ name: String(index).padStart(4, '0') + 'a'.repeat(240), kind: 'file', size: 1 })) })), /too large/);
});

test('file size mismatch is incomplete initially and becomes an unavailable historical item after editing', async t => {
  const { manager, desktopDir } = await fixture(t);
  const ready = await batch(desktopDir, manifest({ items: [{ name: 'note.txt', kind: 'text', size: 10 }] }));
  assert.equal((await manager.refresh()).received.length, 0);
  await fs.writeFile(path.join(ready.folder, 'note.txt'), '0123456789');
  let state = await manager.refresh(); assert.equal(state.received.length, 1); assert.equal(state.received[0].available, true);
  await fs.writeFile(path.join(ready.folder, 'note.txt'), 'edited');
  state = await manager.refresh(); assert.equal(state.received.length, 1); assert.equal(state.received[0].available, false);
  await assert.rejects(manager.addToShelf({ id: state.received[0].id }), /moved or changed/);
});

test('history is capped at one hundred batches and unchanged refresh avoids rewriting its index', async t => {
  const { manager, desktopDir } = await fixture(t);
  for (let index = 0; index < 103; index++) await batch(desktopDir);
  let writes = 0; const save = manager.save.bind(manager); manager.save = async records => { writes++; return save(records); };
  let state = await manager.refresh(); assert.equal(state.received.length, 100); assert.equal(state.unreadCount, 100); assert.equal(writes, 1);
  const ids = state.received.map(record => record.id);
  state = await manager.refresh(); assert.deepEqual(state.received.map(record => record.id), ids); assert.equal(writes, 1);
});

test('lost or moved Desktop contents retain history and cannot silently redirect open or reuse actions', async t => {
  const { manager, desktopDir, directory, opened, service, dataDir } = await fixture(t);
  const ready = await batch(desktopDir); let state = await manager.refresh(); const id = state.received[0].id;
  const moved = path.join(directory, 'moved'); await fs.rename(ready.folder, moved);
  await fs.symlink(moved, ready.folder);
  state = await manager.refresh(); assert.equal(state.received.length, 1); assert.equal(state.received[0].available, false);
  await assert.rejects(manager.openFolder({ id }), /no longer available/);
  await assert.rejects(manager.addToShelf({ id }), /no longer available/);
  assert.equal(opened.length, 0); assert.equal((await service.getState()).items.length, 0);
  await fs.rename(desktopDir, desktopDir + '-away');
  state = await manager.refresh(); assert.equal(state.received.length, 1); assert.match(state.error, /Desktop could not be checked/);
  const reloaded = new ReceivedManager({ dataDir, desktopDir }); state = await reloaded.getState();
  assert.equal(state.received.length, 1); assert.equal(state.received[0].available, false);
});

test('a changed completion marker cannot substitute a different item list after indexing', async t => {
  const { manager, desktopDir, opened } = await fixture(t);
  const ready = await batch(desktopDir); const id = (await manager.refresh()).received[0].id;
  await fs.writeFile(path.join(ready.folder, 'other.txt'), 'hello');
  await fs.writeFile(path.join(ready.folder, RECEIPT_NAME), encodeManifest({ ...ready.receipt, items: [{ name: 'other.txt', kind: 'text', size: 5 }] }));
  await assert.rejects(manager.openFolder({ id }), /changed/); await assert.rejects(manager.addToShelf({ id }), /changed/);
  assert.equal(opened.length, 0);
  const state = await manager.refresh(); assert.equal(state.received[0].items[0].name, 'note.txt'); assert.equal(state.received[0].available, false);
});

test('refresh and mark-read serialize without restoring unread state; failed persistence leaves read state intact', async t => {
  const { manager, desktopDir } = await fixture(t); await batch(desktopDir);
  const id = (await manager.refresh()).received[0].id;
  const originalInspect = manager.inspect.bind(manager); let enter; let release;
  const started = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  manager.inspect = async (...args) => { enter(); await gate; return originalInspect(...args); };
  const scan = manager.refresh(); await started; const sameScan = manager.refresh(); assert.equal(scan, sameScan);
  const marking = manager.markRead({ id }); release(); await Promise.all([scan, marking]);
  assert.equal((await manager.getState()).unreadCount, 0);
  await batch(desktopDir); await manager.refresh(); const unread = (await manager.getState()).unreadCount;
  manager.save = async () => { throw new Error('Disk unavailable'); };
  await assert.rejects(manager.markRead({ all: true }), /Disk unavailable/); assert.equal((await manager.getState()).unreadCount, unread);
});

test('shelf queue revalidates a received batch after it has waited behind another mutation', async t => {
  const { manager, service, desktopDir, directory } = await fixture(t);
  const ready = await batch(desktopDir); const id = (await manager.refresh()).received[0].id;
  let release; const gate = new Promise(resolve => { release = resolve; }); service.shelfMutation = gate;
  let entered; const queued = new Promise(resolve => { entered = resolve; });
  const originalEnqueue = service.enqueueFiles.bind(service);
  service.enqueueFiles = (...args) => { entered(); return originalEnqueue(...args); };
  const adding = manager.addToShelf({ id }); await queued;
  const elsewhere = path.join(directory, 'elsewhere'); await fs.rename(ready.folder, elsewhere); await fs.symlink(elsewhere, ready.folder);
  const rejected = assert.rejects(adding, /no longer available|changed/); release(); await rejected;
  assert.equal((await service.getState()).items.length, 0);
});

test('background-test mode never reads Desktop or its existing local index', async t => {
  const { directory } = await fixture(t);
  const manager = new ReceivedManager({ dataDir: path.join(directory, 'must-not-exist'), desktopDir: path.join(directory, 'no-desktop'), enabled: false });
  manager.rootPath = async () => { throw new Error('Unexpected Desktop access'); };
  manager.start(); await manager.refresh(); const state = await manager.getState();
  assert.equal(state.enabled, false); assert.equal(state.received.length, 0); assert.equal(manager.timer, null);
  await assert.rejects(fs.stat(manager.dataDir), { code: 'ENOENT' });
});

async function senderFixture(t, options = {}) {
  const base = await fixture(t); const stages = []; const snapshots = [];
  const executor = async (command, args) => {
    if (command === 'ssh') {
      const script = args.at(-1);
      if (script === 'echo DRIFT_READY') return { stdout: 'DRIFT_READY', stderr: '' };
      if (script.startsWith('ln --') && options.failMarker) throw new Error('Connection interrupted before receipt promotion.');
      const result = await execFile('/bin/sh', ['-c', script], { env: { ...process.env, HOME: path.dirname(base.desktopDir) } });
      if (script.startsWith('ln --')) { stages.push('complete'); snapshots.push((await base.manager.refresh()).received.length); }
      return result;
    }
    if (command === 'scp') {
      const local = args.at(-2); const target = args.at(-1); const quoted = target.slice(target.indexOf(':') + 1);
      const remote = quoted.slice(1, -1).replaceAll("'\\''", "'");
      const isReceipt = path.basename(local).startsWith('.dropharbor-receipt-');
      if (!isReceipt && options.failPayload) throw new Error('Payload interrupted.');
      await fs.cp(local, remote, { recursive: true, errorOnExist: true, force: false });
      stages.push(isReceipt ? 'marker-upload' : 'payload'); snapshots.push((await base.manager.refresh()).received.length);
      return { stdout: '', stderr: '' };
    }
    throw new Error('Unexpected tool: ' + command);
  };
  const sender = new DriftService({ dataDir: path.join(base.directory, 'sender-data'), homeDir: path.join(base.directory, 'sender'), execFile: executor, platform: 'linux' });
  await sender.initialized;
  await sender.saveHost({ address: 'receiver.invalid', user: 'fixture', name: 'Receiving laptop' }); sender.state.hosts[0].status = 'ready';
  return { ...base, sender, stages, snapshots, hostId: sender.state.hosts[0].id };
}

test('two app services transfer real files into a fresh Desktop batch and reveal receipt only after atomic completion', { skip: process.platform === 'win32' }, async t => {
  const { sender, manager, directory, stages, snapshots, hostId } = await senderFixture(t);
  await sender.updateSettings({ deviceName: 'Travel laptop' });
  const source = path.join(directory, "it's a report.txt"); await fs.writeFile(source, 'hello');
  const reserved = path.join(directory, RECEIPT_NAME); await fs.writeFile(reserved, 'user content');
  const folder = path.join(directory, 'Project'); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'inside.txt'), 'contents');
  const queue = await sender.enqueueFiles([source, reserved, folder]); await sender.enqueueText('an unrelated shelf note');
  const state = await sender.send({ hostId, itemIds: queue.enqueuedItemIds });
  assert.equal(state.history[0].status, 'sent'); assert.equal(state.history[0].receiptPublished, true); assert.equal(state.items.length, 4);
  assert.deepEqual(stages, ['payload', 'payload', 'payload', 'marker-upload', 'complete']); assert.deepEqual(snapshots, [0, 0, 0, 0, 1]);
  const inbox = await manager.getState(); assert.equal(inbox.unreadCount, 1); assert.equal(inbox.received[0].senderLabel, 'Travel laptop');
  assert.deepEqual(inbox.received[0].items.map(item => item.name), ["it's a report.txt", '.dropharbor-receipt (2).json', 'Project']);
  assert.deepEqual(state.history[0].items, inbox.received[0].items);
  const marker = await fs.readFile(path.join(state.history[0].destination, RECEIPT_NAME), 'utf8');
  assert.ok(!marker.includes('receiver.invalid')); assert.ok(!marker.includes(directory)); assert.ok(!marker.includes('unrelated shelf note'));
  assert.deepEqual((await fs.readdir(sender.dataDir)).filter(name => name.startsWith('.dropharbor-receipt-')), []);
});

test('receipt-only failure keeps delivered status with a warning; payload failure publishes no completion receipt', { skip: process.platform === 'win32' }, async t => {
  for (const option of [{ failMarker: true }, { failPayload: true }]) {
    const { sender, manager, directory, hostId, stages } = await senderFixture(t, option);
    const source = path.join(directory, 'report.txt'); await fs.writeFile(source, 'hello'); const queue = await sender.enqueueFiles([source]);
    const state = await sender.send({ hostId, itemIds: queue.enqueuedItemIds });
    assert.equal(state.history[0].status, option.failMarker ? 'sent' : 'failed');
    if (option.failMarker) { assert.equal(state.history[0].receiptPublished, false); assert.match(state.history[0].message, /Files were delivered/); }
    else assert.deepEqual(stages, []);
    assert.equal((await manager.refresh()).received.length, 0);
    assert.deepEqual((await fs.readdir(sender.dataDir)).filter(name => name.startsWith('.dropharbor-receipt-')), []);
  }
});

test('device display name is explicit, validated, persisted and absent by default', async t => {
  const { service, directory } = await fixture(t);
  assert.equal((await service.getState()).settings.deviceName, '');
  for (const value of [null, 1, 'x'.repeat(65), 'line\nname', 'bad\u202ename']) await assert.rejects(service.updateSettings({ deviceName: value }), /Device name/);
  await service.updateSettings({ deviceName: '  Studio Mac  ' }); assert.equal((await service.getState()).settings.deviceName, 'Studio Mac');
  const reloaded = new DriftService({ dataDir: path.join(directory, 'shelf') }); assert.equal((await reloaded.getState()).settings.deviceName, 'Studio Mac');
});
