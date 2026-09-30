'use strict';

const { spawn } = require('node:child_process');
const { Duplex } = require('node:stream');
const { PORT, validateOwnerBootstrap } = require('./clipboard-sync-protocol.cjs');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TERMINATION_GRACE_MS = 750;
const consumeEarlyError = () => {};

function safeTarget(target, port = PORT) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || port !== PORT) throw new Error('Choose a saved machine.');
  if (target.identityFile !== undefined && typeof target.identityFile !== 'string') throw new Error('Choose a saved machine.');
  const identityFile = typeof target.identityFile === 'string' ? target.identityFile : '';
  if (identityFile && (identityFile.length > 4096 || /[\x00-\x1f\x7f]/.test(identityFile) || identityFile.startsWith('-'))) throw new Error('Choose a saved machine.');
  if (target.alias) {
    if (typeof target.alias !== 'string' || target.alias.length > 255 || !NAME.test(target.alias)) throw new Error('Choose a saved machine.');
    return { alias: target.alias, identityFile };
  }
  const portNumber = target.port === undefined ? 22 : Number(target.port);
  if (typeof target.user !== 'string' || typeof target.host !== 'string' || target.user.length > 255 || target.host.length > 255 || !NAME.test(target.user || '') || !NAME.test(target.host || '') || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('Choose a saved machine.');
  return { user: target.user, host: target.host, port: portNumber, identityFile };
}

function buildSshArgs(target, port = PORT) {
  const safe = safeTarget(target, port);
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=8',
    '-o', 'ConnectionAttempts=1',
    '-W', `127.0.0.1:${PORT}`,
  ];
  if (safe.identityFile) args.push('-i', safe.identityFile, '-o', 'IdentitiesOnly=yes');
  if (safe.alias) args.push(safe.alias);
  else args.push('-p', String(safe.port), '-l', safe.user, safe.host);
  return args;
}

function makeFailedStream(error) {
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(error); },
    final(callback) { callback(error); },
  });
  // `ClipboardSync.open()` awaits this stream before it subscribes to errors.
  // Keep early failures from becoming uncaught while later listeners still see them.
  stream.on('error', consumeEarlyError);
  process.nextTick(() => stream.destroy(error));
  return stream;
}

class SshDuplex extends Duplex {
  constructor(child) {
    super({ allowHalfOpen: false });
    // Spawn may fail on the next tick before the owner finishes its async open().
    this.on('error', consumeEarlyError);
    this.child = child;
    this.processExited = false;
    this.stdoutEnded = false;
    this.exitError = null;
    this.terminationTimer = null;
    this.stopRequested = false;

    this.handleStdoutData = chunk => {
      if (this.destroyed) return;
      if (!this.push(chunk)) this.child.stdout.pause();
    };
    this.handleStdoutEnd = () => {
      this.stdoutEnded = true;
      if (this.exitError) this.destroy(this.exitError);
      else if (!this.destroyed) this.push(null);
    };
    this.handleStreamError = error => this.destroy(error);
    this.drainStderr = () => {};
    this.handleExit = (code, signal) => {
      this.processExited = true;
      this.clearTerminationTimer();
      if (code !== 0) {
        this.exitError = new Error(code === null ? `SSH exited after ${signal || 'a signal'}.` : `SSH exited with code ${code}.`);
        if (!this.destroyed) this.destroy(this.exitError);
      }
    };
    this.handleClose = (code, signal) => {
      if (!this.processExited) this.handleExit(code, signal);
      this.clearTerminationTimer();
      if (!this.stdoutEnded && !this.destroyed) {
        this.stdoutEnded = true;
        if (this.exitError) this.destroy(this.exitError);
        else this.push(null);
      }
      this.cleanupListeners();
    };

    child.stdout.on('data', this.handleStdoutData);
    child.stdout.once('end', this.handleStdoutEnd);
    child.stdout.on('error', this.handleStreamError);
    child.stdin.on('error', this.handleStreamError);
    child.stderr.on('data', this.drainStderr);
    child.stderr.on('error', this.handleStreamError);
    child.on('error', this.handleStreamError);
    child.once('exit', this.handleExit);
    child.once('close', this.handleClose);
  }

  _read() {
    this.child.stdout.resume();
  }

