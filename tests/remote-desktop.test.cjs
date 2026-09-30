'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { RemoteDesktop } = require('../desktop/remote-desktop.cjs');
const host = { id: 'host-1', name: 'Desktop', user: 'user', address: '127.0.0.1', port: 22, os: 'posix' };
const serviceFor = () => ({ getState: async () => ({ hosts: [host] }), remoteDesktopExec: async () => ({ stdout: 'Linux\n' }) });
const provider = { inspect: async () => ({ available: true, facts: { auth: '/private/auth', display: ':0' } }), preview: () => ({ available: true, changes: ['Temporary server'] }), apply: async (_s, _h, p) => ({ owner: p.owner, port: p.port }), stop: async () => {} };

test('actual WebSocket/TCP bridge forwards binary bytes and rejects wrong origin, token and reuse', async t => {
  const sockets = new Set(); let channels = 0;
  const tcp = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.write('RFB 003.008\n'); socket.on('data', bytes => socket.write(bytes)); });
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const rd = new RemoteDesktop({ service: serviceFor(), allowedOrigins: ['null'], connect: async (_s, _h, port) => { channels++; assert.equal(port, 5900); const socket = net.connect(tcp.address().port, '127.0.0.1'); await once(socket, 'connect'); return socket; } });
  t.after(async () => { await rd.shutdown(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => tcp.close(resolve)); });
  const result = await rd.start({ hostId: host.id });
  const rejected = async (origin, token = result.connection.token) => { const ws = new WebSocket(result.connection.url, [token, 'binary'], { origin }); const [error] = await once(ws, 'error'); assert.match(error.message, /403/); };
  await rejected('https://untrusted.example'); await rejected('null', 'wrong-token'); assert.equal(channels, 0);
  const ws = new WebSocket(result.connection.url, [result.connection.token, 'binary'], { origin: 'null' });
  const [hello] = await once(ws, 'message'); assert.equal(hello.toString(), 'RFB 003.008\n');
  const bytes = Buffer.from([0, 1, 255, 128, 10]); const response = once(ws, 'message'); ws.send(bytes); assert.deepEqual((await response)[0], bytes);
  assert.equal(rd.getState().session.status, 'connected'); await rejected('null'); assert.equal(channels, 1);
  const tcpClosed = Promise.all([...sockets].map(socket => once(socket, 'close'))); const closed = once(ws, 'close'); await rd.stop({ id: result.session.id }); await closed; await tcpClosed;
  assert.equal(rd.record, null); assert.equal(rd.getState().session, null); assert.equal(sockets.size, 0);
});

test('setup plans are single-use, expire and bind the saved endpoint; cleanup retries retain ownership', async t => {
  let now = 1000, failCleanup = false;
  const service = serviceFor(); service.remoteDesktopSetup = true;
  const rd = new RemoteDesktop({ service, allowedOrigins: ['null'], providers: { 'linux-x11': { ...provider, stop: async () => { if (failCleanup) throw new Error('offline'); } } }, now: () => now });
  t.after(() => rd.shutdown());
  const preview = await rd.previewSetup({ hostId: host.id }); assert.ok(preview.id); assert.equal(JSON.stringify(preview).includes('/private/auth'), false);
  await rd.apply({ planId: preview.id }); assert.ok(rd.getState().ownedServer);
  await assert.rejects(rd.apply({ planId: preview.id }), /expired/);
  failCleanup = true; await assert.rejects(rd.stop(), /cleanup failed/); assert.ok(rd.getState().ownedServer);
  failCleanup = false; await rd.stop(); assert.equal(rd.owned, null);
  const expired = await rd.previewSetup({ hostId: host.id }); now += 120001; await assert.rejects(rd.apply({ planId: expired.id }), /expired/);
  const changed = await rd.previewSetup({ hostId: host.id }); service.getState = async () => ({ hosts: [{ ...host, address: 'different.example' }] }); await assert.rejects(rd.apply({ planId: changed.id }), /connection changed/);
});

test('disconnect cancels a start waiting for saved-machine lookup', async () => {
  let resolve; const service = serviceFor(); service.getState = () => new Promise(done => { resolve = done; });
  const rd = new RemoteDesktop({ service, allowedOrigins: ['null'] });
  const starting = rd.start({ hostId: host.id }); await rd.stop(); resolve({ hosts: [host] });
  await assert.rejects(starting, /cancelled/); assert.equal(rd.record, null); await rd.shutdown();
});

test('late SSH connection is destroyed after Disconnect', async () => {
  let resolve; const rd = new RemoteDesktop({ service: serviceFor(), allowedOrigins: ['null'], connect: () => new Promise(done => { resolve = done; }) });
  const result = await rd.start({ hostId: host.id });
  const ws = new WebSocket(result.connection.url, [result.connection.token, 'binary'], { origin: 'null' }); await once(ws, 'open');
  while (!resolve) await new Promise(done => setImmediate(done));
  const closed = once(ws, 'close'); await rd.stop(); await closed;
  let destroyed = false; resolve({ destroy: () => { destroyed = true; } }); await new Promise(done => setImmediate(done)); assert.equal(destroyed, true); await rd.shutdown();
});
