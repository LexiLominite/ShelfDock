'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RECEIPT_NAME = '.dropharbor-receipt.json';
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_RECORDS = 100;
const MAX_SCAN_FOLDERS = 300;
const MAX_DESKTOP_ENTRIES = 10000;
const BATCH_NAME = /^Drift-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidText = value => /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const validDate = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
const idFor = (folder, id) => crypto.createHash('sha256').update(folder + '\0' + id).digest('hex');
const validName = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 255 && value !== '.' && value !== '..' && !/[\\/:]/.test(value) && !invalidText(value) && value.toLowerCase() !== RECEIPT_NAME;

function validateManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1 || !UUID.test(input.id || '') || !validDate(input.sentAt)) throw new Error('Invalid transfer receipt.');
  if (typeof input.senderLabel !== 'string' || !input.senderLabel.trim() || input.senderLabel.length > 64 || invalidText(input.senderLabel)) throw new Error('Invalid sender label.');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 500) throw new Error('Invalid transfer item list.');
  const names = new Set();
  const items = input.items.map(item => {
    if (!item || typeof item !== 'object' || !validName(item.name) || !['file', 'folder', 'text'].includes(item.kind) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('Invalid received item.');
    const key = item.name.normalize('NFC').toLowerCase();
    if (names.has(key)) throw new Error('Duplicate received item.');
    names.add(key);
    return { name: item.name, kind: item.kind, size: item.size };
  });
  return { version: 1, id: input.id.toLowerCase(), senderLabel: input.senderLabel.trim(), sentAt: new Date(input.sentAt).toISOString(), items };
}