  _write(chunk, encoding, callback) {
    const stdin = this.child.stdin;
    if (this.processExited || !stdin || stdin.destroyed || !stdin.writable) {
      callback(new Error('SSH connection is closed.'));
      return;
    }
    try {
      stdin.write(chunk, encoding, error => callback(error || undefined));
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) {
    const stdin = this.child.stdin;
    if (this.processExited || !stdin || stdin.destroyed || !stdin.writable) {
      callback();
      return;
    }
    try {
      stdin.end(callback);
    } catch (error) {
      callback(error);
    }
  }

  _destroy(error, callback) {
    if (!this.processExited) this.stopChild();
    callback(error);
  }

  stopChild() {
    if (this.stopRequested || this.processExited) return;
    this.stopRequested = true;
    try { this.child.kill('SIGTERM'); } catch { /* The process may have exited between the check and signal. */ }
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = null;
      if (!this.processExited) {
        try { this.child.kill('SIGKILL'); } catch { /* A final signal is best effort during shutdown. */ }
      }
    }, TERMINATION_GRACE_MS);
    this.terminationTimer.unref?.();
  }

  clearTerminationTimer() {
    if (this.terminationTimer) clearTimeout(this.terminationTimer);
    this.terminationTimer = null;
  }

  cleanupListeners() {
    this.child.stdout.removeListener('data', this.handleStdoutData);
    this.child.stdout.removeListener('end', this.handleStdoutEnd);
    this.child.stdout.removeListener('error', this.handleStreamError);
    this.child.stdin.removeListener('error', this.handleStreamError);
    this.child.stderr.removeListener('data', this.drainStderr);
    this.child.stderr.removeListener('error', this.handleStreamError);
    this.child.removeListener('error', this.handleStreamError);
    this.child.removeListener('exit', this.handleExit);
  }
}

function connectSsh(target, spawnProcess = spawn) {
  const args = buildSshArgs(target);
  let child;
  try {
    child = spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    return makeFailedStream(error);
  }
  if (!child?.stdin?.on || !child.stdout?.on || !child.stderr?.on || !child.on || !child.kill) {
    return makeFailedStream(new Error('SSH could not start a connection.'));
  }
  return new SshDuplex(child);
}

// These paths are fixed application profiles, resolved by the authenticated OS
// user's shell. Neither arbitrary remote paths nor capabilities enter argv.
const POSIX_BOOTSTRAP = `for p in "$HOME/Library/Application Support/lex-drift/clipboard-sync/owner/bootstrap.json" "${'$'}{XDG_CONFIG_HOME:-$HOME/.config}/lex-drift/clipboard-sync/owner/bootstrap.json"; do if [ -f "$p" ] && [ ! -L "$p" ]; then head -c 2049 "$p"; exit; fi; done; exit 4`;
const WINDOWS_BOOTSTRAP = `$ErrorActionPreference='Stop'; $p=Join-Path $env:APPDATA 'lex-drift\\clipboard-sync\\owner\\bootstrap.json'; $f=Get-Item -LiteralPath $p; if (($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $f.Length -gt 2048) { exit 4 }; [Console]::Out.Write([IO.File]::ReadAllText($p));`;
const OWNER_UNAVAILABLE = 'ShelfDock on that computer must be updated, running, and have Clipboard tools and sync enabled and resumed in its standard profile.';
function buildBootstrapArgs(target, windows = false) {
  const args = buildSshArgs(target);
  const forward = args.indexOf('-W'); args.splice(forward, 2);
  args.unshift('-T');
  args.push(windows ? 'powershell.exe' : 'sh', windows ? '-NoLogo' : '-c');
  if (windows) args.push('-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_BOOTSTRAP, 'utf16le').toString('base64'));
  else args.push("'" + POSIX_BOOTSTRAP.replace(/'/g, "'\\''") + "'");
  return args;
}
function readBootstrapAttempt(target, windows, { spawnProcess = spawn, signal, now = Date.now } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Clipboard linking was cancelled.')); return; }
    let child, timer, killTimer, completed = false, exited = false, size = 0; const output = [];
    const stop = () => { if (!child || exited) return; try { child.kill('SIGTERM'); } catch {} killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, TERMINATION_GRACE_MS); killTimer.unref?.(); };
    const finish = (error, value) => { if (completed) return; completed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { stop(); reject(new Error(error)); } else resolve(value); };
    const abort = () => finish('Clipboard linking was cancelled.');
    try { child = spawnProcess('ssh', buildBootstrapArgs(target, windows), { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish(OWNER_UNAVAILABLE); return; }
    timer = setTimeout(() => finish(OWNER_UNAVAILABLE), 8000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', () => {}); child.stderr.on('error', () => finish(OWNER_UNAVAILABLE));
    child.stdout.on('error', () => finish(OWNER_UNAVAILABLE));
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2048) finish(OWNER_UNAVAILABLE); else output.push(chunk); });
    child.on('error', () => finish(OWNER_UNAVAILABLE));
    child.once('close', code => { exited = true; clearTimeout(killTimer); if (completed) return; if (code !== 0) { finish(OWNER_UNAVAILABLE); return; } try { finish(null, validateOwnerBootstrap(JSON.parse(Buffer.concat(output).toString('utf8')), now())); } catch { finish(OWNER_UNAVAILABLE); } });
  });
}
async function readOwnerBootstrap(target, options = {}) {
  safeTarget(target);
  try { return await readBootstrapAttempt(target, false, options); }
  catch { if (options.signal?.aborted) throw new Error('Clipboard linking was cancelled.'); return readBootstrapAttempt(target, true, options); }
}
module.exports = { buildSshArgs, connectSsh, safeTarget, readOwnerBootstrap, buildBootstrapArgs, OWNER_UNAVAILABLE };
