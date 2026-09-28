'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile: nodeExecFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateClipboardPNG } = require('./clipboard.cjs');
const { PasswordAuth, endpointKey, validatePassword } = require('./password-auth.cjs');
const { RECEIPT_NAME, encodeManifest } = require('./received.cjs');

const execFileAsync = promisify(nodeExecFile);
const DEFAULT_SETTINGS = Object.freeze({ shakeEnabled: true, sensitivity: 'strong', sendImmediately: false, viewMode: 'expanded', deviceName: '' });
const DEFAULT_DESTINATION = '~/Desktop';
const PUBLIC_HOST_FIELDS = ['id', 'name', 'address', 'user', 'port', 'identityFile', 'sshAlias', 'route', 'source', 'destination', 'status', 'error', 'os', 'online'];
const clone = (value) => JSON.parse(JSON.stringify(value));
const idFor = (address, user, port) => 'host-' + crypto.createHash('sha256').update(`${address.toLowerCase()}\0${user}\0${port}`).digest('hex').slice(0, 20);
const identityFor = (host) => `${host.address.toLowerCase()}\0${host.user}\0${host.port}`;
const quoteRemote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const nameKey = value => value.normalize('NFC').toLowerCase();
const invalidWindowsName = value => /[<>:\u0022|?*]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value);
const hasControl = (value) => /[\x00-\x1f\x7f]/.test(value);
const isTailscaleIP = (address) => net.isIP(address) === 4 && /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);
function messageFor(error) { return String(error && (error.stderr || error.message) || error || 'Unknown error').trim().slice(0, 1200); }
function expandHome(value, home) { return value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value; }
function validateHost(raw, { manual = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Enter a valid machine configuration.');
  const address = String(raw.address || '').trim().replace(/^\[([^\]]+)\]$/, '$1');
  if (!address || address.length > 253 || !(net.isIP(address) || /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(address)) || address.includes('..')) throw new Error('Use a hostname or an IPv4/IPv6 address, without a URL, spaces, or command options.');
  const user = String(raw.user || '').trim();
  if (user && (!/^[A-Za-z0-9_][A-Za-z0-9_.@\\-]*$/.test(user) || user.length > 128)) throw new Error('Enter a valid SSH login username.');
  if (manual && !user) throw new Error('A manual machine needs its SSH login username.');
  const port = raw.port === undefined || raw.port === '' ? 22 : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535.');
  const name = String(raw.name || address).trim();
  if (!name || name.length > 120 || hasControl(name)) throw new Error('Machine name must be a single line of at most 120 characters.');
  const identityFile = Array.isArray(raw.identityFile) ? String(raw.identityFile[0] || '') : String(raw.identityFile || '');
  if (identityFile && (hasControl(identityFile) || identityFile.length > 4096 || !(path.isAbsolute(identityFile) || identityFile.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(identityFile)))) throw new Error('SSH key must use an absolute path or a path beginning with ~/.');
  const sshAlias = String(raw.sshAlias || '');
  if (sshAlias && !/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(sshAlias)) throw new Error('Invalid SSH alias.');
  const remoteOS = raw.os === 'windows' ? 'windows' : 'posix';
  const destination = String(raw.destination || DEFAULT_DESTINATION).trim();
  if (!destination || destination.length > 4096 || hasControl(destination)) throw new Error('Destination must be a single valid folder path.');
  if (remoteOS === 'posix' && !(destination.startsWith('/') || destination === '~' || destination.startsWith('~/'))) throw new Error('Use an absolute remote folder or a folder beginning with ~/ (for example ~/Desktop).');
  if (remoteOS === 'windows' && !(/^[A-Za-z]:[\\/]/.test(destination) || destination === '~' || destination.startsWith('~/'))) throw new Error('For Windows, use a drive path such as C:/Users/you/Desktop or ~/Desktop.');
  const route = ['tailscale', 'lan', 'ssh'].includes(raw.route) ? raw.route : isTailscaleIP(address) ? 'tailscale' : /\.local$/i.test(address) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || address === 'localhost' ? 'lan' : 'ssh';
  const source = ['Wave', 'SSH', 'Tailscale', 'Manual'].includes(raw.source) ? raw.source : 'Manual';
  return { id: String(raw.id || idFor(address, user, port)), name, address, user, port, identityFile, sshAlias, route, source, destination, status: raw.status || (user ? 'unknown' : 'auth-required'), os: remoteOS, ...(typeof raw.online === 'boolean' ? { online: raw.online } : {}) };
}

