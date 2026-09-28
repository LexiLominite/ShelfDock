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
  const history = new ClipboardHistory(args); await history.initialized; if (options.toolsEnabled !== false) await history.updateTools({ enabled: true }); return { history, state, args, dataDir };
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

test('new installs disable Clipboard tools; native history reads, writes and mutations are blocked', async t => {
  const { history, state, dataDir } = await fixture(t, { toolsEnabled: false });
  assert.deepEqual(history.toolsState(), { enabled: false, showTab: true, historyEnabled: false });
  await history.tick();
  for (const operation of [() => history.capture(), () => history.copy({ id: 'fixture' }), () => history.detail('fixture'), () => history.setPinned({ id: 'fixture', pinned: true }), () => history.remove('fixture'), () => history.clearUnpinned(), () => history.saveSnippet({ text: 'fixture' }), () => history.updatePreferences({ enabled: true }), () => history.addToShelf('fixture', {})]) await assert.rejects(operation(), /Enable Clipboard tools/);
  assert.equal(state.reads, 0); assert.equal(state.writes.length, 0);
  assert.deepEqual((await history.getState()).entries, []);
  await assert.rejects(fs.access(path.join(dataDir, 'clipboard-history/history.bin')));
  await history.updateTools({ enabled: true }); await history.tick();
  assert.equal(state.reads, 0, 'Enabling tools alone does not opt in to automatic history');
  await history.capture(); assert.equal(state.reads, 1, 'Explicit capture is available after enabling tools');
});

test('hiding the tab persists independently and does not pause opted-in capture', async t => {
  const { history, state, args } = await fixture(t); await history.updatePreferences({ enabled: true });
  await history.updateTools({ showTab: false }); await history.tick();
  assert.equal(state.reads, 1); assert.deepEqual(history.toolsState(), { enabled: true, showTab: false, historyEnabled: true });
  const restored = new ClipboardHistory(args); await restored.initialized;
  assert.deepEqual(restored.toolsState(), { enabled: true, showTab: false, historyEnabled: true });
  await restored.updateTools({ showTab: true }); assert.equal(restored.historyEnabled(), true);
});

test('disabling keeps encrypted items and resets consent across restart and re-enable', async t => {
  const { history, state, dataDir, args } = await fixture(t); await history.updatePreferences({ enabled: true }); await history.tick();
  const file = path.join(dataDir, 'clipboard-history/history.bin'), before = await fs.readFile(file), id = history.entries[0].id;
  await history.updateTools({ enabled: false }); state.time += 100 * 86400000; await history.tick();
  assert.equal(state.reads, 1); assert.equal(history.entries.length, 1);
  assert.deepEqual(await fs.readFile(file), before, 'Disabling does not rewrite or clear saved history');
  assert.deepEqual((await history.getState()).entries, []);
  const restored = new ClipboardHistory(args); await restored.initialized; await restored.tick();
  assert.equal(restored.entries.length, 1, 'Disabled startup does not expire saved items');
  assert.deepEqual(await fs.readFile(file), before);
  state.time -= 100 * 86400000;
  await restored.updateTools({ enabled: true }); await restored.tick();
  assert.equal(state.reads, 1); assert.equal((await restored.getState()).settings.enabled, false);
  assert.equal((await restored.detail(id)).text, 'private fixture text');
  const restarted = new ClipboardHistory(args); await restarted.initialized; await restarted.tick();
  assert.equal(state.reads, 1, 'Re-enabling and restarting never restores stale encrypted capture consent');
  await restarted.updatePreferences({ enabled: true }); await restarted.tick(); assert.equal(state.reads, 2);
});

