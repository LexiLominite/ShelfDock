'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { API_URL, selectRelease, fetchBuffer, parseChecksums, hashFile, assertAppIdentity, EDITIONS } = require('./updates.cjs');
const { createPrivateTransport } = require('./updates-gh.cjs');
const { extractArchive } = require('./updates-install.cjs');

const PRIVATE_API = 'https://api.github.com/repos/LexiLominite/LexBridge-private/releases?per_page=100';
const MAX_ASSET = 1500 * 1024 ** 2;
const clone = value => JSON.parse(JSON.stringify(value));

function releaseAssetName(version, targetOS, arch, edition) {
  const prefix = EDITIONS[edition === 'personal' ? 'personal' : 'public'].prefix;
  if (targetOS === 'windows' && arch === 'x64') return `${prefix}-${version}-win-x64.exe`;
  if (targetOS === 'linux' && ['x64', 'arm64'].includes(arch)) return `${prefix}-${version}-linux-${arch}.tar.gz`;
  return null;
}

async function readRelease({ targetOS, arch, edition, version, signal, platform = process.platform, stream = null, request = null }) {
  const personal = edition === 'personal';
  const transport = stream || (personal ? createPrivateTransport({}) : undefined);
  const releasesURL = personal ? PRIVATE_API : API_URL;
  const listing = await fetchBuffer(releasesURL, { limit: 8 * 1024 ** 2, signal, ...(transport ? { stream: transport } : request ? { stream: request } : {}) });
  let releases;
  try { releases = JSON.parse(listing.toString('utf8')); } catch { throw new Error('The release service returned invalid release metadata.'); }
  if (!Array.isArray(releases) || releases.length > 100) throw new Error('The release service returned an invalid release list.');
  const tag = `v${version}`;
  const matches = releases.filter(value => value?.tag_name === tag && value.draft === false);
  if (matches.length !== 1) throw new Error(`The ${edition === 'personal' ? 'private' : 'public'} release v${version} is not available.`);
  const release = selectRelease(matches, { version: '0.0.0', platform: targetOS === 'windows' ? 'win32' : 'linux', arch, includePrereleases: true, personal });
  if (!release || release.version !== version || !release.asset || !release.checksumAsset) throw new Error('This release has no package for the selected destination architecture.');
  const expectedName = releaseAssetName(version, targetOS, arch, edition);
  if (!expectedName || release.asset.name !== expectedName) throw new Error('The release package did not match the selected destination.');
  const [checksumBytes, assetBytes] = await Promise.all([
    fetchBuffer(release.checksumAsset.url, { limit: 128 * 1024, signal, ...(transport ? { stream: transport } : request ? { stream: request } : {}) }),
    fetchBuffer(release.asset.url, { limit: MAX_ASSET, signal, ...(transport ? { stream: transport } : request ? { stream: request } : {}) }),
  ]);
  if (assetBytes.length !== release.asset.size || checksumBytes.length !== release.checksumAsset.size) throw new Error('The release download size did not match its metadata.');
  if (release.checksumAsset.digest && crypto.createHash('sha256').update(checksumBytes).digest('hex') !== release.checksumAsset.digest) throw new Error('The release checksum manifest did not match its published digest.');
  const sha256 = crypto.createHash('sha256').update(assetBytes).digest('hex');
  const listed = parseChecksums(checksumBytes.toString('utf8'), expectedName);
  if (sha256 !== listed || (release.asset.digest && sha256 !== release.asset.digest)) throw new Error('The release package did not match its published SHA-256 checksum.');
  return { asset: { name: expectedName, size: assetBytes.length, sha256, bytes: assetBytes }, release: clone({ version, tag, url: release.url, prerelease: release.prerelease }), edition };
}

async function validateLinuxPackage(bytes, { version, arch, productName, personal, tempRoot = os.tmpdir() }) {
  const root = await fs.mkdtemp(path.join(tempRoot, 'shelfdock-remote-verify-'));
  try {
    const archive = path.join(root, 'payload.tar.gz');
    await fs.writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    const appRoot = `${personal ? 'LexBridge-personal' : 'ShelfDock'}-${version}-linux-${arch}`;
    const extracted = await extractArchive({ file: archive, destination: path.join(root, 'extract'), format: 'tar.gz', root: appRoot });
    await assertAppIdentity(extracted, 'linux', version, arch, personal);
    if (productName !== (personal ? 'LexBridge' : 'ShelfDock')) throw new Error('The release package belongs to another app edition.');
    return true;
  } finally { await fs.rm(root, { recursive: true, force: true }).catch(() => {}); }
}

function validateWindowsPortable(bytes, { arch, version, productName, personal }) {
  // electron-builder portable artifacts are PE executables; the exact release asset name,
  // release checksum, and portable resource version bind this to the requested build.
  if (bytes.length < 256 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('The Windows release package is not a portable executable.');
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 24 > bytes.length || bytes.subarray(peOffset, peOffset + 4).toString('hex') !== '50450000') throw new Error('The Windows release package has an invalid executable header.');
  const machine = bytes.readUInt16LE(peOffset + 4);
  // electron-builder's portable launcher may be x86 even for an x64 app.
  // Payload architecture is bound by the exact x64 release name/checksum and
  // release packaging verification; the launcher itself is never executed here.
  if (arch !== 'x64' || ![0x014c, 0x8664].includes(machine)) throw new Error('The Windows release package is for a different processor.');
  const expectedName = personal ? 'LexBridge' : 'ShelfDock';
  if (productName !== expectedName || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('The release package belongs to another app edition or version.');
  // Validate the executable's UTF-16 version strings as well as its PE target.
  // The sender never executes the downloaded installer to discover identity.
  const resourceValue = key => {
    const needle = Buffer.from(key + '\0', 'utf16le');
    let at = bytes.indexOf(needle);
    while (at >= 0) {
      let start = at + needle.length;
      while (start + 1 < bytes.length && bytes.readUInt16LE(start) === 0 && start < at + needle.length + 8) start += 2;
      let end = start;
      while (end + 1 < bytes.length && end - start < 512 && bytes.readUInt16LE(end) !== 0) end += 2;
      const value = bytes.subarray(start, end).toString('utf16le');
      if (value) return value;
      at = bytes.indexOf(needle, at + needle.length);
    }
    return '';
  };
  if (resourceValue('ProductName') !== expectedName || resourceValue('ProductVersion') !== version) throw new Error('The Windows package application identity or version did not match the release.');
  return true;
}

module.exports = { PRIVATE_API, MAX_ASSET, releaseAssetName, readRelease, validateLinuxPackage, validateWindowsPortable };
