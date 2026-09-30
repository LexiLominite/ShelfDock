'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const protocol = require('./clipboard-sync-protocol.cjs');
const { safeTarget, readOwnerBootstrap: defaultReadOwnerBootstrap } = require('./clipboard-sync-ssh.cjs');

const STORAGE_MESSAGE = 'A secure system secret store is required for clipboard sync.';
const UNREACHABLE = 'ShelfDock on that computer is not ready for clipboard sync. Open it there and enable sync.';
const RATE_LIMIT = 30;
const PAIR_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenEquals = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
const inverse = direction => direction === 'send' ? 'receive' : direction === 'receive' ? 'send' : 'both';
const localName = () => os.hostname().replace(/[^\w .()-]/g, '').trim().slice(0, 80) || 'This computer';
const targetKey = target => { const value = safeTarget(target); return value.alias ? `alias:${value.alias.toLowerCase()}` : `endpoint:${value.user}@${value.host.toLowerCase()}:${value.port}`; };

class ClipboardSync {
  constructor({ dataDir, safeStorage, connect = () => { throw new Error(UNREACHABLE); }, now = Date.now, onChange = () => {}, onItem = () => {}, isBlocked = () => false, isLinkBlocked = isBlocked, platform = process.platform, port = protocol.PORT, readOwnerBootstrap = defaultReadOwnerBootstrap } = {}) {
    this.directory = path.join(dataDir, 'clipboard-sync');
    this.ownerDirectory = path.join(this.directory, 'owner');
    this.ownerBootstrap = null;
    this.ownerWrites = Promise.resolve();
    this.ownerRequests = new Set();
    this.readOwnerBootstrap = readOwnerBootstrap;
    this.safeStorage = safeStorage;
    this.connect = connect;
    this.now = now;
    this.onChange = onChange;
    this.onItem = onItem;
    this.isBlocked = isBlocked;
    this.isLinkBlocked = isLinkBlocked;
    this.platform = platform;
    this.requestedPort = port;
    this.settings = { enabled: false, paused: false, continuity: false, receiveMode: 'history', deviceId: crypto.randomUUID() };
    this.peers = [];
    this.excludedPeers = [];
    this.latestLocal = null;
    this.newestEvent = null;
    this.seenTimes = new Map();
    this.preferenceChanging = false;
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

  active() { return !this.closed && !this.preferenceChanging && this.settings.enabled && !this.settings.paused && this.available(); }
  blocked() { try { return this.isBlocked() === true; } catch { return true; } }
  canSend() { return this.active() && !this.blocked(); }
  canLink() { try { return this.active() && this.isLinkBlocked() !== true; } catch { return false; } }
  state() {
    const pairing = this.pairing && this.pairing.expiresAt > this.now() ? { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() } : null;
    return {
      available: this.available(), enabled: this.settings.enabled === true, paused: this.settings.paused === true,
      continuity: this.settings.continuity === true,
      receiveMode: this.settings.receiveMode === 'clipboard' ? 'clipboard' : 'history', pairing,
      excludedPeers: this.excludedPeers.map(({ id, label }) => ({ id, label })),
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
    await this.refreshOwnerBootstrap();
    try {
      const settings = JSON.parse(await fs.readFile(path.join(this.directory, 'settings.json'), 'utf8'));
      if (UUID.test(settings?.deviceId)) this.settings.deviceId = settings.deviceId;
      if (settings?.receiveMode === 'clipboard' || settings?.receiveMode === 'history') this.settings.receiveMode = settings.receiveMode;
      this.settings.paused = settings?.paused === true;
      this.settings.enabled = settings?.enabled === true;
      this.settings.continuity = settings?.continuity === true;
      if (['history', 'clipboard'].includes(settings?.continuityReceiveMode)) this.settings.continuityReceiveMode = settings.continuityReceiveMode;
      if (this.settings.continuity) this.settings.receiveMode = 'clipboard';
    } catch { /* Fresh settings keep sync off. */ }
    if (!this.available()) { this.settings.enabled = false; return; }
    try {
      const parsed = JSON.parse(this.safeStorage.decryptString(await fs.readFile(path.join(this.directory, 'peers.bin'))));
      if (parsed?.version !== 1 || !Array.isArray(parsed.peers) || parsed.peers.length > 32) throw new Error('Invalid peers');
      if (parsed.excludedPeers !== undefined && (!Array.isArray(parsed.excludedPeers) || parsed.excludedPeers.length > 256)) throw new Error('Invalid exclusions');
      const excludedIds = new Set();
      this.excludedPeers = (parsed.excludedPeers || []).map(item => {
        if (!UUID.test(item?.id) || item.id === this.settings.deviceId || excludedIds.has(item.id) || typeof item.label !== 'string' || !item.label.length || item.label.length > 80 || /[\x00-\x1f\x7f]/.test(item.label)) throw new Error('Invalid exclusions');
        excludedIds.add(item.id);
        return { id: item.id, label: item.label, ...(item.sshTarget ? { sshTarget: safeTarget(item.sshTarget) } : {}) };
      });
      const ids = new Set();
      this.peers = parsed.peers.map(peer => {
        protocol.validateMessage({ v: 1, type: 'pair-ok', deviceId: peer.id, token: peer.token, label: peer.label, direction: peer.direction });
        if (ids.has(peer.id) || excludedIds.has(peer.id) || peer.id === this.settings.deviceId) throw new Error('Invalid peers');
        ids.add(peer.id);
        return { id: peer.id, remoteDeviceId: peer.id, label: peer.label, hostLabel: typeof peer.hostLabel === 'string' ? peer.hostLabel.slice(0, 80) : peer.label, direction: peer.direction, paused: peer.paused === true, token: peer.token, sshTarget: peer.sshTarget ? safeTarget(peer.sshTarget) : null, socket: null };
      });
    } catch (error) {
      if (error.code !== 'ENOENT') { this.peers = []; this.settings.enabled = false; this.error = 'Saved clipboard sync devices could not be unlocked.'; }
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
  saveSettings(settings = this.settings) { return this.writeFile(path.join(this.directory, 'settings.json'), JSON.stringify({ version: 1, ...settings })); }
  savePeers() {
    this.requireStorage();
    const peers = this.peers.map(({ id, label, hostLabel, direction, paused, token, sshTarget }) => ({ id, label, hostLabel, direction, paused: paused === true, token, sshTarget }));
    return this.writeFile(path.join(this.directory, 'peers.bin'), this.safeStorage.encryptString(JSON.stringify({ version: 1, peers, excludedPeers: this.excludedPeers })));
  }
  async stopAfterPeerSaveFailure(message) {
    this.settings.enabled = false; this.epoch += 1; this.pairing = null; this.pending.clear(); this.latestLocal = null;
    await this.closeListener();
    let warning = '';
    try { await this.saveSettings(); }
    catch { warning = ' Its off preference also could not be saved; check it before using the app after restarting.'; }
    this.noteError(message + ' Clipboard sync is off.' + warning);
  }

  // Serialized atomic publication prevents stale in-flight writes from restoring
  // a capability after a pause/disable. No capability reaches state() or logs.
  refreshOwnerBootstrap(rotate = false) {
    const operation = this.ownerWrites.catch(() => {}).then(async () => {
      const file = path.join(this.ownerDirectory, 'bootstrap.json');
      if (!this.canLink() || !this.server) {
        this.ownerBootstrap = null;
        let info; try { info = await fs.lstat(this.ownerDirectory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Clipboard linking requires a private owner directory.');
        await fs.rm(file, { force: true }); return;
      }
      if (!rotate && this.ownerBootstrap?.expiresAt > this.now() + protocol.FRESH_MS / 2) return;
      this.ownerBootstrap = null;
      await fs.mkdir(this.ownerDirectory, { recursive: true, mode: 0o700 });
      const info = await fs.lstat(this.ownerDirectory);
      if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Clipboard linking requires a private owner directory.');
      await fs.chmod(this.ownerDirectory, 0o700);
      if (this.platform === 'win32' && process.platform === 'win32') {
        // Windows chmod does not establish privacy. Restrict the directory DACL
        // to this process's user SID; descendants inherit that private ACL.
        const { execFile } = require('node:child_process');
        const script = "$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:SHELFDock_OWNER_DIR -AclObject $acl";
        await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 5000, maxBuffer: 2048, env: { ...process.env, SHELFDock_OWNER_DIR: this.ownerDirectory } }, error => error ? reject(new Error('Clipboard linking requires a private owner directory.')) : resolve()));
      }
      const bootstrap = { v: 1, type: 'owner-bootstrap', deviceId: this.settings.deviceId, capability: crypto.randomBytes(32).toString('hex'), expiresAt: this.now() + protocol.FRESH_MS };
      const temp = path.join(this.ownerDirectory, `${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, JSON.stringify(bootstrap), { mode: 0o600, flag: 'wx' });
        if (!this.canLink() || !this.server) { await fs.rm(file, { force: true }); return; }
        await fs.rename(temp, file);
        this.ownerBootstrap = bootstrap;
      } finally { await fs.rm(temp, { force: true }); }
    });
    this.ownerWrites = operation;
    return operation;
  }
  cancelOwnerRequests() { for (const controller of this.ownerRequests) controller.abort(); this.ownerRequests.clear(); }
  cancelAutomaticOwnerRequests() { for (const controller of this.ownerRequests) if (controller.automatic) controller.abort(); }
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
    this.cancelOwnerRequests();
    this.ownerBootstrap = null;
    clearInterval(this.retryTimer); this.retryTimer = null;
    const server = this.server; this.server = null; this.port = null;
    for (const peer of this.peers) this.dropSocket(peer);
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    await this.refreshOwnerBootstrap();
  }
  startRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => this.retry().catch(() => {}), 2000);
    this.retryTimer.unref?.();
  }
  async retry() {
    try { await this.refreshOwnerBootstrap(); } catch { this.noteError('Clipboard linking is unavailable because its private capability could not be saved.'); }
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
    this.epoch += 1; this.error = ''; this.latestLocal = null; this.newestEvent = null; this.pending.clear(); this.cancelOwnerRequests();
    if (!enabled) { this.pairing = null; this.pending.clear(); await this.closeListener(); }
    else this.startRetry();
    try { await this.saveSettings(); }
    catch {
      this.settings.enabled = false; this.epoch += 1; this.pairing = null; this.pending.clear();
      await this.closeListener();
      this.noteError('Clipboard sync is off for this session. Its preference could not be saved; check it after restarting.');
      throw new Error(this.error);
    }
    await this.refreshOwnerBootstrap(true);
    this.emit();
  }
  async setPaused(paused) {
    await this.ready;
    if (typeof paused !== 'boolean') throw new Error('Choose a paused state.');
    this.settings.paused = paused; this.epoch += 1; this.cancelOwnerRequests(); this.latestLocal = null; this.newestEvent = null; this.pending.clear();
    await this.refreshOwnerBootstrap(true);
    if (paused) { this.pending.clear(); this.pairing = null; for (const socket of this.sockets) socket.destroy(); for (const peer of this.peers) this.dropSocket(peer); }
    try { await this.saveSettings(); }
    catch {
      this.settings.paused = true; this.epoch += 1; this.pending.clear(); this.pairing = null;
      for (const socket of this.sockets) socket.destroy();
      for (const peer of this.peers) this.dropSocket(peer);
      this.noteError('Clipboard sync is paused for this session. Its preference could not be saved; check it after restarting.');
      throw new Error(this.error);
    }
    await this.refreshOwnerBootstrap(true);
    this.emit();
  }
  async setReceiveMode(mode) {
    await this.ready;
    if (!['history', 'clipboard'].includes(mode)) throw new Error('Choose clipboard history or the system clipboard.');
    if (this.settings.continuity && mode !== 'clipboard') throw new Error('Turn off Continuity before changing incoming clipboard delivery.');
    const previous = this.settings.receiveMode;
    this.settings.receiveMode = mode;
    try { await this.saveSettings(); } catch { this.settings.receiveMode = previous; throw new Error('The incoming clipboard preference could not be saved.'); }
    this.emit();
  }
  async setContinuity(continuity) {
    await this.ready;
    if (typeof continuity !== 'boolean') throw new Error('Choose a Continuity state.');
    if (this.preferenceChanging) throw new Error('A clipboard preference is being saved.');
    if (continuity) { this.requireStorage(); if (this.closed) throw new Error('Clipboard sync is shutting down.'); }
    const previous = { ...this.settings };
    const next = { ...previous, continuity };
    if (continuity) {
      if (!previous.continuity) next.continuityReceiveMode = previous.receiveMode;
      next.receiveMode = 'clipboard'; next.enabled = true; next.paused = false;
    } else if (previous.continuity) {
      next.receiveMode = previous.continuityReceiveMode === 'clipboard' ? 'clipboard' : 'history';
      delete next.continuityReceiveMode;
    }
    this.preferenceChanging = true; this.epoch += 1; this.pairing = null;
    this.pending.clear(); this.latestLocal = null; this.newestEvent = null; this.cancelOwnerRequests();
    const epoch = this.epoch;
    const check = () => { if (epoch !== this.epoch || this.closed) throw new Error('Clipboard preference was cancelled.'); };
    try {
      await this.closeListener();
      check();
      await this.saveSettings(next);
      check();
      this.settings = next;
      if (next.enabled) await this.listen();
      check();
      this.preferenceChanging = false;
      if (next.enabled) this.startRetry();
      await this.refreshOwnerBootstrap(true);
      this.error = ''; this.emit(); return this.state();
    } catch {
      this.settings = { ...previous, enabled: false, paused: true, continuity: false };
      this.preferenceChanging = false; this.epoch += 1;
      await this.closeListener();
      try { await this.saveSettings(); } catch { /* Session remains fail closed. */ }
      this.noteError('Continuity could not be saved or started. Clipboard sync is off for this session; check its preferences after restarting.');
      throw new Error(this.error);
    }
  }
  hasTarget(target) { const key = targetKey(target); return this.peers.some(peer => peer.sshTarget && targetKey(peer.sshTarget) === key); }
  isExcludedTarget(target) { const key = targetKey(target); return this.excludedPeers.some(peer => peer.sshTarget && targetKey(peer.sshTarget) === key); }
  async restoreExcludedPeer(id) {
    await this.ready;
    if (!UUID.test(id)) throw new Error('Choose a removed clipboard device.');
    const removed = this.excludedPeers.find(peer => peer.id === id);
    if (!removed) return this.state();
    this.excludedPeers = this.excludedPeers.filter(peer => peer !== removed);
    try { await this.savePeers(); }
    catch { if (!this.excludedPeers.some(peer => peer.id === id)) this.excludedPeers.push(removed); throw new Error('The device permission could not be saved.'); }
    this.emit(); return this.state();
  }
  async beginPairing() {
    await this.ready; this.requireStorage(); this.requireActive();
    this.pairing = { code: protocol.createCode(), expiresAt: this.now() + PAIR_MS };
    this.error = ''; this.emit();
    return { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }
  async pairOwnedWith({ hostLabel, direction = 'both', sshTarget, localLabel = localName(), automatic = false } = {}) {
    await this.ready; this.requireStorage(); this.requireActive();
    if (!this.canLink()) throw new Error('Enable and resume Clipboard tools before linking a computer.');
    // Validate all caller fields before touching the SSH transport.
    const target = safeTarget(sshTarget);
    if (automatic && (!this.settings.continuity || this.blocked())) throw new Error('Continuity is paused or disabled.');
    if (automatic && this.hasTarget(target)) return { ...this.state(), linkedPeerId: this.peers.find(peer => peer.sshTarget && targetKey(peer.sshTarget) === targetKey(target)).id };
    if (this.isExcludedTarget(target)) throw new Error('Allow this removed clipboard device again before linking.');
    if (automatic && this.peers.length >= 32) throw new Error('Pair at most 32 computers.');
    protocol.validateMessage({ v: 1, type: 'owner-pair', capability: '0'.repeat(64), receiverDeviceId: crypto.randomUUID(), deviceId: this.settings.deviceId, label: localLabel, direction });
    if (typeof hostLabel !== 'string' || hostLabel.length < 1 || hostLabel.length > 80 || /[\x00-\x1f\x7f]/.test(hostLabel)) throw new Error('Choose a saved machine.');
    const epoch = this.epoch, controller = new AbortController(); controller.automatic = automatic; this.ownerRequests.add(controller);
    try {
      const bootstrap = protocol.validateOwnerBootstrap(await this.readOwnerBootstrap(target, { signal: controller.signal, now: this.now }), this.now());
      controller.remoteDeviceId = bootstrap.deviceId;
      if (controller.signal.aborted || !this.canLink() || epoch !== this.epoch) throw new Error('Clipboard linking was cancelled.');
      if (bootstrap.deviceId === this.settings.deviceId) return { ...this.state(), skippedSelf: true };
      if (this.excludedPeers.some(peer => peer.id === bootstrap.deviceId)) throw new Error('Allow this removed clipboard device again before linking.');
      if (automatic && this.peers.some(peer => peer.id === bootstrap.deviceId)) return { ...this.state(), linkedPeerId: bootstrap.deviceId };
      if (this.peers.some(peer => peer.id === bootstrap.deviceId && peer.paused)) throw new Error('Resume or remove the existing clipboard link first.');
      return await this.pairWith({ hostLabel, direction, sshTarget: target, localLabel, ownerBootstrap: bootstrap, ownerEpoch: epoch, ownerSignal: controller.signal });
    } finally { this.ownerRequests.delete(controller); }
  }
  async pairWith({ hostLabel, code, direction = 'both', sshTarget, localLabel = localName(), ownerBootstrap, ownerEpoch, ownerSignal } = {}) {
    await this.ready; this.requireStorage(); this.requireActive();
    const epoch = this.epoch;
    if (ownerBootstrap && (ownerSignal?.aborted || ownerEpoch !== epoch || !this.canLink())) throw new Error('Clipboard linking was cancelled.');
    const message = { v: 1, type: 'pair', code: String(code || '').trim().toUpperCase(), deviceId: this.settings.deviceId, label: localLabel, direction };
    if (ownerBootstrap) { message.type = 'owner-pair'; delete message.code; message.capability = ownerBootstrap.capability; message.receiverDeviceId = ownerBootstrap.deviceId; }
    protocol.validateMessage(message);
    const peer = { id: crypto.randomUUID(), label: String(hostLabel || 'Paired computer').slice(0, 80), hostLabel: String(hostLabel || 'Paired computer').slice(0, 80), direction, paused: false, sshTarget: safeTarget(sshTarget), token: '', socket: null };
    const socket = await this.open(peer);
    let previous, saved = false;
    try {
      if (ownerBootstrap && (ownerSignal?.aborted || !this.canLink() || epoch !== this.epoch)) throw new Error('Clipboard linking was cancelled.');
      const reply = await this.exchange(socket, message);
      if (reply.type !== 'pair-ok' || (ownerBootstrap && reply.deviceId !== ownerBootstrap.deviceId) || reply.deviceId === this.settings.deviceId || reply.direction !== inverse(direction)) throw new Error('That computer did not accept clipboard pairing.');
      if (this.excludedPeers.some(item => item.id === reply.deviceId)) throw new Error('Allow this removed clipboard device again before linking.');
      if (!this.active() || (ownerBootstrap && (ownerSignal?.aborted || !this.canLink())) || epoch !== this.epoch) throw new Error('Clipboard sync was paused or disabled.');
      peer.id = reply.deviceId; peer.remoteDeviceId = reply.deviceId; peer.token = reply.token; peer.socket = socket;
      previous = this.peers.find(item => item.id === peer.id);
      if (ownerBootstrap && previous?.paused) throw new Error('Resume or remove the existing clipboard link first.');
      if (!previous && this.peers.length >= 32) throw new Error('Pair at most 32 computers.');
      this.peers = this.peers.filter(item => item.id !== peer.id); this.peers.push(peer);
      await this.savePeers();
      saved = true;
      if (!this.active() || (ownerBootstrap && (ownerSignal?.aborted || !this.canLink())) || epoch !== this.epoch || !this.peers.includes(peer)) throw new Error('Clipboard sync was paused or disabled.');
      this.dropSocket(previous); this.attach(socket, peer); this.error = ''; this.emit(); this.offerLatest(peer);
      return ownerBootstrap ? { ...this.state(), linkedPeerId: peer.id } : this.state();
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
    this.epoch += 1; this.cancelOwnerRequests(); this.ownerBootstrap = null;
    const previous = { direction: peer.direction, paused: peer.paused };
    if (direction !== undefined) peer.direction = direction;
    if (paused !== undefined) peer.paused = paused;
    this.pending.delete(peer.id);
    if (peer.paused) this.dropSocket(peer);
    try { await this.refreshOwnerBootstrap(true); } catch { this.noteError('Clipboard linking is unavailable because its private capability could not be saved.'); }
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
    this.epoch += 1; this.cancelOwnerRequests(); this.ownerBootstrap = null;
    if (!this.excludedPeers.some(item => item.id === peer.id)) {
      if (this.excludedPeers.length >= 256) {
        peer.paused = true; this.dropSocket(peer);
        await this.stopAfterPeerSaveFailure('The removed device safety record is full. Allow an older removed device again before retrying Remove.');
        throw new Error(this.error);
      }
      this.excludedPeers.push({ id: peer.id, label: peer.label, ...(peer.sshTarget ? { sshTarget: peer.sshTarget } : {}) });
    }
    const socket = peer.socket;
    peer.paused = true; this.pending.delete(peer.id); this.rates.delete(peer.id);
    this.peers = this.peers.filter(item => item !== peer);
    try { await this.refreshOwnerBootstrap(true); } catch { this.noteError('Clipboard linking is unavailable because its private capability could not be saved.'); }
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
    if (!this.rememberSeen(message.eventId)) return;
    if (this.settings.continuity && !this.isNewer(message)) return;
    this.newestEvent = { eventId: message.eventId, createdAt: message.createdAt };
    if (this.settings.continuity) this.latestLocal = message;
    await this.fanout(message);
  }
  async fanout(message, sourceId) {
    const outgoing = [];
    for (const peer of this.peers) {
      if (peer.id === sourceId || peer.paused || !['send', 'both'].includes(peer.direction)) continue;
      const pending = this.pending.get(peer.id);
      if (this.settings.continuity && pending && (pending.createdAt > message.createdAt || (pending.createdAt === message.createdAt && pending.eventId > message.eventId))) continue;
      if (!this.allowRate(`send:${peer.id}`)) continue;
      this.pending.set(peer.id, message);
      outgoing.push(this.flush(peer));
    }
    await Promise.allSettled(outgoing);
  }
  rememberSeen(eventId) {
    for (const [id, at] of this.seenTimes) if (this.now() - at > protocol.FRESH_MS + 10000) { this.seenTimes.delete(id); this.seen.delete(id); }
    // At most 32 peers x 30 fresh events/minute fit comfortably in this bound.
    // Saturation drops events rather than evicting a still-fresh loop guard.
    if (this.seenTimes.size >= 4096 && !this.seenTimes.has(eventId)) return false;
    this.seen.add(eventId); this.seenTimes.set(eventId, this.now()); return true;
  }
  isNewer(message) {
    return !this.newestEvent || message.createdAt > this.newestEvent.createdAt || (message.createdAt === this.newestEvent.createdAt && message.eventId > this.newestEvent.eventId);
  }
  offerLatest(peer) {
    if (!this.settings.continuity || !this.canSend() || peer.paused || !['send', 'both'].includes(peer.direction) || !this.latestLocal) return;
    try { protocol.assertFresh(this.latestLocal.createdAt, this.now()); } catch { this.latestLocal = null; return; }
    if (!this.allowRate(`send:${peer.id}`)) return;
    this.pending.set(peer.id, this.latestLocal);
    queueMicrotask(() => this.flush(peer).catch(() => {}));
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
    if (!peer && ['pair', 'owner-pair'].includes(message.type)) return this.acceptPair(socket, message);
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
    const epoch = this.epoch;
    const owned = message.type === 'owner-pair';
    const authority = owned ? this.ownerBootstrap : this.pairing;
    if (!this.active() || this.excludedPeers.some(peer => peer.id === message.deviceId) || (owned && (!this.canLink() || message.receiverDeviceId !== this.settings.deviceId || this.peers.some(peer => peer.id === message.deviceId))) || !authority || authority.expiresAt <= this.now() || !this.allowRate('pairing') || !tokenEquals(owned ? authority.capability : authority.code, owned ? message.capability : message.code) || message.deviceId === this.settings.deviceId) { this.reject(socket, 'auth'); return null; }
    // Concurrent automatic initiation chooses one token without changing the
    // v1 owner-pair shape. The smaller device ID keeps its outbound request;
    // the other side cancels its contender before saving the inbound approval.
    const contenders = owned ? [...this.ownerRequests].filter(controller => controller.automatic && !controller.signal.aborted && (!controller.remoteDeviceId || controller.remoteDeviceId === message.deviceId)) : [];
    if (contenders.length) {
      if (this.settings.deviceId < message.deviceId) { this.reject(socket, 'auth'); return null; }
      for (const controller of contenders) controller.abort();
    }
    // Consume before awaiting persistence so one code authorizes exactly one pairing.
    if (owned) { this.ownerBootstrap = null; await this.refreshOwnerBootstrap(true); } else this.pairing = null;
    if (!this.active() || epoch !== this.epoch || (owned && !this.canLink()) || socket.destroyed) { this.reject(socket, 'auth'); return null; }
    const previous = this.peers.find(item => item.id === message.deviceId);
    if (!previous && this.peers.length >= 32) { this.reject(socket, 'size'); return null; }
    const peer = { id: message.deviceId, remoteDeviceId: message.deviceId, label: message.label, hostLabel: message.label, direction: inverse(message.direction), paused: false, token: crypto.randomBytes(32).toString('hex'), socket, sshTarget: null };
    this.peers = this.peers.filter(item => item.id !== peer.id); this.peers.push(peer);
    let saved = false;
    try {
      await this.savePeers();
      saved = true;
      if (!this.active() || (owned && !this.canLink()) || epoch !== this.epoch || socket.destroyed || !this.peers.includes(peer)) throw new Error('Paused');
      socket.write(protocol.encodeFrame({ v: 1, type: 'pair-ok', deviceId: this.settings.deviceId, label: localName(), token: peer.token, direction: peer.direction }));
      this.dropSocket(previous); this.error = ''; this.emit(); this.offerLatest(peer); return peer;
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
    const epoch = this.epoch;
    if (!this.rememberSeen(message.eventId)) return false;
    const previousNewest = this.newestEvent, previousLocal = this.latestLocal;
    const newest = !this.settings.continuity || this.isNewer(message);
    if (newest) {
      this.newestEvent = { eventId: message.eventId, createdAt: message.createdAt };
      this.latestLocal = null;
      for (const [id, pending] of this.pending) if (pending.createdAt < message.createdAt || (pending.createdAt === message.createdAt && pending.eventId < message.eventId)) this.pending.delete(id);
    }
    try {
      await this.onItem({ eventId: message.eventId, originDeviceId: message.originDeviceId, originLabel: peer.label, kind: message.kind, text: message.text, png: message.png, createdAt: message.createdAt, receiveMode: newest ? this.settings.receiveMode : 'history' });
      if (newest && this.newestEvent?.eventId === message.eventId && this.settings.continuity && this.canSend() && epoch === this.epoch) await this.fanout({ ...message, originDeviceId: this.settings.deviceId }, peer.id);
      return true;
    } catch {
      this.seen.delete(message.eventId); this.seenTimes.delete(message.eventId);
      if (this.newestEvent?.eventId === message.eventId) { this.newestEvent = previousNewest; this.latestLocal = previousLocal; }
      this.noteError('An incoming clipboard item could not be saved.'); return false;
    }
  }
  async shutdown() {
    this.closed = true; this.settings.enabled = false; this.epoch += 1; this.pairing = null; this.pending.clear(); this.latestLocal = null;
    await this.closeListener(); await Promise.allSettled([this.writes, this.deliveries]);
  }
}
module.exports = { ClipboardSync, STORAGE_MESSAGE, targetKey };
