'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

const SCHEMA = 'lex-drift-config';
const VERSION = 1;
const MAX_BYTES = 1024 * 1024;
const MAX_HOSTS = 500;
const SETTINGS_DEFAULTS = Object.freeze({ shakeEnabled: true, sensitivity: 'strong', viewMode: 'expanded' });
const HOST_FIELDS = ['name', 'address', 'user', 'port', 'destination', 'route', 'os'];
const clone = value => JSON.parse(JSON.stringify(value));
const endpoint = host => `${host.address.toLowerCase()}\0${host.user}\0${host.port}`;
const hasControl = value => /[\x00-\x1f\x7f]/.test(value);

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a JSON object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} contains an unsupported field: ${key}. Configuration files cannot include authentication, commands, or local file paths.`);
}

function validateHost(raw, index) {
  const label = `Machine ${index + 1}`;
  object(raw, HOST_FIELDS, label);
  if (typeof raw.address !== 'string' || typeof raw.user !== 'string') throw new Error(`${label} needs an address and SSH login username.`);
  const address = raw.address.trim().replace(/^\[([^\]]+)\]$/, '$1');
  const user = raw.user.trim();
  if (!address || address.length > 253 || !(net.isIP(address) || /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(address)) || address.includes('..')) throw new Error(`${label} needs a hostname or IP address without spaces, URLs, or command options.`);
  if (!user || user.length > 128 || !/^[A-Za-z0-9_][A-Za-z0-9_.@\\-]*$/.test(user)) throw new Error(`${label} needs a valid SSH login username.`);
  const port = raw.port === undefined ? 22 : raw.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} SSH port must be an integer from 1 to 65535.`);
  const name = raw.name === undefined ? address : raw.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || hasControl(name)) throw new Error(`${label} name must be a single line of at most 120 characters.`);
  const os = raw.os === undefined ? 'posix' : raw.os;
  if (!['posix', 'windows'].includes(os)) throw new Error(`${label} operating system must be posix or windows.`);
  const destination = raw.destination === undefined ? '~/Desktop' : raw.destination;
  if (typeof destination !== 'string' || !destination.trim() || destination.length > 4096 || hasControl(destination)) throw new Error(`${label} destination must be a valid folder path.`);
  const folder = destination.trim();
  if (os === 'posix' && !(folder.startsWith('/') || folder === '~' || folder.startsWith('~/'))) throw new Error(`${label} destination must be an absolute remote path or start with ~/.`);
  if (os === 'windows' && !(/^[A-Za-z]:[\\/]/.test(folder) || folder === '~' || folder.startsWith('~/'))) throw new Error(`${label} Windows destination must use a drive path or start with ~/.`);
  const route = raw.route === undefined ? (net.isIPv4(address) && address.split('.')[0] === '100' && Number(address.split('.')[1]) >= 64 && Number(address.split('.')[1]) <= 127 ? 'tailscale' : /\.local$/i.test(address) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || address === 'localhost' ? 'lan' : 'ssh') : raw.route;
  if (!['tailscale', 'lan', 'ssh'].includes(route)) throw new Error(`${label} route must be tailscale, lan, or ssh.`);
  return { name: name.trim(), address, user, port, destination: folder, route, os };
}

