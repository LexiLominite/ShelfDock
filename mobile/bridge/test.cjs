'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createBridge, privateIP, validName, validEndpoint, readPrivate } = require('./server.cjs');
const { validateManifest, ReceivedManager, RECEIPT_NAME } = require('../../desktop/received.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { maxFileBytes = 1024, quotaBytes = 2048 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lexbridge-mobile-test-'));
  const runtime = path.join(root, 'runtime'), desktopDir = path.join(root, 'Desktop');
  await fs.mkdir(desktopDir);
  let bridge = await createBridge({ runtime, desktopDir, configOptions: { maxFileBytes, quotaBytes }, heartbeatMs: 30 });
  let addr = await bridge.listen(0, '127.0.0.1'); let endpoint = `http://127.0.0.1:${addr.port}`;
  const config = bridge.config;
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function call(route, { token, body, bytes, method = body !== undefined || bytes !== undefined ? 'POST' : 'GET', headers = {} } = {}) {
    const r = await fetch(endpoint + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(bytes !== undefined ? { 'Content-Type': 'application/octet-stream' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : bytes });
    return { status: r.status, value: r.headers.get('content-type')?.startsWith('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
  }
  async function pair(deviceName = 'Test phone') {
    const instructions = await bridge.createPairing(endpoint); const info = await readPrivate(instructions.pairingFile);
    const r = await call('/v1/pair', { body: { code: info.code, deviceName } }); assert.equal(r.status, 200);
    return { ...r.value, code: info.code, pairingFile: instructions.pairingFile };
  }
  return { root, runtime, desktopDir, config, call, pair, get bridge() { return bridge; }, get endpoint() { return endpoint; }, async restart() { await bridge.close(); bridge = await createBridge({ runtime, desktopDir, heartbeatMs: 30 }); addr = await bridge.listen(0, '127.0.0.1'); endpoint = `http://127.0.0.1:${addr.port}`; } };
}

test('private network and filename validators reject public and unsafe inputs', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '100.64.0.1', '100.127.255.255', '::ffff:100.64.0.1']) assert.equal(privateIP(ip), true, ip);
  for (const ip of ['100.63.255.255', '100.128.0.1', '192.168.1.1', '10.0.0.1', '8.8.8.8', '100.64.999.1', 'localhost', 'fd7a:115c:a1e0::1']) assert.equal(privateIP(ip), false, ip);
  for (const name of ['../evil', 'a/b', 'a\\b', '.dropharbor-receipt.json', 'a\n.txt', 'a\u202e.txt', 'CON.txt', 'nul', 'a:stream', '..', ' name', 'name.']) assert.throws(() => validName(name), name);
  assert.equal(validName('report 日本語.pdf'), 'report 日本語.pdf');
  for (const url of ['http://example.com', 'http://192.168.1.1', 'http://100.64.0.1/path', 'http://user:pass@100.64.0.1', 'http://100.64.0.1?token=x']) assert.throws(() => validEndpoint(url));
  assert.equal(validEndpoint('http://100.64.0.1:18474'), 'http://100.64.0.1:18474');
});

