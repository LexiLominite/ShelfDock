'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { endpointKey } = require('./password-auth.cjs');
const { portNumber, openDesktopChannel } = require('./remote-desktop-ssh.cjs');
const { providers: defaultProviders, providerFor } = require('./remote-desktop-providers.cjs');
const MAX_BUFFER = 4 * 1024 * 1024;
class RemoteDesktop {
  constructor({ service, onChange = () => {}, allowedOrigins = [], providers = defaultProviders, connect = openDesktopChannel, WebSocketServer, createWebSocketStream, now = Date.now, startupTimeout = 20000 } = {}) {
    if (!service || !allowedOrigins.length) throw new Error('Remote Desktop requires the saved-machine service and explicit trusted renderer origins.');
    this.service = service; this.onChange = onChange; this.allowedOrigins = new Set(allowedOrigins); this.providers = providers; this.connect = connect; this.now = now; this.startupTimeout = startupTimeout;
    const ws = WebSocketServer && createWebSocketStream ? { WebSocketServer, createWebSocketStream } : require('ws'); this.WebSocketServer = ws.WebSocketServer; this.createWebSocketStream = ws.createWebSocketStream;
    this.plans = new Map(); this.record = null; this.owned = null; this.closed = false; this.mutating = false; this.generation = 0;
  }
  getState() { return { session: this.record ? { ...this.record.view } : null, ...(this.owned ? { ownedServer: { hostId: this.owned.host.id, provider: this.owned.provider, port: this.owned.port } } : {}) }; }
  emit() { try { this.onChange(this.getState()); } catch {} }
  async host(hostId) { if (this.closed) throw new Error('Remote Desktop is shutting down.'); const state = await this.service.getState(); const host = state.hosts.find(item => item.id === hostId); if (!host?.user) throw new Error('Choose a saved machine with SSH access.'); return { ...host }; }
  assertIdle() { if (this.closed || this.mutating || this.record || this.service.authenticationSetup || this.service.configurationImport || this.service.configurationSaving || this.service.macInstallation || this.service.remoteInstallation || this.service.transferring) throw new Error('Finish active desktop or machine setup first.'); }
  async inspect({ hostId, port = 5900 } = {}) { port = portNumber(port); const host = await this.host(hostId); const provider = await providerFor(host, this.service); const info = await this.providers[provider].inspect(this.service, host, port); const { facts, ...publicInfo } = info; return { ...publicInfo, hostId, port }; }
  async previewSetup({ hostId, port = 5900, provider: requested } = {}) {
    this.assertIdle(); const generation = this.generation; port = portNumber(port); const host = await this.host(hostId); this.assertIdle(); const provider = await providerFor(host, this.service); if (requested && requested !== provider) throw new Error('Choose the provider for this saved machine.');
    const info = await this.providers[provider].inspect(this.service, host, port); const preview = this.providers[provider].preview(info); if (generation !== this.generation || this.closed) throw new Error('Desktop setup was cancelled.');
    if (!preview.available) return { hostId, provider, port, ...preview };
    this.plans.clear(); const id = crypto.randomUUID(); const expiresAt = this.now() + 120000; this.plans.set(id, { id, hostId, endpoint: endpointKey(host), provider, port, info, owner: crypto.randomUUID(), expiresAt });
    return { id, hostId, provider, port, ...preview, expiresAt: new Date(expiresAt).toISOString() };
  }
  async apply({ planId, credentials } = {}) {
    this.assertIdle(); const generation = this.generation; const plan = this.plans.get(planId); this.plans.delete(planId); if (!plan || plan.expiresAt <= this.now()) throw new Error('This setup review expired or was already used. Review a new plan.');
    const host = await this.host(plan.hostId); this.assertIdle(); if (generation !== this.generation) throw new Error('Desktop setup was cancelled.'); if (endpointKey(host) !== plan.endpoint) throw new Error('This machine’s saved connection changed. Review a new plan.');
    if (this.owned) throw new Error('Disconnect the temporary server before setting up another.'); this.mutating = true; this.applyAbort = new AbortController(); plan.signal = this.applyAbort.signal;
    try { const owned = await this.providers[plan.provider].apply(this.service, host, plan, credentials); this.owned = { ...owned, host, provider: plan.provider, port: plan.port }; if (this.closed || generation !== this.generation) await this.stopOwned(); this.emit(); return this.getState(); }
    finally { credentials = undefined; this.applyAbort = null; this.mutating = false; }
  }
  async start({ hostId, port = 5900 } = {}) {
    this.assertIdle(); const generation = this.generation; port = portNumber(port); const host = await this.host(hostId); this.assertIdle(); if (generation !== this.generation) throw new Error('Desktop connection was cancelled.'); if (this.owned && (this.owned.host.id !== host.id || this.owned.port !== port)) throw new Error('Disconnect the temporary desktop server before choosing another machine or port.'); const token = 'shelfdock-' + crypto.randomBytes(32).toString('hex');
    const record = { host, port, token, abort: new AbortController(), claimed: false, stopped: false, view: { id: crypto.randomUUID(), hostId, hostName: host.name, status: 'waiting' } }; this.record = record; this.emit();
    const server = http.createServer((_request, response) => { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end(); }); record.server = server;
    const wss = new this.WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false, handleProtocols: protocols => protocols.has('binary') ? 'binary' : false }); record.wss = wss;
    server.on('upgrade', (request, socket, head) => {
      const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
      const validToken = protocols.some(value => { const bytes = Buffer.from(value); const expected = Buffer.from(token); return bytes.length === expected.length && crypto.timingSafeEqual(bytes, expected); });
      if (record.stopped || record.claimed || request.url !== '/desktop' || !this.allowedOrigins.has(request.headers.origin) || !validToken || !protocols.includes('binary')) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      record.claimed = true; wss.handleUpgrade(request, socket, head, ws => { record.ws = ws; void this.attach(record, ws); });
    });
    server.on('error', () => void this.fail(record, 'The local desktop viewer could not open.'));
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); if (record.stopped) throw new Error('Desktop connection was cancelled.'); }
    catch { await this.stop({ id: record.view.id }); throw new Error('The desktop viewer could not start.'); }
    record.timer = setTimeout(() => void this.fail(record, 'The desktop viewer did not connect in time.'), this.startupTimeout); record.timer.unref?.();
    return { session: { ...record.view }, connection: { url: `ws://127.0.0.1:${server.address().port}/desktop`, token } };
  }
  async attach(record, ws) {
    ws.on('error', () => void this.fail(record, 'The desktop viewer connection failed.')); ws.once('close', () => { if (!record.stopped) void this.stop({ id: record.view.id }).catch(() => {}); });
    try {
      const stream = this.createWebSocketStream(ws, { encoding: null, highWaterMark: 256 * 1024 }); record.bridge = stream; stream.on('error', () => {}); stream.pause();
      const channel = await this.connect(this.service, record.host, record.port, { signal: record.abort.signal });
      if (record.stopped) { channel.destroy(); return; } record.channel = channel;
      channel.on('error', () => void this.fail(record, 'SSH could not reach the desktop server. Verify SSH trust, authentication and the VNC port.'));
      channel.once('close', () => { if (!record.stopped) void this.stop({ id: record.view.id }).catch(() => {}); });
      channel.pipe(stream); stream.pipe(channel); stream.resume(); clearTimeout(record.timer); record.view.status = 'connected'; this.emit();
      let alive = true; ws.on('pong', () => { alive = true; });
      record.heartbeat = setInterval(() => { if (!alive || ws.bufferedAmount > MAX_BUFFER || stream.writableLength > MAX_BUFFER || channel.writableLength > MAX_BUFFER) { void this.fail(record, 'The desktop connection stopped responding.'); return; } alive = false; ws.ping(); }, 15000); record.heartbeat.unref?.();
    } catch { if (!record.stopped) await this.fail(record, 'SSH could not open this desktop. Verify the saved route, host fingerprint, authentication and VNC port.'); }
  }
  async fail(record, message) { if (record.stopped) return; record.view.status = 'failed'; record.view.error = message; await this.cleanup(record); await this.stopOwned().catch(() => { record.view.error += " Temporary server cleanup needs a retry with Disconnect."; }); this.emit(); }
  async cleanup(record) { if (record.stopped) return; record.stopped = true; clearTimeout(record.timer); clearInterval(record.heartbeat); record.abort.abort(); record.channel?.destroy(); record.bridge?.destroy(); record.ws?.terminate(); record.wss?.close(); if (record.server) await new Promise(resolve => { record.server.close(resolve); record.server.closeAllConnections?.(); }); record.token = null; }
  async stopOwned() { const owned = this.owned; if (owned) { await this.providers[owned.provider].stop(this.service, owned.host, owned); if (this.owned === owned) this.owned = null; } }
  async stop({ id } = {}) {
    if (id && (!this.record || id !== this.record.view.id)) return this.getState();
    this.generation += 1; this.plans.clear(); this.applyAbort?.abort();
    try {
      if (this.record) await this.cleanup(this.record);
      await this.stopOwned(); this.record = null; this.emit(); return this.getState();
    } catch {
      if (this.record) { this.record.view.status = 'failed'; this.record.view.error = 'Temporary desktop server cleanup failed. Retry Disconnect when SSH is available.'; }
      this.emit(); throw new Error('Temporary desktop server cleanup failed. Retry Disconnect when SSH is available.');
    }
  }
  async shutdown() { this.closed = true; this.plans.clear(); await this.stop(); }
}
function createRemoteDesktop(options) { return new RemoteDesktop(options); }
module.exports = { RemoteDesktop, createRemoteDesktop, MAX_BUFFER };
