'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tunnelSiteURL } = require('../desktop/tunnel-site.cjs');

const id = '04bd066c-be64-4d07-acf9-0e4a12e025b1';
const request = { id, scheme: 'http:', path: '/' };
const state = { active: [{ id, mode: 'local', status: 'running', listenPort: 1331 }] };

test('site addresses derive the loopback port from the running backend record', () => {
  assert.equal(tunnelSiteURL(request, state), 'http://127.0.0.1:1331/');
  assert.equal(tunnelSiteURL({ ...request, scheme: 'https:', path: '/hello world?tab=one%20two#details' }, state), 'https://127.0.0.1:1331/hello%20world?tab=one%20two#details');
  assert.equal(tunnelSiteURL({ ...request, path: '/?next=https://example.com/profile' }, state), 'http://127.0.0.1:1331/?next=https://example.com/profile');
  for (const [port, url] of [[80, 'http://127.0.0.1/'], [65535, 'http://127.0.0.1:65535/']]) {
    assert.equal(tunnelSiteURL(request, { active: [{ ...state.active[0], listenPort: port }] }), url);
  }
});

test('renderer requests cannot choose an external address or protocol', () => {
  for (const invalid of [null, [], 'http://example.com', {}, { ...request, id: 'forged-id' }, { ...request, host: 'example.com' }, { ...request, listenPort: 22 }, { ...request, scheme: 'file:' }, { ...request, scheme: 'javascript:' }, { ...request, scheme: 'http' }, { ...request, scheme: {} }]) {
    assert.throws(() => tunnelSiteURL(invalid, state));
  }
  for (const page of ['', undefined, null, 1, {}, ['/', 'x'], 'https://example.com/', '//example.com/', '///user:password@example.com', '\\example.com', '/\\example.com', '/foo\\bar', '/\n//example.com', '/?token=\r\nLocation:https://example.com', '/\x00x', '/\x7fx', '/%0d%0aLocation:https://example.com', '/%00', '/' + 'a'.repeat(4096)]) {
    assert.throws(() => tunnelSiteURL({ ...request, path: page }, state), /page path/);
  }
});

test('only a running local forward can launch its site', () => {
  for (const status of ['starting', 'failed', 'stopped', undefined]) {
    assert.throws(() => tunnelSiteURL(request, { active: [{ ...state.active[0], status }] }), /not running/);
  }
  assert.throws(() => tunnelSiteURL(request, { active: [{ ...state.active[0], mode: 'remote' }] }), /not running/);
  assert.throws(() => tunnelSiteURL(request, { active: [] }), /not running/);
  assert.throws(() => tunnelSiteURL({ ...request, id: '5a75928b-ae27-4b64-ae93-008d98b3d705' }, state), /not running/);
  for (const listenPort of [0, -1, 65536, 1331.5, '1331', NaN, Infinity]) {
    assert.throws(() => tunnelSiteURL(request, { active: [{ ...state.active[0], listenPort }] }), /invalid listening port/);
  }
});

test('website readiness accepts error and redirect HTTP statuses without following redirects or reading bodies', async t => {
  const http = require('node:http'); const { verifyTunnelSite } = require('../desktop/tunnel-site.cjs');
  const seen = [];
  const server = http.createServer((request, response) => { seen.push({ method: request.method, url: request.url }); response.writeHead(Number(request.url.slice(1).split('?')[0]), { Location: 'http://should-never-be-contacted.invalid/' }); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port; const record = { view: { targetHost: 'localhost', targetPort: 8000, hostName: 'Fixture machine' } };
  for (const status of [200, 302, 401, 404, 405, 500]) await verifyTunnelSite(`http://127.0.0.1:${port}/${status}?temporary=1#fragment`, record);
  assert.equal(seen.length, 6); assert.ok(seen.every(request => request.method === 'HEAD')); assert.equal(seen[0].url, '/200?temporary=1');
});

test('website readiness refuses non-loopback probes and reports refused and unresponsive services without URL secrets', async t => {
  const net = require('node:net'); const { verifyTunnelSite } = require('../desktop/tunnel-site.cjs');
  const record = { view: { targetHost: '192.168.1.2', targetPort: 8000, hostName: 'Remote fixture' } };
  await assert.rejects(verifyTunnelSite('http://192.168.1.2:8000/', record), /local forward/);
  const sockets = new Set(); const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  t.after(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(verifyTunnelSite(`http://127.0.0.1:${port}/?private-secret=1`, record, { timeout: 40 }), error => /did not respond.*Remote fixture/.test(error.message) && !error.message.includes('private-secret'));
  for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  await assert.rejects(verifyTunnelSite(`http://127.0.0.1:${port}/?private-secret=1`, record), error => /192\.168\.1\.2:8000.*Remote fixture/.test(error.message) && !error.message.includes('private-secret'));
});
