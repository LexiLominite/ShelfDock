'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DriftService } = require('../desktop/service.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-clear-undo-')); const instances = []; let now = Date.now();
  const create = async () => { const service = new DriftService({ dataDir: path.join(directory, 'data'), homeDir: directory, clock: () => now, execFile: async () => { throw new Error('No network operations in undo tests'); } }); instances.push(service); await service.getState(); return service; };
  t.after(async () => { for (const service of instances) { clearTimeout(service.clearUndoTimer); await service.shelfMutation.catch(() => {}); clearTimeout(service.clearUndoTimer); } await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, create, advance: milliseconds => { now += milliseconds; }, service: await create() };
}

test('Clear keeps files for ten seconds and Undo restores exact items alongside newer additions', async t => {
  const { service, directory } = await fixture(t);
  const original = path.join(directory, 'original.txt'); await fs.writeFile(original, 'original'); await service.enqueueFiles([original]); await service.enqueueText('cleared note'); await service.enqueueClipboardImage(PNG);
  const originalItems = (await service.getState()).items;
  const state = await service.clearItems(); assert.equal(state.items.length, 0); assert.equal(state.clearShelfUndo.count, 3);
  assert.equal(Date.parse(state.clearShelfUndo.expiresAt) - service.clock(), 10000); assert.equal(service.clearUndoTimer.hasRef(), false);
  for (const item of originalItems) await fs.access(item.path);
  const newer = await service.enqueueText('newer note'); const newId = newer.items[0].id;
  const restored = await service.undoClear(); assert.equal(restored.clearShelfUndo, null); assert.equal(restored.items.length, 4);
  assert.deepEqual(restored.items.slice(0, 3), originalItems); assert.equal(restored.items[3].id, newId);
  assert.deepEqual(restored.restoredItemIds, originalItems.map(item => item.id)); assert.deepEqual(restored.enqueuedItemIds, restored.restoredItemIds);
  assert.equal(await fs.readFile(original, 'utf8'), 'original');
});

test('expiry deletes only app-owned staged files and keeps originals', async t => {
  const { service, directory, advance } = await fixture(t);
  const original = path.join(directory, 'original.png'); await fs.writeFile(original, PNG); await service.enqueueFiles([original]); await service.enqueueText('temporary'); await service.enqueueClipboardImage(PNG);
  const items = (await service.getState()).items;
  await service.clearItems(); advance(9999); await service.expireClearUndo(); for (const item of items) await fs.access(item.path);
  advance(1); const state = await service.expireClearUndo(); assert.equal(state.clearShelfUndo, null); assert.equal(service.clearCleanup.length, 0);
  for (const item of items.slice(1)) await assert.rejects(fs.access(item.path), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(original), PNG); await assert.rejects(service.undoClear(), /window has ended/);
});

test('a second clear replaces only its own undo batch after saving and commits the previous batch', async t => {
  const { service } = await fixture(t);
  const first = (await service.enqueueText('first')).items[0]; await service.clearItems();
  const second = (await service.enqueueText('second')).items[0]; await service.clearItems();
  await assert.rejects(fs.access(first.path), { code: 'ENOENT' }); await fs.access(second.path);
  const state = await service.undoClear(); assert.deepEqual(state.items.map(item => item.id), [second.id]);
});

test('clear and undo persistence failures roll back state without deleting content', async t => {
  const { service } = await fixture(t);
  const first = (await service.enqueueText('first')).items[0]; await service.clearItems();
  const pending = structuredClone(service.pendingClear); const second = (await service.enqueueText('second')).items[0];
  const persist = service.persist.bind(service); service.persist = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(service.clearItems(), /disk unavailable/); assert.deepEqual(service.pendingClear, pending); assert.deepEqual(service.state.items.map(item => item.id), [second.id]);
  await assert.rejects(service.undoClear(), /disk unavailable/); assert.deepEqual(service.pendingClear, pending); assert.deepEqual(service.state.items.map(item => item.id), [second.id]);
  await fs.access(first.path); await fs.access(second.path); service.persist = persist;
  assert.equal((await service.undoClear()).items.length, 2);
});

