'use strict';
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const crypto = require('node:crypto');

const MAX_EXPANDED = 3 * 1024 ** 3;
const MAX_ENTRIES = 40000;
const MAX_FILE = 1024 ** 3;
const cleanPath = name => typeof name === 'string' && name.length > 0 && name.length <= 2048 && !/[\\\x00-\x1f\x7f:]/.test(name) && !name.startsWith('/') && !name.split('/').some(part => part === '..' || part === '.');
function validateEntries(entries, root) {
  if (!entries.length || entries.length > MAX_ENTRIES) throw new Error('The update archive contains an invalid number of files.');
  const names = new Map(); let total = 0;
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, '');
    if (!cleanPath(name) || (name !== root && !name.startsWith(root + '/'))) throw new Error('The update archive contains an unsafe path.');
    if (!['file', 'directory', 'symlink'].includes(entry.type) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE) throw new Error('The update archive contains an unsupported file.');
    if (names.has(name.toLowerCase())) throw new Error('The update archive contains duplicate paths.');
    names.set(name.toLowerCase(), entry.type); total += entry.size;
    if (total > MAX_EXPANDED) throw new Error('The expanded update is too large.');
    if (entry.type === 'symlink') {
      if (typeof entry.link !== 'string' || !entry.link || entry.link.length > 2048 || /[\\\x00-\x1f\x7f:]/.test(entry.link) || path.posix.isAbsolute(entry.link)) throw new Error('The update archive contains an unsafe link.');
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), entry.link));
      if (target !== root && !target.startsWith(root + '/')) throw new Error('An update link leaves the application folder.');
    }
  }
  for (const entry of entries) {
    const parts = entry.name.replace(/\/$/, '').split('/'); parts.pop();
    while (parts.length) {
      const kind = names.get(parts.join('/').toLowerCase());
      if (kind && kind !== 'directory') throw new Error('An update path passes through a file or symbolic link.');
      parts.pop();
    }
  }
  return entries;
}
async function readAt(handle, length, position) {
  const data = Buffer.alloc(length); const { bytesRead } = await handle.read(data, 0, length, position);
  if (bytesRead !== length) throw new Error('The update archive is truncated.');
  return data;
}
async function zipEntries(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat(); if (size < 22) throw new Error('The ZIP update is incomplete.');
    const tail = await readAt(handle, Math.min(size, 65557), Math.max(0, size - 65557)); let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    if (eocd < 0 || tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6)) throw new Error('Unsupported ZIP update.');
    const count = tail.readUInt16LE(eocd + 10), centralSize = tail.readUInt32LE(eocd + 12), centralOffset = tail.readUInt32LE(eocd + 16);
    if (count > MAX_ENTRIES || centralSize > 32 * 1024 ** 2 || centralOffset + centralSize > size - 22 || tail.readUInt16LE(eocd + 8) !== count) throw new Error('Invalid ZIP directory.');
    const central = await readAt(handle, centralSize, centralOffset); const entries = []; let offset = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry.');
      const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10), packed = central.readUInt32LE(offset + 20), length = central.readUInt32LE(offset + 24), nameLength = central.readUInt16LE(offset + 28), extraLength = central.readUInt16LE(offset + 30), commentLength = central.readUInt16LE(offset + 32), attributes = central.readUInt32LE(offset + 38), localOffset = central.readUInt32LE(offset + 42);
      if ((flags & 1) || ![0, 8].includes(method) || length > MAX_FILE || offset + 46 + nameLength + extraLength + commentLength > central.length || localOffset + 30 > centralOffset) throw new Error('Unsupported ZIP entry.');
      const name = central.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      const local = await readAt(handle, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== method || local.readUInt16LE(6) !== flags) throw new Error('ZIP entry headers do not match.');
      const localName = await readAt(handle, local.readUInt16LE(26), localOffset + 30);
      if (localName.toString('utf8') !== name) throw new Error('ZIP entry paths do not match.');
      const start = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + packed > centralOffset) throw new Error('ZIP entry exceeds the archive.');
      const mode = attributes >>> 16, kind = mode & 0xf000;
      if (kind && ![0x4000, 0x8000, 0xa000].includes(kind)) throw new Error('Unsupported ZIP file type.');
      const type = kind === 0xa000 ? 'symlink' : name.endsWith('/') ? 'directory' : 'file';
      const entry = { name, size: length, packed, start, method, mode, type };
      if (type === 'symlink') {
        if (length > 2048 || packed > 4096) throw new Error('Oversized archive link.');
        const raw = await readAt(handle, packed, start);
        const value = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 2048 }) : raw;
        if (value.length !== length) throw new Error('Invalid archive link.'); entry.link = value.toString('utf8');
      }
      entries.push(entry); offset += 46 + nameLength + extraLength + commentLength;
    }
    if (offset !== central.length) throw new Error('Unsupported ZIP directory extension.'); return entries;
  } finally { await handle.close(); }
}
const tarString = buffer => buffer.toString('utf8').replace(/\0.*$/s, '');
function tarNumber(buffer) { const value = tarString(buffer).trim(); if (value && !/^[0-7]+$/.test(value)) throw new Error('Unsupported TAR number.'); return value ? parseInt(value, 8) : 0; }
function parsePax(buffer) {
  let offset = 0; const values = {};
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset); if (space < 0) throw new Error('Invalid TAR metadata.');
    const size = Number(buffer.subarray(offset, space).toString());
    if (!Number.isSafeInteger(size) || size <= space - offset + 1 || offset + size > buffer.length || buffer[offset + size - 1] !== 10) throw new Error('Invalid TAR metadata.');
    const text = buffer.subarray(space + 1, offset + size - 1).toString('utf8'); const equal = text.indexOf('=');
    if (equal < 1) throw new Error('Invalid TAR metadata.'); const key = text.slice(0, equal);
    if (key.startsWith('GNU.sparse')) throw new Error('Sparse update files are not supported.');
    if (Object.hasOwn(values, key)) throw new Error('Duplicate TAR metadata.'); values[key] = text.slice(equal + 1); offset += size;
  } return values;
}
async function tarEntries(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat(); let offset = 0, next = {}; const entries = [];
    while (offset + 512 <= size) {
      const header = await readAt(handle, 512, offset); if (header.every(value => value === 0)) break;
      let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== tarNumber(header.subarray(148, 156))) throw new Error('Invalid TAR header checksum.');
      const rawSize = tarNumber(header.subarray(124, 136)); const type = String.fromCharCode(header[156] || 48); const start = offset + 512;
      if (!Number.isSafeInteger(rawSize) || rawSize > MAX_FILE || start + rawSize > size) throw new Error('Invalid TAR entry length.');
      offset = start + Math.ceil(rawSize / 512) * 512;
      if (['x', 'L', 'K'].includes(type)) {
        if (rawSize > 16384) throw new Error('Oversized TAR metadata.'); const raw = await readAt(handle, rawSize, start);
        if (type === 'x') next = { ...next, ...parsePax(raw) }; else next[type === 'L' ? 'path' : 'linkpath'] = tarString(raw); continue;
      }
      if (!['0', '2', '5'].includes(type)) throw new Error('Unsupported TAR file type.');
      if (next.size !== undefined && Number(next.size) !== rawSize) throw new Error('Ambiguous TAR entry length.');
      const name = next.path || [tarString(header.subarray(345, 500)), tarString(header.subarray(0, 100))].filter(Boolean).join('/');
      entries.push({ name, size: rawSize, start, packed: rawSize, method: 0, mode: tarNumber(header.subarray(100, 108)), type: type === '2' ? 'symlink' : type === '5' ? 'directory' : 'file', link: next.linkpath || tarString(header.subarray(157, 257)) });
      next = {}; if (entries.length > MAX_ENTRIES) throw new Error('Too many archive entries.');
    }
    if (Object.keys(next).length) throw new Error('Incomplete TAR metadata.'); return entries;
  } finally { await handle.close(); }
}
function sizeGuard(limit, expected) {
  let size = 0;
  return new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > limit ? new Error('Expanded update exceeds its size limit.') : null, chunk); }, flush(callback) { callback(expected !== undefined && size !== expected ? new Error('Expanded update size did not match.') : null); } });
}
async function extractArchive({ file, destination, format, root, signal }) {
  await fs.mkdir(destination, { mode: 0o700 }); let source = file, temporary;
  try {
    if (format === 'tar.gz') {
      temporary = path.join(destination, '.archive-' + crypto.randomUUID() + '.tar');
      await pipeline(createReadStream(file), zlib.createGunzip(), sizeGuard(MAX_EXPANDED), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal }); source = temporary;
    }
    const entries = validateEntries(format === 'zip' ? await zipEntries(source) : await tarEntries(source), root);
    for (const entry of entries.filter(entry => entry.type !== 'symlink')) {
      signal?.throwIfAborted(); const target = path.join(destination, entry.name);
      if (entry.type === 'directory') { await fs.mkdir(target, { recursive: true, mode: 0o755 }); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      if (!entry.size) { await fs.writeFile(target, '', { flag: 'wx', mode: (entry.mode & 0o111) ? 0o755 : 0o644 }); continue; }
      const streams = [createReadStream(source, { start: entry.start, end: entry.start + entry.packed - 1 })];
      if (entry.method === 8) streams.push(zlib.createInflateRaw());
      streams.push(sizeGuard(entry.size, entry.size), createWriteStream(target, { flags: 'wx', mode: (entry.mode & 0o111) ? 0o755 : 0o644 }));
      await pipeline(...streams, { signal });
    }
    const links = entries.filter(entry => entry.type === 'symlink');
    for (const entry of links) { await fs.mkdir(path.dirname(path.join(destination, entry.name)), { recursive: true, mode: 0o755 }); await fs.symlink(entry.link, path.join(destination, entry.name)); }
    const canonicalRoot = await fs.realpath(path.join(destination, root));
    for (const entry of links) {
      const resolved = await fs.realpath(path.join(destination, entry.name));
      if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep)) throw new Error('An update link resolves outside the application folder.');
    }
    if (temporary) await fs.unlink(temporary);
    return path.join(destination, root);
  } catch (error) { await fs.rm(destination, { recursive: true, force: true }); throw error; }
}