test('single-use scoped pairing, no recipients, host/origin and JSON boundaries', async t => {
  const f = await fixture(t);
  assert.equal((await fs.stat(f.runtime)).mode & 0o777, 0o700);
  for (const file of ['config.json', 'state.json', 'agent.json']) assert.equal((await fs.stat(path.join(f.runtime, file))).mode & 0o777, 0o600);
  assert.equal((await f.call('/v1/notifications', { token: f.config.agentToken, body: { title: 'Done', body: 'Explicit test' } })).status, 409);
  const hostileHostStatus = await new Promise((resolve, reject) => { const req = http.get(f.endpoint + '/v1/health', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await f.call('/v1/health', { headers: { Origin: 'http://localhost' } })).status, 403);
  assert.equal((await f.call('/v1/state', { token: f.config.agentToken })).status, 403);
  const p = await f.pair();
  await assert.rejects(fs.stat(p.pairingFile), { code: 'ENOENT' });
  assert.equal((await f.call('/v1/pair', { body: { code: p.code, deviceName: 'Replay' } })).status, 401);
  assert.equal((await f.call('/v1/pairings', { token: p.token, body: {} })).status, 403);
  assert.equal((await f.call('/v1/outbox?name=x&deviceId=' + p.deviceId, { token: f.config.agentToken, bytes: Buffer.from('x') })).status, 403);
  assert.equal((await f.call('/v1/notifications', { token: f.config.ownerToken, body: { title: 'x', body: 'y', action: 'run' } })).status, 400);
  assert.equal((await f.call('/v1/notifications', { token: f.config.agentToken, body: { title: 'x', body: 'y'.repeat(65536) } })).status, 413);
  const state = (await f.call('/v1/state', { token: f.config.ownerToken })).value;
  const serialized = JSON.stringify(state);
  for (const value of [f.config.agentToken, f.config.ownerToken, p.token, f.runtime, f.desktopDir]) assert.equal(serialized.includes(value), false);
});

test('incoming files publish compatible Received receipts and failed uploads never appear complete', async t => {
  const f = await fixture(t); const p = await f.pair('Android test'); const bytes = Buffer.from('phone file\n');
  const uploaded = await f.call('/v1/inbox?name=hello.txt', { token: p.token, bytes, headers: { 'X-Content-SHA256': digest(bytes) } });
  assert.equal(uploaded.status, 200); assert.equal(uploaded.value.file.status, 'received');
  const folders = await fs.readdir(f.desktopDir); assert.equal(folders.length, 1); assert.match(folders[0], /^Drift-.*-[a-f0-9]{8}$/);
  assert.deepEqual(await fs.readFile(path.join(f.desktopDir, folders[0], 'hello.txt')), bytes);
  const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(f.desktopDir, folders[0], RECEIPT_NAME))));
  assert.equal(manifest.senderLabel, 'Android test'); assert.equal(manifest.items[0].size, bytes.length);
  const received = new ReceivedManager({ desktopDir: f.desktopDir, dataDir: path.join(f.root, 'isolated-received') });
  const desktopState = await received.refresh(); assert.equal(desktopState.received.length, 1); assert.equal(desktopState.received[0].available, true);
  assert.equal((await f.call('/v1/inbox?name=bad.txt', { token: p.token, bytes, headers: { 'X-Content-SHA256': '0'.repeat(64) } })).status, 422);
  assert.equal((await f.call('/v1/inbox?name=..%2Fbad', { token: p.token, bytes })).status, 400);
  assert.equal((await f.call('/v1/inbox?name=large', { token: p.token, bytes: Buffer.alloc(1025) })).status, 413);
  assert.deepEqual(await fs.readdir(f.desktopDir), folders);
  // Deliberately disconnect a chunked upload after some bytes reach the server.
  await new Promise(resolve => {
    const req = http.request(f.endpoint + '/v1/inbox?name=aborted.txt', { method: 'POST', headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/octet-stream' } });
    req.on('error', () => resolve()); req.write('partial'); setTimeout(() => req.destroy(), 30);
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(await fs.readdir(f.desktopDir), folders);
  assert.equal((await f.call('/v1/state', { token: p.token })).value.files.length, 1);
});

test('outbox is durable, isolated, quota bounded and acknowledged only after exact hash', async t => {
  const f = await fixture(t, { maxFileBytes: 20, quotaBytes: 20 }); const a = await f.pair('A'), b = await f.pair('B');
  const bytes = Buffer.from('0123456789abcdef');
  const row = (await f.call(`/v1/outbox?name=report.txt&deviceId=${a.deviceId}`, { token: f.config.ownerToken, bytes })).value.file;
  assert.equal(row.status, 'queued'); assert.equal(row.sha256, digest(bytes));
  assert.equal((await f.call('/v1/state', { token: b.token })).value.files.length, 0);
  assert.equal((await f.call(`/v1/files/${row.id}/content`, { token: b.token })).status, 404);
  assert.equal((await f.call(`/v1/outbox?name=second.txt&deviceId=${a.deviceId}`, { token: f.config.ownerToken, bytes: Buffer.from('12345') })).status, 413);
  await f.restart();
  const downloaded = await f.call(`/v1/files/${row.id}/content`, { token: a.token }); assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.value, bytes); assert.equal(downloaded.headers.get('x-content-sha256'), row.sha256);
  assert.equal((await f.call(`/v1/files/${row.id}/ack`, { token: a.token, body: { sha256: '0'.repeat(64) } })).status, 422);
  assert.equal((await f.call('/v1/state', { token: a.token })).value.files[0].status, 'queued');
  assert.equal((await f.call(`/v1/files/${row.id}/ack`, { token: a.token, body: { sha256: row.sha256 } })).value.status, 'received');
  assert.equal((await f.call(`/v1/files/${row.id}/content`, { token: a.token })).status, 410);
  assert.deepEqual(await fs.readdir(path.join(f.runtime, 'spool')), []);
});

test('offline explicit alerts persist, event IDs bind credentials/content, and actual acknowledgements aggregate', async t => {
  const f = await fixture(t); const a = await f.pair('A'), b = await f.pair('B');
  const eventId = crypto.randomUUID(), body = { title: 'Task finished', body: 'Synthetic explicit alert', source: 'codex', eventId };
  const row = (await f.call('/v1/notifications', { token: f.config.agentToken, body })).value;
  assert.equal(row.recipientCount, 2); assert.equal(row.status, 'queued');
  const retry = (await f.call('/v1/notifications', { token: f.config.agentToken, body })).value; assert.equal(retry.id, row.id);
  assert.equal((await f.call('/v1/notifications', { token: f.config.agentToken, body: { ...body, body: 'Changed' } })).status, 409);
  const ownerRow = (await f.call('/v1/notifications', { token: f.config.ownerToken, body })).value; assert.notEqual(ownerRow.id, row.id);
  assert.equal((await f.call(`/v1/notifications/${ownerRow.id}`, { token: f.config.agentToken })).status, 404);
  await f.restart();
  assert.equal((await f.call('/v1/state', { token: a.token })).value.notifications.length, 2);
  await f.call(`/v1/notifications/${row.id}/ack`, { token: a.token, body: { displayed: false } });
  let status = (await f.call(`/v1/notifications/${row.id}`, { token: f.config.agentToken })).value;
  assert.deepEqual(status, { id: row.id, status: 'queued', recipientCount: 2, receivedCount: 1, displayedCount: 0 });
  await f.call(`/v1/notifications/${row.id}/ack`, { token: b.token, body: { displayed: true } });
  status = (await f.call(`/v1/notifications/${row.id}`, { token: f.config.agentToken })).value;
  assert.equal(status.status, 'received'); assert.equal(status.receivedCount, 2); assert.equal(status.displayedCount, 1);
  await f.call(`/v1/notifications/${row.id}/ack`, { token: a.token, body: { displayed: true } });
  assert.equal((await f.call(`/v1/notifications/${row.id}`, { token: f.config.agentToken })).value.status, 'displayed');
  // An older received acknowledgement cannot downgrade a displayed one.
  assert.equal((await f.call(`/v1/notifications/${row.id}/ack`, { token: a.token, body: { displayed: false } })).value.status, 'displayed');
  const c = await f.pair('C'); assert.equal((await f.call('/v1/state', { token: c.token })).value.notifications.length, 0);
  assert.equal((await f.call(`/v1/notifications/${row.id}/ack`, { token: c.token, body: { displayed: true } })).status, 404);
});

test('SSE initial refresh and heartbeat, revocation closes streams and rejects removed credentials', async t => {
  const f = await fixture(t); const p = await f.pair();
  const stream = await new Promise((resolve, reject) => {
    const req = http.get(f.endpoint + '/v1/events', { headers: { Authorization: `Bearer ${p.token}` } }, res => resolve(res)); req.on('error', reject);
  });
  let text = ''; stream.on('data', chunk => { text += chunk.toString(); });
  const second = await new Promise((resolve, reject) => { const req = http.get(f.endpoint + '/v1/events', { headers: { Authorization: `Bearer ${p.token}` } }, res => { res.resume(); resolve(res); }); req.on('error', reject); });
  assert.equal((await f.call('/v1/events', { token: p.token })).status, 429);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.match(text, /event: state\ndata: \{"type":"state-changed"\}/); assert.match(text, /: heartbeat/);
  const ended = new Promise(resolve => stream.once('end', resolve));
  const secondEnded = new Promise(resolve => second.once('end', resolve));
  assert.equal((await f.call(`/v1/devices/${p.deviceId}/revoke`, { token: f.config.ownerToken, body: {} })).value.revoked, true);
  await Promise.all([ended, secondEnded]);
  assert.equal((await f.call('/v1/state', { token: p.token })).status, 401);
  await f.restart(); assert.equal((await f.call('/v1/state', { token: p.token })).status, 401);
});

test('expired codes fail after restart without consuming a valid different code', async t => {
  const f = await fixture(t);
  const old = await f.bridge.createPairing(f.endpoint), good = await f.bridge.createPairing(f.endpoint);
  const oldInfo = await readPrivate(old.pairingFile), goodInfo = await readPrivate(good.pairingFile);
  const journal = await readPrivate(path.join(f.runtime, 'state.json'));
  journal.pairings.find(p => p.pairingFile === old.pairingFile).expiresAt = new Date(Date.now() - 1).toISOString();
  await fs.writeFile(path.join(f.runtime, 'state.json'), JSON.stringify(journal), { mode: 0o600 });
  await f.restart();
  assert.equal((await f.call('/v1/pair', { body: { code: oldInfo.code, deviceName: 'Expired' } })).status, 401);
  assert.equal((await f.call('/v1/pair', { body: { code: goodInfo.code, deviceName: 'Current' } })).status, 200);
});

test('agent credential rotation creates a distinct idempotency namespace and cannot inspect prior credentials', async t => {
  const f = await fixture(t); await f.pair();
  const body = { title: 'Explicit', body: 'Synthetic fixture', eventId: crypto.randomUUID() };
  const first = (await f.call('/v1/notifications', { token: f.config.agentToken, body })).value;
  const next = crypto.randomBytes(32).toString('base64url');
  const config = await readPrivate(path.join(f.runtime, 'config.json')); config.agentToken = next;
  await fs.writeFile(path.join(f.runtime, 'config.json'), JSON.stringify(config), { mode: 0o600 }); await f.restart();
  assert.equal((await f.call(`/v1/notifications/${first.id}`, { token: next })).status, 404);
  assert.equal((await f.call('/v1/notifications', { token: f.config.agentToken, body })).status, 401);
  const second = (await f.call('/v1/notifications', { token: next, body })).value;
  assert.notEqual(second.id, first.id);
});

test('state supports more than 64KiB with exact bounded alert quota and acknowledged-only eviction', async t => {
  const f = await fixture(t); const p = await f.pair(); const ids = [];
  const body = { title: 'Quota fixture', body: '界'.repeat(8192), deviceId: p.deviceId };
  for (let count = 0; count < 100; count++) {
    const r = await f.call('/v1/notifications', { token: f.config.agentToken, body });
    if (r.status === 429) break;
    assert.equal(r.status, 200); ids.push(r.value.id);
  }
  assert.ok(ids.length >= 9 && ids.length < 100);
  let state = (await f.call('/v1/state', { token: p.token })).value;
  assert.equal(state.notifications.length, ids.length);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 65536);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(state.notifications)) <= 1024 * 1024);
  assert.equal((await f.call('/v1/notifications', { token: f.config.agentToken, body })).status, 429);
  await f.call(`/v1/notifications/${ids[0]}/ack`, { token: p.token, body: { displayed: false } });
  assert.equal((await f.call('/v1/notifications', { token: f.config.agentToken, body })).status, 200);
  state = (await f.call('/v1/state', { token: p.token })).value;
  assert.equal(state.notifications.some(n => n.id === ids[0]), false);
  for (const id of ids.slice(1)) assert.equal(state.notifications.some(n => n.id === id && n.status === 'queued'), true);
  const ownerState = (await f.call('/v1/state', { token: f.config.ownerToken })).value;
  assert.equal(ownerState.notifications.some(n => 'body' in n), false);
});

