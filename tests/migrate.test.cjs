'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { migrateLegacyData } = require('../desktop/migrate.cjs');
const { DriftService } = require('../desktop/service.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-drift-migrate-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = path.join(directory, 'Drift'); const target = path.join(directory, 'lex-drift');
  await fs.mkdir(path.join(legacy, 'notes'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(legacy, 'clipboard-images'), { recursive: true, mode: 0o700 });
  const noteId = 'fa3e052f-baf4-4bdb-9cc1-2de95141f6d9'; const imageId = 'a2a76d4c-b1d8-48a1-93a7-c4eae723ac68';
  const note = path.join(legacy, 'notes', noteId + '.txt'); const image = path.join(legacy, 'clipboard-images', imageId + '.png'); const file = path.join(legacy, 'user-file.txt');
  await fs.writeFile(note, 'keep the legacy note ✓', { mode: 0o600 }); await fs.writeFile(image, 'image fixture', { mode: 0o600 }); await fs.writeFile(file, 'original user file');
  const saved = { version: 1, manualHosts: [], overrides: {}, hiddenHosts: [], settings: { viewMode: 'compact', shakeEnabled: false, sensitivity: 'strong' }, history: [{ id: 'receipt', status: 'sent', message: 'kept' }], items: [
    { id: noteId, name: 'note.txt', kind: 'text', path: note, preview: 'keep the legacy note ✓' },
    { id: imageId, name: 'clipboard.png', kind: 'file', clipboard: true, path: image },
    { id: 'regular-file', name: 'user-file.txt', kind: 'file', path: file },
  ] };
  const stateFile = path.join(legacy, 'state.json'); const original = JSON.stringify(saved);
  await fs.writeFile(stateFile, original, { mode: 0o600 });
  return { directory, legacy, target, saved, note, image, file, stateFile, original };
}

test('upgrade migration remaps only owned paths, copies payloads, and keeps legacy state and originals intact', async t => {
  const { legacy, target, saved, note, image, file, stateFile, original } = await fixture(t);
  assert.equal(await migrateLegacyData({ legacy, target }), true);
  const migrated = JSON.parse(await fs.readFile(path.join(target, 'state.json'), 'utf8'));
  assert.equal(migrated.items[0].path, path.join(target, 'notes', saved.items[0].id + '.txt'));
  assert.equal(migrated.items[1].path, path.join(target, 'clipboard-images', saved.items[1].id + '.png'));
  assert.equal(migrated.items[2].path, file);
  assert.deepEqual(migrated.settings, saved.settings); assert.deepEqual(migrated.history, saved.history);
  assert.equal((await fs.stat(path.join(target, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(migrated.items[0].path, 'utf8'), 'keep the legacy note ✓');
  assert.equal(await fs.readFile(migrated.items[1].path, 'utf8'), 'image fixture');
  const service = new DriftService({ dataDir: target }); await service.getState();
  await service.removeItem(saved.items[0].id); await service.removeItem(saved.items[1].id);
  await assert.rejects(fs.stat(migrated.items[0].path), { code: 'ENOENT' }); await assert.rejects(fs.stat(migrated.items[1].path), { code: 'ENOENT' });
  assert.equal(await fs.readFile(note, 'utf8'), 'keep the legacy note ✓'); assert.equal(await fs.readFile(image, 'utf8'), 'image fixture');
  assert.equal(await fs.readFile(file, 'utf8'), 'original user file'); assert.equal(await fs.readFile(stateFile, 'utf8'), original);
});

test('completed new state takes precedence and is not overwritten by legacy changes', async t => {
  const { legacy, target, stateFile } = await fixture(t);
  await migrateLegacyData({ legacy, target }); const newState = path.join(target, 'state.json'); const before = await fs.readFile(newState, 'utf8');
  await fs.writeFile(stateFile, '{broken legacy file');
  assert.equal(await migrateLegacyData({ legacy, target }), false);
  assert.equal(await fs.readFile(newState, 'utf8'), before);
});

test('malformed or missing legacy state creates no target state commit', async t => {
  const { legacy, target, stateFile } = await fixture(t);
  for (const text of ['{broken', 'null', '[]']) {
    await fs.writeFile(stateFile, text);
    await assert.rejects(migrateLegacyData({ legacy, target }));
    await assert.rejects(fs.stat(path.join(target, 'state.json')), { code: 'ENOENT' });
  }
  await fs.unlink(stateFile); assert.equal(await migrateLegacyData({ legacy, target }), false);
  await assert.rejects(fs.stat(path.join(target, 'state.json')), { code: 'ENOENT' });
});

test('interrupted final migration commit leaves payloads retryable and never marks migration complete', async t => {
  const { legacy, target, note, stateFile, original } = await fixture(t);
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === path.join(target, 'state.json')) throw new Error('Simulated interrupted commit'); return rename(from, to); };
  try { await assert.rejects(migrateLegacyData({ legacy, target }), /interrupted commit/); }
  finally { fs.rename = rename; }
  await assert.rejects(fs.stat(path.join(target, 'state.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(target, 'notes', path.basename(note)), 'utf8'), 'keep the legacy note ✓');
  assert.equal((await fs.readdir(target)).some(name => name.startsWith('migration-')), false);
  assert.equal(await fs.readFile(stateFile, 'utf8'), original);
  assert.equal(await migrateLegacyData({ legacy, target }), true);
  const migrated = JSON.parse(await fs.readFile(path.join(target, 'state.json'), 'utf8'));
  assert.equal(migrated.items[0].path, path.join(target, 'notes', path.basename(note)));
});
