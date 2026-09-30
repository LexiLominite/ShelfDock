'use strict';
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { createPrivateTransport } = require('./updates-gh.cjs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { extractArchive, identifyInstallation, POSIX_HELPER, WINDOWS_HELPER } = require('./updates-install.cjs');

const REPOSITORY = 'LexiLominite/ShelfDock';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
const PRIVATE_RELEASES_URL = 'https://github.com/LexiLominite/LexBridge-private/releases';
const EDITIONS = Object.freeze({ public: Object.freeze({ repository: REPOSITORY, productName: 'ShelfDock', packageName: 'shelfdock', prefix: 'ShelfDock' }), personal: Object.freeze({ repository: 'LexiLominite/LexBridge-private', productName: 'LexBridge', packageName: 'lexbridge', prefix: 'LexBridge-personal' }) });
const MAX_DOWNLOAD = 1500 * 1024 ** 2;
const INTERVAL = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(['checking', 'downloading', 'preparing', 'installing']);
const clone = value => JSON.parse(JSON.stringify(value));
const safeMessage = error => String(error?.message || 'The update did not finish. Please try again.').replace(/https?:\/\/\S+/g, '[download URL]').slice(0, 400);

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part)))) return null;
  const pre = match[4]?.split('.') || [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { numbers: match.slice(1, 4).map(Number), pre };
}
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b); if (!left || !right) throw new Error('Invalid release version.');
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i]; if (x === y) continue; if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1; return x > y ? 1 : -1;
  } return 0;
}
function assetName(version, platform, arch, personal = false) {
  const prefix = EDITIONS[personal ? 'personal' : 'public'].prefix;
  if (!parseVersion(version) || !['arm64', 'x64'].includes(arch)) return null;
  if (platform === 'darwin' && arch === 'arm64') return `${prefix}-${version}-mac-arm64.zip`;
  if (platform === 'win32' && arch === 'x64') return `${prefix}-${version}-win-x64.exe`;
  if (platform === 'linux') return `${prefix}-${version}-linux-${arch}.tar.gz`;
  return null;
}
function assertURL(value, { initial = false } = {}) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) throw new Error('The release used an unsafe download address.');
  const allowed = initial ? ['api.github.com', 'github.com'] : ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
  if (!allowed.includes(url.hostname)) throw new Error('The update redirected outside official GitHub downloads.');
  if (url.hostname === 'api.github.com' && !url.pathname.startsWith(`/repos/${REPOSITORY}/`)) throw new Error('The release used an unexpected repository.');
  if (url.hostname === 'github.com' && !url.pathname.startsWith(`/${REPOSITORY}/releases/download/`)) throw new Error('The release used an unexpected repository.');
  return url;
}
async function requestStream(url, { signal, redirects = 0, request = https.get } = {}) {
  const target = assertURL(url, { initial: redirects === 0 });
  if (redirects > 5) throw new Error('The update redirected too many times.');
  return new Promise((resolve, reject) => {
    const req = request(target, { signal, headers: { 'User-Agent': 'ShelfDock-Updater', Accept: target.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        try { const next = new URL(res.headers.location, target).href; assertURL(next); resolve(requestStream(next, { signal, redirects: redirects + 1, request })); } catch (error) { reject(error); }
      } else if (res.statusCode !== 200) { res.resume(); reject(new Error(res.statusCode === 403 || res.statusCode === 429 ? 'GitHub is limiting update checks. Try again later.' : `GitHub could not provide the update (HTTP ${res.statusCode}).`)); }
      else resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('The update connection timed out.')));
    req.once('error', reject);
  });
}
async function fetchBuffer(url, { limit = 4 * 1024 ** 2, signal, stream = requestStream } = {}) {
  const response = await stream(url, { signal }); const declared = Number(response.headers?.['content-length']);
  if (declared > limit) { response.destroy(); throw new Error('The update response was too large.'); }
  let size = 0; const chunks = [];
  for await (const chunk of response) { signal?.throwIfAborted(); size += chunk.length; if (size > limit) { response.destroy(); throw new Error('The update response was too large.'); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function selectRelease(releases, { version, platform, arch, includePrereleases, personal = false }) {
  const edition = EDITIONS[personal ? 'personal' : 'public'], repository = edition.repository;
  if (!Array.isArray(releases) || releases.length > 100) throw new Error('GitHub returned an invalid release list.');
  const eligible = releases.filter(release => {
    const candidate = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
    return parseVersion(candidate) && release.draft === false && typeof release.prerelease === 'boolean' && (includePrereleases || (!release.prerelease && !parseVersion(candidate).pre.length)) && compareVersions(candidate, version) > 0;
  }).sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  if (!eligible.length) return null;
  const release = eligible[0], nextVersion = release.tag_name.slice(1), name = assetName(nextVersion, platform, arch, personal);
  const url = `https://github.com/${repository}/releases/tag/${release.tag_name}`;
  const result = { version: nextVersion, tag: release.tag_name, url, notes: typeof release.body === 'string' ? release.body.slice(0, 20000) : '', publishedAt: typeof release.published_at === 'string' ? release.published_at.slice(0, 40) : '', prerelease: release.prerelease, asset: null, checksumAsset: null };
  if (!name || !Array.isArray(release.assets) || release.assets.length > 100) return result;
  function select(name, limit) {
    const matching = release.assets.filter(asset => asset?.name === name); if (matching.length !== 1) return null;
    const asset = matching[0], expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
    if (asset.state !== 'uploaded' || asset.browser_download_url !== expected || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit) throw new Error('The release has invalid download metadata.');
    if (asset.digest && !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw new Error('The release has an unsupported checksum.');
    if (personal && (!Number.isSafeInteger(asset.id) || asset.id <= 0)) throw new Error('The private release has an invalid asset identifier.');
    return { name, url: personal ? `https://api.github.com/repos/${repository}/releases/assets/${asset.id}` : expected, size: asset.size, digest: asset.digest?.slice(7).toLowerCase() || null };
  }
  result.asset = select(name, MAX_DOWNLOAD); result.checksumAsset = select('SHA256SUMS.txt', 128 * 1024);
  return result;
}
function parseChecksums(text, name) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 128 * 1024) throw new Error('The checksum list is invalid.');
  const values = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._+-]{0,200})$/.exec(line);
    if (!match || values.has(match[2])) throw new Error('The release has an invalid or duplicate checksum entry.'); values.set(match[2], match[1].toLowerCase());
  }
  if (!values.has(name)) throw new Error('This download is missing from the release checksum list.'); return values.get(name);
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The update cache is not an ordinary local folder.');
}
async function writeJSON(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
async function readJSON(file, limit = 65536) {
  const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Invalid updater record.');
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
async function assertAppIdentity(bundle, platform, version, arch, personal = false) {
  const edition = EDITIONS[personal ? 'personal' : 'public'];
  const resources = path.join(bundle, platform === 'darwin' ? 'Contents/Resources' : 'resources');
  const handle = await fs.open(path.join(resources, 'app.asar'), 'r');
  try {
    const first = Buffer.alloc(16); if ((await handle.read(first, 0, 16, 0)).bytesRead !== 16) throw new Error();
    const headerSize = first.readUInt32LE(4), jsonSize = first.readUInt32LE(12);
    if (headerSize > 32 * 1024 ** 2 || jsonSize > headerSize || jsonSize < 2) throw new Error();
    const json = Buffer.alloc(jsonSize); await handle.read(json, 0, jsonSize, 16); const header = JSON.parse(json.toString('utf8'));
    const entry = header.files?.['package.json']; if (!entry || entry.unpacked || entry.link || !/^\d+$/.test(entry.offset) || !Number.isSafeInteger(entry.size) || entry.size > 128 * 1024) throw new Error();
    const content = Buffer.alloc(entry.size); await handle.read(content, 0, entry.size, 8 + headerSize + Number(entry.offset)); const pkg = JSON.parse(content.toString('utf8'));
    if (pkg.name !== edition.packageName || pkg.version !== version || pkg.productName !== edition.productName) throw new Error();
  } catch { throw new Error('The update application identity or version did not match the release.'); } finally { await handle.close(); }
  const binary = await fs.open(path.join(bundle, platform === 'darwin' ? 'Contents/MacOS/' + edition.productName : edition.productName), 'r');
  try {
    const bytes = Buffer.alloc(20); if ((await binary.read(bytes, 0, 20, 0)).bytesRead !== 20) throw new Error();
    if (platform === 'darwin' ? bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x0100000c : 0x01000007) : bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62)) throw new Error();
  } catch { throw new Error('The update executable is for a different processor.'); } finally { await binary.close(); }
  if (!personal) try { await fs.lstat(path.join(resources, 'personal-config.json')); throw new Error('The public update unexpectedly contains personal configuration.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

class UpdateManager {
  constructor({ dataDir, version, platform = process.platform, arch = process.arch, personal = false, enabled = true, isPackaged = false, execPath = process.execPath, portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE, onChange = () => {}, isBusy = () => false, quit = () => {}, openExternal = async () => {}, revealFile = () => {}, clock = () => Date.now(), stream = null, spawnProcess = spawn, identify = identifyInstallation, validateApp = assertAppIdentity } = {}) {
    if (!parseVersion(version)) throw new Error('The installed version is invalid.');
    Object.assign(this, { version, platform, arch, personal, enabled, isPackaged, execPath, portableExecutable, onChange, isBusy, quit, openExternal, revealFile, clock, stream, spawnProcess, identify, validateApp });
    this.edition = EDITIONS[personal ? 'personal' : 'public']; this.stream = stream || (personal ? createPrivateTransport({ spawnProcess }) : requestStream);
    this.baseDirectory = path.join(dataDir, 'updates'); this.directory = path.join(this.baseDirectory, personal ? 'personal' : 'public'); this.file = path.join(this.directory, 'preferences.json'); this.downloaded = null; this.release = null; this.timer = null; this.controller = null; this.disposed = false;
    this.preferences = { autoCheck: true, autoDownload: true, includePrereleases: true };
    this.preferencesValid = true; this.preferenceWarning = '';
    this.state = { status: 'idle', error: '', progress: null, lastChecked: null, installation: { available: false, reason: 'Checking installation…' }, result: null };
    this.initialized = this.load().catch(() => { this.enabled = false; this.state.status = 'error'; this.state.error = 'The update cache could not be opened. Updates are unavailable; the rest of the app can still be used.'; this.state.installation = { available: false, reason: this.state.error }; });
  }
  async load() {
    if (!this.enabled) { this.state.installation = { available: false, reason: 'Updates are disabled in background test mode.' }; return; }
    await ensurePrivateDirectory(this.baseDirectory);
    await ensurePrivateDirectory(this.directory);
    this.directory = await fs.realpath(this.directory); this.file = path.join(this.directory, 'preferences.json');
    const cacheStat = await fs.lstat(this.directory); this.cacheIdentity = { dev: cacheStat.dev, ino: cacheStat.ino };
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid updater preferences.');
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const keys = ['autoCheck', 'autoDownload', 'includePrereleases'];
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 1 || saved.repository !== this.edition.repository || keys.some(key => typeof saved[key] !== 'boolean') || Object.keys(saved).some(key => !['version', 'repository', ...keys, 'lastChecked'].includes(key)) || (saved.lastChecked !== null && saved.lastChecked !== undefined && (!Number.isFinite(saved.lastChecked) || saved.lastChecked < 0 || saved.lastChecked > this.clock()))) throw new Error('Invalid updater preferences.');
      this.preferences = Object.fromEntries(keys.map(key => [key, saved[key]]));
      if (!this.preferences.autoCheck) this.preferences.autoDownload = false;
      if (Number.isFinite(saved.lastChecked)) this.state.lastChecked = saved.lastChecked;
    } catch (error) {
      if (error.code !== 'ENOENT') { this.preferences = { autoCheck: false, autoDownload: false, includePrereleases: true }; this.preferencesValid = false; this.preferenceWarning = 'Update preferences could not be validated. Automatic checks and downloads are off until you save valid update settings.'; this.state.error = this.preferenceWarning; }
    }
    this.state.installation = await this.identify(this);
    try {
      const saved = await readJSON(path.join(this.directory, 'download.json'));
      const expected = assetName(saved.version, this.platform, this.arch, this.personal);
      if (expected && saved.name === expected && /^[a-f0-9]{64}$/.test(saved.sha256) && compareVersions(saved.version, this.version) > 0 && Number.isSafeInteger(saved.size) && saved.size > 0 && saved.size <= MAX_DOWNLOAD) {
        const file = path.join(this.directory, expected), stat = await fs.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size === saved.size && await hashFile(file) === saved.sha256) {
          this.downloaded = { ...saved, file }; this.release = { version: saved.version, tag: 'v' + saved.version, prerelease: !!saved.prerelease, notes: String(saved.notes || '').slice(0, 20000), url: `https://github.com/${this.edition.repository}/releases/tag/v${saved.version}`, asset: { name: expected, size: saved.size } }; this.state.status = 'downloaded';
        }
      }
    } catch {}
    try {
      const pending = await readJSON(path.join(this.directory, 'install.json'), 8192);
      if (pending.repository === this.edition.repository && parseVersion(pending.version) && typeof pending.id === 'string' && /^[a-f0-9-]{36}$/.test(pending.id)) {
        let result; try { result = await readJSON(path.join(this.directory, 'result-' + pending.id + '.json'), 8192); } catch {}
        let backupRetained = false;
        if (typeof pending.backup === 'string' && path.basename(pending.backup).startsWith('.shelfdock-backup-' + pending.id)) try { const backup = await fs.lstat(pending.backup); backupRetained = !backup.isSymbolicLink() && (backup.isDirectory() || backup.isFile()); } catch {}
        const runningVersion = compareVersions(this.version, pending.version);
        if (runningVersion >= 0) {
          const startupConfirmed = runningVersion === 0 && result?.status === 'installed';
          if (runningVersion === 0) this.state.result = { status: startupConfirmed ? 'installed' : 'starting', version: pending.version, backupRetained };
          if (runningVersion === 0 && !startupConfirmed) this.pendingInstall = { ...pending, backupRetained };
          else {
          // Consume only the journal, never the retained application backup.
          await fs.rm(path.join(this.directory, 'install.json'), { force: true });
          await fs.rm(path.join(this.directory, 'result-' + pending.id + '.json'), { force: true });
          await fs.rm(path.join(this.directory, 'ready-' + pending.id), { force: true });
          await fs.rm(path.join(this.directory, 'started-' + pending.id), { force: true });
          }
        } else {
          const failureStatuses = ['parent_running', 'changed', 'backup_failed', 'rolled_back', 'failed'];
          this.state.result = { status: failureStatuses.includes(result?.status) ? result.status : 'interrupted', version: pending.version, backupRetained };
        }
      }
    } catch {}
    // Interrupted partial downloads are never restored as installable packages.
    for (const name of await fs.readdir(this.directory)) {
      if (/^download-[a-f0-9-]{36}\.part$/.test(name)) await fs.rm(path.join(this.directory, name), { force: true });
      if (name.startsWith(this.edition.prefix + '-')) {
        const match = new RegExp('^' + this.edition.prefix + '-(.+)-(?:mac|win|linux)-(?:arm64|x64)\\.(?:zip|exe|tar\\.gz)$').exec(name);
        if (match && parseVersion(match[1]) && compareVersions(match[1], this.version) <= 0) await fs.rm(path.join(this.directory, name), { force: true });
      }
    }
  }
  snapshot() {
    return clone({ ...this.state, preferences: this.preferences, preferenceWarning: this.preferenceWarning, release: this.release, currentVersion: this.version, platform: this.platform, arch: this.arch, personal: this.personal, canDownload: !!this.release?.asset && !!this.release?.checksumAsset && this.preferencesValid, canInstall: !!this.downloaded && this.state.installation.available, downloaded: this.downloaded ? { name: this.downloaded.name, version: this.downloaded.version, size: this.downloaded.size, sha256: this.downloaded.sha256 } : null });
  }
  async getState() { await this.initialized; return this.snapshot(); }
  emit() { if (!this.disposed) this.onChange(this.snapshot()); }
  async persist() { await writeJSON(this.file, { version: 1, repository: this.edition.repository, ...this.preferences, lastChecked: this.state.lastChecked }); this.preferencesValid = true; this.preferenceWarning = ''; }
  begin(status) {
    if (!this.enabled) throw new Error('Updates are disabled in background test mode.');
    if (this.disposed) throw new Error('The updater is shutting down.');
    if (ACTIVE.has(this.state.status)) throw new Error('An update operation is already running.');
    this.controller = new AbortController(); this.state.status = status; this.state.error = ''; this.state.progress = null; this.emit(); return this.controller;
  }
  async check() {
    await this.initialized;
    if (!this.preferencesValid) throw new Error(this.preferenceWarning);
    const controller = this.begin('checking'); const deadline = setTimeout(() => controller.abort(new Error('The update check timed out.')), 60000); deadline.unref?.();
    try {
      const bytes = await fetchBuffer(`https://api.github.com/repos/${this.edition.repository}/releases?per_page=100`, { signal: controller.signal, stream: this.stream });
      const release = selectRelease(JSON.parse(bytes.toString('utf8')), { ...this, includePrereleases: this.preferences.includePrereleases });
      if (this.downloaded && (!release || release.version !== this.downloaded.version)) await this.forgetDownload();
      this.release = release; this.state.lastChecked = this.clock(); this.state.status = release ? this.downloaded ? 'downloaded' : 'available' : 'current'; await this.persist(); this.emit();
    } catch (error) { this.state.status = this.downloaded ? 'downloaded' : this.release ? 'available' : 'error'; this.state.error = controller.signal.aborted ? 'Update check cancelled or timed out.' : safeMessage(error); this.emit(); }
    finally { clearTimeout(deadline); if (this.controller === controller) this.controller = null; }
    if (!this.state.error && this.release?.asset && this.release?.checksumAsset && this.preferences.autoDownload && !this.downloaded) await this.download();
    return this.snapshot();
  }
  async updatePreferences(patch) {
    await this.initialized;
    if (this.preferenceBusy) throw new Error('Update settings are already being saved.');
    this.preferenceBusy = true;
    try { return await this.setPreferences(patch); } finally { this.preferenceBusy = false; }
  }
  async setPreferences(patch) {
    await this.initialized;
    if (!this.enabled) throw new Error('Updates are disabled in background test mode.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !Object.hasOwn(this.preferences, key) || typeof patch[key] !== 'boolean')) throw new Error('Invalid update preferences.');
    if (ACTIVE.has(this.state.status)) throw new Error('Wait for the current update operation before changing its settings.');
    const before = { ...this.preferences };
    this.preferences = { ...this.preferences, ...patch };
    if (!this.preferences.autoCheck) this.preferences.autoDownload = false;
    try { await this.persist(); } catch (error) { this.preferences = before; throw error; }
    this.state.error = '';
    if (before.includePrereleases !== this.preferences.includePrereleases) { await this.forgetDownload(); this.release = null; this.state.status = 'idle'; }
    this.emit(); this.schedule(); return this.snapshot();
  }
  async forgetDownload() {
    const downloaded = this.downloaded; this.downloaded = null;
    if (!await this.ownsCache()) return;
    const unlink = file => fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    // Remove only this cache's journal and exact package path; unlink never follows a package or journal symlink.
    await unlink(path.join(this.directory, 'download.json'));
    const name = downloaded && assetName(downloaded.version, this.platform, this.arch, this.personal);
    if (name && downloaded.name === name && downloaded.file === path.join(this.directory, name)) await unlink(downloaded.file);
  }
  async ownsCache() {
    try {
      const stat = await fs.lstat(this.directory);
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === this.cacheIdentity?.dev && stat.ino === this.cacheIdentity?.ino && await fs.realpath(this.directory) === this.directory;
    } catch { return false; }
  }
  async verifyDownload() {
    const downloaded = this.downloaded;
    try {
      const name = assetName(downloaded.version, this.platform, this.arch, this.personal);
      if (!name || downloaded.name !== name || downloaded.file !== path.join(this.directory, name) || !await this.ownsCache()) throw new Error();
      const stat = await fs.lstat(downloaded.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== downloaded.size || await hashFile(downloaded.file) !== downloaded.sha256 || compareVersions(downloaded.version, this.version) <= 0) throw new Error();
      return downloaded;
    } catch {
      // Invalidate memory even if a missing or unwritable cache prevents journal cleanup.
      await this.forgetDownload().catch(() => {});
      const retry = this.release?.asset && this.release?.checksumAsset ? 'Download it again.' : 'Check for updates, then download it again.';
      const error = new Error('The downloaded update is missing or changed. ' + retry);
      this.state.status = this.release ? 'available' : 'idle'; this.state.progress = null; this.state.error = error.message; this.emit();
      throw error;
    }
  }
  async download() {
    await this.initialized;
    if (!this.preferencesValid) throw new Error(this.preferenceWarning);
    if (!this.release?.asset || !this.release?.checksumAsset) throw new Error('This release does not have a verified package for your device.');
    if (this.downloaded) return this.snapshot();
    if (!await this.ownsCache()) throw new Error('The update cache changed. Restart the app before downloading again.');
    const release = clone(this.release), controller = this.begin('downloading'); const part = path.join(this.directory, 'download-' + crypto.randomUUID() + '.part'); let promoted; const deadline = setTimeout(() => controller.abort(new Error('The update download timed out.')), 20 * 60 * 1000); deadline.unref?.();
    try {
      const manifest = await fetchBuffer(release.checksumAsset.url, { limit: 128 * 1024, signal: controller.signal, stream: this.stream });
      if (release.checksumAsset.digest && crypto.createHash('sha256').update(manifest).digest('hex') !== release.checksumAsset.digest) throw new Error('The checksum list did not match GitHub’s release digest.');
      const expected = parseChecksums(manifest.toString('utf8'), release.asset.name);
      if (release.asset.digest && release.asset.digest !== expected) throw new Error('The release checksums disagree.');
      const response = await this.stream(release.asset.url, { signal: controller.signal }); let received = 0, lastEmit = 0; const hash = crypto.createHash('sha256');
      const declared = Number(response.headers?.['content-length']); if (declared && declared !== release.asset.size) { response.destroy(); throw new Error('The update download size changed.'); }
      const guard = new Transform({ transform: (chunk, _encoding, callback) => {
        received += chunk.length; if (received > release.asset.size) { callback(new Error('The update exceeded its expected size.')); return; } hash.update(chunk);
        if (this.clock() - lastEmit > 150) { lastEmit = this.clock(); this.state.progress = { received, total: release.asset.size }; this.emit(); } callback(null, chunk);
      } });
      await pipeline(response, guard, createWriteStream(part, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      if (received !== release.asset.size || hash.digest('hex') !== expected) throw new Error('The update did not match its SHA-256 checksum. The incomplete download was removed.');
      const file = path.join(this.directory, release.asset.name); await fs.rename(part, file); promoted = file;
      if (this.platform === 'darwin' && process.platform === 'darwin') await execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(this.clock() / 1000).toString(16)};${this.edition.productName};`, file]);
      this.downloaded = { name: release.asset.name, version: release.version, size: release.asset.size, sha256: expected, notes: release.notes, prerelease: release.prerelease, file };
      try { await writeJSON(path.join(this.directory, 'download.json'), { ...this.downloaded, file: undefined }); } catch (error) { await fs.rm(file, { force: true }); this.downloaded = null; throw error; }
      this.state.status = 'downloaded'; this.state.progress = { received, total: received }; this.emit();
    } catch (error) { await fs.rm(part, { force: true }).catch(() => {}); if (promoted && !this.downloaded) await fs.rm(promoted, { force: true }).catch(() => {}); this.state.status = 'available'; this.state.error = controller.signal.aborted ? 'Download cancelled. You can retry whenever you are ready.' : safeMessage(error); this.state.progress = null; this.emit(); }
    finally { clearTimeout(deadline); if (this.controller === controller) this.controller = null; }
    return this.snapshot();
  }
  async cancel() { await this.initialized; if (['checking', 'downloading'].includes(this.state.status)) this.controller?.abort(); return this.snapshot(); }
  async revealDownload() {
    await this.initialized; if (!this.downloaded) throw new Error('Download the update first.');
    const downloaded = await this.verifyDownload();
    this.revealFile(downloaded.file); return this.snapshot();
  }
  async openRelease() { await this.initialized; if (!this.enabled) throw new Error('Updates are disabled in background test mode.'); await this.openExternal(this.personal ? PRIVATE_RELEASES_URL : this.release?.url || RELEASES_URL); return this.snapshot(); }
  assertIdle() { const busy = this.isBusy(); if (busy) throw new Error(typeof busy === 'string' ? busy : 'Finish transfers, stop live forwards and close active setup before restarting to update.'); }
  async install() {
    await this.initialized; this.assertIdle(); if (!this.downloaded) throw new Error('A verified update is not ready to install.');
    this.state.installation = await this.identify(this); if (!this.state.installation.available) throw new Error(this.state.installation.reason);
    const controller = this.begin('preparing'); const downloaded = this.downloaded, installation = this.state.installation; let staging, helper, installId;
    try {
      await this.verifyDownload();
      const id = installId = crypto.randomUUID(), parent = path.dirname(installation.target); staging = path.join(parent, '.shelfdock-update-' + id); let staged;
      if (this.platform === 'win32') { await fs.mkdir(staging, { mode: 0o700 }); staged = path.join(staging, this.edition.productName + '.exe'); await fs.copyFile(downloaded.file, staged, require('node:fs').constants.COPYFILE_EXCL); }
      else {
        const root = this.platform === 'darwin' ? this.edition.productName + '.app' : `${this.edition.prefix}-${downloaded.version}-linux-${this.arch}`;
        staged = await extractArchive({ file: downloaded.file, destination: staging, format: this.platform === 'darwin' ? 'zip' : 'tar.gz', root, signal: controller.signal });
        await this.validateApp(staged, this.platform, downloaded.version, this.arch, this.personal);
        if (this.platform === 'darwin') await execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(this.clock() / 1000).toString(16)};${this.edition.productName};`, staged]);
      }
      this.assertIdle(); const current = await this.identify(this);
      if (!current.available || current.target !== installation.target || current.identity !== installation.identity) throw new Error('The installation changed while the update was prepared.');
      const backup = path.join(parent, '.shelfdock-backup-' + id + (this.platform === 'win32' ? '.exe' : this.platform === 'darwin' ? '.app' : ''));
      const ready = path.join(this.directory, 'ready-' + id), started = path.join(this.directory, 'started-' + id), result = path.join(this.directory, 'result-' + id + '.json');
      const plan = { id, pid: process.pid, target: installation.target, staged, backup, result, ready, started, version: downloaded.version, sha256: downloaded.sha256, platform: this.platform, identity: installation.identity };
      let executable, args, options = { detached: true, stdio: 'ignore', windowsHide: true };
      if (this.platform === 'win32') {
        plan.oldHash = await hashFile(installation.target); const script = path.join(this.directory, 'apply-' + id + '.ps1'), planFile = path.join(this.directory, 'plan-' + id + '.json');
        await fs.writeFile(script, WINDOWS_HELPER, { flag: 'wx', mode: 0o600 }); await writeJSON(planFile, plan); executable = 'powershell.exe'; args = ['-NoProfile', '-NonInteractive', '-File', script, '-Plan', planFile];
      } else {
        const script = path.join(this.directory, 'apply-' + id + '.sh'); await fs.writeFile(script, POSIX_HELPER, { flag: 'wx', mode: 0o700 }); executable = '/bin/sh'; args = [script, String(plan.pid), plan.target, plan.staged, plan.backup, plan.result, plan.ready, plan.platform, plan.identity, this.edition.productName, plan.started];
      }
      await writeJSON(path.join(this.directory, 'install.json'), { id, repository: this.edition.repository, version: downloaded.version, backup, started });
      const child = this.spawnProcess(executable, args, options); helper = child; let failure; child.once('error', error => { failure = error; }); child.unref();
      for (let i = 0; i < 50; i++) { if (failure) throw failure; try { if ((await fs.readFile(ready, 'utf8')).includes('ready')) break; } catch {} if (i === 49) throw new Error('The update helper could not start. This app is still running.'); await new Promise(resolve => setTimeout(resolve, 50)); }
      try { this.assertIdle(); } catch (error) { child.kill(); throw error; }
      this.state.status = 'installing'; this.state.error = ''; this.emit(); await this.quit(); return this.snapshot();
    } catch (error) {
      helper?.kill();
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (installId) for (const name of ['install.json', 'ready-' + installId, 'started-' + installId, 'result-' + installId + '.json', 'apply-' + installId + '.sh', 'apply-' + installId + '.ps1', 'plan-' + installId + '.json']) await fs.rm(path.join(this.directory, name), { force: true }).catch(() => {});
      this.state.status = this.downloaded ? 'downloaded' : this.release ? 'available' : 'idle'; this.state.error = safeMessage(error); this.emit(); throw error;
    } finally { if (this.controller === controller) this.controller = null; }
  }
  async confirmStartup() {
    await this.initialized;
    const pending = this.pendingInstall;
    if (!pending || pending.version !== this.version || pending.repository !== this.edition.repository) return this.snapshot();
    if (!await this.ownsCache()) throw new Error('The update confirmation record is not in its original updater cache.');
    const marker = path.join(this.directory, 'started-' + pending.id);
    await fs.writeFile(marker, JSON.stringify({ id: pending.id, version: this.version }), { flag: 'wx', mode: 0o600 });
    // The helper commits success only after observing the ready marker. Until then
    // retain the journal so an interrupted or failed helper remains recoverable.
    const resultFile = path.join(this.directory, 'result-' + pending.id + '.json');
    let committed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      let result; try { result = await readJSON(resultFile, 8192); } catch {}
      if (result?.status === 'installed') { committed = true; break; }
      if (result && result.status !== 'installed') throw new Error('The update helper did not confirm installation.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!committed) return this.snapshot();
    for (const name of ['install.json', 'result-' + pending.id + '.json', 'ready-' + pending.id, 'started-' + pending.id]) await fs.rm(path.join(this.directory, name), { force: true });
    this.state.result = { status: 'installed', version: this.version, backupRetained: pending.backupRetained };
    this.pendingInstall = null;
    this.emit();
    return this.snapshot();
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.enabled || !this.started || this.disposed || !this.preferencesValid || !this.preferences.autoCheck) return;
    const remaining = this.state.lastChecked ? Math.max(15000, INTERVAL - (this.clock() - this.state.lastChecked)) : 15000;
    this.timer = setTimeout(async () => {
      try { if (!ACTIVE.has(this.state.status) && !this.isBusy()) await this.check(); } catch {}
      if (!this.disposed && this.preferences.autoCheck) { this.timer = setTimeout(() => { this.schedule(); }, 15 * 60 * 1000); this.timer.unref?.(); }
    }, Math.min(remaining, INTERVAL)); this.timer.unref?.();
  }
  async start() { await this.initialized; this.started = true; this.schedule(); }
  async shutdown() { this.disposed = true; clearTimeout(this.timer); if (this.state.status !== 'installing') this.controller?.abort(); }
}
module.exports = { UpdateManager, EDITIONS, parseVersion, compareVersions, assetName, assertURL, requestStream, fetchBuffer, selectRelease, parseChecksums, hashFile, assertAppIdentity, API_URL, RELEASES_URL, MAX_DOWNLOAD };
