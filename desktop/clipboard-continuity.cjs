'use strict';

const { targetKey } = require('./clipboard-sync.cjs');
const INTERVAL_MS = 30000;
const MAX_HOSTS = 32;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

// Only saved, already-ready SSH routes are eligible. This coordinator never
// discovers, probes, establishes trust, requests credentials, or changes peers.
class ClipboardContinuity {
  constructor({ sync, getHosts = async () => [], targetForHost, linkHost, isBlocked = () => false, onChange = () => {}, now = Date.now } = {}) {
    this.sync = sync; this.getHosts = getHosts; this.targetForHost = targetForHost;
    this.linkHost = linkHost || (host => sync.pairOwnedWith({ hostLabel: host.name, sshTarget: targetForHost(host), direction: 'both', automatic: true }));
    this.isBlocked = isBlocked; this.onChange = onChange; this.now = now;
    this.timer = null; this.running = false; this.closed = false; this.operation = null;
    this.epoch = 0; this.devices = []; this.attempts = new Map();
  }
  state() { return { running: this.running, devices: this.devices.map(device => ({ ...device })) }; }
  emit() { try { this.onChange(this.state()); } catch { /* Observers cannot stop scheduling. */ } }
  eligible() {
    try { return !this.closed && this.sync.state().continuity === true && this.sync.canLink() && this.sync.canSend() && this.isBlocked() !== true; }
    catch { return false; }
  }
  start() {
    if (this.closed) return Promise.resolve(this.state());
    this.running = true;
    if (!this.timer) { this.timer = setInterval(() => this.tick().catch(() => {}), INTERVAL_MS); this.timer.unref?.(); }
    return this.tick();
  }
  tick() {
    if (this.operation) return this.operation;
    const epoch = this.epoch;
    this.operation = this.run(epoch).catch(() => { /* Background failures are quiet and bounded. */ }).finally(() => { this.operation = null; });
    return this.operation;
  }
  async run(epoch) {
    await this.sync.ready;
    if (!this.eligible() || epoch !== this.epoch) { this.devices = []; this.emit(); return; }
    let hosts;
    try { hosts = await this.getHosts(); } catch { return; }
    if (!Array.isArray(hosts) || !this.eligible() || epoch !== this.epoch) return;
    const targets = new Set(), current = new Set();
    const candidates = [];
    for (const host of hosts) {
      if (!host || host.status !== 'ready' || typeof host.id !== 'string' || typeof host.name !== 'string' || !host.name.length || host.name.length > 80 || /[\x00-\x1f\x7f]/.test(host.name)) continue;
      let target, key; try { target = this.targetForHost(host); key = targetKey(target); } catch { continue; }
      if (targets.has(key) || candidates.length >= MAX_HOSTS) continue;
      targets.add(key); current.add(key); candidates.push({ host, target, key });
    }
    for (const key of this.attempts.keys()) if (!current.has(key)) this.attempts.delete(key);
    this.devices = candidates.map(({ host }) => ({ hostId: host.id, label: host.name, status: 'waiting' }));
    for (let index = 0; index < candidates.length; index++) {
      if (!this.eligible() || epoch !== this.epoch) return;
      const { host, target, key } = candidates[index];
      const view = this.devices[index];
      if (this.sync.isExcludedTarget(target)) { view.status = 'excluded'; continue; }
      if (this.sync.hasTarget(target)) {
        const peer = this.sync.peers.find(item => item.sshTarget && targetKey(item.sshTarget) === key);
        view.status = peer?.paused ? 'paused' : peer?.socket && !peer.socket.destroyed ? 'connected' : 'offline'; continue;
      }
      if (this.sync.peers.length >= MAX_HOSTS) { view.status = 'waiting'; view.detail = 'The 32-device limit has been reached.'; continue; }
      let attempt = this.attempts.get(key);
      if (attempt?.peerId) {
        const state = this.sync.state();
        const peer = state.peers.find(item => item.id === attempt.peerId);
        if (peer) { view.status = peer.paused ? 'paused' : peer.status; continue; }
        if (state.excludedPeers?.some(item => item.id === attempt.peerId)) { view.status = 'excluded'; continue; }
        this.attempts.delete(key); attempt = undefined;
      }
      if (attempt?.nextAt > this.now()) { view.status = attempt.status; continue; }
      view.status = 'connecting'; this.emit();
      try {
        const result = await this.linkHost(host);
        if (!this.eligible() || epoch !== this.epoch) return;
        const linked = this.sync.hasTarget(target);
        // A successful identity lookup may resolve a self route or an existing
        // peer through another alias. Do not repeatedly retrieve its bootstrap.
        this.attempts.set(key, { failures: 0, nextAt: result?.skippedSelf || result?.linkedPeerId ? Number.POSITIVE_INFINITY : this.now() + INTERVAL_MS, peerId: result?.linkedPeerId, status: linked ? 'connected' : 'waiting' });
        view.status = linked ? 'connected' : 'waiting';
      } catch {
        if (!this.eligible() || epoch !== this.epoch) return;
        const failures = Math.min((attempt?.failures || 0) + 1, 6);
        this.attempts.set(key, { failures, nextAt: this.now() + Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** (failures - 1)), status: 'waiting' });
        view.status = 'waiting';
        view.detail = 'Waiting for ShelfDock with Clipboard tools and sync enabled.';
      }
      this.emit();
    }
    this.emit();
  }
  stop() {
    this.running = false; this.epoch += 1; clearInterval(this.timer); this.timer = null;
    if (this.operation) this.sync.cancelAutomaticOwnerRequests?.();
    this.devices = []; this.emit();
  }
  async shutdown() { this.closed = true; this.stop(); await this.operation; }
}
module.exports = { ClipboardContinuity, INTERVAL_MS, MAX_BACKOFF_MS };
