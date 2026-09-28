'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const protocol = require('./clipboard-sync-protocol.cjs');

const STORAGE_MESSAGE = 'A secure system secret store is required for clipboard sync.';
const UNREACHABLE = 'ShelfDock on that computer is not ready for clipboard sync. Open it there and choose Allow pairing.';
const RATE_LIMIT = 30;
const PAIR_MS = 5 * 60 * 1000;

const tokenEquals = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
};
const inverse = direction => direction === 'send' ? 'receive' : direction === 'receive' ? 'send' : 'both';
const localName = () => os.hostname().replace(/[^\w .()-]/g, '').trim().slice(0, 80) || 'This computer';

class ClipboardSync {
  constructor({ dataDir, safeStorage, connect = () => { throw new Error(UNREACHABLE); }, now = Date.now, onChange = () => {}, onItem = () => {}, port = protocol.PORT } = {}) {
    this.directory = path.join(dataDir, 'clipboard-sync');
    this.safeStorage = safeStorage;
    this.connect = connect;
    this.now = now;
    this.onChange = onChange;
    this.onItem = onItem;
    this.requestedPort = port;
    this.settings = { enabled: false, paused: false, receiveMode: 'history', deviceId: crypto.randomUUID() };
    this.peers = [];
    this.pairing = null;
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.seen = new Set();
    this.suppress = new Set();
    this.pending = new Map();
    this.rates = new Map();
    this.error = '';
    this.ready = this.load();
  }

  available() {
    try { return this.safeStorage?.isEncryptionAvailable?.() === true; } catch { return false; }
  }

  state() {
    const pairing = this.pairing && this.pairing.expiresAt > this.now() ? { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() } : null;
    return {
      available: this.available(),
      enabled: this.settings.enabled === true,
      paused: this.settings.paused === true,
      receiveMode: this.settings.receiveMode === 'clipboard' ? 'clipboard' : 'history',
      pairing,
      peers: this.peers.map(peer => ({ id: peer.id, label: peer.label, hostLabel: peer.hostLabel, direction: peer.direction, paused: peer.paused === true, status: peer.socket && !peer.socket.destroyed ? 'connected' : 'offline' })),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  noteError(message) { this.error = message; this.emit(); }
  requireStorage() { if (!this.available()) throw new Error(STORAGE_MESSAGE); }
  emit() { try { this.onChange(this.state()); } catch { /* UI subscribers cannot block sync. */ } }

  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const settings = JSON.parse(await fs.readFile(path.join(this.directory, 'settings.json'), 'utf8'));
      if (settings && typeof settings === 'object' && settings.deviceId) this.settings.deviceId = settings.deviceId;
      if (settings?.receiveMode === 'clipboard' || settings?.receiveMode === 'history') this.settings.receiveMode = settings.receiveMode;
      this.settings.paused = settings?.paused === true;
      this.settings.enabled = settings?.enabled === true;
    } catch { /* Missing settings keep sync off. */ }
    if (!this.available()) return;
    try {
      const encrypted = await fs.readFile(path.join(this.directory, 'peers.bin'));
      const parsed = JSON.parse(this.safeStorage.decryptString(encrypted));
      this.peers = Array.isArray(parsed.peers) ? parsed.peers.filter(peer => peer && typeof peer.token === 'string' && typeof peer.id === 'string').map(peer => ({ ...peer, socket: null })) : [];
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = 'Saved clipboard sync devices could not be unlocked.';
    }
    if (this.settings.enabled) {
      try { await this.listen(); } catch { this.settings.enabled = false; }
    }
  }

  async saveSettings() {
    const file = path.join(this.directory, 'settings.json');
    const body = JSON.stringify({ version: 1, deviceId: this.settings.deviceId, enabled: this.settings.enabled, paused: this.settings.paused, receiveMode: this.settings.receiveMode });
    await fs.writeFile(file, body, { mode: 0o600 });
  }

  async savePeers() {
    const file = path.join(this.directory, 'peers.bin');
    if (!this.peers.length) { await fs.rm(file, { force: true }); return; }
    this.requireStorage();
    const body = JSON.stringify({ version: 1, peers: this.peers.map(({ id, label, hostLabel, direction, paused, token, sshTarget, remoteDeviceId }) => ({ id, label, hostLabel, direction, paused: paused === true, token, sshTarget, remoteDeviceId })) });
    await fs.writeFile(file, this.safeStorage.encryptString(body), { mode: 0o600 });
  }

