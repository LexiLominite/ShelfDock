'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { ClipboardHistory } = require('../desktop/clipboard-history.cjs');
class Item { constructor(data) { this.data = data; this.types = Object.keys(data); } async getType(type) { return this.data[type]; } }
const item = (text, html) => new Item({ 'text/plain': new Blob([text]), ...(html ? { 'text/html': new Blob([html]) } : {}) });
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-history-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const state = { reads: 0, writes: [], changes: [], content: [item('private fixture text')], blocked: false, time: Date.now(), markers: false };
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: value => value.toString().split('').reverse().join('') };
  const clipboard = { has: async () => state.markers, read: async () => { state.reads++; return state.content; }, write: async values => { state.writes.push(values); state.content = values; } };
  const args = { dataDir, clipboard, ClipboardItem: Item, safeStorage, platform: 'linux', onChange: value => state.changes.push(value), isBlocked: () => state.blocked, now: () => state.time, ...options };
  const history = new ClipboardHistory(args); await history.initialized; return { history, state, args, dataDir };
}
test('history never reads clipboard until enabled or explicitly captured, and pause blocks reads', async t => {
  const { history, state } = await fixture(t); await history.getState(); await history.tick(); assert.equal(state.reads, 0);
  await history.updatePreferences({ enabled: true }); await history.tick(); assert.equal(state.reads, 1);
  await history.updatePreferences({ paused: true }); await history.tick(); assert.equal(state.reads, 1);
  await history.updatePreferences({ paused: false }); state.blocked = true; await history.tick(); assert.equal(state.reads, 1);
});
test('history encrypted at rest, survives restart, and unchanged polling avoids writes and UI emissions', async t => {
  const { history, state, dataDir, args } = await fixture(t); await history.updatePreferences({ enabled: true }); await history.tick();
  const bytes = await fs.readFile(path.join(dataDir, 'clipboard-history/history.bin')); assert.equal(bytes.includes(Buffer.from('private fixture')), false);
  const changes = state.changes.length; await history.tick(); assert.equal(state.changes.length, changes);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'clipboard-history/history.bin')), bytes);
  const restored = new ClipboardHistory(args); await restored.initialized; assert.equal((await restored.getState()).entries.length, 1); assert.equal((await restored.detail(restored.entries[0].id)).text, 'private fixture text');
});
test('rich text copy and plain-text copy preserve separate actions without sending', async t => {
  const { history, state } = await fixture(t); state.content = [item('hello', '<b>hello</b>')]; await history.capture(); const id = history.entries[0].id;
  await history.copy({ id }); assert.deepEqual(state.writes[0][0].types, ['text/plain','text/html']);
  await history.copy({ id, plainText: true }); assert.deepEqual(state.writes[1][0].types, ['text/plain']);
  assert.equal(await state.writes[1][0].getType('text/plain').then(b => b.text()), 'hello');
});
test('favourites survive retention and clear unpinned; search covers full text', async t => {
  const { history, state } = await fixture(t); await history.saveSnippet({ text: 'snippet needle', title: 'Favourite' }); await history.capture();
  assert.equal((await history.getState({ query: 'needle' })).entries[0].title, 'Favourite');
  state.time += 31 * 86400000; await history.updatePreferences({ retentionDays: 30 }); assert.equal(history.entries.length, 1);
  state.content = [item('temporary')]; await history.capture(); await history.clearUnpinned(); assert.equal(history.entries.length, 1); assert.equal(history.entries[0].pinned, true);
});
test('source-app private markers are skipped without reading clipboard data', async t => {
  const { history, state } = await fixture(t); state.markers = true;
  await assert.rejects(history.capture(), /marked private/); assert.equal(state.reads, 0); assert.equal(history.entries.length, 0);
});
test('unavailable or insecure Linux storage refuses persistence and automatic capture', async t => {
  const { history, state, dataDir } = await fixture(t, { safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' } });
  await assert.rejects(history.updatePreferences({ enabled: true }), /secure system/); await assert.rejects(history.capture(), /secure system/); await history.tick();
  assert.equal(state.reads, 0); assert.equal((await history.getState()).available, false); await assert.rejects(fs.access(path.join(dataDir,'clipboard-history/history.bin')));
});
test('pause invalidates a clipboard read already in flight', async t => {
  const { history, state, args } = await fixture(t); let finish; const waiting = new Promise(resolve => { finish = resolve; });
  args.clipboard.read = async () => { state.reads++; await waiting; return state.content; };
  await history.updatePreferences({ enabled: true }); const tick = history.tick(); await new Promise(r => setImmediate(r));
  const paused = history.updatePreferences({ paused: true }); finish(); await tick; await paused;
  assert.equal(history.entries.length, 0); assert.equal(history.settings.paused, true);
});
test('corrupt history is preserved and cannot be overwritten by capture', async t => {
  const { history, args, dataDir, state } = await fixture(t); await history.capture(); const file = path.join(dataDir, 'clipboard-history/history.bin');
  const bad = await fs.readFile(file); bad[bad.length-1] ^= 1; await fs.writeFile(file,bad);
  const restored = new ClipboardHistory(args); await restored.initialized; const reads = state.reads;
  await assert.rejects(restored.capture(), /could not be decrypted/); assert.equal(state.reads, reads); assert.deepEqual(await fs.readFile(file), bad);
});
test('history add-to-shelf uses exact selected content and never starts network activity', async t => {
  const { history } = await fixture(t); await history.capture(); const calls=[];
  const service={enqueueText:async value => { calls.push(value); return {enqueuedItemIds:['chosen']}; },send:()=>assert.fail('must not send')};
  assert.deepEqual(await history.addToShelf(history.entries[0].id, service), {enqueuedItemIds:['chosen']}); assert.deepEqual(calls,['private fixture text']);
});

test('a missing wrapping key never causes existing history to be overwritten', async t => {
  const { history, args, dataDir } = await fixture(t); await history.capture(); const file = path.join(dataDir,'clipboard-history/history.bin'); const original = await fs.readFile(file);
  await fs.rm(path.join(dataDir,'clipboard-history/key.bin')); const restored = new ClipboardHistory(args); await restored.initialized;
  await assert.rejects(restored.capture(), /could not be decrypted/); assert.deepEqual(await fs.readFile(file),original);
});
test('plain-text copy does not recapture a duplicate through automatic history', async t => {
  const { history, state } = await fixture(t); state.content=[item('hello','<b>hello</b>')]; await history.capture(); await history.updatePreferences({enabled:true});
  await history.copy({id:history.entries[0].id,plainText:true}); await history.tick(); assert.equal(history.entries.length,1);
});

test('clearing unpinned history does not re-add the unchanged system clipboard', async t => {
  const { history } = await fixture(t); await history.updatePreferences({enabled:true}); await history.tick(); assert.equal(history.entries.length,1);
  await history.clearUnpinned(); await history.tick(); assert.equal(history.entries.length,0);
});

test('a full favourites list reports capacity instead of silently losing a new capture', async t => {
  const { history, state } = await fixture(t); await history.updatePreferences({maxItems:20});
  for(let i=0;i<20;i++) await history.saveSnippet({text:'saved '+i});
  state.content=[item('new copy')]; await assert.rejects(history.capture(),/Favourites fill/); assert.equal(history.entries.length,20); assert.ok(history.entries.every(e=>e.pinned));
});

test('full-text search returns metadata only and copy avoids rewriting the encrypted history', async t => {
  const { history, state, dataDir } = await fixture(t); state.content = [item('x'.repeat(250) + ' deep-match')]; await history.capture();
  const result = await history.getState({query:'deep-match'}); assert.equal(result.entries.length,1);
  assert.equal(result.entries[0].preview.length,220); assert.equal('searchText' in result.entries[0],false); assert.equal('text' in result.entries[0],false);
  const file=path.join(dataDir,'clipboard-history/history.bin'), before=await fs.readFile(file);
  await history.copy({id:result.entries[0].id}); assert.deepEqual(await fs.readFile(file),before);
});
for (const broken of ['missing','corrupt']) test(`${broken} preferences preserve a history larger than the default cap`, async t => {
  const { history, state, dataDir, args } = await fixture(t); await history.updatePreferences({maxItems:500,enabled:true});
  state.content=[item('seed')]; await history.capture(); const seed=history.entries[0];
  history.entries=Array.from({length:250},(_,i)=>({...seed,id:require('node:crypto').randomUUID(),hash:'entry-'+i,text:'entry '+i})); await history.persist();
  const file=path.join(dataDir,'clipboard-history/history.bin'), before=await fs.readFile(file), prefs=path.join(dataDir,'clipboard-history/preferences.json');
  if(broken==='missing') await fs.rm(prefs); else await fs.writeFile(prefs,'broken');
  const restored=new ClipboardHistory(args); await restored.initialized; await restored.tick();
  assert.equal(restored.entries.length,250); assert.equal(restored.settings.enabled,false); assert.equal(restored.loadFailed,undefined); assert.match(restored.error,/preferences need review/);
  assert.deepEqual(await fs.readFile(file),before); await assert.rejects(restored.capture(),/preferences need review/);
  await restored.updatePreferences({maxItems:500,retentionDays:30,enabled:false}); assert.equal(restored.entries.length,250); assert.equal(restored.preferencesRecovery,false);
});
test('startup cleanup I/O failure keeps decrypted entries usable and retries later', async t => {
  const { history, state, dataDir, args }=await fixture(t); await history.capture(); const file=path.join(dataDir,'clipboard-history/history.bin'), before=await fs.readFile(file);
  state.time+=31*86400000;
  class FailingCleanup extends ClipboardHistory { async atomic(name,bytes){ if(name==='history.bin') throw new Error('simulated disk failure'); return super.atomic(name,bytes); } }
  const restored=new FailingCleanup(args); await restored.initialized; assert.equal(restored.entries.length,1); assert.equal(restored.loadFailed,undefined); assert.match(restored.error,/expiry cleanup/);
  assert.equal((await restored.detail(restored.entries[0].id)).text,'private fixture text'); assert.deepEqual(await fs.readFile(file),before);
  restored.atomic=ClipboardHistory.prototype.atomic; await restored.tick(); assert.equal(restored.entries.length,0);
});

test('web-link URI representation becomes text but remote file URIs remain rejected', async t=>{
  const {history,state}=await fixture(t); const url='https://example.com/project';
  state.content=[new Item({'text/uri-list':new Blob([url]),'text/plain':new Blob([url])})]; await history.capture(); assert.equal(history.entries[0].kind,'text'); assert.equal(history.entries[0].text,url);
  state.content=[new Item({'text/uri-list':new Blob(['file://server/share/file']),'text/plain':new Blob(['description'])})]; await assert.rejects(history.capture(),/invalid or remote/); assert.equal(history.entries.length,1);
});
