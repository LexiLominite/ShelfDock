'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

const PRIVATE_REPO = 'LexiLominite/LexBridge-private';
const AUTH_HELP = 'For private updates, install GitHub CLI and run gh auth login for github.com with access to the private release repository. You can also download from Private releases.';
async function locateGh({ platform = process.platform, env = process.env } = {}) {
  const names = platform === 'win32' ? ['gh.exe'] : ['gh'];
  const bases = [...(env.PATH || '').split(path.delimiter), ...(platform === 'win32' ? [path.join(env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI')] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])].filter(directory => path.isAbsolute(directory));
  for (const base of [...new Set(bases)]) for (const name of names) {
    const file = path.join(base, name);
    try { const canonical = await fs.realpath(file), stat = await fs.stat(canonical); if (stat.isFile()) { await fs.access(canonical, require('node:fs').constants.X_OK); return canonical; } } catch {}
  }
  throw new Error(AUTH_HELP);
}
function privateEndpoint(value) {
  const url = new URL(value);
  const prefix = '/repos/' + PRIVATE_REPO + '/releases';
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port || url.username || url.password || url.hash || ![prefix, prefix + '/'].includes(url.pathname) && !new RegExp('^' + prefix + '/assets/[1-9][0-9]{0,15}$').test(url.pathname)) throw new Error('The private update requested an unexpected repository address.');
  if (url.search && url.search !== '?per_page=100') throw new Error('The private update requested invalid release options.');
  return url.pathname.slice(1) + url.search;
}
function createPrivateTransport({ findGh = locateGh, spawnProcess = spawn, env = process.env } = {}) {
  async function stream(value, { signal } = {}) {
    const endpoint = privateEndpoint(value); signal?.throwIfAborted(); const executable = await findGh(); signal?.throwIfAborted();
    const childEnvironment = { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
    const args = ['api', '--hostname', 'github.com', endpoint, '-H', endpoint.includes('/assets/') ? 'Accept: application/octet-stream' : 'Accept: application/vnd.github+json'];
    const child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment });
    const output = new PassThrough(); output.headers = {}; let finished = false, stderrSize = 0;
    const abort = () => { child.kill(); output.destroy(new Error('Private update cancelled.')); };
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => { child.kill(); output.destroy(new Error('The private update connection timed out.')); }, 20 * 60 * 1000); deadline.unref?.();
    child.stdout.pipe(output, { end: false });
    child.stderr.on('data', bytes => { stderrSize += bytes.length; if (stderrSize > 64 * 1024) child.kill(); });
    child.once('error', () => { output.destroy(new Error(AUTH_HELP)); });
    child.once('close', code => { finished = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort); if (code === 0) output.end(); else output.destroy(new Error(AUTH_HELP)); });
    output.once('close', () => { if (!finished) child.kill(); clearTimeout(deadline); signal?.removeEventListener('abort', abort); });
    return output;
  }
  return stream;
}
module.exports = { PRIVATE_REPO, AUTH_HELP, locateGh, privateEndpoint, createPrivateTransport };
