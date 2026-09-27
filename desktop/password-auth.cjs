'use strict';

const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const TRUST_MESSAGE = 'Verify this machine’s SSH fingerprint in your terminal, then try again. Password access requires an already trusted SSH host key.';
const STORAGE_MESSAGE = 'Secure password storage is unavailable. Unlock your operating system keychain, or choose one-time password setup instead.';
const endpointKey = host => crypto.createHash('sha256').update(JSON.stringify([host.address.toLowerCase(), host.user, host.port, host.sshAlias || ''])).digest('hex');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const fault = (message, code) => Object.assign(new Error(message), { code });
const expandHome = (value, home) => value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;

function validatePassword(password) {
  if (typeof password !== 'string' || !password.length || Buffer.byteLength(password, 'utf8') > 4096 || password.includes('\0')) throw new Error('Enter a password containing 1–4096 bytes, without a null character.');
  return password;
}

function configWords(value) {
  // OpenSSH -G quotes paths containing whitespace. Reject ambiguous expansions.
  const words = value.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  return words.map(word => /^(["']).*\1$/.test(word) ? word.slice(1, -1) : word);
}

function knownHostKeys(stdout) {
  const accepted = new Set(); const revoked = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0] || parts[0].startsWith('#')) continue;
    const marker = parts[0].startsWith('@') ? parts.shift() : '';
    const [, algorithm, key] = parts;
    if (!algorithm || !/^(ssh-|ecdsa-)/.test(algorithm) || !key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) continue;
    if (marker === '@revoked') revoked.add(key);
    else if (!marker) accepted.add(key);
    // Host certificates need CA validation, and are intentionally not accepted as raw keys.
  }
  return { accepted, revoked };
}