function tokenize(line) {
  const tokens = []; let token = ''; let quote = ''; let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (!quote && c === '#') break;
    if (c === '\\' && i + 1 < line.length && (!quote || quote === '"')) { token += line[++i]; started = true; continue; }
    if (c === '"' || c === "'") { if (quote === c) quote = ''; else if (!quote) quote = c; else token += c; started = true; continue; }
    if (!quote && /\s/.test(c)) { if (started) { tokens.push(token); token = ''; started = false; } }
    else { token += c; started = true; }
  }
  if (started) tokens.push(token);
  return tokens;
}
async function globFiles(pattern) {
  if (!/[?*]/.test(pattern)) return [pattern];
  const pieces = path.resolve(pattern).split(path.sep).filter(Boolean); let roots = [path.parse(path.resolve(pattern)).root];
  for (const piece of pieces) {
    const next = [];
    for (const root of roots) {
      if (!/[?*]/.test(piece)) { next.push(path.join(root, piece)); continue; }
      const regex = new RegExp('^' + piece.split('').map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
      try { for (const name of await fs.readdir(root)) if (regex.test(name)) next.push(path.join(root, name)); } catch {}
    }
    roots = next;
  }
  return roots.sort();
}
async function readSSHAliases(file, home, seen = new Set(), depth = 0) {
  file = path.resolve(file);
  if (depth > 12 || seen.has(file)) return [];
  seen.add(file); let content;
  try { content = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const aliases = [];
  for (const line of content.split(/\r?\n/)) {
    const parts = tokenize(line.replace(/^\s*([A-Za-z]+)\s*=\s*/, '$1 ')); const key = (parts.shift() || '').toLowerCase();
    if (key === 'host') for (const value of parts) if (/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(value)) aliases.push(value);
    if (key === 'include') for (const pattern of parts) {
      const expanded = expandHome(pattern, home); const absolute = path.isAbsolute(expanded) ? expanded : path.join(home, '.ssh', expanded);
      for (const included of await globFiles(absolute)) aliases.push(...await readSSHAliases(included, home, seen, depth + 1));
    }
  }
  return [...new Set(aliases)];
}
function parseSSHConfig(stdout) {
  const resolved = {};
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.indexOf(' '); if (i < 0) continue;
    const key = line.slice(0, i).toLowerCase(); const value = line.slice(i + 1).trim();
    if (['hostname', 'user', 'port', 'identityfile'].includes(key) && resolved[key] === undefined) resolved[key] = value;
  }
  return resolved;
}
async function mapLimit(values, limit, callback) {
  let index = 0; const results = new Array(values.length);
  async function worker() { while (index < values.length) { const i = index++; results[i] = await callback(values[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker)); return results;
}
function classifySSHError(error) {
  const message = messageFor(error);
  if (/permission denied|authentication failed|too many authentication|host key verification|remote host identification|no .*host key is known|no matching host key|identity file|private key|passphrase/i.test(message)) return { status: 'auth-required', error: /host key|host identification/i.test(message) ? 'SSH trust needs attention. Connect once in your terminal and verify the machine’s fingerprint, then check again. ' + message : message };
  if (/timed out|timeout|refused|no route|unreachable|could not resolve|connection .*closed|reset by peer|EHOST|ENET|ECONN/i.test(message) || error.killed || error.code === 'ETIMEDOUT') return { status: 'offline', error: message };
  return { status: 'auth-required', error: message };
}

class DriftService {
  constructor({ dataDir, onChange = () => {}, homeDir = os.homedir(), execFile = execFileAsync, platform = process.platform, safeStorage, passwordAuth, clock = Date.now } = {}) {
    if (!dataDir) throw new Error('Drift needs an application data directory.');
    this.dataDir = dataDir; this.homeDir = homeDir; this.onChange = onChange; this.executor = execFile; this.platform = platform;
    this.passwordAuth = passwordAuth || new PasswordAuth({ dataDir, homeDir, platform, safeStorage, run: (...args) => this.run(...args) });
    this.authenticationSetup = false; this.clock = clock; this.pendingClear = null; this.clearCleanup = []; this.clearUndoTimer = null;
    this.manualHosts = []; this.overrides = {}; this.hiddenHosts = []; this.transferring = false; this.scanPromise = null; this.probePromise = null;
    this.state = { hosts: [], items: [], history: [], settings: { ...DEFAULT_SETTINGS }, discovery: { warnings: [], lastScan: null }, environment: { platform, sshAvailable: false, tailscaleAvailable: false, wayland: platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY) } };
    this.initialized = this.load(); this.writeChain = Promise.resolve(); this.shelfMutation = Promise.resolve();
  }
  async load() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.dataDir, 'state.json'), 'utf8'));
      this.manualHosts = (saved.manualHosts || []).map(host => validateHost(host, { manual: true }));
      this.overrides = saved.overrides || {}; this.hiddenHosts = saved.hiddenHosts || [];
      this.state.items = (saved.items || []).filter(item => item && typeof item.id === 'string' && typeof item.path === 'string' && ['file', 'folder', 'text'].includes(item.kind)).slice(0, 500);
      if (saved.pendingClear && Array.isArray(saved.pendingClear.items) && Number.isFinite(Date.parse(saved.pendingClear.expiresAt))) {
        this.pendingClear = { id: String(saved.pendingClear.id || crypto.randomUUID()), expiresAt: new Date(Math.min(Date.parse(saved.pendingClear.expiresAt), this.clock() + 10000)).toISOString(), items: saved.pendingClear.items.filter(item => item && typeof item.id === 'string' && typeof item.path === 'string' && ['file', 'folder', 'text'].includes(item.kind)).slice(0, 500) };
      }
      this.clearCleanup = (Array.isArray(saved.clearCleanup) ? saved.clearCleanup : []).filter(item => this.ownedStagedPath(item)).slice(0, 2000);
      this.state.history = (saved.history || []).slice(0, 100).map(entry => entry.status === 'sending' ? { ...entry, status: 'failed', message: 'The app closed before this transfer finished. Check the destination before retrying.' } : entry);
      this.state.settings = { ...DEFAULT_SETTINGS, ...this.validSettings(saved.settings || {}) };
      this.state.hosts = clone(this.manualHosts);
    } catch (error) { if (error.code !== 'ENOENT') this.state.discovery.warnings.push('Saved settings could not be loaded: ' + messageFor(error)); }
    this.scheduleClearUndo();
  }
  validSettings(patch) {
    const settings = {};
    if ('shakeEnabled' in patch) { if (typeof patch.shakeEnabled !== 'boolean') throw new Error('Invalid shake setting.'); settings.shakeEnabled = patch.shakeEnabled; }
    if ('sensitivity' in patch) { if (!['gentle', 'normal', 'strong'].includes(patch.sensitivity)) throw new Error('Invalid shake sensitivity.'); settings.sensitivity = patch.sensitivity; }
    if ('viewMode' in patch) { if (!['compact', 'expanded', 'large'].includes(patch.viewMode)) throw new Error('Choose Compact, Expanded, or Large view.'); settings.viewMode = patch.viewMode; }
    if ('deviceName' in patch) { if (typeof patch.deviceName !== 'string' || patch.deviceName.trim().length > 64 || hasControl(patch.deviceName) || /[\u202a-\u202e\u2066-\u2069]/.test(patch.deviceName)) throw new Error('Device name must be a single line of up to 64 characters.'); settings.deviceName = patch.deviceName.trim(); }
    if ('sendImmediately' in patch) { if (typeof patch.sendImmediately !== 'boolean') throw new Error('Invalid send setting.'); settings.sendImmediately = patch.sendImmediately; }
    return settings;
  }
  decoratedState() {
    const state = clone(this.state);
    state.hosts = state.hosts.map(host => ({ ...host, ...this.passwordAuth.metadata(host) }));
    state.environment.passwordStorageAvailable = this.passwordAuth.storageAvailable();
    state.clearShelfUndo = this.pendingClear && Date.parse(this.pendingClear.expiresAt) > this.clock() ? { count: this.pendingClear.items.length, expiresAt: this.pendingClear.expiresAt } : null;
    return state;
  }
  emit() { try { this.onChange(this.decoratedState()); } catch {} }
  async persist() {
    const serialized = JSON.stringify({ version: 1, manualHosts: this.manualHosts, overrides: this.overrides, hiddenHosts: this.hiddenHosts, items: this.state.items, pendingClear: this.pendingClear, clearCleanup: this.clearCleanup, history: this.state.history.slice(0, 100), settings: this.state.settings }, null, 2);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const temporary = path.join(this.dataDir, 'state-' + crypto.randomUUID() + '.tmp');
      await fs.writeFile(temporary, serialized, { mode: 0o600 }); await fs.rename(temporary, path.join(this.dataDir, 'state.json'));
    }); await this.writeChain;
  }
  async getState() { await this.initialized; await this.passwordAuth.initialized; return this.decoratedState(); }
  assertConfigurationIdle() { if (this.appUpdating) throw new Error('Wait for the app update to finish.'); if (this.macInstallation) throw new Error('Wait for Mac installation to finish.'); if (this.tunnelSetup) throw new Error('Wait for port forwarding setup to finish.'); if (this.authenticationSetup) throw new Error('Wait for machine access setup to finish.'); if (this.configurationImport) throw new Error('Wait for configuration import to finish.'); }
  mutateShelf(operation) {
    const next = this.shelfMutation.catch(() => {}).then(async () => {
      await this.initialized;
      this.assertConfigurationIdle();
      return operation();
    });
    this.shelfMutation = next;
    return next;
  }
  async run(command, args, options = {}) { return this.executor(command, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options }); }
  async resolveAlias(alias) { return parseSSHConfig((await this.run('ssh', ['-G', alias])).stdout); }
  async tailscaleStatus() {
    const candidates = this.platform === 'darwin' ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'] : ['tailscale'];
    let last;
    for (const binary of candidates) {
      try { const result = await this.run(binary, ['status', '--json']); const start = result.stdout.indexOf('{'); if (start < 0) throw new Error('Tailscale returned no device list.'); return JSON.parse(result.stdout.slice(start)); } catch (error) { last = error; }
    }
    if (last && last.code !== 'ENOENT') throw new Error('Tailscale device discovery is unavailable: ' + messageFor(last));
    return null;
  }
  async refreshHosts() {
    await this.initialized;
    this.assertConfigurationIdle();
    if (this.transferring) throw new Error('Wait for the current transfer to finish before checking machines.');
    if (this.configurationImport) throw new Error('Wait for configuration import to finish.');
    if (this.scanPromise) return this.scanPromise;
    if (this.probePromise) await this.probePromise;
    this.assertConfigurationIdle();
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scanHosts().finally(() => { this.scanPromise = null; }); return this.scanPromise;
  }
  async scanHosts() {
    const warnings = []; let sshAvailable = false;
    try { const version = await this.run('ssh', ['-V']); sshAvailable = true; this.sshMajor = Number(((version.stdout || '') + (version.stderr || '')).match(/OpenSSH[_ ](\d+)/)?.[1] || 0); } catch (error) { if (error.code !== 'ENOENT') warnings.push('OpenSSH could not be started: ' + messageFor(error)); }
    const sshAliases = sshAvailable ? await readSSHAliases(path.join(this.homeDir, '.ssh', 'config'), this.homeDir).catch(error => { warnings.push('SSH aliases could not be read: ' + messageFor(error)); return []; }) : [];
    const resolvedAliases = new Map();
    await mapLimit(sshAliases, 4, async alias => { try { resolvedAliases.set(alias.toLowerCase(), await this.resolveAlias(alias)); } catch (error) { warnings.push(`SSH alias ${alias} could not be resolved: ${messageFor(error)}`); } });
    const discovered = [];
    const add = (input) => { try { discovered.push(validateHost(input)); } catch (error) { warnings.push(`${input.name || 'Machine'} was skipped: ${messageFor(error)}`); } };
    const wavePaths = this.platform === 'win32' ? [path.join(process.env.APPDATA || path.join(this.homeDir, 'AppData', 'Roaming'), 'waveterm', 'config', 'connections.json'), path.join(this.homeDir, '.config', 'waveterm', 'connections.json')] : [path.join(this.homeDir, '.config', 'waveterm', 'connections.json')];
    let waveEntries = {};
    for (const file of wavePaths) {
      try { waveEntries = JSON.parse(await fs.readFile(file, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') warnings.push('Wave connections could not be read: ' + messageFor(error)); }
    }
    for (const [name, entry] of Object.entries(waveEntries)) {
      if (!entry || typeof entry !== 'object' || /^(local|wsl:|aws:|s3:)/i.test(name)) continue;
      const at = name.lastIndexOf('@'); const alias = at > 0 ? name.slice(at + 1) : name;
      let config = resolvedAliases.get(alias.toLowerCase()) || {};
      if (sshAvailable && !Object.keys(config).length && !entry['ssh:hostname']) {
        try { config = await this.resolveAlias(alias); } catch {}
      }
      const address = entry['ssh:hostname'] || config.hostname || alias;
      const explicitUser = entry['ssh:user'] || (at > 0 ? name.slice(0, at) : '') || (resolvedAliases.has(alias.toLowerCase()) ? config.user : '');
      add({ name, address, user: explicitUser, port: entry['ssh:port'] || config.port || 22, identityFile: entry['ssh:identityfile'] || '', sshAlias: /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(alias) ? alias : '', source: 'Wave', destination: DEFAULT_DESTINATION });
    }
    for (const [alias, config] of resolvedAliases) add({ name: alias, address: config.hostname || alias, user: config.user || '', port: config.port || 22, identityFile: '', sshAlias: sshAliases.find(name => name.toLowerCase() === alias), source: 'SSH', destination: DEFAULT_DESTINATION });
    let tailscale = null;
    try { tailscale = await this.tailscaleStatus(); } catch (error) { warnings.push(messageFor(error)); }
    this.state.environment.sshAvailable = sshAvailable;
    this.state.environment.tailscaleAvailable = Boolean(tailscale);
    if (tailscale && tailscale.BackendState && tailscale.BackendState !== 'Running') warnings.push('Tailscale is installed but is not connected. LAN and other SSH machines are still available.');
    if (!sshAvailable) warnings.push('Install the OpenSSH client to check machines and transfer files.');
    const selfIPs = new Set(tailscale && tailscale.Self && tailscale.Self.TailscaleIPs || []);
    const peers = Object.values(tailscale && tailscale.Peer || {});
    for (const peer of peers) {
      const addresses = peer.TailscaleIPs || [];
      const name = peer.HostName || String(peer.DNSName || '').replace(/\.$/, '').split('.')[0];
      if (addresses.some(address => selfIPs.has(address))) continue;
      const matches = discovered.filter(host => addresses.includes(host.address) || (peer.DNSName && peer.DNSName.replace(/\.$/, '') === host.address) || (!/\.local$/i.test(host.address) && host.address.toLowerCase() === name.toLowerCase()));
      const machineMatches = discovered.filter(host => matches.includes(host) || host.address.replace(/\.local$/i, '').toLowerCase() === name.replace(/\.local$/i, '').toLowerCase());
      for (const host of machineMatches) if (peer.OS === 'windows') host.os = 'windows';
      for (const host of matches) { host.route = 'tailscale'; host.online = peer.Online === true; if (!peer.Online) host.status = 'offline'; }
      if (!peer.Online) continue;
      if (/^nvsync[-_]/i.test(name)) { warnings.push(`${name} is an NVIDIA Sync endpoint; it was not imported as a standalone SSH machine. Add it manually if you know its SSH port and login.`); continue; }
      if (!matches.length && addresses.length) add({ name, address: addresses.find(isTailscaleIP) || addresses[0], user: '', port: 22, identityFile: '', sshAlias: '', source: 'Tailscale', route: 'tailscale', online: true, status: 'auth-required', destination: DEFAULT_DESTINATION, os: peer.OS === 'windows' ? 'windows' : 'posix' });
    }
    let hosts = discovered;
    if (selfIPs.size) warnings.push('This device is only listed as a destination if it was saved explicitly in Wave or SSH.');
    const byIdentity = new Map();
    for (const host of [...hosts, ...this.manualHosts]) {
      if (this.hiddenHosts.includes(host.id)) continue;
      const override = this.overrides[host.id];
      let updated = host;
      if (override) { try { updated = validateHost({ ...host, ...override, id: host.id }); } catch (error) { warnings.push(`Saved changes to ${host.name} were ignored: ${messageFor(error)}`); } }
      const key = identityFor(updated); const existing = byIdentity.get(key);
      if (!existing || updated.source === 'Manual') byIdentity.set(key, updated);
    }
    const oldById = new Map(this.state.hosts.map(host => [host.id, host]));
    this.state.hosts = [...byIdentity.values()].map(host => {
      const old = oldById.get(host.id);
      if (old && ['ready', 'offline', 'auth-required'].includes(old.status) && identityFor(old) === identityFor(host) && old.identityFile === host.identityFile && old.sshAlias === host.sshAlias && host.online !== false) {
        host.status = old.status;
        if (old.error) host.error = old.error;
      }
      if (!host.user) { host.status = 'auth-required'; host.error = 'Add this machine’s SSH login username and authentication settings.'; }
      return host;
    }).sort((a, b) => a.name.localeCompare(b.name));
    this.state.discovery = { warnings: [...new Set(warnings)], lastScan: new Date().toISOString() };
    this.emit(); return this.getState();
  }
  sshArgs(host) {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-p', String(host.port), '-l', host.user];
    if (host.identityFile) args.push('-i', expandHome(host.identityFile, this.homeDir), '-o', 'IdentitiesOnly=yes');
    if (host.sshAlias) args.push('-o', 'HostName=' + host.address);
    args.push(host.sshAlias || host.address); return args;
  }
  async probeHosts({ automatic = false } = {}) {
    await this.initialized;
    this.assertConfigurationIdle();
    if (this.transferring) throw new Error('Wait for the current transfer to finish before checking machines.');
    if (this.configurationImport) throw new Error('Wait for configuration import to finish.');
    if (this.probePromise) return this.probePromise;
    if (this.scanPromise) await this.scanPromise;
    this.assertConfigurationIdle();
    if (!this.state.environment.sshAvailable) await this.refreshHosts();
    this.assertConfigurationIdle();
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.checkHosts({ automatic }).finally(() => { this.probePromise = null; }); return this.probePromise;
  }
  async checkHosts({ automatic = false } = {}) {
    const hosts = this.state.hosts.slice();
    await mapLimit(hosts, 4, async host => {
      if (automatic && this.passwordAuth.metadata(host).hasSavedPassword) return;
      if (!host.user) { host.status = 'auth-required'; host.error = 'Add this machine’s SSH login username and authentication settings.'; this.emit(); return; }
      host.status = 'checking'; delete host.error; this.emit();
      try {
        const result = this.passwordAuth.metadata(host).hasSavedPassword
          ? await this.passwordAuth.withPassword(host, session => session.exec('echo DRIFT_READY', 9000))
          : await this.run('ssh', [...this.sshArgs(host), 'echo DRIFT_READY'], { timeout: 9000 });
        if (!result.stdout.includes('DRIFT_READY')) throw new Error('SSH connected but the remote shell did not accept a command.');
        host.status = 'ready'; delete host.error;
      } catch (error) { Object.assign(host, classifySSHError(error)); }
      const live = this.state.hosts.find(entry => entry.id === host.id && identityFor(entry) === identityFor(host) && entry.identityFile === host.identityFile && entry.sshAlias === host.sshAlias);
      if (live && live !== host) { live.status = host.status; if (host.error) live.error = host.error; else delete live.error; }
      this.emit();
    });
    return this.getState();
  }
  async saveHost(payload) {
    await this.initialized;
    this.assertConfigurationIdle();
    if (this.transferring) throw new Error('Wait for the current transfer to finish before editing machines.');
    const current = this.state.hosts.find(host => host.id === payload.id);
    const host = validateHost({ ...current, ...payload, source: current ? current.source : 'Manual', id: current ? current.id : 'manual-' + crypto.randomUUID(), status: 'unknown' }, { manual: true });
    if (current && current.source !== 'Manual') this.overrides[host.id] = Object.fromEntries(PUBLIC_HOST_FIELDS.filter(key => !['status', 'error', 'online', 'source'].includes(key)).map(key => [key, host[key]]));
    else { host.source = 'Manual'; this.manualHosts = [...this.manualHosts.filter(existing => existing.id !== host.id), host]; }
    this.hiddenHosts = this.hiddenHosts.filter(id => id !== host.id);
    this.state.hosts = [...this.state.hosts.filter(existing => existing.id !== host.id && identityFor(existing) !== identityFor(host)), host].sort((a, b) => a.name.localeCompare(b.name));
    await this.persist();
    if (current && endpointKey(current) !== endpointKey(host)) await this.passwordAuth.forget(current);
    this.emit(); return this.getState();
  }
  async removeHost(id) {
    await this.initialized;
    this.assertConfigurationIdle();
    if (this.transferring) throw new Error('Wait for the current transfer to finish before removing machines.');
    const host = this.state.hosts.find(entry => entry.id === id); if (!host) return this.getState();
    if (host.source === 'Manual') this.manualHosts = this.manualHosts.filter(entry => entry.id !== id);
    else this.hiddenHosts = [...new Set([...this.hiddenHosts, id])];
    delete this.overrides[id]; this.state.hosts = this.state.hosts.filter(entry => entry.id !== id);
    await this.persist(); await this.passwordAuth.forget(host); this.emit(); return this.getState();
  }
  enqueueFiles(paths, validateSource = null) {
    return this.mutateShelf(async () => {
      if (validateSource) await validateSource();
      if (!Array.isArray(paths) || paths.length > 500) throw new Error('Drop a list of at most 500 files or folders.');
      const additions = [];
      for (const file of paths) {
        if (typeof file !== 'string' || !path.isAbsolute(file) || hasControl(file)) throw new Error('Dropped files need an absolute local path.');
        const stats = await fs.lstat(file);
        this.assertConfigurationIdle();
        if (stats.isSymbolicLink()) throw new Error('Drop the original file or folder instead of a symbolic link.');
        if (!stats.isFile() && !stats.isDirectory()) throw new Error('Only regular files and folders can be added.');
        if ([...this.state.items, ...additions].some(item => item.path === file)) continue;
        additions.push({ id: crypto.randomUUID(), name: path.basename(file), kind: stats.isDirectory() ? 'folder' : 'file', size: stats.isDirectory() ? 0 : stats.size, path: file });
      }
      if (validateSource) await validateSource();
      this.assertConfigurationIdle();
      if (this.state.items.length + additions.length > 500) throw new Error('The shelf holds up to 500 items. Remove some items first.');
      const previous = this.state.items;
      this.state.items = [...previous, ...additions];
      const enqueuedItemIds = [...new Set(paths.map(file => this.state.items.find(item => item.path === file)?.id).filter(Boolean))];
      try { await this.persist(); } catch (error) { this.state.items = previous; throw error; }
      this.emit(); return { ...await this.getState(), enqueuedItemIds };
    });
  }
  enqueueText(text) {
    return this.mutateShelf(async () => {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Drop or paste some text first.');
      if (Buffer.byteLength(text, 'utf8') > 20 * 1024 * 1024) throw new Error('A text note can contain up to 20 MB.');
      const id = crypto.randomUUID(); const name = 'note-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
      return this.stageShelfItem({ id, name, kind: 'text', size: Buffer.byteLength(text, 'utf8'), path: path.join(this.dataDir, 'notes', id + '.txt'), preview: text.slice(0, 240) }, text);
    });
  }
  enqueueClipboardImage(input) {
    return this.mutateShelf(async () => {
      const bytes = validateClipboardPNG(input);
      const id = crypto.randomUUID(); const name = 'clipboard-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      return this.stageShelfItem({ id, name, kind: 'file', size: bytes.length, path: path.join(this.dataDir, 'clipboard-images', id + '.png'), clipboard: true }, bytes);
    });
  }
  async stageShelfItem(item, content) {
    if (this.state.items.length >= 500) throw new Error('The shelf holds up to 500 items.');
    let owned = false;
    try {
      await fs.mkdir(path.dirname(item.path), { recursive: true, mode: 0o700 });
      this.assertConfigurationIdle();
      const file = await fs.open(item.path, 'wx', 0o600); owned = true;
      try { this.assertConfigurationIdle(); await file.writeFile(content); } finally { await file.close(); }
      this.assertConfigurationIdle();
      if (this.state.items.length >= 500) throw new Error('The shelf holds up to 500 items.');
      const previous = this.state.items;
      this.state.items = [...previous, item];
      try { await this.persist(); } catch (error) { this.state.items = previous; throw error; }
      this.emit(); return { ...await this.getState(), enqueuedItemIds: [item.id] };
    } catch (error) {
      if (owned) await fs.unlink(item.path).catch(() => {});
      throw error;
    }
  }
  ownedStagedPath(item) {
    if (!item || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)) return null;
    const expected = item.kind === 'text' ? path.join(this.dataDir, 'notes', item.id + '.txt') : item.clipboard === true && item.kind === 'file' ? path.join(this.dataDir, 'clipboard-images', item.id + '.png') : null;
    return expected && item.path === expected ? expected : null;
  }
  retainedStagedPaths() { return new Set([...this.state.items, ...(this.pendingClear?.items || [])].map(item => item.path)); }
  async removeOwnedClipboardImage(item) {
    const owned = item?.clipboard === true ? this.ownedStagedPath(item) : null;
    if (owned && !this.retainedStagedPaths().has(owned)) await fs.unlink(owned).catch(() => {});
  }
  scheduleClearUndo(retryDelay) {
    clearTimeout(this.clearUndoTimer); this.clearUndoTimer = null;
    if (!this.pendingClear && !this.clearCleanup.length) return;
    const deadline = this.pendingClear ? Math.max(0, Date.parse(this.pendingClear.expiresAt) - this.clock()) : Infinity;
    const delay = retryDelay ?? Math.min(deadline, this.clearCleanup.length ? 5000 : Infinity);
    this.clearUndoTimer = setTimeout(() => { this.clearUndoTimer = null; this.expireClearUndo().catch(() => this.scheduleClearUndo(1000)); }, delay);
    this.clearUndoTimer.unref?.();
  }
  cleanupEntries(items) {
    const unique = new Map(this.clearCleanup.map(item => [item.path, item]));
    for (const item of items) if (this.ownedStagedPath(item)) unique.set(item.path, item);
    return [...unique.values()];
  }
  async drainClearCleanup() {
    if (!this.clearCleanup.length) return;
    const previous = this.clearCleanup; const retained = this.retainedStagedPaths(); const remaining = [];
    for (const item of previous) {
      const owned = this.ownedStagedPath(item);
      if (!owned) continue;
      if (retained.has(owned)) { remaining.push(item); continue; }
      try { await fs.unlink(owned); } catch (error) { if (error.code !== 'ENOENT') remaining.push(item); }
    }
    if (remaining.length === previous.length) return;
    this.clearCleanup = remaining;
    try { await this.persist(); } catch (error) { this.clearCleanup = previous; throw error; }
  }
  expireClearUndo() {
    return this.mutateShelf(async () => {
      const beforePending = this.pendingClear; const beforeCleanup = this.clearCleanup;
      if (this.pendingClear && Date.parse(this.pendingClear.expiresAt) <= this.clock()) {
        const previous = this.pendingClear; const priorCleanup = this.clearCleanup;
        this.clearCleanup = this.cleanupEntries(previous.items); this.pendingClear = null;
        try { await this.persist(); } catch (error) { this.pendingClear = previous; this.clearCleanup = priorCleanup; throw error; }
      }
      try { await this.drainClearCleanup(); } finally { this.scheduleClearUndo(); }
      if (beforePending !== this.pendingClear || beforeCleanup !== this.clearCleanup) this.emit();
      return this.getState();
    });
  }
  removeItem(id) {
    return this.mutateShelf(async () => {
      if (this.transferring) throw new Error('Wait for the current transfer to finish before removing shelf items.');
      const previous = this.state.items; const item = previous.find(entry => entry.id === id);
      this.state.items = previous.filter(entry => entry.id !== id);
      try { await this.persist(); } catch (error) { this.state.items = previous; throw error; }
      const owned = this.ownedStagedPath(item);
      if (owned && !this.retainedStagedPaths().has(owned)) await fs.unlink(owned).catch(() => {});
      this.emit(); return this.getState();
    });
  }
  clearItems() {
    return this.mutateShelf(async () => {
      if (this.transferring) throw new Error('Wait for the current transfer to finish before clearing the shelf.');
      if (!this.state.items.length) return this.getState();
      const previous = this.state.items; const priorUndo = this.pendingClear; const priorCleanup = this.clearCleanup;
      const cleanup = this.cleanupEntries(priorUndo?.items || []);
      if (cleanup.length + previous.filter(item => this.ownedStagedPath(item)).length > 2000) throw new Error('Staged-file cleanup is still pending. Check app-folder permissions before clearing more items.');
      this.clearCleanup = cleanup;
      this.pendingClear = { id: crypto.randomUUID(), items: previous, expiresAt: new Date(this.clock() + 10000).toISOString() };
      this.state.items = [];
      try { await this.persist(); } catch (error) { this.state.items = previous; this.pendingClear = priorUndo; this.clearCleanup = priorCleanup; throw error; }
      // A later clear commits the previous undo batch only after the replacement is durable.
      await this.drainClearCleanup().catch(() => {}); this.scheduleClearUndo();
      this.emit(); return this.getState();
    });
  }
  undoClear() {
    return this.mutateShelf(async () => {
      if (this.transferring) throw new Error('Wait for the current transfer to finish before restoring cleared items.');
      const pending = this.pendingClear;
      if (!pending || Date.parse(pending.expiresAt) <= this.clock()) throw new Error('The 10-second undo window has ended.');
      const previous = this.state.items; const existingPaths = new Set(previous.map(item => item.path)); const existingIds = new Set(previous.map(item => item.id));
      const restored = pending.items.filter(item => !existingPaths.has(item.path) && !existingIds.has(item.id));
      if (previous.length + restored.length > 500) throw new Error('Undo would exceed the 500-item shelf limit. Remove some newly added items before the undo window ends.');
      const priorCleanup = this.clearCleanup;
      this.clearCleanup = this.cleanupEntries(pending.items.filter(item => !restored.includes(item)));
      this.state.items = [...restored, ...previous]; this.pendingClear = null;
      try { await this.persist(); } catch (error) { this.state.items = previous; this.pendingClear = pending; this.clearCleanup = priorCleanup; throw error; }
      this.scheduleClearUndo(); this.emit();
      const restoredItemIds = restored.map(item => item.id);
      return { ...await this.getState(), restoredItemIds, enqueuedItemIds: restoredItemIds };
    });
  }
  async checkSource(item, windows = false) {
    const stats = await fs.lstat(item.path);
    if (stats.isSymbolicLink() || !(stats.isFile() || stats.isDirectory())) throw new Error(`${item.name} is no longer a regular file or folder.`);
    if (stats.isDirectory()) {
      let count = 0;
      async function walk(directory) {
        const names = new Set();
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (hasControl(entry.name)) throw new Error('This folder has filenames containing control characters. Rename those files or use an archive before sending.');
          if (names.has(nameKey(entry.name))) throw new Error('This folder has names that differ only in capitalization or Unicode spelling. Use an archive to preserve them safely on every filesystem.');
          names.add(nameKey(entry.name));
          if (windows && invalidWindowsName(entry.name)) throw new Error(`${entry.name} is not a valid filename on Windows. Rename it before sending.`);
          if (++count > 100000) throw new Error('This folder contains more than 100,000 entries. Transfer a smaller folder.');
          if (entry.isSymbolicLink()) throw new Error('This folder contains symbolic links. Drop its ordinary files or a prepared archive instead.');
          if (entry.isDirectory()) await walk(path.join(directory, entry.name));
          else if (!entry.isFile()) throw new Error('This folder contains a special file that cannot be transferred.');
        }
      }
      await walk(item.path);
    }
  }
  windowsDestinationCommand(destination, batch) {
    const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
    const desktop = "[Environment]::GetFolderPath('Desktop')";
    let expression;
    if (destination === '~/Desktop') expression = desktop;
    else if (destination.startsWith('~/Desktop/')) expression = `Join-Path -Path (${desktop}) -ChildPath ${psQuote(destination.slice(10))}`;
    else if (destination === '~') expression = '$env:USERPROFILE';
    else if (destination.startsWith('~/')) expression = `Join-Path -Path $env:USERPROFILE -ChildPath ${psQuote(destination.slice(2))}`;
    else expression = psQuote(destination);
    const script = `$ErrorActionPreference='Stop'; $base=(${expression}); if([string]::IsNullOrWhiteSpace($base)){throw 'The destination folder could not be resolved.'}; [IO.Directory]::CreateDirectory($base) | Out-Null; $target=Join-Path -Path $base -ChildPath ${psQuote(batch)}; if(Test-Path -LiteralPath $target){throw 'This transfer folder already exists.'}; [IO.Directory]::CreateDirectory($target) | Out-Null; [Console]::WriteLine('DRIFT_DEST='+[IO.Path]::GetFullPath($target).Replace('\\','/'))`;
    return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
  }
  async uploadTransferItem(host, passwordSession, localPath, remotePath, kind = 'file') {
    if (passwordSession) return passwordSession.upload(localPath, remotePath);
    const args = [...(host.os === 'windows' ? [] : ['-O']), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-P', String(host.port)];
    if (host.identityFile) args.push('-i', expandHome(host.identityFile, this.homeDir), '-o', 'IdentitiesOnly=yes');
    if (host.sshAlias) args.push('-o', 'HostName=' + host.address);
    if (kind === 'folder') args.push('-r');
    const scpHost = host.sshAlias || host.address;
    const targetHost = scpHost.includes(':') ? '[' + scpHost + ']' : scpHost;
    args.push(localPath, host.user + '@' + targetHost + ':' + (host.os === 'windows' ? remotePath : quoteRemote(remotePath)));
    return this.run('scp', args, { timeout: 60 * 60 * 1000 });
  }
  async publishTransferReceipt(host, passwordSession, receipt) {
    const manifest = encodeManifest({ version: 1, id: receipt.id, senderLabel: this.state.settings.deviceName || 'Another computer', sentAt: new Date(this.clock()).toISOString(), items: receipt.items });
    const temporaryName = '.dropharbor-receipt-' + crypto.randomUUID() + '.tmp';
    const localPath = path.join(this.dataDir, temporaryName);
    const remoteTemporary = receipt.destination + '/' + temporaryName;
    const remoteFinal = receipt.destination + '/' + RECEIPT_NAME;
    try {
      await fs.writeFile(localPath, manifest, { mode: 0o600, flag: 'wx' });
      await this.uploadTransferItem(host, passwordSession, localPath, remoteTemporary);
      const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
      // The completed marker appears only after every payload has arrived. Both
      // forms fail rather than overwriting an existing marker at the destination.
      const script = host.os === 'windows'
        ? 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(`$ErrorActionPreference='Stop'; [IO.File]::Move(${psQuote(remoteTemporary)}, ${psQuote(remoteFinal)})`, 'utf16le').toString('base64')
        : `ln -- ${quoteRemote(remoteTemporary)} ${quoteRemote(remoteFinal)} && test -f ${quoteRemote(remoteFinal)} && test ! -L ${quoteRemote(remoteFinal)} && test ${quoteRemote(remoteTemporary)} -ef ${quoteRemote(remoteFinal)} && rm -- ${quoteRemote(remoteTemporary)}`;
      if (passwordSession) await passwordSession.exec(script);
      else await this.run('ssh', [...this.sshArgs(host), script], { timeout: 15000 });
      receipt.receiptPublished = true;
    } finally { await fs.unlink(localPath).catch(() => {}); }
  }
  async send(payload) { return this.sendOne(payload); }
  async sendMany({ hostIds, itemIds } = {}) {
    await this.initialized; this.assertConfigurationIdle();
    if (this.transferring) throw new Error('A transfer is already running. Wait for its receipts before sending again.');
    if (!Array.isArray(hostIds) || !hostIds.length || hostIds.length > 20 || new Set(hostIds).size !== hostIds.length || !hostIds.every(id => typeof id === 'string')) throw new Error('Choose between 1 and 20 different machines.');
    if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 500 || new Set(itemIds).size !== itemIds.length || !itemIds.every(id => typeof id === 'string')) throw new Error('Choose between 1 and 500 different shelf items.');
    const selectedHostIds = hostIds.slice(); const exactIds = itemIds.slice();
    this.transferring = true;
    const batchId = crypto.randomUUID();
    try {
      // Calls already waiting on another discovery phase can hand off to a new phase.
      // Keep the batch guard while draining every pre-existing scan/probe phase.
      while (this.scanPromise || this.probePromise) {
        const settled = await Promise.allSettled([this.scanPromise, this.probePromise].filter(Boolean));
        const failed = settled.find(result => result.status === 'rejected');
        if (failed) throw new Error('A machine check did not finish successfully. Check your machines again before sending.');
      }
      const targets = selectedHostIds.map(id => {
        const host = this.state.hosts.find(entry => entry.id === id);
        if (!host) throw new Error('One of the selected machines is no longer available. Review your selection.');
        return { ...host };
      });
      if (!exactIds.every(id => this.state.items.some(item => item.id === id))) throw new Error('One of the selected items is no longer on the shelf.');
      await mapLimit(targets, 2, async host => {
        try { await this.sendOne({ hostId: host.id, itemIds: exactIds }, { withinBatch: true, batchId }); }
        catch (error) {
          const existing = this.state.history.find(receipt => receipt.batchId === batchId && receipt.hostId === host.id);
          if (!existing) this.state.history.unshift({ id: crypto.randomUUID(), batchId, hostId: host.id, hostName: host.name, itemCount: exactIds.length, itemIds: exactIds.slice(), items: exactIds.map(id => this.state.items.find(item => item.id === id)).filter(Boolean).map(({ name, kind, size }) => ({ name, kind, size })), status: 'failed', message: messageFor(error), timestamp: new Date().toISOString() });
          else if (existing.status === 'sending') { existing.status = 'failed'; existing.message = messageFor(error); }
          this.state.history = this.state.history.slice(0, 100);
          // A disk failure must not release the batch lock while another worker is still sending.
          // The final persistence attempt happens only after every destination has settled.
          await this.persist().catch(() => {}); this.emit();
        }
      });
    } finally { this.transferring = false; await this.persist(); this.emit(); }
    return this.getState();
  }
  async sendOne({ hostId, itemIds } = {}, { withinBatch = false, batchId } = {}) {
    await this.initialized;
    this.assertConfigurationIdle();
    if (this.transferring && !withinBatch) throw new Error('A transfer is already running. Wait for its receipt before sending again.');
    const current = this.state.hosts.find(host => host.id === hostId); if (!current) throw new Error('Choose a machine first.');
    const host = validateHost(current, { manual: true });
    if (current.status !== 'ready') throw new Error('Check this machine’s SSH connection before sending.');
    if (host.os === 'windows' && this.sshMajor < 9 && !this.passwordAuth.metadata(host).hasSavedPassword) throw new Error('Sending to Windows needs OpenSSH 9 or newer on this device so file paths use SFTP safely. Update the OpenSSH client and check again.');
    if (!Array.isArray(itemIds) || !itemIds.length) throw new Error('Add or select at least one shelf item to send.');
    const wanted = new Set(itemIds); const items = this.state.items.filter(item => wanted.has(item.id));
    if (items.length !== wanted.size) throw new Error('One of the selected items is no longer on the shelf.');
    this.transferring = true;
    const receipt = { id: crypto.randomUUID(), ...(batchId ? { batchId } : {}), hostId: host.id, hostName: host.name, itemCount: items.length, itemIds: items.map(item => item.id), items: items.map(({ name, kind, size }) => ({ name, kind, size })), status: 'sending', message: 'Preparing the transfer…', timestamp: new Date().toISOString() };
    this.state.history.unshift(receipt); this.state.history = this.state.history.slice(0, 100); this.emit();
    try {
      const perform = async passwordSession => {
      await this.persist();
      if (withinBatch) {
        // Recheck this destination immediately before its transfer, after any queue wait.
        const ready = passwordSession ? await passwordSession.exec('echo DRIFT_READY', 9000) : await this.run('ssh', [...this.sshArgs(host), 'echo DRIFT_READY'], { timeout: 9000 });
        if (!ready.stdout.includes('DRIFT_READY')) throw new Error('This machine did not pass its fresh SSH connection check.');
      }
      for (const item of items) {
        await this.checkSource(item, host.os === 'windows');
        if (host.os === 'windows' && invalidWindowsName(item.name)) throw new Error(`${item.name} is not a valid filename on Windows. Rename it before sending.`);
      }
      const batch = 'Drift-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
      const base = host.destination === '~' ? '"$HOME"' : host.destination.startsWith('~/') ? '"$HOME"/' + quoteRemote(host.destination.slice(2)) : quoteRemote(host.destination);
      const posixScript = `umask 077; base=${base}; mkdir -p -- "$base" && target="$base"/${quoteRemote(batch)} && mkdir -- "$target" && printf '\\nDRIFT_DEST=%s\\n' "$target"`;
      const script = host.os === 'windows' ? this.windowsDestinationCommand(host.destination, batch) : posixScript;
      const result = passwordSession ? await passwordSession.exec(script) : await this.run('ssh', [...this.sshArgs(host), script], { timeout: 15000 });
      const match = result.stdout.match(/(?:^|\n)DRIFT_DEST=([^\r\n]+)/); if (!match || (host.os === 'windows' ? !/^[A-Za-z]:[\\/]/.test(match[1]) : !match[1].startsWith('/')) || hasControl(match[1])) throw new Error('The remote machine did not return a usable destination path.');
      receipt.destination = match[1]; const usedNames = new Set([nameKey(RECEIPT_NAME)]);
      for (let index = 0; index < items.length; index++) {
        const item = items[index]; let name = item.name; let suffix = 2;
        while (usedNames.has(nameKey(name))) { const extension = item.kind === 'folder' ? '' : path.extname(item.name); name = item.name.slice(0, item.name.length - extension.length) + ' (' + suffix++ + ')' + extension; }
        usedNames.add(nameKey(name));
        const remotePath = receipt.destination + '/' + name;
        receipt.message = `Sending ${index + 1} of ${items.length}: ${item.name}`; this.emit();
        receipt.items[index] = { name, kind: item.kind, size: item.kind === 'folder' ? 0 : (await fs.lstat(item.path)).size };
        await this.uploadTransferItem(host, passwordSession, item.path, remotePath, item.kind);
      }
      try { await this.publishTransferReceipt(host, passwordSession, receipt); }
      catch { receipt.receiptPublished = false; receipt.receiptWarning = 'Files were delivered, but the receiving app could not be notified. Open the destination folder to find them.'; }
      };
      if (this.passwordAuth.metadata(host).hasSavedPassword) await this.passwordAuth.withPassword(host, perform);
      else await perform();
      receipt.status = 'sent'; receipt.message = `${items.length} ${items.length === 1 ? 'item' : 'items'} delivered to ${receipt.destination}. Your shelf is kept for reuse.` + (receipt.receiptWarning ? ' ' + receipt.receiptWarning : '');
    } catch (error) {
      receipt.status = 'failed'; receipt.message = messageFor(error);
      if (receipt.destination) receipt.message += ` Some files may already be in ${receipt.destination}; retrying creates a new folder.`;
      if (/host key|host identification|fingerprint|password.*rejected|attempts are paused/i.test(receipt.message)) {
        const live = this.state.hosts.find(entry => entry.id === current.id && identityFor(entry) === identityFor(host));
        if (live) { live.status = 'auth-required'; live.error = /password/i.test(receipt.message) ? receipt.message : 'Verify this machine’s SSH fingerprint in your terminal before retrying.'; }
      }
    } finally { if (!withinBatch) this.transferring = false; await this.persist(); this.emit(); }
    return this.getState();
  }
  async configureAccess({ hostId, mode, password } = {}) {
    await this.initialized; await this.passwordAuth.initialized;
    this.assertConfigurationIdle();
    if (this.transferring) throw new Error('Wait for the transfer to finish before changing machine access.');
    if (!['once', 'saved'].includes(mode)) throw new Error('Choose one-time setup or a saved password.');
    validatePassword(password);
    this.authenticationSetup = true;
    try {
      await Promise.all([this.scanPromise, this.probePromise].filter(Boolean));
      const current = this.state.hosts.find(host => host.id === hostId);
      if (!current) throw new Error('Save and choose a machine before configuring access.');
      const host = validateHost(current, { manual: true });
      if (mode === 'saved') {
        if (!this.passwordAuth.storageAvailable()) throw new Error('Secure password storage is unavailable. Unlock your operating system keychain, or choose one-time password setup instead.');
        await this.passwordAuth.withPassword(host, async session => {
          const result = await session.exec('echo DRIFT_READY', 9000);
          if (!result.stdout.includes('DRIFT_READY')) throw new Error('SSH connected but the remote shell did not accept a command.');
        }, password);
        await this.passwordAuth.save(host, password);
      } else {
        const identityFile = await this.passwordAuth.bootstrap(host, password, async file => {
          const args = this.sshArgs({ ...host, identityFile: file });
          // Key-only verification must not succeed using another agent identity or multiplexed session.
          args.unshift('-o', 'IdentityAgent=none', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no');
          const result = await this.run('ssh', [...args, 'echo DRIFT_READY'], { timeout: 12000 });
          if (!result.stdout.includes('DRIFT_READY')) throw new Error('Key verification did not complete.');
        });
        const updated = { ...host, identityFile, status: 'ready' };
        const previousManualHosts = this.manualHosts; const previousOverrides = this.overrides;
        if (host.source === 'Manual') this.manualHosts = this.manualHosts.map(entry => entry.id === host.id ? updated : entry);
        else this.overrides = { ...this.overrides, [host.id]: { ...this.overrides[host.id], identityFile } };
        try { await this.persist(); }
        catch {
          this.manualHosts = previousManualHosts; this.overrides = previousOverrides;
          throw new Error('The new SSH key works, but the machine settings could not be saved. Your previous access settings remain active. The generated key was retained; free space or fix app-folder permissions and retry setup.');
        }
        Object.assign(current, updated);
        await this.passwordAuth.forget(host);
        await this.passwordAuth.completeBootstrap?.(host);
      }
      current.status = 'ready'; delete current.error;
      this.emit(); return this.getState();
    } finally { password = undefined; this.authenticationSetup = false; }
  }
  async forgetPassword(hostId) {
    await this.initialized; this.assertConfigurationIdle();
    if (this.transferring) throw new Error('Wait for the transfer to finish before removing its password.');
    const host = this.state.hosts.find(entry => entry.id === hostId);
    if (!host) throw new Error('Choose a saved machine first.');
    this.authenticationSetup = true;
    try {
      await Promise.all([this.scanPromise, this.probePromise].filter(Boolean));
      await this.passwordAuth.forget(host);
      const live = this.state.hosts.find(entry => entry.id === hostId && endpointKey(entry) === endpointKey(host));
      if (live) { live.status = 'unknown'; delete live.error; }
      this.emit(); return this.getState();
    } finally { this.authenticationSetup = false; }
  }
  async updateSettings(patch) { await this.initialized; this.assertConfigurationIdle(); this.state.settings = { ...this.state.settings, ...this.validSettings(patch) }; await this.persist(); this.emit(); return this.getState(); }
}

module.exports = { DriftService };