test('expiry persistence failure retains recovery data and retries cleanup safely', async t => {
  const { service, advance } = await fixture(t); const item = (await service.enqueueText('keep until expiration commits')).items[0];
  await service.clearItems(); advance(10000); const persist = service.persist.bind(service); service.persist = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(service.expireClearUndo(), /disk unavailable/); await fs.access(item.path); assert.equal(service.pendingClear.items[0].id, item.id);
  service.persist = persist; await service.expireClearUndo(); await assert.rejects(fs.access(item.path), { code: 'ENOENT' });
});

test('restart recovers the remaining undo window and separately recovers expired cleanup', async t => {
  const { service, create, advance } = await fixture(t); const item = (await service.enqueueText('restart-safe note')).items[0];
  const cleared = await service.clearItems(); clearTimeout(service.clearUndoTimer); advance(4000);
  const restarted = await create(); assert.equal((await restarted.getState()).clearShelfUndo.expiresAt, cleared.clearShelfUndo.expiresAt);
  assert.equal((await restarted.undoClear()).items[0].id, item.id);
  await restarted.clearItems(); clearTimeout(restarted.clearUndoTimer); advance(10001);
  const expired = await create(); assert.equal((await expired.getState()).clearShelfUndo, null); await expired.expireClearUndo(); await assert.rejects(fs.access(item.path), { code: 'ENOENT' });
});

test('a re-added staged path is never overwritten or deleted while referenced and cleanup ownership survives restart', async t => {
  const { service, create, advance } = await fixture(t); const staged = (await service.enqueueText('same path')).items[0];
  await service.clearItems(); const added = (await service.enqueueFiles([staged.path])).items[0];
  const undone = await service.undoClear(); assert.deepEqual(undone.items.map(item => item.id), [added.id]); assert.deepEqual(undone.restoredItemIds, []);
  assert.equal(service.clearCleanup.length, 1); await service.expireClearUndo(); await fs.access(staged.path);
  let emits = 0; service.onChange = () => { emits++; };
  let writes = 0; const persist = service.persist.bind(service); service.persist = async () => { writes++; return persist(); };
  await service.expireClearUndo(); assert.equal(writes, 0, 'retained references do not repeatedly rewrite unchanged cleanup state'); assert.equal(emits, 0, 'unchanged housekeeping does not wake the renderer');
  clearTimeout(service.clearUndoTimer); const restarted = await create();
  await restarted.removeItem(added.id); advance(5000); await restarted.expireClearUndo(); await assert.rejects(fs.access(staged.path), { code: 'ENOENT' }); assert.equal(restarted.clearCleanup.length, 0);
});

test('undo exceeding capacity preserves the pending batch and restores after room is made', async t => {
  const { service } = await fixture(t); const staged = (await service.enqueueText('restore me')).items[0]; await service.clearItems();
  service.state.items = Array.from({ length: 500 }, (_, index) => ({ id: 'new-' + index, path: '/fixture-' + index, kind: 'file', name: String(index) }));
  await assert.rejects(service.undoClear(), /500-item shelf limit/); assert.equal(service.pendingClear.items[0].id, staged.id); await fs.access(staged.path);
  await service.removeItem('new-0'); const restored = await service.undoClear(); assert.equal(restored.items.length, 500); assert.equal(restored.items[0].id, staged.id);
});

test('undo expiry and clear operations serialize with shelf changes and respect active setup', async t => {
  const { service, advance } = await fixture(t); const item = (await service.enqueueText('serial')).items[0]; await service.clearItems();
  service.configurationImport = true; await assert.rejects(service.undoClear(), /configuration import/); service.configurationImport = false;
  const [added, restored] = await Promise.all([service.enqueueText('new serial item'), service.undoClear()]);
  assert.ok(restored.items.some(entry => entry.id === item.id)); assert.ok(restored.items.some(entry => entry.id === added.items[0].id));
  await service.clearItems(); advance(10000);
  const expiry = service.expireClearUndo(); const undo = assert.rejects(service.undoClear(), /window has ended/); await expiry; await undo;
});
