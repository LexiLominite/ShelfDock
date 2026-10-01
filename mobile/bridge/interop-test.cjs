'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFixture, DOWNLOAD_NAME, DOWNLOAD_TEXT, UPLOAD_NAME, UPLOAD_TEXT, ALERT_TITLE } = require('./interop-fixture.cjs');
const { readPrivate } = require('./server.cjs');

test('isolated interoperability fixture seeds once and verifies actual HTTP acknowledgements plus Desktop receipt', async t => {
  const fixture = await createFixture();
  t.after(async () => { await fixture.close(); await fs.rm(fixture.root, { recursive: true, force: true }); });
  const pairing = await readPrivate(fixture.pairingFile);
  assert.equal(pairing.expectedFileText, DOWNLOAD_TEXT); assert.equal(pairing.expectedAlertTitle, ALERT_TITLE);
  const call = async (route, { body, bytes, token } = {}) => {
    const r = await fetch(fixture.endpoint + route, { method: body !== undefined || bytes !== undefined ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(bytes !== undefined ? { 'Content-Type': 'application/octet-stream' } : {}) }, body: body !== undefined ? JSON.stringify(body) : bytes });
    assert.equal(r.status, 200); return r.headers.get('content-type').startsWith('application/json') ? r.json() : r.text();
  };
  const phone = await call('/v1/pair', { body: { code: pairing.code, deviceName: 'Synthetic HTTP fixture smoke test' } });
  await call('/v1/inbox?name=' + UPLOAD_NAME, { token: phone.token, bytes: Buffer.from(UPLOAD_TEXT) });
  let state;
  for (let i = 0; i < 50; i++) {
    state = await call('/v1/state', { token: phone.token });
    if (state.files.some(f => f.direction === 'to-phone') && state.notifications.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const outbound = state.files.find(f => f.direction === 'to-phone'); assert.equal(outbound.name, DOWNLOAD_NAME);
  const content = await call(`/v1/files/${outbound.id}/content`, { token: phone.token }); assert.equal(content, DOWNLOAD_TEXT);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  await call(`/v1/files/${outbound.id}/ack`, { token: phone.token, body: { sha256 } });
  await call(`/v1/notifications/${state.notifications[0].id}/ack`, { token: phone.token, body: { displayed: false } });
  let result;
  for (let i = 0; i < 30; i++) { result = await readPrivate(fixture.resultFile); if (result.complete) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(result.complete, true); assert.equal(result.checks.notification.status, 'received');
  assert.equal(result.checks.phoneToDesktop.compatibleDesktopReceipt, true);
  assert.equal(result.checks.desktopToPhone.exactHashAcknowledgement, true);
  for (const secret of [pairing.code, phone.token]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('fixture rejects real Desktop and production runtime paths before touching them', async () => {
  await assert.rejects(createFixture({ root: path.join(os.homedir(), 'Desktop') }), /cannot use/);
  await assert.rejects(createFixture({ root: path.join(os.homedir(), '.config', 'lexbridge-mobile', 'fixture') }), /cannot use/);
});
