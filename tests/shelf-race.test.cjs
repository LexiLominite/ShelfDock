'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DriftService } = require('../desktop/service.cjs');
const { captureClipboard } = require('../desktop/clipboard.cjs');
const { importConfiguration } = require('../desktop/config.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-drift-shelf-race-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data');
  const service = new DriftService({ dataDir, homeDir: directory, execFile: async () => { throw new Error('This test must not connect to a machine.'); } });
  await service.getState();
  return { service, dataDir, directory };
}

test('simultaneous clipboard images cannot exceed the shelf limit or leave rejected images', async t => {
  const { service, dataDir } = await fixture(t);
  service.state.items = Array.from({ length: 499 }, (_, i) => ({ id: `existing-${i}`, name: `${i}.txt`, kind: 'file', path: path.join(dataDir, `${i}.txt`) }));
  const results = await Promise.allSettled([service.enqueueClipboardImage(PNG), service.enqueueClipboardImage(PNG)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected');
  assert.match(failure.reason.message, /500/);
  assert.equal((await service.getState()).items.length, 500);
  assert.equal((await fs.readdir(path.join(dataDir, 'clipboard-images'))).length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')).items.length, 500);
});

test('failed image and text persistence rolls back the shelf and removes staged content', async t => {
  const { service, dataDir } = await fixture(t);
  const persist = service.persist.bind(service);
  service.persist = async () => { throw new Error('Simulated storage failure'); };
  await assert.rejects(service.enqueueClipboardImage(PNG), /storage failure/);
  assert.equal((await service.getState()).items.length, 0);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'clipboard-images')), []);
  await assert.rejects(service.enqueueText('Keep no failed staged note.'), /storage failure/);
  assert.equal((await service.getState()).items.length, 0);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'notes')), []);
  service.persist = persist;
  assert.equal((await service.enqueueClipboardImage(PNG)).items.length, 1, 'a rejected mutation does not block the shelf queue');
});

test('clipboard reads already in progress cannot add items during configuration import', async t => {
  const { service, dataDir } = await fixture(t);
  let release; let began;
  const started = new Promise(resolve => { began = resolve; });
  const clipboard = { read: () => { began(); return new Promise(resolve => { release = resolve; }); } };
  const capture = captureClipboard({ clipboard, service });
  await started;
  service.configurationImport = true;
  release([{ types: ['text/plain'], getType: async () => new Blob(['This must not be staged.']) }]);
  await assert.rejects(capture, /configuration import/);
  assert.equal((await service.getState()).items.length, 0);
  await assert.rejects(fs.stat(path.join(dataDir, 'notes')), { code: 'ENOENT' });
});

test('a clipboard format read that overlaps import is rejected by the shelf mutation guard', async t => {
  const { service, dataDir } = await fixture(t);
  let release; let began;
  const started = new Promise(resolve => { began = resolve; });
  const item = { types: ['image/png'], getType: () => { began(); return new Promise(resolve => { release = resolve; }); } };
  const capture = captureClipboard({ clipboard: { read: async () => [item] }, service });
  await started;
  service.configurationImport = true;
  release(new Blob([PNG]));
  await assert.rejects(capture, /configuration import/);
  assert.equal((await service.getState()).items.length, 0);
  await assert.rejects(fs.stat(path.join(dataDir, 'clipboard-images')), { code: 'ENOENT' });
});

test('an import flag rejects shelf additions and removals without changing owned or original files', async t => {
  const { service, directory } = await fixture(t);
  const original = path.join(directory, 'original.txt'); await fs.writeFile(original, 'original');
  await service.enqueueFiles([original]);
  const state = await service.enqueueClipboardImage(PNG);
  const staged = state.items.find(item => item.clipboard);
  service.configurationImport = true;
  for (const operation of [() => service.enqueueFiles([original]), () => service.enqueueText('text'), () => service.enqueueClipboardImage(PNG), () => service.removeItem(staged.id), () => service.clearItems()]) await assert.rejects(operation(), /configuration import/);
  assert.equal((await service.getState()).items.length, 2);
  assert.deepEqual(await fs.readFile(staged.path), PNG);
  assert.equal(await fs.readFile(original, 'utf8'), 'original');
});

test('failed shelf removal persistence retains the shelf entry and staged file', async t => {
  const { service } = await fixture(t);
  const state = await service.enqueueClipboardImage(PNG); const item = state.items[0];
  const persist = service.persist.bind(service);
  service.persist = async () => { throw new Error('Simulated storage failure'); };
  await assert.rejects(service.removeItem(item.id), /storage failure/);
  assert.equal((await service.getState()).items[0].id, item.id);
  assert.deepEqual(await fs.readFile(item.path), PNG);
  await assert.rejects(service.clearItems(), /storage failure/);
  assert.equal((await service.getState()).items[0].id, item.id);
  assert.deepEqual(await fs.readFile(item.path), PNG);
  service.persist = persist;
  await service.clearItems(); await fs.access(item.path);
  service.clock = () => Date.now() + 10001; await service.expireClearUndo(); await assert.rejects(fs.stat(item.path), { code: 'ENOENT' });
});

for (const failImageCommit of [false, true]) test(`configuration import waits for an image commit${failImageCommit ? ' and its failure cleanup' : ''} before merging`, async t => {
  const { service, dataDir } = await fixture(t);
  const persist = service.persist.bind(service);
  let release; let began; let first = true;
  const started = new Promise(resolve => { began = resolve; });
  const continueCommit = new Promise(resolve => { release = resolve; });
  service.persist = async () => {
    if (first) { first = false; began(); await continueCommit; if (failImageCommit) throw new Error('Image commit failed'); }
    return persist();
  };
  const image = service.enqueueClipboardImage(PNG);
  await started;
  const importing = importConfiguration(service, { schema: 'lex-drift-config', version: 1, hosts: [{ name: 'Imported', address: '100.80.1.2', user: 'example' }], settings: { viewMode: 'compact' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.configurationImport, true);
  assert.equal(service.state.hosts.length, 0, 'import does not stage hosts before the pending shelf commit settles');
  release();
  const [imageResult, imported] = await Promise.all([Promise.allSettled([image]), importing]);
  assert.equal(imageResult[0].status, failImageCommit ? 'rejected' : 'fulfilled');
  assert.equal(imported.hosts[0].name, 'Imported');
  assert.equal(imported.settings.viewMode, 'compact');
  assert.equal(imported.items.length, failImageCommit ? 0 : 1);
  assert.equal((await fs.readdir(path.join(dataDir, 'clipboard-images'))).length, failImageCommit ? 0 : 1);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.items.length, failImageCommit ? 0 : 1);
  assert.equal(saved.manualHosts[0].name, 'Imported');
});

test('automatic route inference only labels the Tailscale CGNAT range as Tailscale', async t => {
  const { service } = await fixture(t);
  const expected = new Map([['100.10.1.1', 'ssh'], ['100.63.255.255', 'ssh'], ['100.64.0.0', 'tailscale'], ['100.127.255.255', 'tailscale'], ['100.128.0.0', 'ssh']]);
  for (const address of expected.keys()) await service.saveHost({ name: address, address, user: 'example' });
  for (const host of (await service.getState()).hosts) assert.equal(host.route, expected.get(host.address), host.address);
});
