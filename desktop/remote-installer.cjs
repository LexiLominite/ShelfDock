'use strict';
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { readRelease, validateLinuxPackage, validateWindowsPortable } = require('./remote-install-download.cjs');
const { endpointKey } = require('./password-auth.cjs');

const PLAN_MS = 5 * 60 * 1000;
const clone = value => JSON.parse(JSON.stringify(value));
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

const secure = ['ClearAllForwardings=yes', 'PermitLocalCommand=no', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ForwardX11Trusted=no', 'ForkAfterAuthentication=no', 'ControlMaster=no', 'ControlPath=none', 'RemoteCommand=none', 'RequestTTY=no'].flatMap(value => ['-o', value]);

class RemoteInstaller {
  constructor({ service, productName, version, edition, macInstaller = null, onChange = () => {}, clock = Date.now } = {}) {
    Object.assign(this, { service, productName, version, edition: edition === 'personal' ? 'personal' : 'public', macInstaller, onChange, clock });
    this.plans = new Map();
    this.operation = null;
    this.task = null;
    this.closed = false;
  }
  
  capabilities() {
    let reason = '';
    if (this.closed) reason = 'The app is shutting down.';
    return { available: !reason, reason, productName: this.productName || 'ShelfDock', version: this.version };
  }
  
  getState() { const operation = this.delegatingMac ? (this.macInstaller?.getState?.().operation || this.operation) : this.operation; return { ...this.capabilities(), operation: operation ? { ...clone(operation), canCancel: !this.delegatingMac && !['installing', 'cancelling'].includes(operation.status) } : null }; }
  emit() { try { this.onChange(this.getState()); } catch {} }
  
  assertIdle() {
    if (!this.capabilities().available) throw new Error(this.capabilities().reason);
    if (this.task || this.service.remoteInstallation || this.service.macInstallation || this.service.transferring || this.service.appUpdating || this.service.remoteDesktopSetup || this.service.authenticationSetup || this.service.configurationImport || this.service.configurationSaving || this.service.tunnelSetup) throw new Error('Wait for the current task to finish.');
  }

  exclusive(work) {
    this.assertIdle();
    this.service.remoteInstallation = true;
    const task = Promise.resolve().then(work).finally(() => { this.service.remoteInstallation = false; if (this.task === task) this.task = null; });
    this.task = task; return task;
  }

  async whenIdle() { await this.task?.catch(() => {}); return this.getState(); }
  async shutdown() { this.closed = true; this.plans.clear(); this.controller?.abort(); this.previewController?.abort(); return this.whenIdle(); }
  cancel() { if (this.previewController) { this.previewController.abort(); this.plans.clear(); return this.getState(); } if (this.delegatingMac || this.operation?.status === 'installing') return { ...this.getState(), cancelReason: 'The destination is completing its atomic installation. Wait for its result.' }; if (this.controller) { if (this.operation) { this.operation.status = 'cancelling'; this.operation.message = 'Cancelling the transfer and removing its staging folder.'; this.emit(); } this.controller.abort(); } return this.getState(); }
  checkpoint() { this.controller?.signal.throwIfAborted(); }

  async host(hostId, endpoint) {
    const host = (await this.service.getState()).hosts.find(entry => entry.id === hostId);
    if (!host || !host.user) throw new Error('Choose a saved machine with an SSH login username.');
    if (endpoint && endpointKey(host) !== endpoint) throw new Error('This machine’s connection details changed. Preview it again before installing.');
    return clone(host);
  }

  async withSession(host, work) { return this.service.passwordAuth.metadata(host).hasSavedPassword ? this.service.passwordAuth.withPassword(host, work) : work(null); }

  async remote(host, command, session = null, timeout = 15000) {
    return session ? session.exec(command, timeout) : this.service.run('ssh', [...secure, ...this.service.sshArgs(host), command], { timeout, ...(this.previewController ? { signal: this.previewController.signal } : {}) });
  }

  async identifyTarget(host) {
    return this.withSession(host, async session => {
      let result;
      if (host.os === 'windows') {
        const script = "$ErrorActionPreference='Stop'; if([Environment]::OSVersion.Platform -ne 'Win32NT'){throw 'Destination is not Windows'}; $a=$env:PROCESSOR_ARCHITEW6432; if(!$a){$a=$env:PROCESSOR_ARCHITECTURE}; [Console]::WriteLine('DH_TARGET=windows;arch='+$a)";
        result = await this.remote(host, 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64'), session);
      } else {
        result = await this.remote(host, "printf 'DH_TARGET=%s;arch=%s\\n' \"$(uname -s)\" \"$(uname -m)\"", session);
      }
      const line = String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith('DH_TARGET='));
      const match = line && line.match(/^DH_TARGET=(linux|windows|darwin);arch=(x86_64|amd64|aarch64|arm64|AMD64|ARM64|x64)$/i);
      if (!match) throw new Error('Could not confirm the remote operating system and processor. Check its SSH shell and try again.');
      const osName = match[1].toLowerCase();
      if (osName === 'darwin') {
        if (host.os !== 'posix') throw new Error('The saved machine type does not match the SSH destination. Update the machine and check again.');
        return { os: 'macos', architecture: /^(aarch64|arm64)$/i.test(match[2]) ? 'arm64' : 'x64' };
      }
      if ((host.os === 'windows') !== (osName === 'windows')) throw new Error('The saved machine type does not match the SSH destination. Update the machine and check again.');
      const architecture = /^(aarch64|arm64)$/i.test(match[2]) ? 'arm64' : 'x64';
      return { os: osName, architecture };
    });
  }
  
  async upload(host, session, localPath, remotePath) {
    if (session) {
      // Close only this SFTP channel on abort so the SSH session remains usable
      // for removing the owned staging folder in the caller's finally block.
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(10 * 60 * 1000)]);
      signal.throwIfAborted();
      const sftp = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, channel) => {
          if (settled) { channel?.end?.(); return; }
          settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (error) { channel?.end?.(); reject(error); } else resolve(channel);
        };
        const abort = () => finish(new Error('The remote upload was cancelled or timed out.'));
        const timer = setTimeout(() => finish(new Error('The SFTP server did not respond.')), 15000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        try { session.client.sftp(finish); } catch { finish(new Error('The target SFTP channel could not open.')); }
      });
      try {
        const stat = await fs.lstat(localPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The prepared package changed before upload.');
        await pipeline(createReadStream(localPath, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) }), sftp.createWriteStream(remotePath, { flags: 'wx', mode: 0o600 }), { signal });
      } finally { sftp.end(); }
    } else {
      const args = this.service.sshArgs(host).slice(); const target = args.pop(); const converted = [];
      for (let i = 0; i < args.length; i++) { if (args[i] === '-p') converted.push('-P', args[++i]); else if (args[i] === '-l') converted.push('-o', 'User=' + args[++i]); else converted.push(args[i]); }
      const targetHost = target.includes(':') ? '[' + target + ']' : target;
      await this.service.run('scp', ['-O', ...secure, ...converted, localPath, targetHost + ':' + quote(remotePath)], { timeout: 10 * 60 * 1000, signal: this.controller.signal });
    }
  }

  async preview({ hostId } = {}) {
    return this.exclusive(async () => {
      const previewController = new AbortController(); this.previewController = previewController;
      try {
        const host = await this.host(hostId);
        if (!['posix', 'windows'].includes(host.os)) throw new Error('Choose a saved machine with a supported SSH operating system.');
        const target = await this.identifyTarget(host);
        previewController.signal.throwIfAborted();
        if (target.os === 'macos') {
          if (!this.macInstaller) throw new Error('Install on another Mac is unavailable in this app build.');
          const mac = await this.macInstaller.preview({ hostId });
          previewController.signal.throwIfAborted();
          const view = { ...mac, os: 'macos', architecture: mac.architecture === 'Apple Silicon' ? 'arm64' : mac.architecture === 'Intel' ? 'x64' : mac.architecture };
          this.plans.clear(); this.plans.set(view.id, { ...view, delegated: 'mac', delegatePlanId: mac.id, endpoint: endpointKey(host) });
          return clone(view);
        }
        const id = crypto.randomUUID();
        const expiresAt = this.clock() + PLAN_MS;
        if (target.os === 'windows' && target.architecture !== 'x64') throw new Error('Windows remote installation requires an x64 destination.');
        const view = { includesPersonalPreset: this.edition === 'personal', destination: target.os === 'linux' ? '~/Applications/' + (this.edition === 'personal' ? 'LexBridge-personal' : 'ShelfDock') + '-' + this.version + '-linux-' + target.architecture : '%LOCALAPPDATA%\\Programs\\' + this.productName, id, hostId: host.id, hostName: host.name, address: host.address, user: host.user, os: target.os, architecture: target.architecture, version: this.version, productName: this.productName, expiresAt, canInstall: true, reason: '' };
        this.plans.clear();
        this.plans.set(id, { ...view, endpoint: endpointKey(host), hostOS: host.os, identityFile: host.identityFile || '' });
        return clone(view);
      } finally { if (this.previewController === previewController) this.previewController = null; }
    });
  }

  async install({ planId, consentPersonalPreset = false } = {}) {
    const plan = this.plans.get(planId);
    if (!plan || plan.expiresAt <= this.clock()) { this.plans.delete(planId); throw new Error('This installation preview expired or was already used.'); }

    if (plan.includesPersonalPreset && consentPersonalPreset !== true) throw new Error('Confirm sharing the bundled personal machine preset before installing.');
    if (plan.delegated === 'mac') {
      return this.exclusive(async () => {
        this.plans.delete(planId); this.delegatingMac = true;
        try { const state = await this.macInstaller.install({ planId: plan.delegatePlanId, confirmPreset: consentPersonalPreset }); this.operation = state.operation; this.emit(); return this.getState(); }
        finally { this.delegatingMac = false; }
      });
    }
    
    return this.exclusive(async () => {
      this.plans.delete(planId);
      const update = (status, message, extra = {}) => { this.operation = { planId, hostId: plan.hostId, hostName: plan.hostName, version: plan.version, destination: plan.destination, ...(this.operation?.planId === planId && this.operation.cleanupPending ? { cleanupPending: true, stagingDirectory: this.operation.stagingDirectory } : {}), status, message, ...extra }; this.emit(); };
      
      let tempDir;
      this.controller = new AbortController();
      try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-remote-install-'));
        
        update('preparing', 'Downloading the release package.');
        const host = await this.host(plan.hostId, plan.endpoint);
        const actual = await this.identifyTarget(host);
        if ((host.identityFile || '') !== plan.identityFile || actual.os !== plan.os || actual.architecture !== plan.architecture || host.os !== plan.hostOS) throw new Error('The destination operating system or processor changed. Check the machine and prepare a new preview.');
        
        const { asset } = await readRelease({ targetOS: plan.os, arch: plan.architecture, edition: this.edition, version: this.version, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(120000)]) });
        
        update('verifying', 'Verifying the release package.');
        if (plan.os === 'linux') await validateLinuxPackage(asset.bytes, { version: this.version, arch: plan.architecture, productName: this.productName, personal: this.edition === 'personal' });
        else await validateWindowsPortable(asset.bytes, { arch: plan.architecture, version: this.version, productName: this.productName, personal: this.edition === 'personal' });
        
        const localPayloadPath = path.join(tempDir, asset.name);
        await fs.writeFile(localPayloadPath, asset.bytes);
        
        const scriptName = plan.os === 'linux' ? 'install.sh' : 'install.ps1';
        const scriptPath = path.join(__dirname, '..', 'installers', scriptName);
        const localScriptPath = path.join(tempDir, scriptName);
        await fs.copyFile(scriptPath, localScriptPath);

        this.checkpoint();
        await this.host(plan.hostId, plan.endpoint);
        await this.withSession(host, async session => {
          const token = crypto.randomUUID();
          let stage;
          const ps = script => 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
          const psQuote = value => "'" + String(value).replaceAll("'", "''") + "'";
          try {
            this.checkpoint();
            const created = plan.os === 'linux'
              ? await this.remote(host, `umask 077; stage=$(mktemp -d "$HOME/.shelfdock-install-${token}-XXXXXX") || exit; printf 'DH_STAGE=%s\\n' "$stage"`, session)
              : await this.remote(host, ps(`$ErrorActionPreference='Stop'; $p=Join-Path $env:LOCALAPPDATA '.shelfdock-install-${token}'; if(Test-Path -LiteralPath $p){throw 'Staging path already exists'}; [IO.Directory]::CreateDirectory($p)|Out-Null; [Console]::WriteLine('DH_STAGE='+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)))`), session);
            const line = String(created.stdout || '').split(/\r?\n/).find(value => value.startsWith('DH_STAGE='));
            if (!line) throw new Error('The destination did not confirm its staging folder.');
            const candidate = plan.os === 'linux' ? line.slice(9) : Buffer.from(line.slice(9), 'base64').toString('utf8');
            const base = plan.os === 'linux' ? path.posix.basename(candidate) : path.win32.basename(candidate);
            const expected = '.shelfdock-install-' + token;
            const validBase = plan.os === 'linux' ? base.startsWith(expected + '-') && /^[A-Za-z0-9]{6}$/.test(base.slice(expected.length + 1)) : base === expected;
            if (!validBase || /[\r\n\0]/.test(candidate) || candidate.split(/[\\/]/).some(part => part === '..' || part === '.') || (plan.os === 'linux' ? !candidate.startsWith('/') : !/^[A-Za-z]:[\\]/.test(candidate))) throw new Error('The destination returned an unexpected staging folder.');
            stage = candidate;
            const join = plan.os === 'linux' ? path.posix.join : path.win32.join;
            const payload = plan.os === 'linux' ? 'payload.tar.gz' : 'payload.exe';
            update('uploading', 'Uploading the verified app package.', { destination: plan.destination });
            this.checkpoint();
            await this.upload(host, session, localPayloadPath, join(stage, payload));
            this.checkpoint();
            await this.upload(host, session, localScriptPath, join(stage, scriptName));
            this.checkpoint();
            const freshHost = await this.host(plan.hostId, plan.endpoint);
            const fresh = await this.identifyTarget(freshHost);
            if (fresh.os !== plan.os || fresh.architecture !== plan.architecture || (freshHost.identityFile || '') !== plan.identityFile) throw new Error('The destination changed after upload. Prepare a new preview.');
            this.checkpoint();
            update('installing', 'Installing in your user account. The app will stay closed.');
            const command = plan.os === 'linux'
              ? `sh ${quote(join(stage, scriptName))} ${quote(this.productName)} ${quote(this.edition)} ${quote(payload)} ${quote(asset.sha256)} ${quote(this.version)} ${quote(plan.architecture)}`
              : ps(`& ${psQuote(join(stage, scriptName))} -AppName ${psQuote(this.productName)} -Edition ${psQuote(this.edition)} -Payload ${psQuote(payload)} -Sha256 ${psQuote(asset.sha256)} -Version ${psQuote(this.version)} -Architecture ${psQuote(plan.architecture)}`);
            const out = await this.remote(host, command, session, 10 * 60 * 1000);
            if (!String(out.stdout || '').split(/\r?\n/).includes('DH_INSTALLED=yes')) throw new Error('The destination did not confirm installation. Check its app folder before retrying.');
          } finally {
            if (stage) {
              const command = plan.os === 'linux' ? `rm -rf -- ${quote(stage)}` : ps(`Remove-Item -LiteralPath ${psQuote(stage)} -Recurse -Force -ErrorAction Stop`);
              try { await this.remote(host, command, session); }
              catch { this.operation.cleanupPending = true; this.operation.stagingDirectory = stage; this.emit(); }
            }
          }
        });

        update('installed', 'Installed.');
      } catch (error) {
        update(this.controller.signal.aborted ? 'cancelled' : 'failed', this.controller.signal.aborted ? 'Installation cancelled before the destination commit.' : error.message || 'Installation failed.');
      } finally {
        this.controller = null;
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
      return this.getState();
    });
  }
}
module.exports = { RemoteInstaller };