for (const optedIn of [false, true]) test(`legacy history consent never enables Clipboard tools: ${optedIn}`, async t => {
  const { history, args, dataDir } = await fixture(t); await history.capture();
  if (optedIn) await history.updatePreferences({ enabled: true });
  await fs.rm(path.join(dataDir, 'clipboard-history/tools.json'));
  await fs.rm(path.join(dataDir, 'clipboard-history/tools-configured-v1'));
  const before = await fs.readFile(path.join(dataDir, 'clipboard-history/history.bin'));
  const restored = new ClipboardHistory(args); await restored.initialized;
  assert.equal(restored.toolsState().enabled, false); assert.equal(restored.historyEnabled(), false);
  assert.equal(restored.entries.length, 1); assert.deepEqual(await fs.readFile(path.join(dataDir, 'clipboard-history/history.bin')), before);
});

test('corrupt tools preferences fail closed without changing saved history', async t => {
  const { history, args, dataDir, state } = await fixture(t); await history.updatePreferences({ enabled: true }); await history.tick();
  const before = await fs.readFile(path.join(dataDir, 'clipboard-history/history.bin'));
  await fs.writeFile(path.join(dataDir, 'clipboard-history/tools.json'), '{invalid');
  const restored = new ClipboardHistory(args); await restored.initialized; await restored.tick();
  assert.equal(restored.toolsState().enabled, false); assert.equal(state.reads, 1);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'clipboard-history/history.bin')), before);
  await restored.updateTools({ enabled: true }); await restored.tick(); assert.equal(state.reads, 1);
});

test('turning tools off invalidates an in-flight read before it can be saved', async t => {
  const { history, state, args } = await fixture(t); let finish, started;
  const reading = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  args.clipboard.read = async () => { state.reads++; started(); await waiting; return state.content; };
  await history.updatePreferences({ enabled: true }); const capture = history.tick(); await reading;
  const disabling = history.updateTools({ enabled: false });
  assert.equal(history.toolsState().enabled, false, 'The native gate closes immediately while an older read is pending');
  finish(); await capture; await disabling;
  assert.equal(history.entries.length, 0); assert.equal(history.historyEnabled(), false);
});

test('tools can be disabled even when encrypted storage is locked', async t => {
  const { history, args } = await fixture(t); await history.updatePreferences({ enabled: true });
  args.safeStorage.isEncryptionAvailable = () => false;
  await history.updateTools({ enabled: false });
  assert.equal(history.toolsState().enabled, false); assert.equal(history.historyEnabled(), false);
  await history.updateTools({ enabled: true }); assert.equal(history.historyEnabled(), false);
});


test('missing tools preferences after an explicit disable never revive a legacy opt-in', async t => {
  const { history, args, dataDir, state } = await fixture(t); await history.updatePreferences({ enabled: true }); await history.tick();
  await history.updateTools({ enabled: false });
  await fs.rm(path.join(dataDir, 'clipboard-history/tools.json'));
  const restored = new ClipboardHistory(args); await restored.initialized; await restored.tick();
  assert.equal(restored.toolsState().enabled, false); assert.equal(state.reads, 1);
  await restored.updateTools({ enabled: true }); await restored.tick(); assert.equal(state.reads, 1);
});

test('failed disable persistence still closes the runtime gate and reports failure', async t => {
  const { history, state } = await fixture(t); await history.updatePreferences({ enabled: true });
  history.atomic = async () => { throw new Error('simulated disk failure'); };
  await assert.rejects(history.updateTools({ enabled: false }), /simulated disk failure/);
  await history.tick(); assert.equal(state.reads, 0); assert.equal(history.toolsState().enabled, false);
});

