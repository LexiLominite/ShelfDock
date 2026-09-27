'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile: nodeExecFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateClipboardPNG } = require('./clipboard.cjs');

const execFileAsync = promisify(nodeExecFile);
const DEFAULT_SETTINGS = Object.freeze({ shakeEnabled: true, sensitivity: 'normal', sendImmediately: false, viewMode: 'expanded' });
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
  constructor({ dataDir, onChange = () => {}, homeDir = os.homedir(), execFile = execFileAsync, platform = process.platform } = {}) {
    if (!dataDir) throw new Error('Drift needs an application data directory.');
    this.dataDir = dataDir; this.homeDir = homeDir; this.onChange = onChange; this.executor = execFile; this.platform = platform;
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
      this.state.history = (saved.history || []).slice(0, 100).map(entry => entry.status === 'sending' ? { ...entry, status: 'failed', message: 'The app closed before this transfer finished. Check the destination before retrying.' } : entry);
      this.state.settings = { ...DEFAULT_SETTINGS, ...this.validSettings(saved.settings || {}) };
      this.state.hosts = clone(this.manualHosts);
    } catch (error) { if (error.code !== 'ENOENT') this.state.discovery.warnings.push('Saved settings could not be loaded: ' + messageFor(error)); }
  }
  validSettings(patch) {
    const settings = {};
    if ('shakeEnabled' in patch) { if (typeof patch.shakeEnabled !== 'boolean') throw new Error('Invalid shake setting.'); settings.shakeEnabled = patch.shakeEnabled; }
    if ('sensitivity' in patch) { if (!['gentle', 'normal', 'strong'].includes(patch.sensitivity)) throw new Error('Invalid shake sensitivity.'); settings.sensitivity = patch.sensitivity; }
    if ('viewMode' in patch) { if (!['compact', 'expanded', 'large'].includes(patch.viewMode)) throw new Error('Choose Compact, Expanded, or Large view.'); settings.viewMode = patch.viewMode; }
    if ('sendImmediately' in patch) { if (typeof patch.sendImmediately !== 'boolean') throw new Error('Invalid send setting.'); settings.sendImmediately = patch.sendImmediately; }
    return settings;
  }
  emit() { try { this.onChange(clone(this.state)); } catch {} }
  async persist() {
    const serialized = JSON.stringify({ version: 1, manualHosts: this.manualHosts, overrides: this.overrides, hiddenHosts: this.hiddenHosts, items: this.state.items, history: this.state.history.slice(0, 100), settings: this.state.settings }, null, 2);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const temporary = path.join(this.dataDir, 'state-' + crypto.randomUUID() + '.tmp');
      await fs.writeFile(temporary, serialized, { mode: 0o600 }); await fs.rename(temporary, path.join(this.dataDir, 'state.json'));
    }); await this.writeChain;
  }
  async getState() { await this.initialized; return clone(this.state); }
  assertConfigurationIdle() { if (this.configurationImport) throw new Error('Wait for configuration import to finish.'); }
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
    if (this.configurationImport) throw new Error('Wait for configuration import to finish.');
    if (this.scanPromise) return this.scanPromise;
    if (this.probePromise) await this.probePromise;
    if (this.configurationImport) throw new Error('Wait for configuration import to finish.');
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
  async probeHosts() {
    await this.initialized;
    if (this.configurationImport) throw new Error('Wait for configuration import to finish.');
    if (this.probePromise) return this.probePromise;
    if (this.scanPromise) await this.scanPromise;
    if (!this.state.environment.sshAvailable) await this.refreshHosts();
    if (this.configurationImport) throw new Error('Wait for configuration import to finish.');
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.checkHosts().finally(() => { this.probePromise = null; }); return this.probePromise;
  }
  async checkHosts() {
    const hosts = this.state.hosts.slice();
    await mapLimit(hosts, 4, async host => {
      if (!host.user) { host.status = 'auth-required'; host.error = 'Add this machine’s SSH login username and authentication settings.'; this.emit(); return; }
      host.status = 'checking'; delete host.error; this.emit();
      try {
        const result = await this.run('ssh', [...this.sshArgs(host), 'echo DRIFT_READY'], { timeout: 9000 });
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
    const current = this.state.hosts.find(host => host.id === payload.id);
    const host = validateHost({ ...current, ...payload, source: current ? current.source : 'Manual', id: current ? current.id : 'manual-' + crypto.randomUUID(), status: 'unknown' }, { manual: true });
    if (current && current.source !== 'Manual') this.overrides[host.id] = Object.fromEntries(PUBLIC_HOST_FIELDS.filter(key => !['status', 'error', 'online', 'source'].includes(key)).map(key => [key, host[key]]));
    else { host.source = 'Manual'; this.manualHosts = [...this.manualHosts.filter(existing => existing.id !== host.id), host]; }
    this.hiddenHosts = this.hiddenHosts.filter(id => id !== host.id);
    this.state.hosts = [...this.state.hosts.filter(existing => existing.id !== host.id && identityFor(existing) !== identityFor(host)), host].sort((a, b) => a.name.localeCompare(b.name));
    await this.persist(); this.emit(); return this.getState();
  }
  async removeHost(id) {
    await this.initialized;
    this.assertConfigurationIdle();
    const host = this.state.hosts.find(entry => entry.id === id); if (!host) return this.getState();
    if (host.source === 'Manual') this.manualHosts = this.manualHosts.filter(entry => entry.id !== id);
    else this.hiddenHosts = [...new Set([...this.hiddenHosts, id])];
    delete this.overrides[id]; this.state.hosts = this.state.hosts.filter(entry => entry.id !== id);
    await this.persist(); this.emit(); return this.getState();
  }
  enqueueFiles(paths) {
    return this.mutateShelf(async () => {
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
  async removeOwnedClipboardImage(item) {
    if (!item || item.clipboard !== true || item.kind !== 'file' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)) return;
    const ownedPath = path.join(this.dataDir, 'clipboard-images', item.id + '.png');
    if (item.path === ownedPath) await fs.unlink(ownedPath).catch(() => {});
  }
  removeItem(id) {
    return this.mutateShelf(async () => {
      if (this.transferring) throw new Error('Wait for the current transfer to finish before removing shelf items.');
      const previous = this.state.items;
      const item = previous.find(entry => entry.id === id);
      this.state.items = previous.filter(entry => entry.id !== id);
      try { await this.persist(); } catch (error) { this.state.items = previous; throw error; }
      // Delete only staged content, and only after its removal is safely saved.
      if (item && item.kind === 'text' && item.path.startsWith(path.join(this.dataDir, 'notes') + path.sep)) await fs.unlink(item.path).catch(() => {});
      await this.removeOwnedClipboardImage(item);
      this.emit(); return this.getState();
    });
  }
  clearItems() {
    return this.mutateShelf(async () => {
      if (this.transferring) throw new Error('Wait for the current transfer to finish before clearing the shelf.');
      const previous = this.state.items;
      this.state.items = [];
      try { await this.persist(); } catch (error) { this.state.items = previous; throw error; }
      for (const item of previous) {
        if (item.kind === 'text' && item.path.startsWith(path.join(this.dataDir, 'notes') + path.sep)) await fs.unlink(item.path).catch(() => {});
        await this.removeOwnedClipboardImage(item);
      }
      this.emit(); return this.getState();
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
  async send({ hostId, itemIds } = {}) {
    await this.initialized;
    this.assertConfigurationIdle();
    if (this.transferring) throw new Error('A transfer is already running. Wait for its receipt before sending again.');
    const current = this.state.hosts.find(host => host.id === hostId); if (!current) throw new Error('Choose a machine first.');
    const host = validateHost(current, { manual: true });
    if (current.status !== 'ready') throw new Error('Check this machine’s SSH connection before sending.');
    if (host.os === 'windows' && this.sshMajor < 9) throw new Error('Sending to Windows needs OpenSSH 9 or newer on this device so file paths use SFTP safely. Update the OpenSSH client and check again.');
    if (!Array.isArray(itemIds) || !itemIds.length) throw new Error('Add or select at least one shelf item to send.');
    const wanted = new Set(itemIds); const items = this.state.items.filter(item => wanted.has(item.id));
    if (items.length !== wanted.size) throw new Error('One of the selected items is no longer on the shelf.');
    this.transferring = true;
    const receipt = { id: crypto.randomUUID(), hostName: host.name, itemCount: items.length, itemIds: items.map(item => item.id), status: 'sending', message: 'Preparing the transfer…', timestamp: new Date().toISOString() };
    this.state.history.unshift(receipt); this.state.history = this.state.history.slice(0, 100); this.emit();
    try {
      await this.persist();
      for (const item of items) {
        await this.checkSource(item, host.os === 'windows');
        if (host.os === 'windows' && invalidWindowsName(item.name)) throw new Error(`${item.name} is not a valid filename on Windows. Rename it before sending.`);
      }
      const batch = 'Drift-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
      const base = host.destination === '~' ? '"$HOME"' : host.destination.startsWith('~/') ? '"$HOME"/' + quoteRemote(host.destination.slice(2)) : quoteRemote(host.destination);
      const posixScript = `umask 077; base=${base}; mkdir -p -- "$base" && target="$base"/${quoteRemote(batch)} && mkdir -- "$target" && printf '\\nDRIFT_DEST=%s\\n' "$target"`;
      const script = host.os === 'windows' ? this.windowsDestinationCommand(host.destination, batch) : posixScript;
      const result = await this.run('ssh', [...this.sshArgs(host), script], { timeout: 15000 });
      const match = result.stdout.match(/(?:^|\n)DRIFT_DEST=([^\r\n]+)/); if (!match || (host.os === 'windows' ? !/^[A-Za-z]:[\\/]/.test(match[1]) : !match[1].startsWith('/')) || hasControl(match[1])) throw new Error('The remote machine did not return a usable destination path.');
      receipt.destination = match[1]; const usedNames = new Set();
      for (let index = 0; index < items.length; index++) {
        const item = items[index]; let name = item.name; let suffix = 2;
        while (usedNames.has(nameKey(name))) { const extension = item.kind === 'folder' ? '' : path.extname(item.name); name = item.name.slice(0, item.name.length - extension.length) + ' (' + suffix++ + ')' + extension; }
        usedNames.add(nameKey(name));
        const remotePath = receipt.destination + '/' + name;
        receipt.message = `Sending ${index + 1} of ${items.length}: ${item.name}`; this.emit();
        const args = [...(host.os === 'windows' ? [] : ['-O']), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-P', String(host.port)];
        if (host.identityFile) args.push('-i', expandHome(host.identityFile, this.homeDir), '-o', 'IdentitiesOnly=yes');
        if (host.sshAlias) args.push('-o', 'HostName=' + host.address);
        if (item.kind === 'folder') args.push('-r');
        const scpHost = host.sshAlias || host.address;
        const targetHost = scpHost.includes(':') ? '[' + scpHost + ']' : scpHost;
        args.push(item.path, host.user + '@' + targetHost + ':' + (host.os === 'windows' ? remotePath : quoteRemote(remotePath)));
        await this.run('scp', args, { timeout: 60 * 60 * 1000 });
      }
      receipt.status = 'sent'; receipt.message = `${items.length} ${items.length === 1 ? 'item' : 'items'} delivered to ${receipt.destination}. Your shelf is kept for reuse.`;
    } catch (error) {
      receipt.status = 'failed'; receipt.message = messageFor(error);
      if (receipt.destination) receipt.message += ` Some files may already be in ${receipt.destination}; retrying creates a new folder.`;
      if (/host key|host identification/i.test(receipt.message)) { current.status = 'auth-required'; current.error = 'Verify this machine’s SSH fingerprint in your terminal before retrying.'; }
    } finally { this.transferring = false; await this.persist(); this.emit(); }
    return this.getState();
  }
  async updateSettings(patch) { await this.initialized; this.assertConfigurationIdle(); this.state.settings = { ...this.state.settings, ...this.validSettings(patch) }; await this.persist(); this.emit(); return this.getState(); }
}

module.exports = { DriftService };