class PasswordAuth {
  constructor({ dataDir, homeDir, platform = process.platform, safeStorage, run, Client } = {}) {
    this.dataDir = dataDir; this.homeDir = homeDir; this.platform = platform; this.safeStorage = safeStorage; this.run = run; this.Client = Client;
    this.file = path.join(dataDir, 'password-vault.json'); this.entries = {}; this.writeChain = Promise.resolve();
    this.initialized = this.load();
  }
  async load() {
    try {
      const stat = await fs.stat(this.file); if (stat.size > 1024 * 1024) throw new Error('Invalid password vault.');
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new Error('Invalid password vault.');
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (/^[a-f0-9]{64}$/.test(key) && entry && typeof entry.encrypted === 'string' && entry.encrypted.length < 16384) this.entries[key] = { encrypted: entry.encrypted, paused: entry.paused === true };
      }
    } catch (error) { if (error.code !== 'ENOENT') this.loadError = 'Saved passwords could not be loaded. Remove and re-enter the password for this machine.'; }
  }
  storageAvailable() {
    try { return Boolean(this.safeStorage?.isEncryptionAvailable() && (this.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.safeStorage.getSelectedStorageBackend?.()))); } catch { return false; }
  }
  metadata(host) {
    const entry = this.entries[endpointKey(host)];
    return { authMode: entry ? 'password' : 'key', hasSavedPassword: Boolean(entry), passwordPaused: entry?.paused === true };
  }
  async mutate(operation) {
    await this.initialized;
    const next = this.writeChain.catch(() => {}).then(async () => {
      const entries = { ...this.entries }; operation(entries);
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
      try { await fs.writeFile(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, this.file); this.entries = entries; }
      finally { await fs.unlink(temporary).catch(() => {}); }
    });
    this.writeChain = next; return next;
  }
  async save(host, password) {
    validatePassword(password); if (!this.storageAvailable()) throw new Error(STORAGE_MESSAGE);
    let encrypted;
    try { encrypted = this.safeStorage.encryptString(password).toString('base64'); } catch { throw new Error(STORAGE_MESSAGE); }
    await this.mutate(entries => { entries[endpointKey(host)] = { encrypted, paused: false }; });
  }
  async forget(host) { await this.mutate(entries => { delete entries[endpointKey(host)]; }); }
  async password(host) {
    await this.initialized;
    const entry = this.entries[endpointKey(host)];
    if (!entry) throw new Error(this.loadError || 'No password is saved for this machine.');
    if (entry.paused) throw fault('Saved password attempts are paused after an authentication failure. Open machine access and enter the correct password to retry.', 'AUTH_PAUSED');
    if (!this.storageAvailable()) throw new Error(STORAGE_MESSAGE);
    try { return validatePassword(this.safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64'))); } catch { throw new Error(STORAGE_MESSAGE); }
  }
  async trustedKeys(host) {
    let resolved;
    try {
      const args = ['-G', '-o', 'StrictHostKeyChecking=yes', '-p', String(host.port), '-l', host.user];
      if (host.sshAlias) args.push('-o', 'HostName=' + host.address);
      args.push(host.sshAlias || host.address);
      const result = await this.run('ssh', args);
      resolved = Object.fromEntries(result.stdout.split(/\r?\n/).map(line => { const i = line.indexOf(' '); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
    } catch { throw new Error('OpenSSH could not resolve this machine’s trusted connection settings. Check its SSH configuration first.'); }
    if (resolved.hostname && resolved.hostname.toLowerCase() !== host.address.toLowerCase()) throw new Error('This hostname resolves to a different SSH configuration destination. Add its actual LAN/Tailscale address for password access.');
    if (resolved.revokedhostkeys && resolved.revokedhostkeys !== 'none') throw new Error('This SSH configuration uses a separate revoked-key file. Use the existing OpenSSH key route so its revocation policy remains enforced.');
    if ([resolved.proxycommand, resolved.proxyjump].some(value => value && value !== 'none') || (resolved.knownhostscommand && resolved.knownhostscommand !== 'none')) throw new Error('Password access supports direct SSH connections. This SSH alias uses a proxy or dynamic host-key command; use its existing SSH key, or add a direct LAN/Tailscale route.');
    const alias = resolved.hostkeyalias && resolved.hostkeyalias !== 'none' ? resolved.hostkeyalias : '';
    const lookup = alias || (host.port === 22 ? host.address : '[' + host.address + ']:' + host.port);
    if (/[\r\n\0]/.test(lookup) || lookup.startsWith('-')) throw new Error(TRUST_MESSAGE);
    const fileList = [resolved.userknownhostsfile || '~/.ssh/known_hosts ~/.ssh/known_hosts2', resolved.globalknownhostsfile || ''].flatMap(configWords).filter(value => value !== 'none');
    const accepted = new Set(); const revoked = new Set();
    for (let file of fileList) {
      file = expandHome(file, this.homeDir);
      if (!path.isAbsolute(file) || /[%$\0\r\n]/.test(file)) throw new Error('The SSH known-hosts path uses an unsupported expansion. Use an absolute known-hosts path for password access.');
      let stdout;
      try { ({ stdout } = await this.run('ssh-keygen', ['-F', lookup, '-f', file])); }
      catch (error) { if (error.code === 1 || error.code === 'ENOENT' || /No such file|cannot stat|does not exist|not found/i.test(String(error.stderr || ''))) continue; throw new Error(TRUST_MESSAGE); }
      const found = knownHostKeys(stdout);
      for (const key of found.accepted) accepted.add(key);
      for (const key of found.revoked) revoked.add(key);
    }
    for (const key of revoked) accepted.delete(key);
    if (!accepted.size) throw new Error(TRUST_MESSAGE);
    const allowedByConfig = resolved.hostkeyalgorithms?.split(',');
    const serverHostKey = [...accepted].flatMap(value => {
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length < 4 || bytes.readUInt32BE(0) > bytes.length - 4) return [];
      const type = bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString('utf8');
      return type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256'] : ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'].includes(type) ? [type] : [];
    }).filter(value => !allowedByConfig || allowedByConfig.includes(value));
    if (!serverHostKey.length) throw new Error('The trusted host key uses an unsupported or disabled algorithm. Verify a current Ed25519, ECDSA, or RSA SHA-2 host key in your terminal.');
    return { accepted, revoked, serverHostKey: [...new Set(serverHostKey)] };
  }
  async connect(host, password, privateKey) {
    const keys = await this.trustedKeys(host);
    const Client = this.Client || require('ssh2').Client;
    const client = new Client(); let keyRejected = false;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => fail(fault('SSH connection timed out. Check that the SSH server and network are available.', 'ETIMEDOUT')), 12000);
      const fail = error => { if (settled) return; settled = true; clearTimeout(timeout); client.destroy(); reject(error); };
      client.on('error', error => fail(keyRejected ? fault(TRUST_MESSAGE, 'HOST_KEY') : error.level === 'client-authentication' ? fault('The SSH password was rejected. Check the username and password; password authentication must be enabled on the target.', 'AUTH_FAILED') : fault('SSH password connection failed. Check the SSH server, network, and authentication settings.', 'SSH_CONNECTION')));
      client.once('close', () => fail(fault('The SSH connection closed before authentication completed.', 'SSH_CONNECTION')));
      client.once('ready', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(); } });
      try {
        client.connect({ host: host.address, port: host.port, username: host.user, ...(privateKey ? { privateKey } : { password }), readyTimeout: 10000, keepaliveInterval: 5000, keepaliveCountMax: 2, algorithms: { serverHostKey: keys.serverHostKey }, tryKeyboard: false, authHandler: [privateKey ? 'publickey' : 'password'], hostVerifier: key => { const encoded = key.toString('base64'); const allowed = keys.accepted.has(encoded) && !keys.revoked.has(encoded); if (!allowed) keyRejected = true; return allowed; } });
      } catch { fail(fault('SSH password connection could not be started.', 'SSH_CONNECTION')); }
    });
    return new PasswordSession(client);
  }
  async withPassword(host, operation, suppliedPassword) {
    let password = suppliedPassword === undefined ? await this.password(host) : validatePassword(suppliedPassword);
    let session;
    try { session = await this.connect(host, password); password = undefined; return await operation(session); }
    catch (error) {
      if (suppliedPassword === undefined && error.code === 'AUTH_FAILED') await this.mutate(entries => { const key = endpointKey(host); if (entries[key]) entries[key] = { ...entries[key], paused: true }; });
      throw error;
    } finally { password = undefined; session?.close(); }
  }
  pendingFile(host) { return path.join(this.dataDir, 'ssh-keys', 'pending-' + endpointKey(host) + '.json'); }
  async completeBootstrap(host) { await fs.unlink(this.pendingFile(host)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  async bootstrap(host, password, verifyKey) {
    let keyDirectory; let installed = false;
    try {
      return await this.withPassword(host, async session => {
        const root = path.join(this.dataDir, 'ssh-keys'); await fs.mkdir(root, { recursive: true, mode: 0o700 });
        let resume = false;
        try {
          const pending = JSON.parse(await fs.readFile(this.pendingFile(host), 'utf8'));
          if (!/^device-[A-Za-z0-9]+$/.test(pending.directory)) throw new Error('Invalid pending key.');
          keyDirectory = path.join(root, pending.directory);
          const stat = await fs.lstat(keyDirectory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid pending key directory.');
          for (const name of ['id_ed25519', 'id_ed25519.pub']) {
            const key = await fs.lstat(path.join(keyDirectory, name));
            if (!key.isFile() || key.isSymbolicLink()) throw new Error('Invalid pending key file.');
          }
          resume = true; installed = true;
        } catch (error) { if (error.code !== 'ENOENT') throw new Error('The pending SSH key could not be recovered. Check the app’s private key folder before retrying.'); }
        if (!resume) keyDirectory = await fs.mkdtemp(path.join(root, 'device-'));
        const identityFile = path.join(keyDirectory, 'id_ed25519');
        if (this.platform === 'win32') {
          try {
            const identity = await this.run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
            const sid = identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
            if (!sid) throw new Error('Missing local user identity.');
            await this.run('icacls.exe', [keyDirectory, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F']);
          } catch { throw new Error('Private SSH key folder permissions could not be secured on this Windows device.'); }
        }
        try { if (!resume) await this.run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'dropharbor-' + crypto.randomUUID(), '-f', identityFile], { timeout: 15000 }); await fs.chmod(identityFile, 0o600); }
        catch { throw new Error('A dedicated SSH key could not be created on this device. Check OpenSSH and local folder permissions.'); }
        const publicKey = (await fs.readFile(identityFile + '.pub', 'utf8')).trim();
        if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} dropharbor-[a-f0-9-]+$/.test(publicKey)) throw new Error('OpenSSH returned an invalid generated public key.');
        await fs.writeFile(this.pendingFile(host), JSON.stringify({ directory: path.basename(keyDirectory) }), { mode: 0o600 });
        // A dropped connection can hide a successful append: retain the local private key once installation starts.
        installed = true;
        const installation = await session.exec(bootstrapCommand(host.os, publicKey));
        if (!installation.stdout.includes('DRIFT_KEY_INSTALLED')) throw new Error('The target did not confirm key installation. The local key was retained for recovery.');
        let verification;
        try {
          verification = await this.connect(host, undefined, await fs.readFile(identityFile));
          const result = await verification.exec('echo DRIFT_READY', 9000);
          if (!result.stdout.includes('DRIFT_READY')) throw new Error('Key authentication did not complete.');
          await verifyKey(identityFile);
        } catch { throw new Error('The public key was installed, but key-only sign-in did not succeed. The generated key was kept for recovery. Check the target’s OpenSSH public-key settings before retrying.'); } finally { verification?.close(); }
        return identityFile;
      }, password);
    } catch (error) {
      // Once a remote key may have been installed, preserve its private half for recovery.
      if (keyDirectory && !installed) await fs.rm(keyDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

class PasswordSession {
  constructor(client) { this.client = client; }
  close() { this.client.end(); }
  exec(command, timeout = 15000) {
    return new Promise((resolve, reject) => {
      let stream; let output = ''; let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); this.client.removeListener('close', closed); if (error) { stream?.destroy(); reject(error); } else resolve(value); };
      const closed = () => finish(new Error('The SSH connection closed before the remote command completed.'));
      const timer = setTimeout(() => finish(new Error('The remote SSH command timed out.')), timeout);
      this.client.once('close', closed);
      this.client.exec(command, (error, channel) => {
        if (settled) { channel?.destroy(); return; }
        if (error) return finish(new Error('The target did not accept the SSH command.'));
        stream = channel;
        channel.on('error', () => finish(new Error('The remote SSH command failed.')));
        channel.on('data', bytes => { output += bytes.toString('utf8'); if (Buffer.byteLength(output) > 1024 * 1024) finish(new Error('The remote SSH command returned too much output.')); });
        channel.stderr.on('data', () => {}); // Never surface an untrusted server's reflection of a password.
        channel.on('close', code => code === 0 ? finish(null, { stdout: output, stderr: '' }) : finish(new Error('The remote SSH command failed. Check the target’s folder permissions and OpenSSH setup.')));
      });
    });
  }
  async upload(local, remote) {
    const deadline = AbortSignal.timeout(60 * 60 * 1000);
    const request = operation => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) { value?.end?.(); return; }
        settled = true; clearTimeout(timer); deadline.removeEventListener('abort', aborted); this.client.removeListener('close', closed);
        error ? reject(error) : resolve(value);
      };
      const aborted = () => finish(new Error('The SFTP transfer timed out.'));
      const closed = () => finish(new Error('The SFTP connection closed.'));
      const timer = setTimeout(() => finish(new Error('The SFTP server did not respond.')), 15000);
      deadline.addEventListener('abort', aborted, { once: true }); this.client.once('close', closed);
      if (deadline.aborted) return aborted();
      try { operation(finish); } catch { finish(new Error('The SFTP operation could not be started.')); }
    });
    const sftp = await request(callback => this.client.sftp(callback)).catch(() => { throw new Error('The target’s SFTP subsystem is unavailable or did not respond. Enable SFTP in OpenSSH.'); });
    try {
      const copy = async (source, target) => {
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('A source changed during transfer. Only ordinary files and folders can be sent.');
        if (stat.isDirectory()) {
          await request(callback => sftp.mkdir(target, { mode: 0o700 }, callback));
          for (const name of await fs.readdir(source)) await copy(path.join(source, name), target.replace(/\/$/, '') + '/' + name);
        } else {
          await pipeline(createReadStream(source, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) }), sftp.createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: deadline });
        }
      };
      await copy(local, remote);
    } catch { throw new Error('SFTP could not finish the transfer. Check the connection, target permissions, available space, and whether source files changed.'); }
    finally { sftp.end(); }
  }
}