async function identifyInstallation({ platform, execPath, portableExecutable, isPackaged, personal, homeDir }) {
  const productName = personal ? 'LexBridge' : 'ShelfDock', prefix = personal ? 'LexBridge-personal' : 'ShelfDock';
  if (!isPackaged) return { available: false, reason: 'Install a packaged release to update this app.' };
  let target;
  if (platform === 'darwin') {
    target = path.resolve(path.dirname(execPath), '../..');
    if (path.basename(target) !== productName + '.app' || path.relative(target, execPath) !== 'Contents/MacOS/' + productName) return { available: false, reason: 'This Mac app has a custom layout. Use the verified download to update it manually.' };
  } else if (platform === 'win32') {
    if (!portableExecutable || !path.win32.isAbsolute(portableExecutable)) return { available: false, reason: 'Run the portable Windows executable to update it in place.' };
    target = portableExecutable;
  } else if (platform === 'linux') {
    if (path.basename(execPath) !== productName) return { available: false, reason: 'This Linux installation has a custom layout. Update it manually.' }; target = path.dirname(execPath);
    if (path.basename(target) !== productName && !new RegExp('^' + prefix + '-[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?-linux-(arm64|x64)$').test(path.basename(target))) return { available: false, reason: 'Linux automatic installation needs a dedicated release folder. Use the verified download to avoid replacing unrelated files.' };
  } else return { available: false, reason: 'Automatic installation is unavailable on this platform.' };
  try {
    const stat = await fs.lstat(target), parent = path.dirname(target);
    if (stat.isSymbolicLink() || (platform === 'win32' ? !stat.isFile() : !stat.isDirectory()) || path.resolve(target) === path.parse(target).root || parent === path.parse(parent).root) throw new Error();
    if (process.getuid && stat.uid !== process.getuid()) throw new Error();
    if (await fs.realpath(target) !== path.resolve(target) || await fs.realpath(parent) !== path.resolve(parent)) throw new Error();
    if (platform === 'linux' && (['/usr', '/opt', '/bin', '/sbin', '/lib', '/etc', '/var'].some(base => target === base || target.startsWith(base + '/')) || path.resolve(target) === path.resolve(homeDir || require('node:os').homedir()))) throw new Error();
    if (platform !== 'win32') {
      const asar = path.join(target, platform === 'darwin' ? 'Contents/Resources/app.asar' : 'resources/app.asar');
      if (!(await fs.lstat(asar)).isFile()) throw new Error();
    }
    await fs.access(parent, require('node:fs').constants.W_OK);
    return { available: true, target, identity: `${stat.dev}:${stat.ino}`, platform };
  } catch { return { available: false, reason: 'This installation is not a writable app owned by you. Use the verified package to update it manually.' }; }
}