test('a paused streamed upload does not block an explicit agent alert and reserves concurrent quota', async t => {
  const f = await fixture(t, { maxFileBytes: 20, quotaBytes: 20 }); const p = await f.pair();
  const req = http.request(f.endpoint + `/v1/outbox?name=paused.txt&deviceId=${p.deviceId}`, { method: 'POST', headers: { Authorization: `Bearer ${f.config.ownerToken}`, 'Content-Type': 'application/octet-stream' } });
  req.on('error', () => {}); req.write('partial');
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    let timeout;
    const alert = await Promise.race([f.call('/v1/notifications', { token: f.config.agentToken, body: { title: 'During upload', body: 'Synthetic concurrent fixture' } }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Alert was blocked by upload.')), 1500); })]).finally(() => clearTimeout(timeout));
    assert.equal(alert.status, 200);
    assert.equal((await f.call(`/v1/outbox?name=concurrent.txt&deviceId=${p.deviceId}`, { token: f.config.ownerToken, bytes: Buffer.from('x') })).status, 413);
  } finally { req.destroy(); }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(await fs.readdir(path.join(f.runtime, 'spool')), []);
});

test('global alert byte quota rejects queued overflow, then prunes acknowledged rows and survives restart', async t => {
  const f = await fixture(t); const phones = [];
  for (let i = 0; i < 6; i++) phones.push(await f.pair(`Quota phone ${i}`));
  const records = []; let globalRejected = false;
  for (const phone of phones) {
    for (let i = 0; i < 100; i++) {
      const r = await f.call('/v1/notifications', { token: f.config.agentToken, body: { title: 'Global quota', body: '界'.repeat(8192), deviceId: phone.deviceId } });
      if (r.status === 429) { if (/Global notification/.test(r.value.error)) globalRejected = true; break; }
      assert.equal(r.status, 200); records.push({ id: r.value.id, phone });
    }
    if (globalRejected) break;
  }
  assert.equal(globalRejected, true);
  const journal = await readPrivate(path.join(f.runtime, 'state.json'));
  assert.ok(Buffer.byteLength(JSON.stringify(journal.notifications)) <= 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(journal)) < 12 * 1024 * 1024);
  const lastPhone = phones.at(-1);
  await f.call(`/v1/notifications/${records[0].id}/ack`, { token: records[0].phone.token, body: { displayed: true } });
  const next = await f.call('/v1/notifications', { token: f.config.agentToken, body: { title: 'After global pruning', body: '界'.repeat(8192), deviceId: lastPhone.deviceId } });
  assert.equal(next.status, 200);
  await f.restart();
  assert.equal((await f.call(`/v1/notifications/${next.value.id}`, { token: f.config.agentToken })).value.status, 'queued');
  assert.equal((await f.call('/v1/state', { token: records[1].phone.token })).value.notifications.some(n => n.id === records[1].id), true);
});

test('central journal byte bound refuses oversized mutations while health and restart remain available', async t => {
  const f = await fixture(t); const phone = await f.pair();
  const journal = await readPrivate(path.join(f.runtime, 'state.json'));
  journal.fixturePadding = 'x'.repeat(12 * 1024 * 1024);
  await fs.writeFile(path.join(f.runtime, 'state.json'), JSON.stringify(journal), { mode: 0o600 });
  await f.restart();
  const response = await f.call('/v1/notifications', { token: f.config.agentToken, body: { title: 'Bounded journal', body: 'Synthetic overflow fixture' } });
  assert.equal(response.status, 429); assert.match(response.value.error, /journal byte quota/);
  assert.equal((await f.call('/v1/health')).status, 200);
  assert.equal((await f.call('/v1/state', { token: phone.token })).status, 200);
  await f.restart(); assert.equal((await f.call('/v1/health')).status, 200);
});

test('startup removes only owned crash remnants, and incoming quota survives restart', async t => {
  const f = await fixture(t, { maxFileBytes: 10, quotaBytes: 10 }); const p = await f.pair();
  assert.equal((await f.call('/v1/inbox?name=first.txt', { token: p.token, bytes: Buffer.from('12345678') })).status, 200);
  const name = `.lexbridge-mobile-${crypto.randomUUID()}.part`;
  await fs.mkdir(path.join(f.desktopDir, name)); await fs.writeFile(path.join(f.desktopDir, name, 'partial'), 'x');
  await fs.writeFile(path.join(f.runtime, 'spool', `${crypto.randomUUID()}.part`), 'partial');
  await fs.mkdir(path.join(f.desktopDir, 'user-folder.part'));
  await f.restart();
  assert.equal((await f.call('/v1/inbox?name=second.txt', { token: p.token, bytes: Buffer.from('123') })).status, 413);
  assert.equal((await fs.readdir(f.desktopDir)).includes(name), false);
  assert.equal((await fs.readdir(f.desktopDir)).includes('user-folder.part'), true);
  assert.deepEqual(await fs.readdir(path.join(f.runtime, 'spool')), []);
});

test('CLI init/pair output contains only paths and creates private instructions without a running server', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lexbridge-cli-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'main.cjs'), ...args, '--runtime', path.join(root, 'runtime')]); let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; }); child.on('error', reject); child.on('close', code => code ? reject(new Error(stderr)) : resolve(stdout.trim()));
  });
  const output = await run(['init', '--endpoint', 'http://127.0.0.1:59999']);
  const conf = await readPrivate(path.join(root, 'runtime', 'config.json'));
  assert.equal(output.includes(conf.ownerToken), false); assert.equal(output.includes(conf.agentToken), false);
  const pairingFile = await run(['pair']); assert.equal(path.dirname(pairingFile), path.join(root, 'runtime'));
  assert.equal((await fs.stat(pairingFile)).mode & 0o777, 0o600);
  const pairing = await readPrivate(pairingFile); assert.equal(pairing.code.length, 24); assert.equal(pairing.endpoint, 'http://127.0.0.1:59999');
});
