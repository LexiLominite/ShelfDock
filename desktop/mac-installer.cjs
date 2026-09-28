'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { endpointKey } = require('./password-auth.cjs');

const BUNDLE_ID = 'com.lexilominite.lex-drift';
const PLAN_MS = 5 * 60 * 1000;
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const clone = value => JSON.parse(JSON.stringify(value));
const clean = value => typeof value === 'string' && value.length < 4096 && !/[\x00-\x1f\x7f]/.test(value);
const shell = script => '/bin/sh -c ' + quote('set -eu\n' + script);
const secure = ['ClearAllForwardings=yes', 'PermitLocalCommand=no', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ForwardX11Trusted=no', 'ForkAfterAuthentication=no', 'ControlMaster=no', 'ControlPath=none', 'RemoteCommand=none', 'RequestTTY=no'].flatMap(value => ['-o', value]);
const errorScript = `fail() { printf 'DH_ERROR=%s\\n' "$1"; exit 0; }\n`;
const ERRORS = {
  OS: 'This destination is not a Mac. Install on another Mac supports macOS destinations only.',
  HOME: 'The destination Mac did not return a safe home folder.',
  BASE: 'The destination Applications folder must be an ordinary folder, not a symbolic link.',
  CHANGED: 'The destination changed since preview. Review the Mac again before installing.',
  EXISTS: 'An app already exists at this destination. Open it or update it manually; this installer never replaces an existing app.',
  BUSY: 'Another installation holds the destination lock. Wait for it to finish; a stale lock needs manual inspection.',
  STAGE: 'The private installation staging folder could not be verified.',
  HASH: 'The uploaded installer did not match its SHA-256 checksum. Nothing was installed.',
  BUNDLE: 'The uploaded app identity or version did not match this installation plan.',
  COMMIT: 'The app could not be installed without replacing an existing destination. Check the destination and preview again.'
};
function parse(stdout) {
  const result = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^DH_([A-Z0-9_]+)=(.*)$/.exec(line); if (!m) continue;
    if (Object.hasOwn(result, m[1])) throw new Error('The Mac returned an ambiguous installation response.');
    result[m[1]] = m[2];
  }
  if (result.ERROR) throw new Error(ERRORS[result.ERROR] || 'The destination refused this installation.');
  return result;
}
function decode(value) {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('The Mac returned an invalid destination path.');
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!clean(decoded) || !decoded.startsWith('/') || decoded.includes('/../') || decoded.endsWith('/..')) throw new Error('The Mac returned an invalid destination path.');
  return decoded;
}
const architectureLabel = arch => arch === 'arm64' ? 'Apple Silicon (ARM64)' : 'Intel (x64)';
const remotePrelude = expectedHome => `${errorScript}
[ "$(/usr/bin/uname -s)" = Darwin ] || fail OS
home=$(cd "$HOME" && /bin/pwd -P) || fail HOME
${expectedHome ? `[ "$home" = ${quote(expectedHome)} ] || fail CHANGED` : ''}
base="$home/Applications"
[ ! -L "$base" ] || fail BASE
if [ -e "$base" ]; then [ -d "$base" ] || fail BASE; fi
architecture=$(/usr/bin/uname -m)
if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then architecture=arm64; fi
`;
function inspectCommand(appName, expectedHome) {
  return shell(`${remotePrelude(expectedHome)}
destination="$base"/${quote(appName)}
existing=no; version=unknown
if [ -e "$destination" ] || [ -L "$destination" ]; then
  existing=yes
  if [ ! -L "$destination" ] && [ -f "$destination/Contents/Info.plist" ] && [ ! -L "$destination/Contents" ] && [ ! -L "$destination/Contents/Info.plist" ]; then
    version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$destination/Contents/Info.plist" 2>/dev/null || printf unknown)
  fi
fi
printf 'DH_OS=Darwin\\nDH_ARCH=%s\\nDH_EXISTS=%s\\nDH_VERSION_B64=' "$architecture" "$existing"
printf '%s' "$version" | /usr/bin/base64 | /usr/bin/tr -d '\\n'
printf '\\nDH_HOME_B64='
printf '%s' "$home" | /usr/bin/base64 | /usr/bin/tr -d '\\n'
printf '\\n'
`);
}
function stageCommand(plan, token) {
  return shell(`${remotePrelude(plan.home)}
[ "$architecture" = ${quote(plan.remoteArchitecture)} ] || fail CHANGED
destination="$base"/${quote(plan.appName)}
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail EXISTS
umask 077
if [ ! -d "$base" ]; then /bin/mkdir "$base"; fi
[ ! -L "$base" ] && [ "$(cd "$base" && /bin/pwd -P)" = "$base" ] || fail BASE
stage="$base/.dropharbor-install-${token}"
/bin/mkdir "$stage"
printf '%s' ${quote(token)} > "$stage/.owner"
printf 'DH_STAGE_B64='
printf '%s' "$stage" | /usr/bin/base64 | /usr/bin/tr -d '\\n'
printf '\\n'
`);
}
function finishCommand(plan, token, hash) {
  const lock = '.dropharbor-install-' + crypto.createHash('sha256').update(plan.appName).digest('hex').slice(0, 16) + '.lock';
  return shell(`${remotePrelude(plan.home)}
[ "$architecture" = ${quote(plan.remoteArchitecture)} ] || fail CHANGED
stage="$base/.dropharbor-install-${token}"
[ -d "$stage" ] && [ ! -L "$stage" ] && [ "$(/bin/cat "$stage/.owner")" = ${quote(token)} ] || fail STAGE
archive="$stage/payload.zip"
[ -f "$archive" ] && [ ! -L "$archive" ] || fail STAGE
actual=$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')
[ "$actual" = ${quote(hash)} ] || fail HASH
/bin/mkdir "$stage/extracted"
/usr/bin/ditto -x -k --rsrc --extattr --qtn --acl "$archive" "$stage/extracted"
bundle="$stage/extracted"/${quote(plan.appName)}
[ -d "$bundle" ] && [ ! -L "$bundle" ] || fail BUNDLE
plist="$bundle/Contents/Info.plist"
[ -f "$plist" ] && [ ! -L "$plist" ] || fail BUNDLE
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" = ${quote(BUNDLE_ID)} ] || fail BUNDLE
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" = ${quote(plan.version)} ] || fail BUNDLE
lock="$base"/${quote(lock)}
/bin/mkdir "$lock" 2>/dev/null || fail BUSY
printf '%s' ${quote(token)} > "$lock/.owner"
release_lock() { if [ ! -L "$lock" ] && [ "$(/bin/cat "$lock/.owner" 2>/dev/null)" = ${quote(token)} ]; then /bin/rm -f "$lock/.owner"; /bin/rmdir "$lock" 2>/dev/null || true; fi; }
trap release_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
destination="$base"/${quote(plan.appName)}
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail EXISTS
# Parent destination keeps mv -n from nesting inside a racing .app directory.
/bin/mv -n "$bundle" "$base/"
[ ! -e "$bundle" ] && [ ! -L "$bundle" ] && [ -d "$destination" ] && [ ! -L "$destination" ] || fail COMMIT
printf 'DH_INSTALLED=yes\\n'
`);
}
function cleanupCommand(plan, token) {
  return shell(`${remotePrelude(plan.home)}
stage="$base/.dropharbor-install-${token}"
if [ -e "$stage" ] || [ -L "$stage" ]; then
 [ -d "$stage" ] && [ ! -L "$stage" ] && [ "$(/bin/cat "$stage/.owner" 2>/dev/null)" = ${quote(token)} ] || fail STAGE
 /bin/rm -rf "$stage"
fi
printf 'DH_CLEANED=yes\\n'
`);
}
async function fingerprint(root) {
  const records = [];
  async function walk(file) {
    const stat = await fs.lstat(file); const relative = path.relative(root, file);
    if (stat.isSymbolicLink()) {
      const target = await fs.realpath(file);
      if (!target.startsWith(root + path.sep)) throw new Error('This app contains a link outside its bundle. Use an unmodified packaged app.');
      records.push([relative, 'link', await fs.readlink(file)]); return;
    }
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('This app bundle contains an unsupported file. Use an unmodified packaged app.');
    records.push([relative, stat.size, stat.mtimeMs, stat.mode, stat.isFile() ? await sha256(file) : null]);
    if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await walk(path.join(file, name));
  }
  await walk(root); return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}
