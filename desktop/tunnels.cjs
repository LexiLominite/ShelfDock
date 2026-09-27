'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { endpointKey } = require('./password-auth.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const publicPlan = ({ endpoint, ...plan }) => plan;
function note(value = '') {
  if (typeof value !== 'string' || value.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Use a note of at most 500 characters, without control characters.');
  return value.trim();
}
function validate(input) {
  if (!input || !['local', 'remote'].includes(input.mode)) throw new Error('Choose local or remote forwarding.');
  let targetHost = typeof input.targetHost === 'string' ? input.targetHost.trim().replace(/^\[([^\]]+)\]$/, '$1') : '';
  if (!targetHost || targetHost.length > 253 || !(net.isIP(targetHost) || /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(targetHost)) || targetHost.includes('..')) throw new Error('Enter a target hostname or IP address without a URL, spaces, or command options.');
  const ports = {};
  for (const field of ['targetPort', 'listenPort']) {
    if (typeof input[field] !== 'number' && typeof input[field] !== 'string') throw new Error('Choose ports between 1 and 65535.');
    const port = Number(input[field]); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose ports between 1 and 65535.');
    ports[field] = port;
  }
  if (input.remember !== undefined && typeof input.remember !== 'boolean') throw new Error('Choose whether to remember this forwarding plan.');
  return { mode: input.mode, targetHost, ...ports, note: note(input.note), remember: input.remember === true };
}

function listenerCommand(host, port) {
  if (host.os === 'windows') {
    const script = `$ErrorActionPreference='Stop'; [Console]::WriteLine('DRIFT_BIND_WINDOWS'); Get-NetTCPConnection -State Listen -LocalPort ${port} | ForEach-Object { [Console]::WriteLine($_.LocalAddress) }`;
    return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
  }
  return `if command -v ss >/dev/null 2>&1; then printf 'DRIFT_BIND_SS\\n'; ss -H -ltn 'sport = :${port}'; elif command -v lsof >/dev/null 2>&1; then printf 'DRIFT_BIND_LSOF\\n'; lsof -nP -a -iTCP:${port} -sTCP:LISTEN -Fn; else exit 1; fi`;
}
function verifyListener(stdout, port) {
  const lines = String(stdout).split(/\r?\n/); let format; const addresses = [];
  for (const line of lines) {
    if (/^DRIFT_BIND_(SS|LSOF|WINDOWS)$/.test(line)) { format = line.slice(11); continue; }
    if (!line.trim() || !format) continue;
    if (format === 'WINDOWS') addresses.push(line.trim());
    else {
      let address = format === 'SS' ? line.trim().split(/\s+/)[3] : line.startsWith('n') ? line.slice(1) : '';
      if (!address) continue;
      if (!address.endsWith(':' + port)) throw new Error('The remote listener returned an unexpected address.');
      addresses.push(address.slice(0, -String(port).length - 1).replace(/^\[|\]$/g, ''));
    }
  }
  if (!addresses.length || addresses.some(address => !(address === '::1' || /^127(?:\.\d{1,3}){3}$/.test(address)))) throw new Error('The remote listener could not be verified as loopback-only. Check the SSH server’s GatewayPorts policy and listener-inspection tools before retrying.');
}