  async listen() {
    if (this.server) return;
    this.server = net.createServer(socket => this.accept(socket));
    await new Promise((resolve, reject) => {
      const fail = error => { this.server = null; reject(error); };
      this.server.once('error', fail);
      this.server.listen(this.requestedPort, protocol.HOST, () => { this.server.off('error', fail); this.port = this.server.address().port; resolve(); });
    }).catch(error => {
      this.error = error.code === 'EADDRINUSE' ? 'Clipboard sync is already running for another ShelfDock window.' : UNREACHABLE;
      throw new Error(this.error);
    });
  }

  async closeListener() {
    const server = this.server;
    this.server = null;
    this.port = null;
    for (const peer of this.peers) this.dropSocket(peer);
    for (const socket of this.sockets) socket.destroy();
    if (!server) return;
    await new Promise(resolve => { server.close(resolve); setTimeout(resolve, 200); });
  }

  dropSocket(peer) {
    const socket = peer?.socket;
    peer.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
  }

  async setEnabled(enabled) {
    await this.ready;
    if (typeof enabled !== 'boolean') throw new Error('Choose an enabled or paused state.');
    if (enabled) { this.requireStorage(); await this.listen(); }
    this.settings.enabled = enabled;
    this.error = '';
    if (!enabled) { this.pairing = null; await this.closeListener(); }
    await this.saveSettings();
    this.emit();
  }

  async setPaused(paused) {
    await this.ready;
    if (typeof paused !== 'boolean') throw new Error('Choose an enabled or paused state.');
    this.settings.paused = paused;
    await this.saveSettings();
    this.emit();
  }

  async setReceiveMode(receiveMode) {
    await this.ready;
    if (receiveMode !== 'history' && receiveMode !== 'clipboard') throw new Error('Choose clipboard history or the system clipboard.');
    this.settings.receiveMode = receiveMode;
    await this.saveSettings();
    this.emit();
  }