async function sha256(file) { const digest = crypto.createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes); return digest.digest('hex'); }

class MacInstaller {
  constructor({ service, sourceApp, platform = process.platform, arch = process.arch, version, productName, isPackaged = false, onChange = () => {}, clock = Date.now, executor = promisify(execFile) } = {}) {
    if (!service) throw new Error('Mac installation requires the saved-machine service.');
    Object.assign(this, { service, sourceApp, platform, arch, version, productName, isPackaged, onChange, clock, executor });
    this.plans = new Map(); this.operation = null; this.task = null; this.closed = false;
  }
  capabilities() {
    let reason = '';
    if (this.platform !== 'darwin') reason = 'Install on another Mac is available from the macOS app. The rest of ShelfDock remains cross-platform.';
    else if (!this.isPackaged || !this.sourceApp || !path.isAbsolute(this.sourceApp) || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,70}\.app$/.test(path.basename(this.sourceApp))) reason = 'Run the installed macOS .app to install it on another Mac; development and browser previews cannot provide an installer.';
    else if (!['arm64', 'x64'].includes(this.arch)) reason = 'This Mac app architecture cannot be installed on another Mac.';
    else if (this.closed) reason = 'The app is shutting down.';
    return { available: !reason, reason, sourceApp: this.sourceApp || null, productName: this.productName || 'ShelfDock', version: this.version, architecture: architectureLabel(this.arch) };
  }
  getState() { return { ...this.capabilities(), operation: this.operation ? clone(this.operation) : null }; }
  emit() { try { this.onChange(this.getState()); } catch {} }
  assertIdle() {
    if (!this.capabilities().available) throw new Error(this.capabilities().reason);
    if (this.task || this.service.macInstallation || this.service.transferring || this.service.authenticationSetup || this.service.configurationImport || this.service.configurationSaving || this.service.tunnelSetup || this.service.scanPromise || this.service.probePromise) throw new Error('Wait for the current transfer, machine check, settings save, access setup, or installation to finish.');
  }
  exclusive(work) {
    this.assertIdle(); this.service.macInstallation = true;
    const task = Promise.resolve().then(work).finally(() => { this.service.macInstallation = false; if (this.task === task) this.task = null; });
    this.task = task; return task;
  }
  async whenIdle() { await this.task?.catch(() => {}); return this.getState(); }
  async shutdown() { this.closed = true; this.plans.clear(); return this.whenIdle(); }
  async source() {
    const stat = await fs.lstat(this.sourceApp);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The source must be the installed app bundle, not a shortcut or symbolic link.');
    const root = await fs.realpath(this.sourceApp); const plist = path.join(root, 'Contents/Info.plist');
    const field = async key => String((await this.executor('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist], { timeout: 10000, maxBuffer: 8192 })).stdout).trim();
    const [bundleId, version, executable] = await Promise.all(['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleExecutable'].map(field));
    if (bundleId !== BUNDLE_ID || version !== this.version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(version) || !clean(executable) || path.basename(executable) !== executable) throw new Error('The installed app identity or version changed. Restart the correct packaged app before trying again.');
    const binary = await fs.open(path.join(root, 'Contents/MacOS', executable), 'r');
    try {
      const header = Buffer.alloc(8); await binary.read(header, 0, 8, 0);
      const expected = this.arch === 'arm64' ? 0x0100000c : 0x01000007;
      if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== expected) throw new Error('This installer requires a matching single-architecture Mac package. Download the Apple Silicon or Intel build for this Mac.');
    } finally { await binary.close(); }
    const hash = await fingerprint(root);
    let includesPersonalPreset = false;
    try { const preset = await fs.lstat(path.join(root, 'Contents/Resources/personal-config.json')); if (!preset.isFile() || preset.isSymbolicLink()) throw new Error('The bundled personal preset is not a regular file.'); includesPersonalPreset = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { root, appName: path.basename(root), fingerprint: hash, includesPersonalPreset, version };
  }
  async host(hostId, endpoint) {
    const host = (await this.service.getState()).hosts.find(entry => entry.id === hostId);
    if (!host || !host.user || host.os === 'windows') throw new Error('Choose a saved Mac with an SSH login username.');
    if (endpoint && endpointKey(host) !== endpoint) throw new Error('This machine’s connection details changed. Preview it again before installing.');
    return clone(host);
  }
  async withSession(host, work) { return this.service.passwordAuth.metadata(host).hasSavedPassword ? this.service.passwordAuth.withPassword(host, work) : work(null); }
  async remote(host, session, command, timeout = 15000) { return parse((session ? await session.exec(command, timeout) : await this.service.run('ssh', [...secure, ...this.service.sshArgs(host), command], { timeout })).stdout); }
  async inspect(host, session, appName, home) {
    const info = await this.remote(host, session, inspectCommand(appName, home));
    if (info.OS !== 'Darwin' || !['arm64', 'x86_64'].includes(info.ARCH) || !['yes', 'no'].includes(info.EXISTS)) throw new Error('The destination did not return a complete Mac installation preview.');
    const remoteHome = decode(info.HOME_B64); const remoteArchitecture = this.arch === 'arm64' ? 'arm64' : 'x86_64';
    if (info.ARCH !== remoteArchitecture) throw new Error(`This app is for ${architectureLabel(this.arch)}; the destination is ${architectureLabel(info.ARCH === 'arm64' ? 'arm64' : 'x64')}. Download the matching Mac build instead.`);
    const existingVersion = info.EXISTS === 'yes' ? Buffer.from(info.VERSION_B64 || '', 'base64').toString('utf8').slice(0, 80).replace(/[\x00-\x1f\x7f]/g, '') || 'unknown' : null;
    return { home: remoteHome, remoteArchitecture, destination: path.posix.join(remoteHome, 'Applications', appName), existingDestination: info.EXISTS === 'yes', existingVersion };
  }
  preview({ hostId } = {}) {
    return this.exclusive(async () => {
      const source = await this.source(); const host = await this.host(hostId);
      const remote = await this.withSession(host, session => this.inspect(host, session, source.appName));
      const id = crypto.randomUUID(); const expiresAt = this.clock() + PLAN_MS;
      const view = { id, hostId: host.id, hostName: host.name, address: host.address, user: host.user, destination: remote.destination, architecture: architectureLabel(this.arch), version: source.version, productName: this.productName, includesPersonalPreset: source.includesPersonalPreset, expiresAt, existingVersion: remote.existingVersion, existingDestination: remote.existingDestination, canInstall: !remote.existingDestination, reason: remote.existingDestination ? ERRORS.EXISTS : '' };
      for (const [key, plan] of this.plans) if (plan.expiresAt <= this.clock()) this.plans.delete(key);
      this.plans.clear(); this.plans.set(id, { ...view, ...remote, ...source, endpoint: endpointKey(host) });
      return clone(view);
    });
  }
  install({ planId, confirmPreset = false } = {}) {
    const plan = this.plans.get(planId);
    if (!plan || plan.expiresAt <= this.clock()) { this.plans.delete(planId); throw new Error('This installation preview expired or was already used. Preview the Mac again.'); }
    if (!plan.canInstall) throw new Error(ERRORS.EXISTS);
    if (plan.includesPersonalPreset && confirmPreset !== true) throw new Error('Confirm that this app includes your bundled personal machine preset before installing it on another Mac.');
    return this.exclusive(async () => {
      this.plans.delete(planId); const token = crypto.randomUUID(); let temporary;
      const update = (status, message, extra = {}) => { this.operation = { planId, hostId: plan.hostId, hostName: plan.hostName, destination: plan.destination, version: plan.version, status, message, ...extra }; this.emit(); };
      update('preparing', 'Checking the Mac and preparing this app bundle.');
      try {
        const host = await this.host(plan.hostId, plan.endpoint); const source = await this.source();
        if (source.root !== plan.root || source.fingerprint !== plan.fingerprint || source.version !== plan.version || source.includesPersonalPreset !== plan.includesPersonalPreset) throw new Error('The source app changed since preview. Preview again before installing.');
        await this.withSession(host, async session => {
          let staged = false;
          try {
            const fresh = await this.inspect(host, session, plan.appName, plan.home);
            if (fresh.existingDestination) throw new Error(ERRORS.EXISTS);
            temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-mac-install-')); await fs.chmod(temporary, 0o700);
            const archive = path.join(temporary, 'payload.zip');
            await this.executor('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', '--rsrc', '--extattr', '--qtn', '--acl', source.root, archive], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
            if ((await this.source()).fingerprint !== plan.fingerprint) throw new Error('The app changed while its installer was being prepared. Preview again.');
            const hash = await sha256(archive); await this.host(plan.hostId, plan.endpoint);
            // Recheck after compression and immediately before any remote writes.
            const finalCheck = await this.inspect(host, session, plan.appName, plan.home);
            if (finalCheck.existingDestination) throw new Error(ERRORS.EXISTS);
            staged = true; // A lost reply may still mean the owned staging directory was created.
            const created = await this.remote(host, session, stageCommand(plan, token));
            const stage = decode(created.STAGE_B64); const expectedStage = path.posix.join(plan.home, 'Applications', '.dropharbor-install-' + token);
            if (stage !== expectedStage) throw new Error('The Mac returned an unexpected staging folder.');
            update('uploading', 'Sending only the app bundle to this Mac.');
            if (session) await session.upload(archive, stage + '/payload.zip');
            else {
              const args = this.service.sshArgs(host).slice(); const target = args.pop(); const converted = [];
              for (let i = 0; i < args.length; i++) { if (args[i] === '-p') converted.push('-P', args[++i]); else if (args[i] === '-l') converted.push('-o', 'User=' + args[++i]); else converted.push(args[i]); }
              const targetHost = target.includes(':') ? '[' + target + ']' : target;
              await this.service.run('scp', ['-O', ...secure, ...converted, archive, targetHost + ':' + quote(stage + '/payload.zip')], { timeout: 60 * 60 * 1000 });
            }
            await this.host(plan.hostId, plan.endpoint); update('verifying', 'Verifying the upload and installing without replacing any app.');
            const result = await this.remote(host, session, finishCommand(plan, token, hash), 10 * 60 * 1000);
            if (result.INSTALLED !== 'yes') throw new Error('The Mac did not confirm installation. Check the destination before trying again.');
            update('installed', 'Installed. Open the app on the destination Mac when you are ready; it was not launched automatically.');
          } finally {
            if (staged) {
              try { const cleaned = await this.remote(host, session, cleanupCommand(plan, token)); if (cleaned.CLEANED !== 'yes') throw new Error('Cleanup was not confirmed.'); }
              catch { if (this.operation) { this.operation.cleanupPending = true; this.operation.stagingDirectory = path.posix.join(plan.home, 'Applications', '.dropharbor-install-' + token); this.emit(); } }
            }
          }
        });
      } catch (error) {
        const message = error && !error.stderr && clean(error.message) ? error.message : 'Installation could not be verified. Check SSH connectivity, destination permissions, and the destination app before trying again.';
        update('failed', message, { ...(this.operation?.cleanupPending ? { cleanupPending: true, stagingDirectory: this.operation.stagingDirectory } : {}) });
      } finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => { if (this.operation) { this.operation.localCleanupPending = true; this.emit(); } }); }
      return this.getState();
    });
  }
}
module.exports = { MacInstaller, BUNDLE_ID };
