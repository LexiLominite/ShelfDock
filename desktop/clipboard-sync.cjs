'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const protocol = require('./clipboard-sync-protocol.cjs');
const { safeTarget } = require('./clipboard-sync-ssh.cjs');

const STORAGE_MESSAGE = 'A secure system secret store is required for clipboard sync.';
const UNREACHABLE = 'ShelfDock on that computer is not ready for clipboard sync. Open it there and enable sync.';
const RATE_LIMIT = 30;
const PAIR_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenEquals = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
const inverse = direction => direction === 'send' ? 'receive' : direction === 'receive' ? 'send' : 'both';
const localName = () => os.hostname().replace(/[^\w .()-]/g, '').trim().slice(0, 80) || 'This computer';

class ClipboardSync {
  constructor({ dataDir, safeStorage, connect = () => { throw new Error(UNREACHABLE); }, now = Date.now, onChange = () => {}, onItem = () => {}, isBlocked = () => false, platform = process.platform, port = protocol.PORT } = {}) {
    this.directory = path.join(dataDir, 'clipboard-sync');
    this.safeStorage = safeStorage;
    this.connect = connect;
    this.now = now;
    this.onChange = onChange;
    this.onItem = onItem;
    this.isBlocked = isBlocked;
    this.platform = platform;
    this.requestedPort = port;
    this.settings = { enabled: false, paused: false, receiveMode: 'history', deviceId: crypto.randomUUID() };
    this.peers = [];
    this.pairing = null;
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.seen = new Set();
    this.pending = new Map();
    this.rates = new Map();
    this.error = '';
    this.epoch = 0;
    this.closed = false;
    this.retryTimer = null;
    this.writes = Promise.resolve();
    this.deliveries = Promise.resolve();
    this.ready = this.load();
  }

