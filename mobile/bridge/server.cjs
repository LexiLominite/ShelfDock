'use strict';

// Deliberately dependency-free: this bridge never reads agent sessions or executes commands.
const fs = require('node:fs/promises');
const { constants, createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { encodeManifest, RECEIPT_NAME } = require('../../desktop/received.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_RUNTIME = path.join(os.homedir(), '.config', 'lexbridge-mobile');
const DEFAULT_PORT = 18474;
const LIMIT_JSON = 65536;
const MAX_DEVICES = 32;
const MAX_HISTORY = 500;
const MAX_NOTIFICATIONS = 1000;
const MAX_NOTIFICATION_BYTES = 1024 * 1024;
const MAX_GLOBAL_NOTIFICATION_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 12 * 1024 * 1024;
const MAX_GLOBAL_FILES = 8000;
const now = () => new Date().toISOString();
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const secret = () => crypto.randomBytes(32).toString('base64url');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function privateIP(input) {
  let ip = String(input || '').toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return true;
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  return Number(parts[0]) === 127 || (Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127);
}
function loopbackIP(ip) { return String(ip).toLowerCase() === '::1' || /^127\./.test(String(ip).replace(/^::ffff:/i, '')); }
function validEndpoint(input) {
  let u; try { u = new URL(input); } catch { fail(400, 'Use a private bridge URL.'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(host === 'localhost' || privateIP(host))) fail(400, 'Use a loopback or Tailscale IP bridge URL.');
  return u.origin;
}
function validName(name) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 255 || /[\\/:\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(name) || name === '.' || name === '..' || name !== name.trim() || /[. ]$/.test(name) || name.toLowerCase() === RECEIPT_NAME || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail(400, 'Use a safe file basename.');
  return name;
}
function object(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) fail(400, 'Invalid request fields.');
  return input;
}
function label(value, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) fail(400, 'Invalid text.');
  return value.trim();
}
async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Private runtime must be an ordinary directory.');
  await fs.chmod(dir, 0o700);
}
async function readPrivate(file, max = 64 * 1024 * 1024) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > max || (st.mode & 0o077)) throw new Error('Private file permissions or type invalid.');
    const contents = await handle.readFile('utf8');
    try { return JSON.parse(contents); } catch { throw new Error('Private bridge file is not valid JSON.'); }
  } finally { await handle.close(); }
}
async function atomic(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value));
    await handle.sync(); await handle.close(); handle = null;
    await fs.rename(tmp, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await fs.unlink(tmp).catch(() => {}); }
}
async function init(runtime = DEFAULT_RUNTIME, endpoint = `http://127.0.0.1:${DEFAULT_PORT}`, options = {}) {
  endpoint = validEndpoint(endpoint);
  await privateDir(runtime);
  let config;
  try { config = await readPrivate(path.join(runtime, 'config.json'), LIMIT_JSON); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    config = { version: 1, endpoint, ownerToken: secret(), agentToken: secret(), maxFileBytes: 1024 ** 3, quotaBytes: 2 * 1024 ** 3, ...options };
    // Only init creates secrets; subsequent invocations preserve the active identity.
    await atomic(path.join(runtime, 'config.json'), config);
  }
  if (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1 || !Number.isSafeInteger(config.quotaBytes) || config.quotaBytes < config.maxFileBytes || !config.ownerToken || !config.agentToken) throw new Error('Invalid bridge configuration.');
  await atomic(path.join(runtime, 'agent.json'), { version: 1, endpoint: config.endpoint, token: config.agentToken });
  await privateDir(path.join(runtime, 'spool'));
  return config;
}
async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Use application/json.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > LIMIT_JSON) fail(413, 'Request too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON.'); }
}
function publicFile(file) { const { deviceId, spool, batch, ...row } = file; return row; }
function publicNotification(row, deviceId) { return { id: row.id, title: row.title, body: row.body, source: row.source, severity: row.severity, createdAt: row.createdAt, status: row.recipients[deviceId] }; }
function aggregate(row) {
  const values = Object.values(row.recipients);
  return { id: row.id, status: values.every(v => v === 'displayed') ? 'displayed' : values.every(v => v !== 'queued') ? 'received' : 'queued', recipientCount: values.length, receivedCount: values.filter(v => v !== 'queued').length, displayedCount: values.filter(v => v === 'displayed').length };
}

