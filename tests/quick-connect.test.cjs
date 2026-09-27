const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../src/quick-connect.mjs');
const plan = { id: 'saved-studio', hostId: 'studio', mode: 'local', targetHost: 'localhost', targetPort: 1331, listenPort: 1331, lastUsedAt: '2026-01-01T00:00:00Z' };
const site = { scheme: 'http:', path: '/dashboard?temporary=yes#detail', pathname: '/dashboard', known: true };
const empty = { active: [], history: [] };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const running = (overrides = {}) => ({ ...plan, id: 'session', historyId: plan.id, status: 'running', ...overrides });
const memoryStorage = () => { let data = {}; return { getItem: key => data[key] || null, setItem: (key, value) => { data[key] = value; }, values: () => data }; };

test('quick address accepts the user localhost example, bare addresses and default service ports', async () => {
  const { parseQuickUrl } = await api;
  assert.deepEqual(parseQuickUrl(' http://localhost:1331 '), { scheme: 'http:', targetHost: 'localhost', targetPort: 1331, path: '/', pathname: '/', url: 'http://localhost:1331/' });
  assert.equal(parseQuickUrl('localhost:1331/app').path, '/app');
  assert.equal(parseQuickUrl('studio.lan').targetPort, 80);
  assert.equal(parseQuickUrl('https://studio.lan').targetPort, 443);
  assert.equal(parseQuickUrl('HTTP://studio.lan:1331').scheme, 'http:');
});

test('IPv6 targets are unbracketed for SSH and bracketed again for displayed URLs', async () => {
  const { parseQuickUrl, urlForPlan } = await api;
  const parsed = parseQuickUrl('http://[::1]:1331/health');
  assert.equal(parsed.targetHost, '::1');
  assert.equal(parsed.targetPort, 1331);
  assert.equal(urlForPlan({ ...plan, targetHost: '::1' }, { scheme: 'https:', path: '/health' }), 'https://[::1]:1331/health');
  assert.equal(parseQuickUrl('[::1]:1331').targetHost, '::1');
});

test('HTTPS, encoded paths, transient query strings and fragments retain their meaning', async () => {
  const { parseQuickUrl, localSiteUrl } = await api;
  const parsed = parseQuickUrl('https://studio.lan:9443/a%20b?session=private#place');
  assert.equal(parsed.scheme, 'https:');
  assert.equal(parsed.path, '/a%20b?session=private#place');
  assert.equal(localSiteUrl(running({ listenPort: 9444 }), parsed), 'https://127.0.0.1:9444/a%20b?session=private#place');
  assert.equal(localSiteUrl(running({ mode: 'remote' }), parsed), '');
});

test('invalid and ambiguous addresses fail before any SSH operation', async () => {
  const { parseQuickUrl } = await api;
  for (const invalid of ['', 'ssh://studio:22', 'file:///tmp/file', 'javascript:alert(1)', 'http:studio', 'https://name:password@studio', 'http://@studio', 'http://studio:', 'http://studio:0', 'http://studio:65536', 'http://studio:-1', 'http://bad host:1331', 'http://bad..host', 'http://-host', 'http://host_/a', 'http://studio\n:1331', 'http://studio\\evil', 'http://studio/%0aheader', 'http://studio/?key=%7f', 'http://studio//elsewhere']) {
    assert.throws(() => parseQuickUrl(invalid), undefined, invalid);
  }
  assert.throws(() => parseQuickUrl(`http://studio/${'a'.repeat(4096)}`), /4096/);
});

test('first-use listener follows destination, saved explicit listener is respected, and directions remain distinct', async () => {
  const { parseQuickUrl, quickPlanForUrl } = await api;
  const input = { hostId: 'studio', site: parseQuickUrl('localhost:1331') };
  assert.equal(quickPlanForUrl(input).listenPort, 1331);
  assert.equal(quickPlanForUrl({ ...input, savedPlan: { listenPort: 8080 } }).listenPort, 8080);
  const remote = quickPlanForUrl({ ...input, mode: 'remote', listenPort: '9444', targetPort: '9443' });
  assert.equal(remote.mode, 'remote'); assert.equal(remote.targetPort, 9443); assert.equal(remote.listenPort, 9444);
  assert.throws(() => quickPlanForUrl({ ...input, listenPort: '1.5' }), /Listening port/);
  assert.throws(() => quickPlanForUrl({ ...input, mode: 'other' }), /Local or Remote/);
});

test('last used is selected within the host and direction, independent of history order', async () => {
  const { latestSavedPlan } = await api;
  const newest = { ...plan, id: 'newest', lastUsedAt: '2026-02-01' };
  const history = [plan, { ...newest, id: 'remote', mode: 'remote', lastUsedAt: '2026-03-01' }, { ...newest, id: 'other', hostId: 'other', lastUsedAt: '2026-04-01' }, newest];
  assert.equal(latestSavedPlan({ history }, 'studio').id, 'newest');
  assert.equal(latestSavedPlan({ history }, 'studio', 'remote').id, 'remote');
  assert.equal(latestSavedPlan({ history }, 'missing'), null);
});