test('noteSyncEvent does not recapture a sync write, including a racing identical poll', async t => {
  const submitted = [];
  const { history, state } = await fixture(t, { isSyncEnabled: () => true, onLocalItem: item => submitted.push({ ...item }) });
  await history.updatePreferences({ enabled: true });
  state.content = [item('synthetic local text')];
  await history.tick();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].kind, 'text');
  assert.equal(submitted[0].text, 'synthetic local text');
  assert.match(submitted[0].eventId, /^[0-9a-f-]{36}$/);
  const eventId = require('node:crypto').randomUUID();
  const synced = 'synthetic sync text';
  const hash = history.contentHash({ kind: 'text', text: synced });
  history.noteSyncEvent(eventId, hash);
  state.content = [item(synced)];
  history.lastHash = '';
  await history.tick();
  assert.equal(history.entries.length, 1, 'suppress hash ignores the sync write when the poll races the marker');
  assert.equal(submitted.length, 1);
  state.content = [new Item({ 'text/plain': new Blob([synced]), 'application/x-shelfdock-sync-event': new Blob([eventId]) })];
  history.lastHash = '';
  history.syncSuppressUntil = 0;
  await history.tick();
  assert.equal(history.entries.length, 1);
  assert.equal(submitted.length, 1, 'a noted sync event id is not submitted again');
  state.time += 6000;
  state.content = [item('https://example.com/synthetic')];
  await history.tick();
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].kind, 'url');
  assert.equal(submitted[1].text, 'https://example.com/synthetic');
  state.content = [item('synthetic local text')];
  await history.tick();
  assert.equal(submitted.length, 3);
  assert.notEqual(submitted[2].eventId, submitted[0].eventId, 'copying the same text again creates a new event');
  assert.equal(history.entries.length, 2, 'the same text updates its history row instead of duplicating it');
});

test('tools off does not imply sync and loading history does not submit saved entries', async t => {
  const submitted = [];
  const { history, state, args, dataDir } = await fixture(t, { isSyncEnabled: () => true, onLocalItem: item => submitted.push(item.text) });
  await history.updatePreferences({ enabled: true });
  state.content = [item('synthetic kept text')];
  await history.tick();
  assert.deepEqual(submitted, ['synthetic kept text']);
  const file = path.join(dataDir, 'clipboard-history/history.bin');
  const before = await fs.readFile(file);
  await history.updateTools({ enabled: false });
  state.content = [item('synthetic while tools are off')];
  await history.tick();
  assert.deepEqual(submitted, ['synthetic kept text']);
  assert.equal(history.tools.enabled, false);
  assert.equal(history.historyEnabled(), false);
  assert.equal(history.syncEnabled, undefined);
  const hidden = history.snapshot();
  assert.equal(hidden.token, undefined);
  assert.equal(JSON.stringify(hidden).includes('token'), false);
  assert.equal(JSON.stringify(hidden).includes('synthetic'), false);
  const restored = new ClipboardHistory({ ...args, isSyncEnabled: () => false, onLocalItem: item => submitted.push(item.text) });
  await restored.initialized;
  assert.equal(restored.entries.length, 1, 'existing history still loads');
  assert.deepEqual(submitted, ['synthetic kept text'], 'turning sync on later must not upload saved entries');
  assert.deepEqual(await fs.readFile(file), before);
  await restored.updateTools({ enabled: true });
  await restored.tick();
  assert.deepEqual(submitted, ['synthetic kept text']);
  await restored.ingestSync({ eventId: require('node:crypto').randomUUID(), kind: 'text', text: 'synthetic incoming', sourceLabel: 'Other computer' });
  assert.equal(restored.entries.length, 2, 'explicit sync stores received items without opting into automatic history');
});