// The helper is fixed local code. All paths are separate arguments, never interpolated shell commands.
const POSIX_HELPER = `#!/bin/sh
set -eu
umask 077
pid=$1; target=$2; staged=$3; backup=$4; result=$5; ready=$6; platform=$7; identity=$8; executable=$9; started=\${10}
case "$executable" in ShelfDock|LexBridge) ;; *) exit 1 ;; esac
write_result() { printf '{"status":"%s"}\\n' "$1" > "$result.tmp"; mv "$result.tmp" "$result"; }
restore_backup() {
  [ -e "$backup" ] || return 1
  if [ -e "$target" ]; then mv "$target" "$staged" || return 1; fi
  mv "$backup" "$target"
}
printf 'ready' > "$ready"
count=0
while kill -0 "$pid" 2>/dev/null; do count=$((count+1)); [ "$count" -lt 300 ] || { write_result parent_running; exit 1; }; sleep 0.2; done
[ ! -L "$target" ] && [ ! -L "$staged" ] && [ -e "$target" ] && [ -e "$staged" ] && [ ! -e "$backup" ] && [ ! -L "$backup" ] && [ ! -e "$started" ] && [ ! -L "$started" ] || { write_result changed; exit 1; }
if [ "$platform" = darwin ]; then actual=$(/usr/bin/stat -f '%d:%i' "$target"); else actual=$(stat -c '%d:%i' "$target"); fi
[ "$actual" = "$identity" ] || { write_result changed; exit 1; }
mv "$target" "$backup" || { write_result backup_failed; exit 1; }
if ! mv "$staged" "$target"; then if restore_backup; then write_result rolled_back; else write_result failed; fi; exit 1; fi
if [ "$platform" = darwin ]; then
  /usr/bin/open -g -W "$target" --args --background & new_pid=$!
else
  if [ ! -x "$target/$executable" ]; then if restore_backup; then write_result rolled_back; "$target/$executable" --background >/dev/null 2>&1 & else write_result failed; fi; exit 1; fi
  "$target/$executable" --background >/dev/null 2>&1 & new_pid=$!
fi
count=0
while [ ! -f "$started" ]; do
  count=$((count+1))
  if [ "$count" -ge 300 ] || { [ -n "$new_pid" ] && ! kill -0 "$new_pid" 2>/dev/null; }; then
    if [ -n "$new_pid" ] && kill -0 "$new_pid" 2>/dev/null; then kill "$new_pid" 2>/dev/null || true; fi
    if [ "$platform" = darwin ]; then
      # open -W tracks the app lifetime but is not the app process itself.
      # Stop only executables in this exact replaced bundle before restoring it.
      /bin/ps -axo pid=,comm= | while read -r app_pid command; do
        if [ "$command" = "$target/Contents/MacOS/$executable" ]; then kill "$app_pid" 2>/dev/null || true; fi
      done
    fi
    if restore_backup; then
      write_result rolled_back
      if [ "$platform" = darwin ]; then /usr/bin/open -g "$target" --args --background || true; else "$target/$executable" --background >/dev/null 2>&1 & fi
    else write_result failed; fi
    exit 1
  fi
  sleep 0.2
done
rmdir "$(dirname "$staged")" 2>/dev/null || true
write_result installed
`;
const WINDOWS_HELPER = String.raw`param([string]$Plan)
$ErrorActionPreference = 'Stop'
$p = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
function Result([string]$state) { @{status=$state} | ConvertTo-Json -Compress | Set-Content -LiteralPath ($p.result + '.tmp') -Encoding UTF8; Move-Item -LiteralPath ($p.result + '.tmp') -Destination $p.result -Force }
function RestoreBackup {
  try { if (Test-Path -LiteralPath $p.target) { Move-Item -LiteralPath $p.target -Destination $p.staged } } catch { return $false }
  try { Move-Item -LiteralPath $p.backup -Destination $p.target; return $true } catch { return $false }
}
Set-Content -LiteralPath $p.ready -Value 'ready' -Encoding ASCII
$deadline = (Get-Date).AddSeconds(60)
while (Get-Process -Id $p.pid -ErrorAction SilentlyContinue) { if ((Get-Date) -gt $deadline) { Result 'parent_running'; exit 1 }; Start-Sleep -Milliseconds 200 }
try {
  if ((Test-Path -LiteralPath $p.backup) -or (Test-Path -LiteralPath $p.started) -or !(Test-Path -LiteralPath $p.target) -or !(Test-Path -LiteralPath $p.staged)) { throw 'Changed destination' }
  foreach ($f in @($p.target, $p.staged)) { if ((Get-Item -LiteralPath $f).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe destination' } }
  if ((Get-FileHash -LiteralPath $p.target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.oldHash) { throw 'Changed executable' }
  if ((Get-FileHash -LiteralPath $p.staged -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.sha256) { throw 'Changed download' }
  $moveDeadline = (Get-Date).AddSeconds(10)
  while ($true) {
    try { Move-Item -LiteralPath $p.target -Destination $p.backup; break }
    catch { if ((Get-Date) -gt $moveDeadline) { throw }; Start-Sleep -Milliseconds 200; if ((Get-FileHash -LiteralPath $p.target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.oldHash) { throw 'Changed executable' } }
  }
  try {
    Move-Item -LiteralPath $p.staged -Destination $p.target
    $newProcess = Start-Process -FilePath $p.target -ArgumentList '--background' -PassThru
    $startupDeadline = (Get-Date).AddSeconds(60)
    while (!(Test-Path -LiteralPath $p.started)) {
      if ((Get-Date) -gt $startupDeadline -or $newProcess.HasExited) { throw 'Startup was not confirmed' }
      Start-Sleep -Milliseconds 200
    }
  }
  catch {
    if ($newProcess -and !$newProcess.HasExited) { Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue }
    if (RestoreBackup) { Result 'rolled_back'; Start-Process -FilePath $p.target -ArgumentList '--background' | Out-Null } else { Result 'failed' }
    exit 1
  }
  Result 'installed'
  Remove-Item -LiteralPath (Split-Path -Parent $p.staged) -ErrorAction SilentlyContinue
} catch { Result 'failed'; exit 1 }
`;
module.exports = { MAX_EXPANDED, validateEntries, zipEntries, tarEntries, extractArchive, identifyInstallation, POSIX_HELPER, WINDOWS_HELPER };
