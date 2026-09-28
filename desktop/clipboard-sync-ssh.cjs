'use strict';

const { spawn } = require('node:child_process');
const { PORT } = require('./clipboard-sync-protocol.cjs');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function safeTarget(target, port = PORT) {
  if (!target || typeof target !== 'object' || port !== PORT) throw new Error('Choose a saved machine.');
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
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', '-W', `127.0.0.1:${PORT}`];
  if (safe.identityFile) args.push('-i', safe.identityFile, '-o', 'IdentitiesOnly=yes');
  if (safe.alias) args.push(safe.alias);
  else args.push('-p', String(safe.port), '-l', safe.user, safe.host);
  return args;
}

function connectSsh(target, spawnProcess = spawn) {
  const child = spawnProcess('ssh', buildSshArgs(target), { stdio: ['pipe', 'pipe', 'pipe'] });
  const stream = child.stdout;
  stream.write = chunk => child.stdin.write(chunk);
  stream.destroy = () => { stream.destroyed = true; child.kill(); };
  child.once('exit', () => { stream.destroyed = true; stream.emit('end'); });
  child.once('error', error => stream.emit('error', error));
  return stream;
}

module.exports = { buildSshArgs, connectSsh, safeTarget };