function bootstrapCommand(remoteOS, publicKey) {
  if (remoteOS !== 'windows') return `umask 077; test ! -L "$HOME/.ssh" && mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && test ! -L "$HOME/.ssh/authorized_keys" && touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys" && { grep -qxF ${quote(publicKey)} "$HOME/.ssh/authorized_keys" || printf '\\n%s\\n' ${quote(publicKey)} >> "$HOME/.ssh/authorized_keys"; } && printf 'DRIFT_KEY_INSTALLED\\n'`;
  // Use the Windows OpenSSH administrator-specific file only for elevated administrators.
  // A non-elevated admin cannot change that file safely; return an actionable failure instead.
  const key = publicKey.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object Security.Principal.WindowsPrincipal($identity); $adminMember=@($identity.Groups | ForEach-Object {$_.Value}) -contains 'S-1-5-32-544'; $admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); if($adminMember -and !$admin){throw 'This administrator login has a filtered token. Use an elevated OpenSSH session or ask an administrator to install the public key in administrators_authorized_keys.'}; if($adminMember){$folder=Join-Path $env:ProgramData 'ssh'; $file=Join-Path $folder 'administrators_authorized_keys'}else{$folder=Join-Path $env:USERPROFILE '.ssh'; $file=Join-Path $folder 'authorized_keys'}; foreach($candidate in @($folder,$file)){if((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Refusing a redirected SSH key path'}}; [IO.Directory]::CreateDirectory($folder)|Out-Null; $key='${key}'; if(!(Test-Path -LiteralPath $file)){[IO.File]::WriteAllText($file,'',([Text.UTF8Encoding]::new($false)))}; $existing=[IO.File]::ReadAllLines($file); if($existing -notcontains $key){[IO.File]::AppendAllText($file,[Environment]::NewLine+$key+[Environment]::NewLine,([Text.UTF8Encoding]::new($false)))}; if($admin){& icacls.exe $file /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F'|Out-Null}else{& icacls.exe $file /inheritance:r /grant:r ('*'+$identity.User.Value+':F') '*S-1-5-18:F'|Out-Null}; if($LASTEXITCODE -ne 0){throw 'SSH key permissions could not be set'}; [Console]::WriteLine('DRIFT_KEY_INSTALLED')`;
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
}

module.exports = { PasswordAuth, PasswordSession, endpointKey, knownHostKeys, bootstrapCommand, validatePassword };
