#!/usr/bin/env node
'use strict';

// Explicit, synthetic native interoperability fixture. Never uses the production runtime.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createBridge, readPrivate, DEFAULT_RUNTIME } = require('./server.cjs');
const { validateManifest, RECEIPT_NAME } = require('../../desktop/received.cjs');
const PORT = 18475;
const DOWNLOAD_NAME = 'desktop-to-phone.txt';
const DOWNLOAD_TEXT = 'LexBridge native interoperability download\n';
const UPLOAD_NAME = 'phone-to-desktop.txt';
const UPLOAD_TEXT = 'LexBridge native interoperability upload\n';
const ALERT_TITLE = 'Native interoperability check';
const hash = input => crypto.createHash('sha256').update(input).digest('hex');

async function atomicResult(file, result) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const h = await fs.open(temp, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(result, null, 2)); await h.sync(); } finally { await h.close(); }
  await fs.rename(temp, file);
}
async function createFixture({ root } = {}) {
  if (root) {
    root = path.resolve(root);
    for (const forbidden of [path.join(os.homedir(), 'Desktop'), DEFAULT_RUNTIME]) {
      const relative = path.relative(forbidden, root);
      if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Fixture cannot use the real Desktop or production runtime.');
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(root);
    if (!st.isDirectory() || st.isSymbolicLink() || (await fs.readdir(root)).length) throw new Error('Fixture root must be an empty ordinary directory.');
    await fs.chmod(root, 0o700);
  } else root = await fs.mkdtemp(path.join(os.tmpdir(), 'lexbridge-native-interop-'));
  const runtime = path.join(root, 'runtime'), desktopDir = path.join(root, 'Desktop');
  await fs.mkdir(desktopDir, { mode: 0o700 });
  const endpoint = `http://127.0.0.1:${PORT}`, resultFile = path.join(root, 'verification.json');
  const bridge = await createBridge({ runtime, desktopDir, endpoint });
  let timer, paired = false, seeding, outbox, notification, checking = false, shuttingDown = false;
  const base = { fixture: 'LexBridge native Android and Node interoperability', protocolVersion: 1, endpoint, complete: false };
  await atomicResult(resultFile, base);
  async function call(route, token, body, bytes) {
    const response = await fetch(endpoint + route, { method: body !== undefined || bytes !== undefined ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(bytes !== undefined ? { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': hash(bytes) } : {}) }, body: body !== undefined ? JSON.stringify(body) : bytes });
    const text = await response.text();
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Fixture response too large.');
    const value = JSON.parse(text);
    if (!response.ok) throw new Error(value.error || 'Fixture request failed.');
    return value;
  }
  async function seed() {
    const state = await call('/v1/state', bridge.config.ownerToken);
    if (state.devices.length !== 1) throw new Error('Fixture expects exactly one paired phone.');
    const deviceId = state.devices[0].id;
    outbox = (await call(`/v1/outbox?name=${DOWNLOAD_NAME}&deviceId=${deviceId}`, bridge.config.ownerToken, undefined, Buffer.from(DOWNLOAD_TEXT))).file;
    notification = await call('/v1/notifications', bridge.config.agentToken, { title: ALERT_TITLE, body: 'Synthetic native Android and Node fixture.', source: 'agent', severity: 'success', deviceId, eventId: crypto.randomUUID() });
    await atomicResult(resultFile, { ...base, deviceId, seeded: true, outboundFileId: outbox.id, notificationId: notification.id });
  }
  bridge.server.on('request', (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/pair') res.once('finish', () => {
      if (paired || res.statusCode !== 200) return;
      paired = true; seeding = seed().catch(async () => { await atomicResult(resultFile, { ...base, failed: true, error: 'Synthetic fixture seeding failed.' }); });
    });
  });
  async function check() {
    if (checking || !outbox || !notification || shuttingDown) return;
    checking = true;
    try {
      const state = await call('/v1/state', bridge.config.ownerToken);
      const outbound = state.files.find(f => f.id === outbox.id);
      const uploaded = state.files.find(f => f.direction === 'from-phone' && f.name === UPLOAD_NAME && f.sha256 === hash(UPLOAD_TEXT) && f.size === Buffer.byteLength(UPLOAD_TEXT));
      const alert = await call(`/v1/notifications/${notification.id}`, bridge.config.agentToken);
      if (!uploaded || outbound?.status !== 'received' || alert.receivedCount !== 1 || alert.recipientCount !== 1) return;
      let verifiedReceipt;
      for (const name of await fs.readdir(desktopDir)) {
        if (!/^Drift-\d{4}-.*-[a-f0-9]{8}$/.test(name)) continue;
        const folder = path.join(desktopDir, name), st = await fs.lstat(folder);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        const receiptPath = path.join(folder, RECEIPT_NAME), receiptHandle = await fs.open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let manifest;
        try { if ((await receiptHandle.stat()).size > 128 * 1024) throw new Error('Fixture receipt oversized.'); manifest = validateManifest(JSON.parse(await receiptHandle.readFile('utf8'))); } finally { await receiptHandle.close(); }
        if (manifest.id !== uploaded.id) continue;
        if (manifest.items.length !== 1 || manifest.items[0].name !== UPLOAD_NAME || manifest.items[0].kind !== 'file' || manifest.items[0].size !== Buffer.byteLength(UPLOAD_TEXT)) throw new Error('Fixture receipt mismatch.');
        const h = await fs.open(path.join(folder, UPLOAD_NAME), constants.O_RDONLY | constants.O_NOFOLLOW);
        let content;
        try { const stat = await h.stat(); if (!stat.isFile() || stat.size !== Buffer.byteLength(UPLOAD_TEXT)) throw new Error('Fixture upload size mismatch.'); content = await h.readFile(); } finally { await h.close(); }
        if (!content.equals(Buffer.from(UPLOAD_TEXT)) || hash(content) !== uploaded.sha256) throw new Error('Fixture upload hash mismatch.');
        verifiedReceipt = { id: manifest.id, batchName: name, compatibleDesktopReceipt: true, sha256: uploaded.sha256 }; break;
      }
      if (!verifiedReceipt) return;
      clearInterval(timer);
      await atomicResult(resultFile, { ...base, complete: true, completedAt: new Date().toISOString(), deviceId: state.devices[0].id, checks: { desktopToPhone: { id: outbound.id, name: outbound.name, size: outbound.size, sha256: outbound.sha256, status: outbound.status, exactHashAcknowledgement: true }, phoneToDesktop: { id: uploaded.id, name: uploaded.name, size: uploaded.size, status: uploaded.status, ...verifiedReceipt }, notification: { title: ALERT_TITLE, ...alert } } });
    } catch {
      if (!shuttingDown) await atomicResult(resultFile, { ...base, failed: true, error: 'Synthetic fixture verification failed.' });
    } finally { checking = false; }
  }
  try { await bridge.listen(PORT, '127.0.0.1'); }
  catch (e) { await bridge.close(); throw e; }
  const pairing = await bridge.createPairing(endpoint);
  const instructions = await readPrivate(pairing.pairingFile);
  await atomicResult(pairing.pairingFile, { ...instructions, expectedFileText: DOWNLOAD_TEXT, expectedAlertTitle: ALERT_TITLE });
  timer = setInterval(() => { void check(); }, 500);
  return { endpoint, root, pairingFile: pairing.pairingFile, resultFile, async close() { shuttingDown = true; clearInterval(timer); await seeding; await bridge.close(); } };
}
async function main(argv = process.argv.slice(2)) {
  let root, status = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = argv[++i];
    else if (argv[i] === '--status') status = true;
    else throw new Error('Usage: interop-fixture.cjs [--root emptyDIR] [--status --root DIR]');
  }
  if (status) { if (!root) throw new Error('Status requires --root.'); console.log(JSON.stringify(await readPrivate(path.join(path.resolve(root), 'verification.json')), null, 2)); return; }
  const fixture = await createFixture({ root });
  console.log(JSON.stringify({ endpoint: fixture.endpoint, pairingFile: fixture.pairingFile, resultFile: fixture.resultFile, root: fixture.root }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await fixture.close(); };
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { createFixture, DOWNLOAD_NAME, DOWNLOAD_TEXT, UPLOAD_NAME, UPLOAD_TEXT, ALERT_TITLE };
