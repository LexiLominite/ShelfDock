'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DriftService } = require('../desktop/service.cjs');
const { captureClipboard, parseFileURIs, validateClipboardPNG, MAX_CLIPBOARD_BYTES } = require('../desktop/clipboard.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
function clipboardItem(formats, reads = []) {
  return { types: Object.keys(formats), async getType(type) { reads.push(type); return new Blob([formats[type]], { type }); } };
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-drift-clipboard-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = []; const dataDir = path.join(directory, 'data');
  const service = new DriftService({ dataDir, homeDir: directory, platform: 'linux', execFile: async (...args) => { calls.push(args); throw new Error('Clipboard capture must not start a transfer.'); } });
  await service.getState();
  return { directory, dataDir, service, calls };
}

test('explicit clipboard capture reads once, keeps Unicode and whitespace, and never transfers', async t => {
  const { service, calls } = await fixture(t); let reads = 0;
  const text = '  Clipboard ✓ 🦋\nsecond line\n';
  const clipboard = { async read() { reads++; return [clipboardItem({ 'text/plain': text })]; } };
  assert.equal(reads, 0, 'service construction does not access the clipboard');
  const state = await captureClipboard({ clipboard, service });
  assert.equal(reads, 1); assert.equal(state.items.length, 1);
  assert.equal(await fs.readFile(state.items[0].path, 'utf8'), text);
  assert.deepEqual(state.enqueuedItemIds, [state.items[0].id]); assert.deepEqual(calls, []);
});

test('native copied files take priority over image/text representations and keep originals', async t => {
  const { service, directory } = await fixture(t); const reads = [];
  const file = path.join(directory, "copied ✓ report's.txt"); await fs.writeFile(file, 'original');
  const folder = path.join(directory, 'a folder'); await fs.mkdir(folder);
  const clipboard = { async read() { return [clipboardItem({ 'text/plain': 'filename description', 'image/png': PNG, 'text/uri-list': pathToFileURL(file).href }, reads), clipboardItem({ 'text/uri-list': pathToFileURL(folder).href }, reads)]; } };
  const state = await captureClipboard({ clipboard, service });
  assert.deepEqual(reads, ['text/uri-list', 'text/uri-list']);
  assert.deepEqual(state.items.map(item => item.path), [file, folder]);
  assert.deepEqual(state.items.map(item => item.kind), ['file', 'folder']);
  assert.deepEqual(state.enqueuedItemIds, state.items.map(item => item.id));
  await service.clearItems(); assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.ok((await fs.stat(folder)).isDirectory());
});

test('file URI parsing accepts local paths on macOS/Linux and Windows without accessing the filesystem', () => {
  assert.deepEqual(parseFileURIs('# comments\r\nfile:///tmp/a%20b.txt\r\nfile://localhost/tmp/a%20b.txt\r\nfile:///tmp/%E2%9C%93.txt', 'darwin'), ['/tmp/a b.txt', '/tmp/✓.txt']);
  assert.deepEqual(parseFileURIs('file:///C:/Users/Lex/Desktop/a%20b.txt\r\nfile:///D:/notes.txt', 'win32'), ['C:\\Users\\Lex\\Desktop\\a b.txt', 'D:\\notes.txt']);
  for (const text of ['https://example.com/file', 'file://server/share/file', 'file:///tmp/a?query=1', 'file:///tmp/a#fragment', 'file:///tmp/a%00b', 'file:///tmp/a%0Ab', 'file:///tmp/a%2Fb', 'file:///tmp/%ZZ', 'file:///tmp/a\nhttps://example.com']) assert.throws(() => parseFileURIs(text, 'linux'));
  assert.throws(() => parseFileURIs('file:///tmp/file', 'win32'));
});

test('invalid copied-file data is refused without silently capturing another representation', async t => {
  const { service } = await fixture(t); const reads = [];
  const clipboard = { async read() { return [clipboardItem({ 'text/uri-list': 'file://remote/share/report.txt', 'text/plain': 'report.txt', 'image/png': PNG }, reads)]; } };
  await assert.rejects(captureClipboard({ clipboard, service }), /invalid or remote/);
  assert.deepEqual(reads, ['text/uri-list']); assert.equal((await service.getState()).items.length, 0);
});

test('copied symbolic links keep the existing file safety checks', async t => {
  const { service, directory } = await fixture(t);
  const original = path.join(directory, 'original'); const link = path.join(directory, 'link');
  await fs.writeFile(original, 'original'); await fs.symlink(original, link);
  const clipboard = { async read() { return [clipboardItem({ 'text/uri-list': pathToFileURL(link).href })]; } };
  await assert.rejects(captureClipboard({ clipboard, service }), /symbolic link/);
  assert.equal((await service.getState()).items.length, 0);
});

test('PNG clipboard capture wins over text, stages privately, persists, and cleans up its own file', async t => {
  const { service, dataDir } = await fixture(t); const reads = [];
  const clipboard = { async read() { return [clipboardItem({ 'text/plain': 'image label', 'image/png': PNG }, reads)]; } };
  const state = await captureClipboard({ clipboard, service }); const item = state.items[0];
  assert.deepEqual(reads, ['image/png']); assert.equal(item.kind, 'file'); assert.equal(item.clipboard, true);
  assert.match(item.name, /^clipboard-.*\.png$/); assert.deepEqual(await fs.readFile(item.path), PNG);
  assert.equal((await fs.stat(item.path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(item.path))).mode & 0o777, 0o700);
  const restored = new DriftService({ dataDir }); assert.equal((await restored.getState()).items[0].clipboard, true);
  await restored.removeItem(item.id); await assert.rejects(fs.stat(item.path), { code: 'ENOENT' });
});

test('clearing a clipboard image and ordinary PNG deletes only the staged copy', async t => {
  const { service, directory } = await fixture(t);
  const original = path.join(directory, 'original.png'); await fs.writeFile(original, PNG);
  await service.enqueueFiles([original]); const state = await service.enqueueClipboardImage(PNG);
  const staged = state.items.find(item => item.clipboard).path;
  await service.clearItems(); await fs.access(staged);
  service.clock = () => Date.now() + 10001; await service.expireClearUndo(); await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(original), PNG);
});