  available() {
    try {
      return this.safeStorage?.isEncryptionAvailable?.() === true && (this.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.safeStorage.getSelectedStorageBackend?.()));
    } catch { return false; }
  }

  active() { return !this.closed && this.settings.enabled && !this.settings.paused && this.available(); }
  blocked() { try { return this.isBlocked() === true; } catch { return true; } }
  canSend() { return this.active() && !this.blocked(); }
  state() {
    const pairing = this.pairing && this.pairing.expiresAt > this.now() ? { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() } : null;
    return {
      available: this.available(), enabled: this.settings.enabled === true, paused: this.settings.paused === true,
      receiveMode: this.settings.receiveMode === 'clipboard' ? 'clipboard' : 'history', pairing,
      peers: this.peers.map(peer => ({ id: peer.id, label: peer.label, hostLabel: peer.hostLabel, direction: peer.direction, paused: peer.paused === true, status: peer.socket && !peer.socket.destroyed ? 'connected' : 'offline' })),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  noteError(message) { this.error = message; this.emit(); }
  requireStorage() { if (!this.available()) throw new Error(STORAGE_MESSAGE); }
  requireActive() { if (!this.active()) throw new Error('Turn on and resume clipboard sync before pairing.'); }
  emit() { try { this.onChange(this.state()); } catch { /* A subscriber cannot stop sync. */ } }

  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const settings = JSON.parse(await fs.readFile(path.join(this.directory, 'settings.json'), 'utf8'));
      if (UUID.test(settings?.deviceId)) this.settings.deviceId = settings.deviceId;
      if (settings?.receiveMode === 'clipboard' || settings?.receiveMode === 'history') this.settings.receiveMode = settings.receiveMode;
      this.settings.paused = settings?.paused === true;
      this.settings.enabled = settings?.enabled === true;
    } catch { /* Fresh settings keep sync off. */ }
    if (!this.available()) { this.settings.enabled = false; return; }
    try {
      const parsed = JSON.parse(this.safeStorage.decryptString(await fs.readFile(path.join(this.directory, 'peers.bin'))));
      if (parsed?.version !== 1 || !Array.isArray(parsed.peers) || parsed.peers.length > 32) throw new Error('Invalid peers');
      const ids = new Set();
      this.peers = parsed.peers.map(peer => {
        protocol.validateMessage({ v: 1, type: 'pair-ok', deviceId: peer.id, token: peer.token, label: peer.label, direction: peer.direction });
        if (ids.has(peer.id) || peer.id === this.settings.deviceId) throw new Error('Invalid peers');
        ids.add(peer.id);
        return { id: peer.id, remoteDeviceId: peer.id, label: peer.label, hostLabel: typeof peer.hostLabel === 'string' ? peer.hostLabel.slice(0, 80) : peer.label, direction: peer.direction, paused: peer.paused === true, token: peer.token, sshTarget: peer.sshTarget ? safeTarget(peer.sshTarget) : null, socket: null };
      });
    } catch (error) {
      if (error.code !== 'ENOENT') { this.peers = []; this.error = 'Saved clipboard sync devices could not be unlocked.'; }
    }
    // The controller activates only after checking Clipboard tools. Loading never listens.
  }

  writeFile(file, body) {
    const operation = this.writes.catch(() => {}).then(async () => {
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, body, { mode: 0o600 }); await fs.rename(temp, file); }
      finally { await fs.rm(temp, { force: true }); }
    });
    this.writes = operation;
    return operation;
  }
  saveSettings() { return this.writeFile(path.join(this.directory, 'settings.json'), JSON.stringify({ version: 1, ...this.settings })); }
  savePeers() {
    this.requireStorage();
    const peers = this.peers.map(({ id, label, hostLabel, direction, paused, token, sshTarget }) => ({ id, label, hostLabel, direction, paused: paused === true, token, sshTarget }));
    return this.writeFile(path.join(this.directory, 'peers.bin'), this.safeStorage.encryptString(JSON.stringify({ version: 1, peers })));
  }
  async stopAfterPeerSaveFailure(message) {
    this.settings.enabled = false; this.epoch += 1; this.pairing = null; this.pending.clear();
    await this.closeListener();
    let warning = '';
    try { await this.saveSettings(); }
    catch { warning = ' Its off preference also could not be saved; check it before using the app after restarting.'; }
    this.noteError(message + ' Clipboard sync is off.' + warning);
  }

  async listen() {
    if (this.server) return;
    const server = net.createServer(socket => this.accept(socket));
    this.server = server;
    await new Promise((resolve, reject) => {
      const fail = error => { if (this.server === server) this.server = null; reject(error); };
      server.once('error', fail);
      server.listen(this.requestedPort, protocol.HOST, () => {
        server.off('error', fail);
        server.on('error', () => this.noteError(UNREACHABLE));
        this.port = server.address().port;
        resolve();
      });
    }).catch(error => { this.error = error.code === 'EADDRINUSE' ? 'Another ShelfDock instance is already using clipboard sync.' : UNREACHABLE; throw new Error(this.error); });
  }
  track(socket) {
    this.sockets.add(socket);
    socket.on('error', () => { socket.destroy(); });
    socket.once('close', () => this.sockets.delete(socket));
    socket.once('end', () => { this.sockets.delete(socket); socket.destroy(); });
    return socket;
  }
  dropSocket(peer) { const socket = peer?.socket; if (peer) peer.socket = null; if (socket && !socket.destroyed) socket.destroy(); }
  async closeListener() {
    clearInterval(this.retryTimer); this.retryTimer = null;
    const server = this.server; this.server = null; this.port = null;
    for (const peer of this.peers) this.dropSocket(peer);
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
  startRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => this.retry().catch(() => {}), 2000);
    this.retryTimer.unref?.();
  }
  async retry() {
    if (!this.canSend()) return;
    for (const peer of this.peers) {
      if (peer.paused || peer.retryAt > this.now()) continue;
      if (this.pending.has(peer.id)) await this.flush(peer);
      else if (peer.sshTarget && !peer.socket) { try { await this.ensureSocket(peer); } catch { /* Bounded backoff is applied by ensureSocket. */ } }
    }
  }
  async setEnabled(enabled) {
    await this.ready;
    if (typeof enabled !== 'boolean') throw new Error('Choose an enabled state.');
    if (enabled) { this.requireStorage(); if (this.closed) throw new Error('Clipboard sync is shutting down.'); await this.listen(); }
    this.settings.enabled = enabled;
    this.epoch += 1; this.error = '';
    if (!enabled) { this.pairing = null; this.pending.clear(); await this.closeListener(); }
    else this.startRetry();
    try { await this.saveSettings(); }
    catch {
      this.settings.enabled = false; this.epoch += 1; this.pairing = null; this.pending.clear();
      await this.closeListener();
      this.noteError('Clipboard sync is off for this session. Its preference could not be saved; check it after restarting.');
      throw new Error(this.error);
    }
    this.emit();
  }
  async setPaused(paused) {
    await this.ready;
    if (typeof paused !== 'boolean') throw new Error('Choose a paused state.');
    this.settings.paused = paused; this.epoch += 1;
    if (paused) { this.pending.clear(); this.pairing = null; for (const socket of this.sockets) socket.destroy(); for (const peer of this.peers) this.dropSocket(peer); }
    try { await this.saveSettings(); }
    catch {
      this.settings.paused = true; this.epoch += 1; this.pending.clear(); this.pairing = null;
      for (const socket of this.sockets) socket.destroy();
      for (const peer of this.peers) this.dropSocket(peer);
      this.noteError('Clipboard sync is paused for this session. Its preference could not be saved; check it after restarting.');
      throw new Error(this.error);
    }
    this.emit();
  }
  async setReceiveMode(mode) {
    await this.ready;
    if (!['history', 'clipboard'].includes(mode)) throw new Error('Choose clipboard history or the system clipboard.');
    const previous = this.settings.receiveMode;
    this.settings.receiveMode = mode;
    try { await this.saveSettings(); } catch { this.settings.receiveMode = previous; throw new Error('The incoming clipboard preference could not be saved.'); }
    this.emit();
  }
  async beginPairing() {
    await this.ready; this.requireStorage(); this.requireActive();
    this.pairing = { code: protocol.createCode(), expiresAt: this.now() + PAIR_MS };
    this.error = ''; this.emit();
    return { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }
  async pairWith({ hostLabel, code, direction = 'both', sshTarget, localLabel = localName() } = {}) {
    await this.ready; this.requireStorage(); this.requireActive();
    const epoch = this.epoch;
    const message = { v: 1, type: 'pair', code: String(code || '').trim().toUpperCase(), deviceId: this.settings.deviceId, label: localLabel, direction };
    protocol.validateMessage(message);
    const peer = { id: crypto.randomUUID(), label: String(hostLabel || 'Paired computer').slice(0, 80), hostLabel: String(hostLabel || 'Paired computer').slice(0, 80), direction, paused: false, sshTarget: safeTarget(sshTarget), token: '', socket: null };
    const socket = await this.open(peer);
    let previous, saved = false;
    try {
      const reply = await this.exchange(socket, message);
      if (reply.type !== 'pair-ok' || reply.deviceId === this.settings.deviceId || reply.direction !== inverse(direction)) throw new Error('That computer did not accept clipboard pairing.');
      if (!this.active() || epoch !== this.epoch) throw new Error('Clipboard sync was paused or disabled.');
      peer.id = reply.deviceId; peer.remoteDeviceId = reply.deviceId; peer.token = reply.token; peer.socket = socket;
      previous = this.peers.find(item => item.id === peer.id);
      if (!previous && this.peers.length >= 32) throw new Error('Pair at most 32 computers.');
      this.peers = this.peers.filter(item => item.id !== peer.id); this.peers.push(peer);
      await this.savePeers();
      saved = true;
      if (!this.active() || epoch !== this.epoch || !this.peers.includes(peer)) throw new Error('Clipboard sync was paused or disabled.');
      this.dropSocket(previous); this.attach(socket, peer); this.error = ''; this.emit();
      return this.state();
    } catch (error) {
      if (this.peers.includes(peer)) {
        this.peers = this.peers.filter(item => item !== peer);
        if (previous && !this.peers.some(item => item.id === previous.id)) this.peers.push(previous);
        if (saved) {
          try { await this.savePeers(); }
          catch { await this.stopAfterPeerSaveFailure('Pairing was cancelled, but its saved record could not be removed. Remove the device after storage is available.'); }
        }
      }
      socket.destroy(); this.emit(); throw error;
    }
  }
  async updatePeer({ id, direction, paused } = {}) {
    await this.ready;
    const peer = this.peers.find(item => item.id === id);
    if (!peer) throw new Error('That computer is no longer paired.');
    if (direction !== undefined && !['send', 'receive', 'both'].includes(direction)) throw new Error('Choose send, receive, or both directions.');
    if (paused !== undefined && typeof paused !== 'boolean') throw new Error('Choose a paused state.');
    const previous = { direction: peer.direction, paused: peer.paused };
    if (direction !== undefined) peer.direction = direction;
    if (paused !== undefined) peer.paused = paused;
    this.pending.delete(peer.id);
    if (peer.paused) this.dropSocket(peer);
    try { await this.savePeers(); }
    catch {
      peer.direction = previous.direction; peer.paused = true; this.dropSocket(peer);
      await this.stopAfterPeerSaveFailure('The device preference could not be saved. It is paused for this session; retry its preference when storage is available.');
      throw new Error(this.error);
    }
    this.emit();
  }
  async revoke(id) {
    await this.ready;
    const peer = this.peers.find(item => item.id === id);
    if (!peer) return this.state();
    await this.removePeer(peer);
    return this.state();
  }
  async removePeer(peer) {
    const socket = peer.socket;
    peer.paused = true; this.pending.delete(peer.id); this.rates.delete(peer.id);
    this.peers = this.peers.filter(item => item !== peer);
    try { await this.savePeers(); }
    catch {
      if (!this.peers.some(item => item.id === peer.id)) this.peers.push(peer);
      this.dropSocket(peer);
      await this.stopAfterPeerSaveFailure('The device could not be removed from saved pairings. It is paused for this session; retry Remove before restarting.');
      throw new Error(this.error);
    }
    if (socket && !socket.destroyed) { try { socket.write(protocol.encodeFrame({ v: 1, type: 'revoke', deviceId: this.settings.deviceId })); } catch {} }
    this.dropSocket(peer); this.emit();
  }
  async submitLocal(item) {
    await this.ready;
    if (!this.canSend() || !item || this.seen.has(item.eventId)) return;
    try { protocol.assertFresh(item.createdAt, this.now()); } catch { return; }
    const message = { v: 1, type: 'item', eventId: item.eventId, originDeviceId: this.settings.deviceId, kind: item.kind, createdAt: item.createdAt, ...(item.kind === 'png' ? { png: item.png } : { text: item.text }) };
    try { protocol.validateMessage(message); } catch { return; }
    const outgoing = [];
    for (const peer of this.peers) {
      if (peer.paused || !['send', 'both'].includes(peer.direction)) continue;
      if (!this.allowRate(`send:${peer.id}`)) continue;
      this.pending.set(peer.id, message);
      outgoing.push(this.flush(peer));
    }
    await Promise.allSettled(outgoing);
  }
  allowRate(id) {
    const stamps = (this.rates.get(id) || []).filter(stamp => stamp >= this.now() - 60000);
    if (stamps.length >= RATE_LIMIT) return false;
    stamps.push(this.now()); this.rates.set(id, stamps); return true;
  }
  async flush(peer) {
    const message = this.pending.get(peer.id);
    if (!this.canSend() || peer.paused || !['send', 'both'].includes(peer.direction) || !message) return;
    try { protocol.assertFresh(message.createdAt, this.now()); } catch { this.pending.delete(peer.id); return; }
    if (peer.retryAt > this.now() || (!peer.sshTarget && !peer.socket)) return;
    try {
      const socket = await this.ensureSocket(peer);
      if (!this.canSend() || !this.peers.includes(peer) || peer.paused || this.pending.get(peer.id) !== message) return;
      if (!socket.destroyed) socket.write(protocol.encodeFrame(message));
      // Retain only the newest event until an authenticated acknowledgement arrives.
    } catch { this.noteError(UNREACHABLE); }
  }
  async ensureSocket(peer) {
    if (peer.socket && !peer.socket.destroyed) return peer.socket;
    if (peer.connecting) return peer.connecting;
    const epoch = this.epoch;
    peer.connecting = (async () => {
      let socket;
      try {
        socket = await this.open(peer);
        const reply = await this.exchange(socket, { v: 1, type: 'hello', deviceId: this.settings.deviceId, token: peer.token });
        if (reply.type !== 'hello-ok' || reply.deviceId !== peer.id || !this.active() || peer.paused || epoch !== this.epoch || !this.peers.includes(peer)) throw new Error(UNREACHABLE);
        peer.socket = socket; peer.failures = 0; peer.retryAt = 0;
        this.attach(socket, peer); this.error = ''; this.emit(); return socket;
      } catch {
        socket?.destroy(); peer.failures = Math.min((peer.failures || 0) + 1, 5); peer.retryAt = this.now() + Math.min(60000, 2000 * 2 ** peer.failures); throw new Error(UNREACHABLE);
      } finally { peer.connecting = null; }
    })();
    return peer.connecting;
  }
  async open(peer) {
    let socket;
    try { socket = await this.connect(peer); } catch { throw new Error(UNREACHABLE); }
    if (!socket || typeof socket.write !== 'function' || typeof socket.on !== 'function') throw new Error(UNREACHABLE);
    this.track(socket);
    if (socket.destroyed || socket.errored) throw new Error(UNREACHABLE);
    if (socket.connecting) {
      await new Promise((resolve, reject) => {
        const done = error => { clearTimeout(timer); socket.off('connect', connected); socket.off('error', failed); socket.off('close', failed); if (error) { socket.destroy(); reject(new Error(UNREACHABLE)); } else resolve(); };
        const connected = () => done(); const failed = () => done(true);
        const timer = setTimeout(failed, 8000);
        socket.once('connect', connected); socket.once('error', failed); socket.once('close', failed);
      });
    }
    return socket;
  }
  exchange(socket, message) {
    return new Promise((resolve, reject) => {
      let state = { buffer: Buffer.alloc(0) }, finished = false;
      const finish = (error, reply) => {
        if (finished) return; finished = true; clearTimeout(timer);
        socket.off('data', data); socket.off('error', failed); socket.off('close', failed); socket.off('end', failed);
        if (error) { socket.destroy(); reject(new Error(UNREACHABLE)); } else resolve(reply);
      };
      const failed = () => finish(true);
      const data = chunk => {
        try {
          const decoded = protocol.pushBytes(state, chunk); state = decoded.state;
          if (decoded.messages.length) { socket.syncInitial = { state, messages: decoded.messages.slice(1) }; finish(false, decoded.messages[0]); }
        } catch { finish(true); }
      };
      const timer = setTimeout(failed, 8000);
      socket.on('data', data); socket.once('error', failed); socket.once('close', failed); socket.once('end', failed);
      try { socket.write(protocol.encodeFrame(message)); } catch { failed(); }
    });
  }
  accept(socket) {
    if (!this.active() || this.sockets.size >= 16) { socket.destroy(); return; }
    this.track(socket);
    this.attach(socket, null);
  }
  reject(socket, reason) { try { socket.end(protocol.encodeFrame({ v: 1, type: 'reject', reason })); } catch { socket.destroy(); } const timer = setTimeout(() => socket.destroy(), 100); timer.unref?.(); }
  attach(socket, initialPeer) {
    let peer = initialPeer;
    let state = socket.syncInitial?.state || { buffer: Buffer.alloc(0) };
    let queue = Promise.resolve(), queued = 0;
    const dispatch = messages => {
      if (queued + messages.length > 4) { this.reject(socket, 'size'); return; }
      queued += messages.length;
      queue = queue.then(async () => {
        for (const message of messages) {
          if (socket.destroyed) return;
          try { peer = await this.receive(socket, peer, message); } catch { this.reject(socket, 'malformed'); return; } finally { queued -= 1; }
        }
      }).catch(() => socket.destroy());
    };
    socket.on('data', chunk => {
      try {
        if (!peer && (state.buffer.length + chunk.length > 4096 || (state.buffer.length >= 4 && state.buffer.readUInt32BE(0) > 4092))) { this.reject(socket, 'size'); return; }
        const decoded = protocol.pushBytes(state, chunk); state = decoded.state; dispatch(decoded.messages);
      } catch { this.reject(socket, 'malformed'); }
    });
    const gone = () => { if (peer?.socket === socket) { peer.socket = null; this.emit(); } };
    socket.once('close', gone); socket.once('end', gone);
    const timer = setTimeout(() => { if (!peer) socket.destroy(); }, 8000); timer.unref?.(); socket.once('close', () => clearTimeout(timer));
    if (socket.syncInitial?.messages.length) dispatch(socket.syncInitial.messages);
    delete socket.syncInitial;
  }
  async receive(socket, peer, message) {
    if (!this.active()) { this.reject(socket, 'paused'); return peer; }
    if (!peer && message.type === 'pair') return this.acceptPair(socket, message);
    if (!peer && message.type === 'hello') {
      const matched = this.peers.find(item => item.id === message.deviceId && tokenEquals(item.token, message.token));
      if (!matched || matched.paused) { this.reject(socket, 'auth'); return null; }
      this.dropSocket(matched); matched.socket = socket;
      socket.write(protocol.encodeFrame({ v: 1, type: 'hello-ok', deviceId: this.settings.deviceId }));
      this.emit(); queueMicrotask(() => this.flush(matched).catch(() => {})); return matched;
    }
    if (!peer || !this.peers.includes(peer)) { this.reject(socket, 'auth'); return peer; }
    if (message.type === 'item') {
      // Delivery is globally serialized, including frames on different peer sockets.
      const delivery = this.deliveries.catch(() => {}).then(() => this.acceptItem(peer, message));
      this.deliveries = delivery;
      if (await delivery) socket.write(protocol.encodeFrame({ v: 1, type: 'ack', deviceId: this.settings.deviceId, eventId: message.eventId }));
      return peer;
    }
    if (message.type === 'ack' && message.deviceId === peer.id) { if (this.pending.get(peer.id)?.eventId === message.eventId) this.pending.delete(peer.id); return peer; }
    if (message.type === 'revoke' && message.deviceId === peer.id) {
      await this.removePeer(peer); socket.destroy(); return null;
    }
    this.reject(socket, 'malformed'); return peer;
  }
  async acceptPair(socket, message) {
    if (!this.active() || !this.pairing || this.pairing.expiresAt <= this.now() || !this.allowRate('pairing') || !tokenEquals(this.pairing.code, message.code) || message.deviceId === this.settings.deviceId) { this.reject(socket, 'auth'); return null; }
    // Consume before awaiting persistence so one code authorizes exactly one pairing.
    this.pairing = null;
    const epoch = this.epoch;
    const previous = this.peers.find(item => item.id === message.deviceId);
    if (!previous && this.peers.length >= 32) { this.reject(socket, 'size'); return null; }
    const peer = { id: message.deviceId, remoteDeviceId: message.deviceId, label: message.label, hostLabel: message.label, direction: inverse(message.direction), paused: false, token: crypto.randomBytes(32).toString('hex'), socket, sshTarget: null };
    this.peers = this.peers.filter(item => item.id !== peer.id); this.peers.push(peer);
    let saved = false;
    try {
      await this.savePeers();
      saved = true;
      if (!this.active() || epoch !== this.epoch || socket.destroyed || !this.peers.includes(peer)) throw new Error('Paused');
      socket.write(protocol.encodeFrame({ v: 1, type: 'pair-ok', deviceId: this.settings.deviceId, label: localName(), token: peer.token, direction: peer.direction }));
      this.dropSocket(previous); this.error = ''; this.emit(); return peer;
    } catch {
      if (this.peers.includes(peer)) {
        this.peers = this.peers.filter(item => item !== peer);
        if (previous && !this.peers.some(item => item.id === previous.id)) this.peers.push(previous);
        if (saved) {
          try { await this.savePeers(); }
          catch { await this.stopAfterPeerSaveFailure('Pairing was cancelled, but its saved record could not be removed. Remove the device after storage is available.'); this.reject(socket, 'auth'); return null; }
        }
      }
      this.noteError('The paired computer could not be saved.'); this.reject(socket, 'auth'); return null;
    }
  }
  async acceptItem(peer, message) {
    if (!this.canSend() || peer.paused || !this.peers.includes(peer) || !['receive', 'both'].includes(peer.direction) || message.originDeviceId !== peer.id) return false;
    try { protocol.assertFresh(message.createdAt, this.now()); } catch { return false; }
    if (this.seen.has(message.eventId)) return true;
    if (!this.allowRate(`receive:${peer.id}`)) return false;
    try {
      await this.onItem({ eventId: message.eventId, originDeviceId: message.originDeviceId, originLabel: peer.label, kind: message.kind, text: message.text, png: message.png, createdAt: message.createdAt, receiveMode: this.settings.receiveMode });
      protocol.rememberEvent(this.seen, message.eventId);
      return true;
    } catch { this.noteError('An incoming clipboard item could not be saved.'); return false; }
  }
  async shutdown() {
    this.closed = true; this.settings.enabled = false; this.epoch += 1; this.pairing = null; this.pending.clear();
    await this.closeListener(); await Promise.allSettled([this.writes, this.deliveries]);
  }
}
module.exports = { ClipboardSync, STORAGE_MESSAGE };