test('only matching active plans suppress duplicate starts; failed plans remain retryable', async () => {
  const { activeForPlan } = await api;
  assert.equal(activeForPlan({ active: [running()] }, plan).id, 'session');
  assert.equal(activeForPlan({ active: [running({ status: 'starting' })] }, plan).status, 'starting');
  assert.equal(activeForPlan({ active: [running({ mode: 'remote' })] }, plan), null);
  assert.equal(activeForPlan({ active: [running({ listenPort: 1332 })] }, plan), null);
  assert.equal(activeForPlan({ active: [running({ status: 'failed' })] }, plan), null);
});

test('website preferences never persist query strings or fragments and stay keyed to the saved plan', async () => {
  const { rememberSitePreferences, sitePreferences } = await api;
  const storage = memoryStorage();
  const saved = { ...plan, id: 'privacy-plan' };
  rememberSitePreferences(saved, { scheme: 'https:', path: '/app?private-token=secret#private' }, storage);
  const text = JSON.stringify(storage.values());
  assert.match(text, /https:/); assert.match(text, /app/);
  assert.doesNotMatch(text, /private-token|secret|#private/);
  assert.equal(sitePreferences(saved, storage).path, '/app?private-token=secret#private');
  assert.equal(sitePreferences({ ...saved, id: 'changed-endpoint-plan' }, storage).known, false);
  assert.equal(sitePreferences({ ...saved, listenPort: 1444 }, storage).known, false);
});

test('malformed saved website data is not sent to the opener and HTTPS is never inferred from port 443', async () => {
  const { sitePreferences, rememberSitePreferences } = await api;
  const storage = memoryStorage(); const saved = { ...plan, id: 'invalid-pref', targetPort: 443 };
  rememberSitePreferences(saved, { scheme: 'file:', path: '/' }, storage);
  assert.equal(sitePreferences(saved, storage).known, false);
  rememberSitePreferences(saved, { scheme: 'https:', path: '//external' }, storage);
  assert.equal(sitePreferences(saved, storage).known, false);
  rememberSitePreferences(saved, { scheme: 'https:', path: '/%0d' }, storage);
  assert.equal(sitePreferences(saved, storage).known, false);
});

test('saved repeats use the native history ID and preserve its endpoint-change rejection', async () => {
  const { repeatSavedForward } = await api;
  let received; let starts = 0;
  const bridge = { startTunnel: () => { starts++; }, restartTunnel: async id => { received = id; throw new Error('The machine address changed; review this saved forward.'); } };
  const result = await repeatSavedForward({ bridge, plan, snapshot: empty });
  assert.equal(received, plan.id); assert.equal(starts, 0); assert.match(result.error, /address changed/);
});

test('an existing saved plan submitted through Go also retains native endpoint verification', async () => {
  const { startQuickForward } = await api;
  let repeated = ''; let starts = 0;
  const bridge = { restartTunnel: async id => { repeated = id; return { active: [running()], history: [plan] }; }, startTunnel: () => { starts++; } };
  const result = await startQuickForward({ bridge, plan, site, snapshot: { active: [], history: [plan] }, open: false });
  assert.equal(repeated, plan.id); assert.equal(starts, 0); assert.equal(result.entry.status, 'running');
});

test('an old saved plan without a known website scheme starts but never opens a guessed website', async () => {
  const { repeatSavedForward } = await api;
  const saved = { ...plan, id: 'legacy-unknown' }; let opens = 0;
  const bridge = { restartTunnel: async () => ({ active: [running({ historyId: saved.id })], history: [saved] }), openTunnelSite: async () => { opens++; } };
  const result = await repeatSavedForward({ bridge, plan: saved, snapshot: empty });
  assert.equal(result.needsUrl, true); assert.equal(opens, 0);
});

test('new website input on an already live saved plan records explicit HTTPS without another SSH start', async () => {
  const { startQuickForward, sitePreferences } = await api;
  const saved = { ...plan, id: 'already-live-https' }; let starts = 0; let opened;
  const bridge = { startTunnel: () => { starts++; }, restartTunnel: () => { starts++; }, openTunnelSite: async value => { opened = value; return { url: 'https://127.0.0.1:1331/app' }; } };
  const result = await startQuickForward({ bridge, plan: saved, site: { scheme: 'https:', path: '/app' }, snapshot: { active: [running({ historyId: saved.id })], history: [saved] } });
  assert.equal(starts, 0); assert.equal(result.entry.id, 'session'); assert.equal(opened.scheme, 'https:'); assert.equal(sitePreferences(saved).scheme, 'https:');
});

test('simultaneous Go and Repeat share a synchronous start lock', async () => {
  const { startQuickForward, repeatSavedForward } = await api;
  const wait = deferred(); let starts = 0; let repeats = 0;
  const bridge = { startTunnel: () => { starts++; return wait.promise; }, restartTunnel: () => { repeats++; } };
  const first = startQuickForward({ bridge, plan, site, snapshot: empty, open: false });
  const second = await repeatSavedForward({ bridge, plan, snapshot: empty });
  assert.equal(second.pending, true); assert.equal(starts, 1); assert.equal(repeats, 0);
  wait.resolve({ active: [running()], history: [plan] }); await first;
});

test('Stop from another component supersedes a pending Start response and prevents late browser opening', async () => {
  const { startQuickForward, stopForward } = await api;
  const wait = deferred(); const applied = []; const busy = []; let opened = 0;
  const bridge = { startTunnel: () => wait.promise, stopTunnel: async () => empty, openTunnelSite: async () => { opened++; } };
  const starting = startQuickForward({ bridge, plan, site, snapshot: empty, onSnapshot: value => applied.push(value), onBusyChange: value => busy.push(value) });
  await stopForward({ bridge, id: 'session', onSnapshot: value => applied.push(value) });
  wait.resolve({ active: [running()], history: [plan] });
  const result = await starting;
  assert.equal(result.superseded, true); assert.deepEqual(applied, [empty]); assert.equal(opened, 0); assert.deepEqual(busy, [true, false]);
});

test('cancelling before the starting session ID arrives suppresses browser opening', async () => {
  const { startQuickForward } = await api;
  let opened = 0;
  const bridge = { startTunnel: async () => ({ active: [running()], history: [plan] }), openTunnelSite: async () => { opened++; } };
  const result = await startQuickForward({ bridge, plan, site, snapshot: empty, isCancelled: () => true });
  assert.equal(result.entry.id, 'session'); assert.equal(opened, 0);
});

test('double Stop calls share one request and failed starts report the actual backend error', async () => {
  const { stopForward, startQuickForward } = await api;
  const wait = deferred(); let stops = 0;
  const bridge = { stopTunnel: () => { stops++; return wait.promise; }, startTunnel: async () => ({ active: [running({ status: 'failed', error: 'Port 1331 is already in use.' })], history: [] }) };
  const first = stopForward({ bridge, id: 'session' }); const second = stopForward({ bridge, id: 'session' });
  assert.equal(stops, 1); assert.equal(first, second); wait.resolve(empty); await first;
  const result = await startQuickForward({ bridge, plan, site, snapshot: empty });
  assert.match(result.error, /already in use/);
});

test('remote sessions never open a local website and browser errors retain the live SSH session', async () => {
  const { startQuickForward } = await api;
  let opened = 0;
  const remote = { ...plan, mode: 'remote' };
  const bridge = { startTunnel: async request => ({ active: [running({ mode: request.mode })], history: [] }), openTunnelSite: async () => { opened++; throw new Error('Browser unavailable.'); } };
  const remoteResult = await startQuickForward({ bridge, plan: remote, site, snapshot: empty });
  assert.equal(remoteResult.entry.mode, 'remote'); assert.equal(opened, 0);
  const localResult = await startQuickForward({ bridge, plan, site, snapshot: empty });
  assert.equal(opened, 1); assert.equal(localResult.entry.status, 'running'); assert.match(localResult.error, /Forward is live/);
});

test('legacy history edits share the start lock and cannot overwrite a newer Stop snapshot', async () => {
  const { startQuickForward, mutateForwardHistory, stopForward } = await api;
  const startWait = deferred(); const editWait = deferred(); const applied = []; let edits = 0;
  const bridge = { startTunnel: () => startWait.promise, updateTunnelNote: () => { edits++; return editWait.promise; }, stopTunnel: async () => empty };
  const start = startQuickForward({ bridge, plan, site, snapshot: empty, open: false });
  const blockedEdit = await mutateForwardHistory({ bridge, method: 'updateTunnelNote', value: { id: plan.id, note: 'Test' } });
  assert.equal(blockedEdit.pending, true); assert.equal(edits, 0);
  startWait.resolve({ active: [running()], history: [plan] }); await start;
  const edit = mutateForwardHistory({ bridge, method: 'updateTunnelNote', value: { id: plan.id, note: 'Test' }, onSnapshot: value => applied.push(value) });
  await stopForward({ bridge, id: 'session', onSnapshot: value => applied.push(value) });
  editWait.resolve({ active: [running()], history: [plan] });
  assert.equal((await edit).superseded, true); assert.deepEqual(applied, [empty]);
});

test('an older concurrent Stop reply cannot resurrect another session that was stopped later', async () => {
  const { stopForward } = await api;
  const earlier = deferred(); const applied = [];
  const bridge = { stopTunnel: id => id === 'a' ? earlier.promise : Promise.resolve(empty) };
  const first = stopForward({ bridge, id: 'a', onSnapshot: value => applied.push(value) });
  await stopForward({ bridge, id: 'b', onSnapshot: value => applied.push(value) });
  earlier.resolve({ active: [running({ id: 'b' })], history: [] }); await first;
  assert.deepEqual(applied, [empty]);
});
