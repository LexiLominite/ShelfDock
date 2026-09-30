'use strict';
const { spawn } = require('node:child_process');
const { Duplex } = require('node:stream');
const hardening = ['-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ForkAfterAuthentication=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'StrictHostKeyChecking=yes'];
function portNumber(value = 5900) { const port = Number(value); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a VNC port between 1024 and 65535.'); return port; }
class ProcessStream extends Duplex {
  constructor(child) {
    super({ allowHalfOpen: false }); this.child = child; this.on('error', () => {});
    child.stdout.on('data', bytes => { if (!this.push(bytes)) child.stdout.pause(); });
    child.stdout.once('end', () => this.push(null));
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => this.destroy(new Error('The SSH desktop channel failed.')));
    child.stderr.resume(); child.once('error', () => this.destroy(new Error('OpenSSH could not start.')));
    child.once('exit', code => { this.exited = true; clearTimeout(this.killTimer); if (code && !this.destroyed) this.destroy(new Error('SSH desktop access failed. Verify the saved route, host fingerprint and authentication.')); });
  }
  _read() { this.child.stdout.resume(); }
  _write(bytes, encoding, callback) { this.child.stdin.write(bytes, encoding, callback); }
  _final(callback) { this.child.stdin.end(callback); }
  _destroy(error, callback) {
    if (!this.exited) { this.child.kill('SIGTERM'); this.killTimer = setTimeout(() => { if (!this.exited) this.child.kill('SIGKILL'); }, 750); this.killTimer.unref?.(); }
    callback(error);
  }
}
function openDesktopChannel(service, host, port, { signal, spawnProcess = spawn } = {}) {
  port = portNumber(port);
  if (service.remoteDesktopConnect) return service.remoteDesktopConnect(host, port, { signal });
  if (service.passwordAuth?.metadata(host).hasSavedPassword) return new Promise((resolve, reject) => {
    let release; let session; let settled = false;
    const stop = () => { release?.(); session?.close(); if (!settled) { settled = true; reject(new Error('Desktop connection was cancelled.')); } };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) { stop(); return; }
    service.passwordAuth.withPassword(host, async connection => {
      session = connection;
      if (signal?.aborted) throw new Error('Desktop connection was cancelled.');
      await new Promise((done, fail) => connection.client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error, channel) => {
        if (error) return fail(new Error('The saved SSH connection could not reach the VNC server.'));
        if (signal?.aborted) { channel.destroy(); return fail(new Error('Desktop connection was cancelled.')); }
        channel.on('error', () => {}); channel.once('close', done); release = () => { channel.destroy(); done(); }; settled = true; resolve(channel);
      }));
    }).catch(error => { if (!settled) { settled = true; reject(error); } }).finally(() => signal?.removeEventListener('abort', stop));
  });
  const child = spawnProcess('ssh', [...hardening, '-T', '-W', `127.0.0.1:${port}`, ...service.sshArgs(host)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const stream = new ProcessStream(child); const stop = () => stream.destroy(); signal?.addEventListener('abort', stop, { once: true }); stream.once('close', () => signal?.removeEventListener('abort', stop)); if (signal?.aborted) stream.destroy(); return stream;
}
// Commands and secrets use separate streams. Error messages never include remote output.
function execWithInput(open, { stdin = '', timeout = 15000, signal, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let channel, child, settled = false, output = [], size = 0, killTimer;
    const stop = () => { channel?.destroy(); if (child) { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 750); killTimer.unref?.(); } };
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); if (error) { stop(); reject(error); } else resolve(value); };
    const aborted = () => finish(new Error('The remote SSH command was cancelled.'));
    const timer = setTimeout(() => finish(new Error('The remote SSH command timed out.')), timeout);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) return aborted();
    const ready = (error, streams) => {
      if (settled) { streams?.channel?.destroy(); streams?.child?.kill(); return; }
      if (error) return finish(new Error('The SSH command could not start.'));
      ({ channel, child } = streams);
      const { input, output: readable, errors, completion } = streams;
      for (const stream of [input, readable, errors]) stream?.on('error', () => finish(new Error('The remote SSH command failed.')));
      errors?.resume();
      readable.on('data', bytes => { size += bytes.length; if (size > maxBuffer) return finish(new Error('The remote SSH command returned too much output.')); output.push(bytes); });
      completion.once('error', () => finish(new Error('The SSH command could not start.')));
      completion.once('close', code => { clearTimeout(killTimer); code === 0 ? finish(null, { stdout: Buffer.concat(output).toString('utf8'), stderr: '' }) : finish(new Error('The remote SSH command failed. Verify SSH access and target permissions.')); });
      input.end(stdin); stdin = undefined;
    };
    try { open(ready); } catch { ready(new Error('SSH failed')); }
  });
}
async function desktopExec(service, host, command, options = {}) {
  if (service.remoteDesktopExec) return service.remoteDesktopExec(host, command, options);
  if (service.passwordAuth?.metadata(host).hasSavedPassword) return service.passwordAuth.withPassword(host, session => execWithInput(ready => session.client.exec(command, (error, channel) => ready(error, channel && { channel, input: channel, output: channel, errors: channel.stderr, completion: channel })), options));
  if (options.stdin === undefined && !options.signal && !options.spawnProcess) return service.run('ssh', [...hardening, '-T', ...service.sshArgs(host), command], { timeout: options.timeout || 15000 });
  return execWithInput(ready => { const child = (options.spawnProcess || spawn)('ssh', [...hardening, '-T', ...service.sshArgs(host), command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }); ready(null, { child, input: child.stdin, output: child.stdout, errors: child.stderr, completion: child }); }, options);
}
module.exports = { portNumber, openDesktopChannel, desktopExec, execWithInput, ProcessStream, hardening };
