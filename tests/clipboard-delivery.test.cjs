'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverClipboard } = require('../desktop/clipboard-delivery.cjs');
const crypto = require('node:crypto');
const item = { eventId: crypto.randomUUID(), kind: 'text', text: 'synthetic remote', originLabel: 'Fixture', receiveMode: 'clipboard' };
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), release: () => resolve() }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = [], settings = { receiveMode: 'clipboard', continuity: true };
  const sync = { epoch: 1, enabled: true, newestEvent: { eventId: item.eventId }, canSend() { return this.enabled; }, state: () => settings };
  let current = { kind: 'text', text: 'synthetic baseline' };
  const history = { epoch: 1, tools: true, toolsState() { return { enabled: this.tools }; }, contentHash: content => crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex'), async readCurrent() { calls.push('read'); return current; }, async capture() { calls.push('capture'); }, async ingestSync(value) { calls.push(['ingest', value]); }, noteSyncEvent() { calls.push('note'); }, acknowledgeSyncWrite() { calls.push('ack'); } };
  const clipboard = { async writeText(text) { calls.push(['text', text]); }, async write(items) { calls.push(['image', items]); } };
  class ClipboardItem { constructor(data) { this.data = data; } }
  return { history, sync, clipboard, ClipboardItem, calls, settings, setCurrent: value => { current = value; } };
}
test('text delivery waits for the native write before acknowledgement', async () => {
  const f = fixture(), hold = gate(); f.clipboard.writeText = async text => { f.calls.push(['text', text]); await hold.promise; };
  const pending = deliverClipboard(f, item); await flush(); assert.equal(f.calls.includes('ack'), false); hold.release();
  assert.deepEqual(await pending, { applied: true }); assert.equal(f.calls.at(-1), 'ack');
});
test('PNG delivery uses the supported atomic ClipboardItem API and awaits it', async () => {
  const f = fixture(), hold = gate(); let image;
  f.clipboard.write = async items => { image = items[0].data['image/png']; await hold.promise; };
  const pending = deliverClipboard(f, { ...item, kind: 'png', png: Buffer.from('synthetic PNG bytes').toString('base64') });
  await flush(); assert.equal(image.type, 'image/png'); assert.equal(await image.text(), 'synthetic PNG bytes'); assert.equal(f.calls.includes('ack'), false);
  hold.release(); assert.equal((await pending).applied, true); assert.equal(f.calls.at(-1), 'ack');
});
test('native write failure does not acknowledge a write that never completed', async () => {
  const f = fixture(); f.clipboard.writeText = async () => { throw new Error('synthetic denied'); };
  await assert.rejects(deliverClipboard(f, item), /synthetic denied/); assert.equal(f.calls.includes('ack'), false);
});
test('per-item history mode never touches the OS clipboard even when global mode is native', async () => {
  const f = fixture(); assert.equal((await deliverClipboard(f, { ...item, receiveMode: 'history' })).applied, false);
  assert.equal(f.calls.includes('read'), false); assert.equal(f.calls.some(c => c[0] === 'text'), false); assert.equal(f.calls[0][0], 'ingest');
});
test('tools off cannot read, persist or replace a clipboard', async () => {
  const f = fixture(); f.history.tools = false; await assert.rejects(deliverClipboard(f, item), /disabled/); assert.deepEqual(f.calls, []);
});
for (const boundary of ['pause', 'disable', 'history tools', 'receive preference']) test(`${boundary} during persistence prevents a late OS write`, async () => {
  const f = fixture(), hold = gate(); f.history.ingestSync = () => hold.promise;
  const pending = deliverClipboard(f, item); const outcome = pending.catch(() => ({ applied: false })); await flush();
  if (boundary === 'history tools') { f.history.tools = false; f.history.epoch++; }
  else if (boundary === 'receive preference') f.settings.receiveMode = 'history';
  else { f.sync.enabled = false; f.sync.epoch++; }
  hold.release(); assert.equal((await outcome).applied, false); assert.equal(f.calls.some(c => c[0] === 'text'), false);
});
test('a newer local copy made during persistence is retained and captured before relay', async () => {
  const f = fixture(), hold = gate(); f.history.ingestSync = () => hold.promise;
  const pending = deliverClipboard(f, item); await flush(); f.setCurrent({ kind: 'text', text: 'synthetic newer local' }); hold.release();
  assert.equal((await pending).applied, false); assert.equal(f.calls.filter(c => c === 'capture').length, 2); assert.equal(f.calls.some(c => c[0] === 'text'), false);
});
test('a newer local copy already present but not yet polled takes precedence', async () => {
  const f = fixture(); f.history.capture = async () => { f.calls.push('capture'); f.sync.newestEvent = { eventId: crypto.randomUUID() }; };
  assert.equal((await deliverClipboard(f, item)).applied, false); assert.equal(f.calls.includes('read'), false); assert.equal(f.calls.some(c => c[0] === 'text'), false);
});
test('failed local capture cannot permit an incoming write or relay over an unobserved copy', async () => {
  const f = fixture(); f.history.capture = async () => { throw new Error('synthetic capture storage failure'); };
  await assert.rejects(deliverClipboard(f, item), /capture storage failure/);
  assert.equal(f.calls.some(c => c[0] === 'text'), false); assert.equal(f.calls.includes('ack'), false);
});
for (const kind of ['private', 'unsupported']) test(`${kind} clipboard is preserved while the incoming item enters history`, async () => {
  const f = fixture(); f.setCurrent({ kind }); assert.equal((await deliverClipboard(f, item)).applied, false);
  assert.equal(f.calls.some(c => c[0] === 'ingest'), true); assert.equal(f.calls.some(c => c[0] === 'text'), false);
});
test('an empty clipboard accepts the received item', async () => {
  const f = fixture(); f.setCurrent({ kind: 'empty' }); assert.equal((await deliverClipboard(f, item)).applied, true);
});
test('a newer event during the final native read prevents stale replacement', async () => {
  const f = fixture(), hold = gate(); let reads = 0;
  f.history.readCurrent = async () => { if (++reads === 2) { await hold.promise; } return { kind: 'empty' }; };
  const pending = deliverClipboard(f, item); await flush(); f.sync.newestEvent = { eventId: crypto.randomUUID() }; hold.release();
  assert.equal((await pending).applied, false); assert.equal(f.calls.some(c => c[0] === 'text'), false);
});
