'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Commit the rewritten state last. An interrupted copy can be retried safely.
async function migrateLegacyData({ legacy, target }) {
  try { await fs.access(path.join(target, 'state.json')); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let saved;
  try { saved = JSON.parse(await fs.readFile(path.join(legacy, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw new Error('Previous shelf settings could not be migrated: ' + error.message); }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Previous shelf settings are not valid.');
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const directory of ['notes', 'clipboard-images']) {
    try { await fs.cp(path.join(legacy, directory), path.join(target, directory), { recursive: true, force: false, errorOnExist: false }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const item of saved.items || []) {
    const directory = item.kind === 'text' ? 'notes' : item.clipboard ? 'clipboard-images' : null;
    if (directory && typeof item.path === 'string' && item.path.startsWith(path.join(legacy, directory) + path.sep)) item.path = target + item.path.slice(legacy.length);
  }
  const temporary = path.join(target, 'migration-' + crypto.randomUUID() + '.tmp');
  try { await fs.writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temporary, path.join(target, 'state.json')); }
  finally { await fs.unlink(temporary).catch(() => {}); }
  return true;
}
module.exports = { migrateLegacyData };