async function createBridge({ runtime = DEFAULT_RUNTIME, desktopDir = path.join(os.homedir(), 'Desktop'), endpoint, configOptions, heartbeatMs = 20000 } = {}) {
  const config = await init(runtime, endpoint, configOptions);
  const stateFile = path.join(runtime, 'state.json');
  let state;
  try { state = await readPrivate(stateFile, 16 * 1024 * 1024); }
  catch (e) { if (e.code !== 'ENOENT') throw e; state = { version: 1, devices: [], pairings: [], files: [], notifications: [] }; await atomic(stateFile, state); }
  if (state.version !== 1 || !['devices', 'pairings', 'files', 'notifications'].every(k => Array.isArray(state[k]))) throw new Error('Invalid bridge journal.');
  const clients = new Map();
  const uploads = new Map();
  let operations = Promise.resolve();
  const serialize = fn => { const job = operations.catch(() => {}).then(fn); operations = job; return job; };
  const save = async draft => {
    const encoded = JSON.stringify(draft);
    if (Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES) fail(429, 'Bridge journal byte quota exceeded.');
    await atomic(stateFile, encoded); state = draft;
  };
  const clone = () => structuredClone(state);
  // Owned crash remnants are never exposed as completed transfers.
  const spoolDir = path.join(runtime, 'spool');
  for (const name of await fs.readdir(spoolDir)) {
    if (/^[0-9a-f-]{36}\.part$/.test(name) || (/^[0-9a-f-]{36}\.bin$/.test(name) && !state.files.some(f => f.spool === name && f.status === 'queued'))) await fs.unlink(path.join(spoolDir, name));
  }
  // Inbox staging directories are created only in the selected Desktop. Never follow links.
  try {
    for (const name of await fs.readdir(desktopDir)) if (/^\.lexbridge-mobile-[0-9a-f-]{36}\.part$/.test(name)) {
      const dir = path.join(desktopDir, name), st = await fs.lstat(dir);
      if (st.isDirectory() && !st.isSymbolicLink()) await fs.rm(dir, { recursive: true });
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  function push(client, message) {
    if (client.res.destroyed || client.res.writableLength > 65536) { client.res.destroy(); return; }
    // Do not build a queue while a phone is not reading. Its next connection refreshes state.
    if (!client.res.write(message)) client.res.destroy();
  }
  function changed(ids) { for (const [id, entries] of clients) if (!ids || ids.includes(id)) for (const client of entries) push(client, 'event: state\ndata: {"type":"state-changed"}\n\n'); }
  const heartbeat = setInterval(() => { for (const entries of clients.values()) for (const client of entries) push(client, ': heartbeat\n\n'); }, heartbeatMs);
  heartbeat.unref();
  function auth(req, scopes) {
    const h = req.headers.authorization;
    if (typeof h !== 'string' || !/^Bearer [A-Za-z0-9_-]+$/.test(h)) fail(401, 'Authentication required.');
    const token = h.slice(7);
    let who;
    if (same(token, config.ownerToken)) {
      if (!loopbackIP(req.socket.remoteAddress)) fail(403, 'Owner controls require loopback.');
      who = { scope: 'owner', key: crypto.createHash('sha256').update(token).digest('hex') };
    } else if (same(token, config.agentToken)) who = { scope: 'agent', key: crypto.createHash('sha256').update(token).digest('hex') };
    else { const device = state.devices.find(d => same(d.token, token)); if (device) who = { scope: 'device', device, key: device.id }; }
    if (!who) fail(401, 'Authentication required.');
    if (!scopes.includes(who.scope)) fail(403, 'Credential scope does not allow this operation.');
    return who;
  }
  function snapshot(who) {
    const id = who.device?.id;
    const result = { protocolVersion: 1, serverName: 'LexBridge', ...(id ? { deviceId: id } : {}), files: state.files.filter(f => !id || f.deviceId === id).map(publicFile), notifications: state.notifications.filter(n => id ? n.recipients[id] : true).map(n => id ? publicNotification(n, id) : { id: n.id, title: n.title, source: n.source, severity: n.severity, createdAt: n.createdAt, ...aggregate(n) }), connection: id ? (clients.get(id)?.size ? 'connected' : 'disconnected') : 'listening', ...(id ? {} : { devices: state.devices.map(d => ({ id: d.id, name: d.name, lastSeenAt: d.lastSeenAt })) }) };
    if (Buffer.byteLength(JSON.stringify(result)) > (id ? 2 : 8) * 1024 * 1024) fail(413, 'State exceeds response limit.');
    return result;
  }
  async function createPairing(endpointValue) {
    const url = validEndpoint(endpointValue || config.endpoint);
    return serialize(async () => {
      const code = crypto.randomBytes(18).toString('base64url'); const expiresAt = new Date(Date.now() + 600000).toISOString();
      const pairingFile = path.join(runtime, `pairing-${crypto.randomUUID()}.json`);
      await atomic(pairingFile, { version: 1, endpoint: url, code, expiresAt });
      const draft = clone(); draft.pairings = draft.pairings.filter(p => Date.parse(p.expiresAt) > Date.now()).slice(-31);
      draft.pairings.push({ hash: crypto.createHash('sha256').update(code).digest('hex'), expiresAt, pairingFile });
      await save(draft); return { pairingFile, expiresAt };
    });
  }
  async function revoke(id) {
    return serialize(async () => {
      const draft = clone(); const target = draft.devices.find(d => d.id === id);
      if (!target) fail(404, 'Device not found.');
      draft.devices = draft.devices.filter(d => d.id !== id);
      const spool = draft.files.filter(f => f.deviceId === id && f.spool).map(f => f.spool);
      draft.files = draft.files.filter(f => f.deviceId !== id);
      for (const n of draft.notifications) delete n.recipients[id];
      draft.notifications = draft.notifications.filter(n => Object.keys(n.recipients).length);
      await save(draft);
      for (const c of clients.get(id) || []) c.res.end();
      clients.delete(id);
      for (const u of uploads.values()) if (u.deviceId === id) u.req.destroy();
      for (const name of spool) await fs.unlink(path.join(spoolDir, name)).catch(() => {});
      return { revoked: true };
    });
  }
  async function upload(req, direction, device, name) {
    name = validName(name);
    if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') fail(415, 'Use application/octet-stream.');
    const expected = req.headers['x-content-sha256'];
    if (expected !== undefined && !HASH.test(expected)) fail(400, 'Invalid content hash.');
    const declared = req.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > config.maxFileBytes)) fail(413, 'File exceeds bridge limit.');
    if (uploads.size >= 2) fail(429, 'Two transfers are already active.');
      if (!state.devices.some(d => d.id === device.id)) fail(401, 'Device was revoked.');
      const queued = state.files.filter(f => f.deviceId === device.id && f.status === 'queued').reduce((n, f) => n + f.size, 0);
      const today = now().slice(0, 10);
      const persistedDevice = state.devices.find(d => d.id === device.id);
      const incomingUsed = persistedDevice.incomingDay === today ? persistedDevice.incomingBytes || 0 : 0;
      const id = crypto.randomUUID(); let size = 0; const hash = crypto.createHash('sha256'); let staging, finalBatch, handle, tmp, finalSpool, committed = false;
      const reservedByOthers = [...uploads.values()].filter(u => u.deviceId === device.id && u.direction === direction).reduce((n, u) => n + u.reserved, 0);
      const available = Math.max(0, config.quotaBytes - (direction === 'to-phone' ? queued : incomingUsed) - reservedByOthers);
      const reserved = declared === undefined ? Math.min(config.maxFileBytes, available) : Number(declared);
      if (reserved > available) fail(413, 'File or device quota exceeded.');
      uploads.set(id, { deviceId: device.id, direction, reserved, req });
      try {
        if (direction === 'from-phone') {
          const root = await fs.realpath(desktopDir); const stat = await fs.lstat(root); if (!stat.isDirectory()) fail(503, 'Desktop unavailable.');
          staging = path.join(root, `.lexbridge-mobile-${id}.part`); await fs.mkdir(staging, { mode: 0o700 });
          finalBatch = path.join(root, `Drift-${now().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`);
          tmp = path.join(staging, name);
        } else { tmp = path.join(spoolDir, `${id}.part`); finalSpool = `${id}.bin`; }
        handle = await fs.open(tmp, 'wx', 0o600);
        for await (const chunk of req) {
          size += chunk.length;
          if (size > config.maxFileBytes || size > reserved) fail(413, 'File or device quota exceeded.');
          hash.update(chunk); await handle.writeFile(chunk);
        }
        if (req.aborted || !req.complete) fail(400, 'Upload incomplete.');
        const sha256 = hash.digest('hex'); if (expected !== undefined && !same(expected, sha256)) fail(422, 'Content hash mismatch.');
        await handle.sync(); await handle.close(); handle = null;
        const row = { id, deviceId: device.id, name, size, sha256, direction, createdAt: now(), status: direction === 'to-phone' ? 'queued' : 'received' };
        return await serialize(async () => {
        const draft = clone(); const currentDevice = draft.devices.find(d => d.id === device.id);
        if (!currentDevice) fail(401, 'Device was revoked.');
        const commitDay = now().slice(0, 10), currentIncoming = currentDevice.incomingDay === commitDay ? currentDevice.incomingBytes || 0 : 0;
        const currentQueued = draft.files.filter(f => f.deviceId === device.id && f.status === 'queued').reduce((n, f) => n + f.size, 0);
        if ((direction === 'to-phone' ? currentQueued : currentIncoming) + size > config.quotaBytes) fail(413, 'File or device quota exceeded.');
        const prune = (rows, maximum) => {
          const removable = rows.filter(f => f.status !== 'queued').slice(0, Math.max(0, rows.length + 1 - maximum)).map(f => f.id);
          draft.files = draft.files.filter(f => !removable.includes(f.id));
          if (rows.length - removable.length + 1 > maximum) fail(409, 'Acknowledge queued files before sending more.');
        };
        prune(draft.files.filter(f => f.deviceId === device.id), MAX_HISTORY); prune(draft.files, MAX_GLOBAL_FILES);
        if (staging) {
          const receipt = encodeManifest({ version: 1, id, senderLabel: device.name, sentAt: row.createdAt, items: [{ name, kind: 'file', size }] });
          await atomic(path.join(staging, RECEIPT_NAME), receipt);
          await fs.rename(staging, finalBatch); staging = null; row.batch = path.basename(finalBatch);
          const dh = await fs.open(path.dirname(finalBatch), 'r'); try { await dh.sync(); } finally { await dh.close(); }
        } else {
          await fs.rename(tmp, path.join(spoolDir, finalSpool)); row.spool = finalSpool;
          const sh = await fs.open(spoolDir, 'r'); try { await sh.sync(); } finally { await sh.close(); }
        }
        draft.files.push(row);
        if (direction === 'from-phone') { currentDevice.incomingDay = commitDay; currentDevice.incomingBytes = currentIncoming + size; }
        await save(draft); committed = true; changed([device.id]); return { file: publicFile(row) };
        });
      } finally {
        uploads.delete(id);
        await handle?.close();
        if (staging) await fs.rm(staging, { recursive: true, force: true });
        if (direction === 'to-phone' && !committed) { await fs.unlink(tmp || '').catch(() => {}); if (finalSpool) await fs.unlink(path.join(spoolDir, finalSpool)).catch(() => {}); }
      }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const respond = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (!privateIP(req.socket.remoteAddress)) fail(403, 'Private network required.');
      // Native clients do not send Origin. No browser endpoint, CORS, or cookie credentials.
      if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Browser origins are not allowed.');
      const host = req.headers.host; let u;
      try { u = new URL(req.url, `http://${host}`); } catch { fail(400, 'Invalid request URL.'); }
      const hostname = u.hostname.replace(/^\[|\]$/g, '');
      if (typeof host !== 'string' || /[\s/@?#]/.test(host) || u.username || u.password || !(hostname === 'localhost' || privateIP(hostname)) || req.url[0] !== '/' || req.url.startsWith('//')) fail(403, 'Private host required.');
      const route = u.pathname;
      if (route !== '/v1/inbox' && route !== '/v1/outbox' && u.search) fail(400, 'Query parameters are not allowed.');
      if (req.method === 'GET' && route === '/v1/health') return respond({ protocolVersion: 1, serverName: 'LexBridge', maxFileBytes: config.maxFileBytes });
      if (req.method === 'POST' && route === '/v1/pair') {
        const b = object(await jsonBody(req), ['code', 'deviceName']); const name = label(b.deviceName, 64);
        if (/[\x00-\x1f\x7f]/.test(name)) fail(400, 'Invalid device name.');
        if (typeof b.code !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(b.code)) fail(400, 'Invalid pairing code.');
        const result = await serialize(async () => {
          const hash = crypto.createHash('sha256').update(b.code).digest('hex'); const pairing = state.pairings.find(p => same(p.hash, hash) && Date.parse(p.expiresAt) > Date.now());
          if (!pairing) fail(401, 'Pairing code expired or already used.');
          if (state.devices.length >= MAX_DEVICES) fail(409, 'Device limit reached.');
          const draft = clone(), device = { id: crypto.randomUUID(), token: secret(), name, lastSeenAt: now() };
          draft.pairings = draft.pairings.filter(p => p.hash !== hash); draft.devices.push(device); await save(draft);
          await fs.unlink(pairing.pairingFile).catch(() => {});
          return { deviceId: device.id, token: device.token, serverName: 'LexBridge', protocolVersion: 1, maxFileBytes: config.maxFileBytes };
        }); return respond(result);
      }
      if (req.method === 'POST' && route === '/v1/pairings') { auth(req, ['owner']); const b = object(await jsonBody(req), ['endpoint']); return respond(await createPairing(b.endpoint)); }
      let match;
      if (req.method === 'POST' && (match = route.match(/^\/v1\/devices\/([^/]+)\/revoke$/))) { auth(req, ['owner']); object(await jsonBody(req), []); if (!UUID.test(match[1])) fail(400, 'Invalid device ID.'); return respond(await revoke(match[1])); }
      if (req.method === 'GET' && route === '/v1/state') return respond(snapshot(auth(req, ['owner', 'device'])));
      if (req.method === 'GET' && route === '/v1/events') {
        const who = auth(req, ['device']); const id = who.device.id;
        await serialize(async () => { const draft = clone(); const d = draft.devices.find(d => d.id === id); if (!d) fail(401, 'Device was revoked.'); if (Date.now() - Date.parse(d.lastSeenAt) > 60000) { d.lastSeenAt = now(); await save(draft); } });
        if ((clients.get(id)?.size || 0) >= 2) fail(429, 'Too many event connections.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const client = { res }; if (!clients.has(id)) clients.set(id, new Set()); clients.get(id).add(client);
        res.on('close', () => { clients.get(id)?.delete(client); if (!clients.get(id)?.size) clients.delete(id); });
        push(client, 'event: state\ndata: {"type":"state-changed"}\n\n'); return;
      }
      if (req.method === 'POST' && ['/v1/inbox', '/v1/outbox'].includes(route)) {
        const who = auth(req, route === '/v1/inbox' ? ['device'] : ['owner']);
        const device = who.device || state.devices.find(d => d.id === u.searchParams.get('deviceId'));
        if (!device) fail(404, 'Device not found.');
        if ([...u.searchParams.keys()].some(k => !['name', ...(who.device ? [] : ['deviceId'])].includes(k)) || u.searchParams.getAll('name').length !== 1 || (!who.device && u.searchParams.getAll('deviceId').length !== 1)) fail(400, 'Invalid upload query.');
        return respond(await upload(req, who.device ? 'from-phone' : 'to-phone', device, u.searchParams.get('name')));
      }
      if ((match = route.match(/^\/v1\/files\/([^/]+)\/(content|ack)$/))) {
        const who = auth(req, ['device']); const row = state.files.find(f => f.id === match[1] && f.deviceId === who.device.id && f.direction === 'to-phone');
        if (!row) fail(404, 'File not found.');
        if (req.method === 'GET' && match[2] === 'content') {
          if (!row.spool) fail(410, 'File has already been acknowledged.');
          if (row.spool !== `${row.id}.bin` || !UUID.test(row.id)) fail(503, 'File unavailable.');
          const handle = await fs.open(path.join(spoolDir, row.spool), constants.O_RDONLY | constants.O_NOFOLLOW); const stat = await handle.stat();
          if (!stat.isFile() || stat.size !== row.size) { await handle.close(); fail(503, 'File unavailable.'); }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': row.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`, 'X-Content-SHA256': row.sha256 });
          try { await pipeline(handle.createReadStream(), res); } finally { await handle.close().catch(() => {}); } return;
        }
        if (req.method === 'POST' && match[2] === 'ack') {
          const b = object(await jsonBody(req), ['sha256']); if (!same(b.sha256, row.sha256)) fail(422, 'Content hash mismatch.');
          await serialize(async () => { const draft = clone(); const f = draft.files.find(f => f.id === row.id && f.deviceId === who.device.id); if (!f) fail(404, 'File not found.'); f.status = 'received'; delete f.spool; await save(draft); if (row.spool) await fs.unlink(path.join(spoolDir, row.spool)).catch(() => {}); changed([who.device.id]); });
          return respond({ status: 'received' });
        }
      }
      if (req.method === 'POST' && route === '/v1/notifications') {
        const who = auth(req, ['agent', 'owner']); const b = object(await jsonBody(req), ['title', 'body', 'source', 'severity', 'deviceId', 'eventId']);
        const title = label(b.title, 120), body = label(b.body, 8192), source = label(b.source, 64, 'agent'), severity = b.severity === undefined ? 'info' : b.severity;
        if (!['info', 'success', 'warning', 'error'].includes(severity) || (b.deviceId !== undefined && !UUID.test(b.deviceId)) || (b.eventId !== undefined && !UUID.test(b.eventId))) fail(400, 'Invalid notification.');
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ title, body, source, severity, deviceId: b.deviceId || null })).digest('hex');
        const result = await serialize(async () => {
          const existing = b.eventId && state.notifications.find(n => n.eventId === b.eventId && n.credential === who.key);
          if (existing) { if (existing.fingerprint !== fingerprint) fail(409, 'Event ID already used for different content.'); return { id: existing.id, status: aggregate(existing).status, recipientCount: Object.keys(existing.recipients).length }; }
          const devices = state.devices.filter(d => !b.deviceId || d.id === b.deviceId);
          if (!devices.length) fail(409, 'Pair a phone first.');
          const draft = clone();
          // Never evict undelivered alerts to accommodate a new one.
          if (draft.notifications.length >= MAX_NOTIFICATIONS) {
            const index = draft.notifications.findIndex(n => Object.values(n.recipients).every(s => s !== 'queued'));
            if (index < 0) fail(429, 'Notification queue is full.'); draft.notifications.splice(index, 1);
          }
          if (devices.some(d => draft.notifications.filter(n => n.recipients[d.id]).length >= MAX_HISTORY)) {
            for (const d of devices) {
              const own = draft.notifications.filter(n => n.recipients[d.id]);
              if (own.length >= MAX_HISTORY) { const old = own.find(n => n.recipients[d.id] !== 'queued'); if (!old) fail(429, 'Phone notification queue is full.'); delete old.recipients[d.id]; }
            }
            draft.notifications = draft.notifications.filter(n => Object.keys(n.recipients).length);
          }
          const row = { id: crypto.randomUUID(), title, body, source, severity, createdAt: now(), credential: who.key, ...(b.eventId ? { eventId: b.eventId } : {}), fingerprint, recipients: Object.fromEntries(devices.map(d => [d.id, 'queued'])) };
          for (const device of devices) {
            const bytesFor = n => Buffer.byteLength(JSON.stringify({ ...publicNotification(n, device.id), status: 'displayed' })) + 1;
            const own = draft.notifications.filter(n => n.recipients[device.id]);
            let bytes = 2 + own.reduce((total, n) => total + bytesFor(n), 0) + bytesFor(row);
            for (const old of own) {
              if (bytes <= MAX_NOTIFICATION_BYTES) break;
              if (old.recipients[device.id] !== 'queued') { bytes -= bytesFor(old); delete old.recipients[device.id]; }
            }
            if (bytes > MAX_NOTIFICATION_BYTES) fail(429, 'Phone notification byte quota exceeded.');
          }
          draft.notifications = draft.notifications.filter(n => Object.keys(n.recipients).length);
          draft.notifications.push(row);
          const globalBytesFor = n => Buffer.byteLength(JSON.stringify({ ...n, recipients: Object.fromEntries(Object.keys(n.recipients).map(id => [id, 'displayed'])) })) + 1;
          let globalBytes = 2 + draft.notifications.reduce((total, n) => total + globalBytesFor(n), 0);
          const remove = new Set();
          for (const old of draft.notifications) {
            if (globalBytes <= MAX_GLOBAL_NOTIFICATION_BYTES) break;
            if (Object.values(old.recipients).every(s => s !== 'queued')) { globalBytes -= globalBytesFor(old); remove.add(old.id); }
          }
          if (globalBytes > MAX_GLOBAL_NOTIFICATION_BYTES) fail(429, 'Global notification byte quota exceeded.');
          draft.notifications = draft.notifications.filter(n => !remove.has(n.id));
          await save(draft); changed(devices.map(d => d.id)); return { id: row.id, status: 'queued', recipientCount: devices.length };
        }); return respond(result);
      }
      if ((match = route.match(/^\/v1\/notifications\/([^/]+)(\/ack)?$/))) {
        const who = auth(req, match[2] ? ['device'] : ['agent', 'owner']);
        const row = state.notifications.find(n => n.id === match[1] && (who.scope === 'device' ? n.recipients[who.device.id] : who.scope === 'owner' || n.credential === who.key));
        if (!row) fail(404, 'Notification not found.');
        if (req.method === 'GET' && !match[2]) return respond(aggregate(row));
        if (req.method === 'POST' && match[2]) {
          const b = object(await jsonBody(req), ['displayed']); if (typeof b.displayed !== 'boolean') fail(400, 'Invalid acknowledgement.');
          const result = await serialize(async () => { const draft = clone(); const n = draft.notifications.find(n => n.id === row.id && n.recipients[who.device.id]); if (!n) fail(404, 'Notification not found.'); const current = n.recipients[who.device.id]; n.recipients[who.device.id] = current === 'displayed' || b.displayed ? 'displayed' : 'received'; await save(draft); changed([who.device.id]); return { status: n.recipients[who.device.id] }; }); return respond(result);
        }
      }
      fail(404, 'Route not found.');
    } catch (e) {
      if (res.headersSent) res.destroy(); else respond({ error: e.status ? e.message : 'Bridge operation failed.' }, e.status || 500);
      // Drain rejected requests without retaining their bytes or echoing credentials.
      if (!req.complete) req.resume();
    }
  });
  server.requestTimeout = 10 * 60 * 1000; server.headersTimeout = 15000; server.maxHeadersCount = 32; server.maxConnections = 128;
  server.on('clientError', (_, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return { server, config, createPairing, revoke, async close() {
    clearInterval(heartbeat); for (const entries of clients.values()) for (const c of entries) c.res.end();
    const closed = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    server.closeAllConnections();
    while (uploads.size) await new Promise(resolve => setTimeout(resolve, 5));
    await operations.catch(() => {}); await closed;
  }, listen(port = DEFAULT_PORT, host = '0.0.0.0') { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); }); }); } };
}

module.exports = { createBridge, init, readPrivate, validEndpoint, validName, privateIP, DEFAULT_RUNTIME, DEFAULT_PORT };
