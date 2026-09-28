'use strict';

const { spawn } = require('node:child_process');
const { Duplex } = require('node:stream');
const { PORT } = require('./clipboard-sync-protocol.cjs');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TERMINATION_GRACE_MS = 750;
const consumeEarlyError = () => {};

function safeTarget(target, port = PORT) {
  if (!target || typeof target !== 'object' || port !== PORT) throw new Error('Choose a saved machine.');
  if (target.identityFile !== undefined && typeof target.identityFile !== 'string') throw new Error('Choose a saved machine.');
  const identityFile = typeof target.identityFile === 'string' ? target.identityFile : '';
  if (identityFile && (identityFile.length > 4096 || /[\x00-\x1f\x7f]/.test(identityFile) || identityFile.startsWith('-'))) throw new Error('Choose a saved machine.');
  if (target.alias) {
    if (!NAME.test(target.alias)) throw new Error('Choose a saved machine.');
    return { alias: target.alias, identityFile };
  }
  const portNumber = target.port === undefined ? 22 : Number(target.port);
  if (!NAME.test(target.user || '') || !NAME.test(target.host || '') || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('Choose a saved machine.');
  return { user: target.user, host: target.host, port: portNumber, identityFile };
}

function buildSshArgs(target, port = PORT) {
  const safe = safeTarget(target, port);
  const args = [
    '-o', 'BatchMode=yes',
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

module.exports = { buildSshArgs, connectSsh, safeTarget };