  async beginPairing() {
    await this.ready;
    this.requireStorage();
    await this.listen();
    this.pairing = { code: protocol.createCode(), expiresAt: this.now() + PAIR_MS };
    this.error = '';
    this.emit();
    return { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }

  async pairWith({ hostLabel, code, direction = 'both', sshTarget, localLabel = localName() } = {}) {
    await this.ready;
    this.requireStorage();
    const normalized = String(code || '').trim().toUpperCase();
    const message = { v: protocol.VERSION, type: 'pair', code: normalized, deviceId: this.settings.deviceId, label: localLabel, direction };
    protocol.validateMessage(message);
    const peer = { id: crypto.randomUUID(), label: String(hostLabel || 'Paired computer').slice(0, 80), hostLabel: String(hostLabel || 'Paired computer').slice(0, 80), direction, paused: false, sshTarget, socket: null, token: '' };
    const socket = await this.open(peer);
    const reply = await this.exchange(socket, message);
    if (reply.type !== 'pair-ok') throw new Error('That computer did not accept clipboard pairing.');
    peer.id = reply.deviceId;
    peer.token = reply.token;
    peer.remoteDeviceId = reply.deviceId;
    peer.socket = socket;
    this.peers = this.peers.filter(existing => existing.id !== peer.id);
    this.peers.push(peer);
    this.attach(socket, peer);
    await this.savePeers();
    this.error = '';
    this.emit();
    return this.state();
  }

  async updatePeer({ id, direction, paused } = {}) {
    await this.ready;
    const peer = this.peers.find(item => item.id === id);
    if (!peer) throw new Error('That computer is no longer paired.');
    if (direction !== undefined) {
      if (!['send', 'receive', 'both'].includes(direction)) throw new Error('Choose send, receive, or both directions.');
      peer.direction = direction;
    }
    if (paused !== undefined) peer.paused = paused === true;
    await this.savePeers();
    this.emit();
  }

  async revoke(id) {
    await this.ready;
    const peer = this.peers.find(item => item.id === id);
    if (!peer) return this.state();
    if (peer.socket && !peer.socket.destroyed) {
      try { peer.socket.write(protocol.encodeFrame({ v: protocol.VERSION, type: 'revoke', deviceId: this.settings.deviceId })); } catch { /* Closing still removes the peer. */ }
    }
    this.dropSocket(peer);
    this.pending.delete(peer.id);
    this.peers = this.peers.filter(item => item.id !== id);
    await this.savePeers();
    this.emit();
    return this.state();
  }

  async submitLocal(item) {
    await this.ready;
    if (!this.settings.enabled || this.settings.paused) return;
    if (!item || this.suppress.has(item.eventId) || this.seen.has(item.eventId)) return;
    try { protocol.assertFresh(item.createdAt, this.now()); } catch { return; }
    const message = { v: protocol.VERSION, type: 'item', eventId: item.eventId, originDeviceId: this.settings.deviceId, kind: item.kind, createdAt: item.createdAt, ...(item.kind === 'png' ? { png: item.png } : { text: item.text }) };
    try { protocol.validateMessage(message); } catch { return; }
    for (const peer of this.peers) {
      if (peer.paused || (peer.direction !== 'send' && peer.direction !== 'both')) continue;
      if (!this.allowRate(peer.id)) { this.noteError('Clipboard sync is pausing briefly because items are arriving too quickly.'); continue; }
      this.pending.set(peer.id, message);
      await this.flush(peer);
    }
  }

  allowRate(id) {
    const windowStart = this.now() - 60000;
    const stamps = (this.rates.get(id) || []).filter(stamp => stamp >= windowStart);
    if (stamps.length >= RATE_LIMIT) { this.rates.set(id, stamps); return false; }
    stamps.push(this.now());
    this.rates.set(id, stamps);
    return true;
  }

  async flush(peer) {
    const message = this.pending.get(peer.id);
    if (!message) return;
    try { protocol.assertFresh(message.createdAt, this.now()); } catch { this.pending.delete(peer.id); return; }
    try {
      const socket = await this.ensureSocket(peer);
      if (this.pending.get(peer.id) !== message) return;
      socket.write(protocol.encodeFrame(message));
      this.pending.delete(peer.id);
    } catch {
      this.noteError(UNREACHABLE);
    }
  }

  async ensureSocket(peer) {
    if (peer.socket && !peer.socket.destroyed) return peer.socket;
    const socket = await this.open(peer);
    peer.socket = socket;
    this.attach(socket, peer);
    socket.write(protocol.encodeFrame({ v: protocol.VERSION, type: 'hello', deviceId: this.settings.deviceId, token: peer.token }));
    return socket;
  }

  async open(peer) {
    let socket;
    try { socket = await this.connect(peer); } catch { throw new Error(UNREACHABLE); }
    if (!socket || typeof socket.write !== 'function' || typeof socket.on !== 'function') throw new Error(UNREACHABLE);
    this.sockets.add(socket);
    socket.once?.('close', () => this.sockets.delete(socket));
    if (socket.readyState === 'opening' || socket.connecting) {
      await new Promise((resolve, reject) => {
        if (socket.readyState === 'open') return resolve();
        const timer = setTimeout(() => reject(new Error(UNREACHABLE)), 8000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new Error(UNREACHABLE)); });
      });
    }
    return socket;
  }

  exchange(socket, message) {
    return new Promise((resolve, reject) => {
      let state = { buffer: Buffer.alloc(0) };
      const timer = setTimeout(() => finish(new Error(UNREACHABLE)), 8000);
      const finish = error => { clearTimeout(timer); socket.off('data', onData); if (error) reject(error); };
      const onData = chunk => {
        try {
          const decoded = protocol.pushBytes(state, chunk);
          state = decoded.state;
          if (!decoded.messages.length) return;
          clearTimeout(timer);
          socket.off('data', onData);
          resolve(decoded.messages[0]);
        } catch (error) { finish(error); socket.destroy(); }
      };
      socket.on('data', onData);
      socket.once('error', () => finish(new Error(UNREACHABLE)));
      try { socket.write(protocol.encodeFrame(message)); } catch (error) { finish(error); }
    });
  }

  accept(socket) {
    this.sockets.add(socket);
    socket.once?.('close', () => this.sockets.delete(socket));
    let state = { buffer: Buffer.alloc(0) };
    let peer = null;
    const reject = reason => { try { socket.write(protocol.encodeFrame({ v: protocol.VERSION, type: 'reject', reason })); } catch { /* The socket is already closing. */ } socket.destroy(); };
    socket.on('data', chunk => {
      let decoded;
      try { decoded = protocol.pushBytes(state, chunk); state = decoded.state; }
      catch { reject('malformed'); return; }
      for (const message of decoded.messages) {
        try { peer = this.receive(socket, peer, message, reject); }
        catch { reject('malformed'); return; }
      }
    });
    socket.setTimeout?.(15000, () => { if (!peer) socket.destroy(); });
  }

  receive(socket, peer, message, reject) {
    if (message.type === 'pair') return this.acceptPair(socket, message, reject);
    if (!peer && message.type === 'hello') return this.acceptHello(socket, message, reject);
    if (!peer) { reject('auth'); return peer; }
    if (message.type === 'item') { this.acceptItem(peer, message, reject); return peer; }
    if (message.type === 'revoke' && message.deviceId === peer.remoteDeviceId) { this.peers = this.peers.filter(item => item.id !== peer.id); this.pending.delete(peer.id); this.savePeers().catch(() => {}); this.emit(); socket.destroy(); }
    if (message.type === 'pause') peer.paused = true;
    if (message.type === 'resume') peer.paused = false;
    return peer;
  }

  acceptPair(socket, message, reject) {
    if (!this.pairing || this.pairing.expiresAt <= this.now() || this.pairing.code !== message.code) { reject('auth'); return null; }
    const token = crypto.randomBytes(32).toString('hex');
    const peer = { id: message.deviceId, label: message.label, hostLabel: message.label, direction: inverse(message.direction), paused: false, token, remoteDeviceId: message.deviceId, socket, sshTarget: null };
    this.peers = this.peers.filter(item => item.id !== peer.id);
    this.peers.push(peer);
    this.pairing = null;
    socket.write(protocol.encodeFrame({ v: protocol.VERSION, type: 'pair-ok', deviceId: this.settings.deviceId, label: localName(), token, direction: peer.direction }));
    this.savePeers().catch(error => this.noteError(error.message === STORAGE_MESSAGE ? STORAGE_MESSAGE : 'The paired computer could not be saved.'));
    this.error = '';
    this.emit();
    return peer;
  }

  acceptHello(socket, message, reject) {
    const peer = this.peers.find(item => tokenEquals(item.token, message.token));
    if (!peer) { reject('auth'); return null; }
    this.dropSocket(peer);
    peer.socket = socket;
    peer.remoteDeviceId = message.deviceId;
    this.emit();
    return peer;
  }

  acceptItem(peer, message, reject) {
    if (!this.peers.includes(peer)) { reject('revoked'); return; }
    if (this.settings.paused || peer.paused || (peer.direction !== 'receive' && peer.direction !== 'both')) { reject('paused'); return; }
    try { protocol.assertFresh(message.createdAt, this.now()); } catch { reject('fresh'); return; }
    if (!protocol.rememberEvent(this.seen, message.eventId)) return;
    this.suppress.add(message.eventId);
    try {
      this.onItem({ eventId: message.eventId, originDeviceId: message.originDeviceId, originLabel: peer.label, kind: message.kind, text: message.text, png: message.png, createdAt: message.createdAt, receiveMode: this.settings.receiveMode });
    } catch { /* Delivery errors stay local and never echo the payload. */ }
  }

  attach(socket, peer) {
    let state = { buffer: Buffer.alloc(0) };
    socket.on('data', chunk => {
      let decoded;
      try { decoded = protocol.pushBytes(state, chunk); state = decoded.state; }
      catch { socket.destroy(); return; }
      for (const message of decoded.messages) {
        if (message.type === 'reject') { this.dropSocket(peer); this.noteError('That computer refused clipboard sync.'); return; }
        if (message.type === 'item') this.acceptItem(peer, message, () => socket.destroy());
        if (message.type === 'revoke') { this.peers = this.peers.filter(item => item.id !== peer.id); this.savePeers().catch(() => {}); this.dropSocket(peer); this.emit(); }
      }
    });
    socket.once('close', () => { if (peer.socket === socket) peer.socket = null; });
    socket.once('end', () => { if (peer.socket === socket) peer.socket = null; });
  }

  async shutdown() {
    this.settings.enabled = false;
    this.pairing = null;
    await this.closeListener();
  }
}

module.exports = { ClipboardSync, STORAGE_MESSAGE };