class TunnelManager {
  constructor({ dataDir, service, onChange = () => {}, spawnProcess = spawn, network = net, startupTimeout = 15000 } = {}) {
    if (!dataDir || !service) throw new Error('Forwarding needs an app data directory and machine service.');
    this.dataDir = dataDir; this.service = service; this.onChange = onChange; this.spawnProcess = spawnProcess; this.network = network; this.startupTimeout = startupTimeout;
    this.file = path.join(dataDir, 'tunnels.json'); this.active = new Map(); this.history = []; this.writeChain = Promise.resolve(); this.closed = false;
    this.initialized = this.load();
  }
  async load() {
    try {
      const stat = await fs.stat(this.file); if (stat.size > 1024 * 1024) throw new Error('Oversized forwarding history.');
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.history)) throw new Error('Invalid forwarding history.');
      for (const entry of saved.history.slice(0, 100)) {
        try {
          const settings = validate(entry);
          if (!/^[a-f0-9-]{36}$/.test(entry.id) || typeof entry.hostId !== 'string' || typeof entry.hostName !== 'string' || !/^[a-f0-9]{64}$/.test(entry.endpoint)) continue;
          this.history.push({ id: entry.id, hostId: entry.hostId, hostName: entry.hostName.slice(0, 120), endpoint: entry.endpoint, mode: settings.mode, targetHost: settings.targetHost, targetPort: settings.targetPort, listenPort: settings.listenPort, note: settings.note, lastUsedAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : null });
        } catch {}
      }
    } catch (error) { if (error.code !== 'ENOENT') this.warning = 'Saved forwarding plans could not be loaded. Existing machine settings are unchanged.'; }
  }
  snapshot() { return { active: [...this.active.values()].map(record => clone(record.view)), history: this.history.map(entry => clone(publicPlan(entry))), ...(this.warning ? { warning: this.warning } : {}) }; }
  async getState() { await this.initialized; return this.snapshot(); }
  emit() { try { this.onChange(this.snapshot()); } catch {} }
  async changeHistory(change) {
    await this.initialized;
    const next = this.writeChain.catch(() => {}).then(async () => {
      const updated = change(clone(this.history)).slice(0, 100);
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
      try { await fs.writeFile(temporary, JSON.stringify({ version: 1, history: updated }, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, this.file); this.history = updated; }
      finally { await fs.unlink(temporary).catch(() => {}); }
    }); this.writeChain = next; await next;
  }
  assertIdle() {
    if (this.closed) throw new Error('Forwarding is shutting down.');
    if (this.service.macInstallation) throw new Error('Wait for Mac installation to finish before starting a forward.');
    if (this.service.authenticationSetup || this.service.configurationImport) throw new Error('Wait for machine access or configuration setup to finish before starting a forward.');
  }
  async start(input) { return this.startPlan(input); }
  async startPlan(input, expectedEndpoint) {
    await this.initialized; this.assertIdle(); const settings = validate(input);
    const state = await this.service.getState(); this.assertIdle();
    const live = state.hosts.find(host => host.id === input.hostId);
    if (!live || !live.user) throw new Error('Choose a saved machine with an SSH login username.');
    const host = clone(live); const endpoint = endpointKey(host);
    if (expectedEndpoint && expectedEndpoint !== endpoint) throw new Error('This machine’s connection details changed. Review and create a new forwarding plan instead of restarting the old one.');
    if ([...this.active.values()].some(record => ['starting', 'running'].includes(record.view.status) && record.view.mode === settings.mode && record.view.listenPort === settings.listenPort && (settings.mode === 'local' || record.endpoint === endpoint))) throw new Error('A forward is already using that listening port. Stop it or choose another port.');
    if ([...this.active.values()].filter(record => ['starting', 'running'].includes(record.view.status)).length >= 20) throw new Error('Up to 20 forwards can run at once. Stop one before starting another.');
    const id = crypto.randomUUID(); const record = { endpoint, host, sockets: new Set(), channels: new Set(), stopped: false, view: { id, hostId: host.id, hostName: host.name, mode: settings.mode, targetHost: settings.targetHost, targetPort: settings.targetPort, listenPort: settings.listenPort, note: settings.note, status: 'starting', startedAt: new Date().toISOString() } };
    this.active.set(id, record); this.service.tunnelSetup = (this.service.tunnelSetup || 0) + 1; this.emit();
    try {
      if (settings.remember) {
        await this.changeHistory(history => {
          const prior = history.find(entry => entry.endpoint === endpoint && entry.mode === settings.mode && entry.targetHost === settings.targetHost && entry.targetPort === settings.targetPort && entry.listenPort === settings.listenPort);
          const plan = { ...record.view, id: prior?.id || crypto.randomUUID(), endpoint, lastUsedAt: new Date().toISOString() }; delete plan.status; delete plan.startedAt;
          record.view.historyId = plan.id;
          return [plan, ...history.filter(entry => entry.id !== plan.id)];
        });
      }
      if (record.stopped) return this.snapshot();
      if (this.service.passwordAuth.metadata(host).hasSavedPassword) await this.startPassword(record);
      else await this.startNative(record);
      if (!record.stopped) { record.view.status = 'running'; this.emit(); }
    } catch (error) { if (!record.stopped) await this.fail(record, error.message || 'Forwarding could not be started.'); }
    finally { this.service.tunnelSetup = Math.max(0, (this.service.tunnelSetup || 1) - 1); }
    return this.snapshot();
  }
  async verifyRemote(record, session) {
    const command = listenerCommand(record.host, record.view.listenPort);
    const result = session ? await session.exec(command, 9000) : await this.service.run('ssh', ['-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ForkAfterAuthentication=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...this.service.sshArgs(record.host), command], { timeout: 10000 });
    verifyListener(result.stdout, record.view.listenPort);
  }
  async startNative(record) {
    const args = this.service.sshArgs(record.host);
    const resolved = await this.service.run('ssh', ['-G', ...args]).catch(() => { throw new Error('OpenSSH could not resolve this machine’s connection settings. Check its SSH alias and client installation.'); });
    if (/^(localforward|remoteforward|dynamicforward)\s+/mi.test(resolved.stdout) || /^clearallforwardings\s+yes$/mi.test(resolved.stdout)) throw new Error('This SSH alias already defines forwarding rules. Use a direct machine route or an alias without other forwards so only the selected port is opened.');
    if (record.stopped) return;
    const target = net.isIP(record.view.targetHost) === 6 ? '[' + record.view.targetHost + ']' : record.view.targetHost;
    const forwarding = `127.0.0.1:${record.view.listenPort}:${target}:${record.view.targetPort}`;
    const child = this.spawnProcess('ssh', ['-N', '-T', '-v', '-o', 'ExitOnForwardFailure=yes', '-o', 'PermitLocalCommand=no', '-o', 'ForkAfterAuthentication=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', record.view.mode === 'local' ? '-L' : '-R', forwarding, ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    record.child = child; if (child.pid) record.view.pid = child.pid;
    let authenticated = false; let forwarded = false; let buffer = ''; let settled = false; let checking = false;
    await new Promise((resolve, reject) => {
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); record.cancelStartup = null; error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error('SSH forwarding did not become ready in time. Check SSH authentication and the selected port.')), this.startupTimeout);
      record.cancelStartup = () => finish(new Error('Forwarding was stopped.'));
      const ready = async () => {
        if (!authenticated || !forwarded || settled || checking) return;
        checking = true;
        try { if (record.view.mode === 'remote') await this.verifyRemote(record); if (record.stopped || record.exited) throw new Error('Forwarding closed before it became ready.'); finish(); }
        catch (error) { finish(error); }
      };
      child.stderr?.on('data', bytes => {
        buffer = (buffer + bytes.toString('utf8')).slice(-12000);
        if (/forwarding listen address .* overridden|GatewayPorts.*override/i.test(buffer)) { const error = new Error('The SSH server overrode the requested loopback address. Change its GatewayPorts policy before forwarding.'); if (!settled) finish(error); else void this.fail(record, error.message); return; }
        if (/Authenticated to |Authentication succeeded \(/i.test(buffer)) authenticated = true;
        if (record.view.mode === 'local' ? /Local forwarding listening on 127\.0\.0\.1 port \d+/i.test(buffer) : /remote forward success for:/i.test(buffer)) forwarded = true;
        void ready();
      });
      child.once('error', () => { const error = new Error('OpenSSH could not start. Install the SSH client and check this machine’s key authentication.'); if (!settled) finish(error); else void this.fail(record, error.message); });
      child.once('exit', (code, signal) => {
        record.exited = true;
        if (record.stopped) return;
        const error = new Error(/host key verification|identification has changed|no .*host key is known/i.test(buffer) ? 'Verify this machine’s SSH fingerprint in your terminal before forwarding.' : /permission denied|authentication failed/i.test(buffer) ? 'SSH key authentication failed. Check machine access before forwarding.' : /address already in use|cannot listen|forwarding failed/i.test(buffer) ? 'The listening port is unavailable or the SSH server refused forwarding.' : `SSH forwarding closed${signal ? ' after a signal' : code ? ' with an error' : ''}.`);
        if (!settled) finish(error); else void this.fail(record, error.message);
      });
    });
  }
  async startPassword(record) {
    let readyResolve; let readyReject; let startupDone = false;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timer = setTimeout(() => { if (!startupDone) readyReject(new Error('Password forwarding did not become ready in time.')); }, this.startupTimeout);
    record.cancelStartup = () => readyReject(new Error('Forwarding was stopped.'));
    record.task = this.service.passwordAuth.withPassword(record.host, async session => {
      record.session = session;
      if (record.stopped) throw new Error('Forwarding was stopped.');
      session.client.once('close', () => { if (!record.stopped) void this.fail(record, 'The SSH forwarding connection closed.'); });
      if (record.view.mode === 'local') {
        const server = this.network.createServer(socket => {
          if (record.sockets.size >= 64) { socket.destroy(); return; }
          record.sockets.add(socket); socket.pause(); socket.on('error', () => {}); socket.once('close', () => record.sockets.delete(socket));
          const pending = setTimeout(() => socket.destroy(), 15000);
          socket.once('close', () => clearTimeout(pending));
          session.client.forwardOut('127.0.0.1', socket.remotePort || 0, record.view.targetHost, record.view.targetPort, (error, channel) => {
            clearTimeout(pending);
            if (error || record.stopped || socket.destroyed) { socket.destroy(); channel?.destroy(); return; }
            this.pipe(record, socket, channel); socket.resume();
          });
        }); server.maxConnections = 64; record.server = server;
        server.on('error', () => { if (startupDone && !record.stopped) void this.fail(record, 'The local forwarding listener failed.'); });
        await new Promise((resolve, reject) => { server.once('error', () => reject(new Error('The local listening port is unavailable.'))); server.listen(record.view.listenPort, '127.0.0.1', resolve); });
      } else {
        session.client.on('tcp connection', (details, accept, reject) => {
          if (record.stopped || record.sockets.size >= 64 || details.destIP !== '127.0.0.1' || details.destPort !== record.view.listenPort) return reject();
          const channel = accept(); const socket = this.network.connect({ host: record.view.targetHost, port: record.view.targetPort });
          const pending = setTimeout(() => socket.destroy(), 15000);
          socket.once('connect', () => clearTimeout(pending)); socket.once('close', () => clearTimeout(pending));
          this.pipe(record, socket, channel);
        });
        await new Promise((resolve, reject) => session.client.forwardIn('127.0.0.1', record.view.listenPort, error => error ? reject(new Error('The SSH server refused the remote listening port.')) : resolve()));
        await this.verifyRemote(record, session);
      }
      if (record.stopped) throw new Error('Forwarding was stopped.');
      startupDone = true; clearTimeout(timer); record.cancelStartup = null; readyResolve();
      await new Promise(resolve => { record.release = resolve; });
    }).catch(error => { if (!startupDone) readyReject(error); else if (!record.stopped) return this.fail(record, error.message || 'Password forwarding failed.'); }).finally(() => clearTimeout(timer));
    await ready;
  }
  pipe(record, socket, channel) {
    record.sockets.add(socket); record.channels.add(channel);
    socket.on('error', () => channel.destroy()); channel.on('error', () => socket.destroy());
    socket.once('close', () => { record.sockets.delete(socket); channel.destroy(); }); channel.once('close', () => { record.channels.delete(channel); socket.destroy(); });
    socket.pipe(channel); channel.pipe(socket);
  }
  async cleanup(record) {
    record.stopped = true; record.cancelStartup?.(); record.cancelStartup = null;
    for (const socket of record.sockets) socket.destroy(); for (const channel of record.channels) channel.destroy();
    if (record.server) await new Promise(resolve => { try { record.server.close(resolve); } catch { resolve(); } });
    record.release?.(); record.session?.close();
    if (record.child && !record.exited) await new Promise(resolve => {
      let done = false; const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { record.child.kill('SIGKILL'); finish(); }, 1500);
      record.child.once('exit', finish); record.child.kill('SIGTERM');
    });
  }
  async fail(record, error) {
    if (record.stopped) return;
    record.view.status = 'failed'; record.view.error = String(error).slice(0, 500);
    await this.cleanup(record); this.emit();
  }
  async stop(id) { await this.initialized; const record = this.active.get(id); if (!record) return this.snapshot(); await this.cleanup(record); this.active.delete(id); this.emit(); return this.snapshot(); }
  async removeHistory(id) { await this.changeHistory(history => history.filter(entry => entry.id !== id)); this.emit(); return this.snapshot(); }
  async updateNote({ id, note: value } = {}) {
    const updated = note(value);
    await this.changeHistory(history => { const plan = history.find(entry => entry.id === id); if (!plan) throw new Error('That forwarding plan is no longer saved.'); plan.note = updated; return history; });
    for (const record of this.active.values()) if (record.view.historyId === id) record.view.note = updated;
    this.emit(); return this.snapshot();
  }
  async restart(id) {
    await this.initialized; const plan = this.history.find(entry => entry.id === id); if (!plan) throw new Error('That forwarding plan is no longer saved.');
    return this.startPlan({ ...publicPlan(plan), remember: true }, plan.endpoint);
  }
  async shutdown() { this.closed = true; await Promise.all([...this.active.values()].map(record => this.cleanup(record))); this.active.clear(); }
}

module.exports = { TunnelManager, validateTunnel: validate, verifyListener, listenerCommand };