test('incoming sync keeps an origin label and export snapshots have no token', async t => {
  const submitted = [];
  const { history } = await fixture(t, { isSyncEnabled: () => true, onLocalItem: item => submitted.push(item) });
  await history.updatePreferences({ enabled: true });
  const eventId = require('node:crypto').randomUUID();
  await history.ingestSync({ eventId, kind: 'text', text: 'synthetic incoming', sourceLabel: 'Other computer' });
  assert.equal(submitted.length, 0, 'sync ingestion is not sent back');
  assert.equal(history.entries[0].sourceLabel, 'Other computer');
  assert.equal(history.entries[0].eventId, eventId);
  assert.equal(history.entries[0].token, undefined);
  const view = await history.getState();
  assert.equal(view.entries[0].sourceLabel, 'Other computer');
  assert.equal(view.entries[0].preview, 'synthetic incoming');
  assert.equal(JSON.stringify(view).includes('token'), false);
  await history.ingestSync({ eventId, kind: 'text', text: 'synthetic incoming', sourceLabel: 'Other computer' });
  assert.equal(history.entries.length, 1, 'the same sync event is stored once');
  const { createConfig } = require('../desktop/config.cjs');
  const exported = createConfig({
    hosts: [{ name: 'Synthetic', address: '192.0.2.20', user: 'example', port: 22, destination: '~/Desktop', route: 'ssh', os: 'posix', token: 'synthetic-secret', sshTarget: { token: 'synthetic-secret' } }],
    settings: { shakeEnabled: true, sensitivity: 'strong', viewMode: 'expanded', token: 'synthetic-secret', clipboardSync: { token: 'synthetic-secret' } },
    clipboardSync: { token: 'synthetic-secret', directory: 'clipboard-sync' },
    items: [{ preview: 'synthetic-secret' }],
  });
  const serialized = JSON.stringify(exported);
  assert.equal(exported.clipboardSync, undefined);
  assert.equal(exported.token, undefined);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('synthetic-secret'), false);
  assert.equal(serialized.includes('clipboard-sync'), false);
  assert.equal(serialized.includes('sshTarget'), false);
});

test('v0.4.1 automatic tools opt-in resets once without touching history; fresh Settings choice persists', async t => {
  const { history, args, dataDir, state } = await fixture(t); await history.updatePreferences({ enabled: true }); await history.tick();
  const historyFile = path.join(dataDir, 'clipboard-history/history.bin');
  const before = await fs.readFile(historyFile);
  await fs.writeFile(path.join(dataDir, 'clipboard-history/tools.json'), JSON.stringify({ enabled: true, showTab: true, historyConsent: true }));
  state.time += 100 * 86400000;
  const upgraded = new ClipboardHistory(args); await upgraded.initialized; await upgraded.tick();
  assert.equal(upgraded.toolsState().enabled, false); assert.equal(upgraded.historyEnabled(), false);
  assert.equal(upgraded.entries.length, 1); assert.equal(state.reads, 1);
  assert.deepEqual(await fs.readFile(historyFile), before);
  state.time -= 100 * 86400000;
  await upgraded.updateTools({ enabled: true });
  const restarted = new ClipboardHistory(args); await restarted.initialized; await restarted.tick();
  assert.equal(restarted.toolsState().enabled, true); assert.equal(restarted.historyEnabled(), false); assert.equal(state.reads, 1);
  await restarted.updatePreferences({ enabled: true });
  const optedIn = new ClipboardHistory(args); await optedIn.initialized;
  assert.equal(optedIn.historyEnabled(), true);
});


test('explicit sync captures new copies without automatic history and skips the initial clipboard', async t => {
  const submitted = [];
  let enabled = true;
  const { history, state } = await fixture(t, { isSyncEnabled: () => enabled, onLocalItem: item => submitted.push(item) });
  history.resetSyncBaseline();
  await history.tick(); await history.localSubmissions;
  assert.equal(submitted.length, 0, 'enabling sync does not publish old clipboard contents');
  state.content = [item('new synthetic copy')];
  await history.tick(); await history.localSubmissions;
  assert.equal(submitted.length, 1);
  assert.equal(history.entries.length, 0, 'sync consent does not enable automatic local history');
  state.markers = true; state.content = [item('private synthetic copy')];
  await history.tick(); await history.localSubmissions;
  assert.equal(submitted.length, 1);
  enabled = false; const reads = state.reads;
  await history.tick(); assert.equal(state.reads, reads);
});

test('saving a snippet does not sync until it is actually copied', async t => {
  const submitted = [];
  const { history } = await fixture(t, { isSyncEnabled: () => true, onLocalItem: item => submitted.push(item) });
  await history.saveSnippet({ text: 'synthetic snippet' }); await history.localSubmissions;
  assert.equal(submitted.length, 0);
  await history.copy({ id: history.entries[0].id }); await history.localSubmissions;
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, 'synthetic snippet');
});