function validateConfig(input) {
  let serialized;
  if (typeof input === 'string') serialized = input;
  else {
    try { serialized = JSON.stringify(input); } catch { throw new Error('Choose a valid JSON configuration file.'); }
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error('Configuration files must be valid JSON and no larger than 1 MB.');
  let config;
  try { config = JSON.parse(serialized); } catch { throw new Error('Choose a valid JSON configuration file.'); }
  object(config, ['schema', 'version', 'hosts', 'settings'], 'Configuration');
  if (config.schema !== SCHEMA || config.version !== VERSION) throw new Error('This file is not a supported ShelfDock or LexBridge configuration (version 1).');
  if (!Array.isArray(config.hosts) || config.hosts.length > MAX_HOSTS) throw new Error('A configuration can contain at most 500 machines.');
  const hosts = config.hosts.map(validateHost);
  const identities = new Set();
  for (const host of hosts) {
    const key = endpoint(host);
    if (identities.has(key)) throw new Error(`The configuration repeats the same machine address, username, and port: ${host.name}.`);
    identities.add(key);
  }
  const settings = config.settings === undefined ? {} : config.settings;
  object(settings, Object.keys(SETTINGS_DEFAULTS), 'Settings');
  if ('shakeEnabled' in settings && typeof settings.shakeEnabled !== 'boolean') throw new Error('Shake enabled must be true or false.');
  if ('sensitivity' in settings && !['gentle', 'normal', 'strong'].includes(settings.sensitivity)) throw new Error('Shake sensitivity must be gentle, normal, or strong.');
  if ('viewMode' in settings && !['compact', 'expanded', 'large'].includes(settings.viewMode)) throw new Error('View mode must be compact, expanded, or large.');
  return { schema: SCHEMA, version: VERSION, hosts, settings: { ...settings } };
}

function createConfig(state) {
  const seen = new Set();
  const hosts = (state.hosts || []).filter(host => typeof host.user === 'string' && host.user.trim()).filter(host => {
    const key = endpoint(host); if (seen.has(key)) return false; seen.add(key); return true;
  }).map(host => Object.fromEntries(HOST_FIELDS.map(key => [key, host[key]])));
  // Portable setup never includes clipboard-sync pairings, tokens, or that directory.
  const settingsSource = { ...(state.settings || {}) };
  delete settingsSource.clipboardSync;
  delete settingsSource.token;
  const settings = Object.fromEntries(Object.keys(SETTINGS_DEFAULTS).map(key => [key, settingsSource[key] ?? SETTINGS_DEFAULTS[key]]));
  return validateConfig({ schema: SCHEMA, version: VERSION, hosts, settings });
}

// Caller must reject other mutations/refreshes while configurationImport is true.
// There is one disk commit, and rejected files cannot alter the current setup.
async function importConfiguration(service, input) {
  const config = validateConfig(input);
  await service.initialized;
  if (service.macInstallation) throw new Error('Wait for Mac installation to finish before importing settings.');
  if (service.configurationImport) throw new Error('Wait for the current configuration import to finish.');
  if (service.tunnelSetup) throw new Error('Wait for forwarding setup to finish before importing settings.');
  if (service.authenticationSetup) throw new Error('Wait for connection setup to finish before importing settings.');
  if (service.transferring) throw new Error('Wait for the current transfer to finish before importing settings.');
  service.configurationImport = true;
  try {
    if (service.shelfMutation) await service.shelfMutation.catch(() => {});
    if (service.scanPromise) await service.scanPromise;
    if (service.probePromise) await service.probePromise;
    if (service.transferring) throw new Error('Wait for the current transfer to finish before importing settings.');
    const previous = { manualHosts: service.manualHosts, overrides: service.overrides, hiddenHosts: service.hiddenHosts, hosts: service.state.hosts, settings: service.state.settings };
    const manualHosts = clone(service.manualHosts);
    const overrides = clone(service.overrides);
    const hiddenHosts = [...service.hiddenHosts];
    let hosts = clone(service.state.hosts);
    let added = 0; let updated = 0;
    for (const portable of config.hosts) {
      const current = hosts.find(host => endpoint(host) === endpoint(portable));
      // Auth stays local and is retained only when the entire endpoint matches.
      const host = { ...current, ...portable, id: current?.id || 'manual-' + crypto.randomUUID(), source: current?.source || 'Manual', identityFile: current?.identityFile || '', sshAlias: current?.sshAlias || '', status: 'unknown' };
      delete host.error;
      if (current && current.source !== 'Manual') {
        overrides[host.id] = { ...(overrides[host.id] || {}), ...Object.fromEntries(['id', ...HOST_FIELDS, 'identityFile', 'sshAlias'].map(key => [key, host[key]])) };
      } else {
        host.source = 'Manual';
        const index = manualHosts.findIndex(saved => saved.id === host.id);
        if (index === -1) manualHosts.push(host); else manualHosts[index] = host;
      }
      const hiddenIndex = hiddenHosts.indexOf(host.id); if (hiddenIndex !== -1) hiddenHosts.splice(hiddenIndex, 1);
      hosts = [...hosts.filter(saved => endpoint(saved) !== endpoint(host)), host];
      if (current) updated++; else added++;
    }
    if (hosts.length > MAX_HOSTS) throw new Error('The merged configuration would exceed 500 machines. Remove unused machines first.');
    hosts.sort((a, b) => a.name.localeCompare(b.name));
    service.manualHosts = manualHosts; service.overrides = overrides; service.hiddenHosts = hiddenHosts;
    service.state.hosts = hosts; service.state.settings = { ...service.state.settings, ...config.settings };
    try { await service.persist(); } catch (error) {
      service.manualHosts = previous.manualHosts; service.overrides = previous.overrides; service.hiddenHosts = previous.hiddenHosts;
      service.state.hosts = previous.hosts; service.state.settings = previous.settings;
      service.emit();
      throw error;
    }
    service.emit();
    return { ...await service.getState(), configurationImportSummary: { added, updated } };
  } finally { service.configurationImport = false; }
}

module.exports = { createConfig, validateConfig, importConfiguration, SCHEMA, VERSION, MAX_BYTES, MAX_HOSTS };