function encodeManifest(input) {
  const encoded = JSON.stringify(validateManifest(input));
  if (Buffer.byteLength(encoded, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('Transfer receipt is too large.');
  return encoded;
}

// Read a bounded, ordinary file. O_NOFOLLOW and inode checks protect the marker
// itself; callers also verify its enclosing directory before and after reading.
async function readBoundedFile(file, maximum) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new Error('Not a bounded regular file.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximum || stats.dev !== before.dev || stats.ino !== before.ino) throw new Error('File changed while opening.');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maximum) throw new Error('File is too large.');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

class ReceivedManager {
  constructor({ dataDir, desktopDir, service, openPath = async () => '', onChange = () => {}, clock = Date.now, enabled = true, intervalMs = 15000 } = {}) {
    if (!dataDir || !desktopDir) throw new Error('Received items need an app data directory and Desktop directory.');
    this.dataDir = dataDir; this.desktopDir = path.resolve(desktopDir); this.service = service; this.openPath = openPath; this.onChange = onChange; this.clock = clock; this.enabled = enabled; this.intervalMs = Math.max(5000, intervalMs);
    this.records = []; this.scanning = false; this.lastScan = null; this.error = ''; this.timer = null; this.refreshPromise = null; this.operations = Promise.resolve();
    this.initialized = this.load();
  }
  async load() {
    if (!this.enabled) return;
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readBoundedFile(path.join(this.dataDir, 'received.json'), MAX_MANIFEST_BYTES * MAX_RECORDS + 1024 * 1024));
      if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > MAX_RECORDS) throw new Error('Invalid index.');
      const seen = new Set();
      this.records = data.records.map(record => {
        if (!record || !BATCH_NAME.test(record.folderName) || !validDate(record.receivedAt) || typeof record.unread !== 'boolean') throw new Error('Invalid received record.');
        const manifest = validateManifest(record.manifest);
        if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_MANIFEST_BYTES) throw new Error('Oversized record.');
        const id = idFor(record.folderName, manifest.id);
        if (seen.has(id)) throw new Error('Duplicate record.');
        seen.add(id);
        return { id, folderName: record.folderName, manifest, receivedAt: record.receivedAt, unread: record.unread, available: false };
      });
    } catch (error) { if (error.code !== 'ENOENT') this.error = 'Received history could not be loaded. Refresh to find completed transfers on your Desktop.'; }
  }
  snapshot() {
    const received = this.records.map(({ id, folderName, manifest, receivedAt, unread, available }) => ({ id, folderName, senderLabel: manifest.senderLabel, sentAt: manifest.sentAt, receivedAt, items: clone(manifest.items), itemCount: manifest.items.length, unread, available }));
    return { received, unreadCount: received.filter(item => item.unread).length, scanning: this.scanning, lastScan: this.lastScan, error: this.error, locationLabel: 'Desktop', enabled: this.enabled };
  }
  async getState() { await this.initialized; return this.snapshot(); }
  emit() { try { this.onChange(this.snapshot()); } catch {} }
  serialize(operation) {
    const next = this.operations.catch(() => {}).then(async () => { await this.initialized; return operation(); });
    this.operations = next;
    return next;
  }
  async save(records) {
    const file = path.join(this.dataDir, 'received-' + crypto.randomUUID() + '.tmp');
    try {
      await fs.writeFile(file, JSON.stringify({ version: 1, records: records.map(({ id, available, ...record }) => record) }), { flag: 'wx', mode: 0o600 });
      await fs.rename(file, path.join(this.dataDir, 'received.json'));
    } finally { await fs.unlink(file).catch(() => {}); }
  }
  async rootPath() {
    // Electron supplies the OS-resolved Desktop (including OneDrive redirects).
    // Resolve it once per operation; never accept roots supplied by a renderer.
    const root = await fs.realpath(this.desktopDir);
    if (!(await fs.lstat(root)).isDirectory()) throw new Error('Desktop is unavailable.');
    return root;
  }
  async batchPath(root, folderName) {
    if (!BATCH_NAME.test(folderName)) throw new Error('Invalid transfer folder.');
    const folder = path.join(root, folderName);
    const stats = await fs.lstat(folder);
    if (!stats.isDirectory() || stats.isSymbolicLink() || await fs.realpath(folder) !== folder) throw new Error('Transfer folder is no longer available.');
    return { folder, stats };
  }
  async inspect(root, folderName) {
    const { folder, stats } = await this.batchPath(root, folderName);
    const manifest = validateManifest(JSON.parse(await readBoundedFile(path.join(folder, RECEIPT_NAME), MAX_MANIFEST_BYTES)));
    const markerStats = await fs.lstat(path.join(folder, RECEIPT_NAME));
    const completedAt = new Date(markerStats.mtimeMs).toISOString();
    const after = await this.batchPath(root, folderName);
    if (stats.dev !== after.stats.dev || stats.ino !== after.stats.ino) throw new Error('Transfer folder changed.');
    let available = true;
    for (const item of manifest.items) {
      try {
        const itemPath = path.join(folder, item.name); const itemStats = await fs.lstat(itemPath);
        if (itemStats.isSymbolicLink() || (item.kind === 'folder' ? !itemStats.isDirectory() : !itemStats.isFile() || itemStats.size !== item.size) || path.dirname(await fs.realpath(itemPath)) !== folder) available = false;
      } catch { available = false; }
    }
    return { manifest, available, folder, folderStats: stats, completedAt };
  }
  refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.serialize(async () => {
      if (!this.enabled) return this.snapshot();
      this.scanning = true; this.emit();
      try {
        const root = await this.rootPath(); const directory = await fs.opendir(root); const names = [];
        let examined = 0;
        for await (const entry of directory) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && BATCH_NAME.test(entry.name)) names.push(entry.name);
          if (++examined >= MAX_DESKTOP_ENTRIES) break;
        }
        const candidates = names.sort().reverse().slice(0, MAX_SCAN_FOLDERS);
        const existing = new Map(this.records.map(record => [record.id, { ...record, available: false }]));
        for (const folderName of candidates) {
          try {
            const { manifest, available, completedAt } = await this.inspect(root, folderName);
            const id = idFor(folderName, manifest.id); const previous = existing.get(id);
            // Do not display an incomplete/new batch. Previously indexed records
            // remain as history if the user later moves or edits their files.
            if (!available && !previous) continue;
            if (previous && JSON.stringify(previous.manifest) !== JSON.stringify(manifest)) continue;
            existing.set(id, { id, folderName, manifest, receivedAt: previous?.receivedAt || completedAt, unread: previous ? previous.unread : true, available });
          } catch { /* Ignore incomplete or malformed batches without opening their payloads. */ }
        }
        const records = [...existing.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.folderName.localeCompare(a.folderName)).slice(0, MAX_RECORDS);
        const metadata = values => JSON.stringify(values.map(({ available, ...record }) => record));
        if (metadata(records) !== metadata(this.records)) await this.save(records);
        this.records = records; this.lastScan = new Date(this.clock()).toISOString();
        this.error = examined >= MAX_DESKTOP_ENTRIES ? 'Only the first 10,000 Desktop entries were checked. Move older items out of Desktop if a transfer is missing.' : '';
      } catch {
        this.records = this.records.map(record => ({ ...record, available: false }));
        this.error = 'Desktop could not be checked. Allow Desktop access and refresh. Your received history is kept.';
      } finally { this.scanning = false; this.emit(); }
      return this.snapshot();
    }).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
  markRead(payload = {}) {
    return this.serialize(async () => {
      if (!this.enabled) return this.snapshot();
      if (!payload || typeof payload !== 'object' || (payload.all !== true && (typeof payload.id !== 'string' || !this.records.some(record => record.id === payload.id)))) throw new Error('Choose a received transfer.');
      const records = this.records.map(record => payload.all === true || record.id === payload.id ? { ...record, unread: false } : record);
      await this.save(records); this.records = records; this.emit(); return this.snapshot();
    });
  }
  async resolveRecord(id) {
    await this.initialized;
    if (!this.enabled || typeof id !== 'string') throw new Error('Choose a received transfer.');
    const record = this.records.find(item => item.id === id);
    if (!record) throw new Error('This received transfer is no longer in history.');
    const root = await this.rootPath(); const inspected = await this.inspect(root, record.folderName);
    if (JSON.stringify(inspected.manifest) !== JSON.stringify(record.manifest)) throw new Error('This transfer folder changed. Refresh Received before opening it.');
    return { record, ...inspected, root };
  }
  async openFolder({ id } = {}) {
    const { folder, root, record, folderStats } = await this.resolveRecord(id);
    const current = await this.batchPath(root, record.folderName);
    if (current.stats.ino !== folderStats.ino || current.stats.dev !== folderStats.dev) throw new Error('Transfer folder changed.');
    const error = await this.openPath(folder);
    if (error) throw new Error('The received folder could not be opened.');
    return this.markRead({ id });
  }
  async addToShelf({ id, names } = {}) {
    if (!this.service?.enqueueFiles) throw new Error('The transfer shelf is unavailable.');
    const { record, manifest, folder, available, root, folderStats } = await this.resolveRecord(id);
    if (!available) throw new Error('Some received files were moved or changed. Open their folder to find them.');
    const selected = names === undefined ? manifest.items.map(item => item.name) : names;
    if (!Array.isArray(selected) || !selected.length || selected.length > 500 || new Set(selected).size !== selected.length || !selected.every(name => manifest.items.some(item => item.name === name))) throw new Error('Choose items from this received transfer.');
    const validateSource = async () => {
      const current = await this.batchPath(root, record.folderName);
      if (current.stats.ino !== folderStats.ino || current.stats.dev !== folderStats.dev || await this.rootPath() !== root) throw new Error('Transfer folder changed.');
      for (const name of selected) {
        const itemPath = path.join(folder, name);
        const stats = await fs.lstat(itemPath);
        if (stats.isSymbolicLink() || path.dirname(await fs.realpath(itemPath)) !== folder) throw new Error('A received item changed.');
      }
    };
    // Validate inside the shelf mutation queue, again immediately before its
    // persist; a queued request must not follow a folder swapped for a symlink.
    const state = await this.service.enqueueFiles(selected.map(name => path.join(folder, name)), validateSource);
    await this.markRead({ id });
    return state;
  }
  start() {
    if (!this.enabled || this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { ReceivedManager, RECEIPT_NAME, MAX_MANIFEST_BYTES, validateManifest, encodeManifest };