test('forged clipboard ownership cannot delete an ordinary file or sibling path', async t => {
  const { service, directory } = await fixture(t);
  const file = path.join(directory, 'original.png'); await fs.writeFile(file, PNG);
  let state = await service.enqueueFiles([file]); service.state.items[0].clipboard = true;
  await service.removeItem(state.items[0].id); assert.deepEqual(await fs.readFile(file), PNG);
  state = await service.enqueueClipboardImage(PNG);
  const item = state.items[0]; const originalPath = item.path;
  service.state.items[0].path = path.join(path.dirname(originalPath), '..', '..', 'original.png');
  await service.clearItems(); assert.deepEqual(await fs.readFile(file), PNG);
  assert.deepEqual(await fs.readFile(originalPath), PNG, 'cleanup never guesses a path from a mismatched shelf entry');
});

test('PNG size and dimension limits reject malformed or huge images before staging', async t => {
  const { service, dataDir } = await fixture(t);
  const hugeDimensions = Buffer.from(PNG); hugeDimensions.writeUInt32BE(32769, 16);
  const truncated = PNG.subarray(0, PNG.length - 5);
  const noImageData = Buffer.concat([PNG.subarray(0, 33), PNG.subarray(PNG.length - 12)]);
  for (const input of ['not bytes', Buffer.from('not PNG'), truncated, noImageData, hugeDimensions, Buffer.alloc(MAX_CLIPBOARD_BYTES + 1)]) await assert.rejects(service.enqueueClipboardImage(input));
  assert.deepEqual(validateClipboardPNG(PNG), PNG);
  assert.equal((await service.getState()).items.length, 0);
  await assert.rejects(fs.stat(path.join(dataDir, 'clipboard-images')), { code: 'ENOENT' });
});

test('oversized clipboard payloads are rejected before materializing their bytes', async t => {
  const { service } = await fixture(t); let materialized = false;
  const clipboard = { async read() { return [{ types: ['image/png'], async getType() { return { size: MAX_CLIPBOARD_BYTES + 1, async arrayBuffer() { materialized = true; return new ArrayBuffer(0); } }; } }]; } };
  await assert.rejects(captureClipboard({ clipboard, service }), /20 MB/); assert.equal(materialized, false);
});

test('empty, unsupported, whitespace, invalid UTF-8, and excessive file lists return useful errors', async t => {
  const { service } = await fixture(t);
  for (const items of [[], [clipboardItem({ 'text/html': '<b>rich only</b>' })], [clipboardItem({ 'text/plain': ' \n ' })], [clipboardItem({ 'text/plain': Buffer.from([0xff]) })]]) await assert.rejects(captureClipboard({ clipboard: { read: async () => items }, service }));
  assert.throws(() => parseFileURIs(Array.from({ length: 501 }, (_, i) => 'file:///tmp/' + i).join('\n')), /500/);
  assert.equal((await service.getState()).items.length, 0);
});

test('copied web link URI representation falls back to plain text without becoming a file', async t=>{
  const {service,calls}=await fixture(t); const url='https://example.com/project';
  const clipboard={read:async()=>[clipboardItem({'text/uri-list':url,'text/plain':url})]};
  const state=await captureClipboard({clipboard,service}); assert.equal(state.items.length,1); assert.equal(await fs.readFile(state.items[0].path,'utf8'),url); assert.deepEqual(calls,[]);
});
