'use strict';
// This adds updater-only mocks after the ordinary fictional UI fixture loads.
// No network requests, filesystem operations, credentials or app restarts occur.
module.exports = function installUpdateFixture({ personal = false, status = 'idle', downloaded = false, installable = true, platform = 'darwin', privateAuthenticated = false } = {}) {
  const clone = value => structuredClone(value);
  const prefix = personal ? 'LexBridge-personal' : 'ShelfDock';
  const repository = personal ? 'LexiLominite/LexBridge-private' : 'LexiLominite/ShelfDock';
  const release = { version: '0.5.1', tag: 'v0.5.1', prerelease: true, notes: 'Fictional update for interface testing.\nClearer history and small usability improvements.', url: 'https://github.com/' + repository + '/releases/tag/v0.5.1', asset: { name: prefix + '-0.5.1-mac-arm64.zip', size: 12 * 1024 ** 2 }, checksumAsset: { name: 'SHA256SUMS.txt' } };
  window.__update = { status, personal, currentVersion: '0.5.0', platform, arch: 'arm64', preferences: { autoCheck: true, autoDownload: true, includePrereleases: true }, release: status === 'idle' ? null : release, downloaded: null, canDownload: status !== 'idle', canInstall: false, progress: null, lastChecked: null, error: '', result: null, installation: { available: installable, target: platform === 'darwin' ? '/Applications/' + (personal ? 'LexBridge' : 'ShelfDock') + '.app' : '/fictional/ShelfDock', reason: installable ? '' : 'This installation is not writable. Use the verified package manually.' } };
  window.__updateRepository = repository;
  window.__privateUpdateAuthenticated = privateAuthenticated;
  window.__updateCalls = [];
  let listener = null;
  let finishDownload = null;
  let finishCheck = null;
  const summary = () => {
    window.__state.updatesSummary = { availableVersion: window.__update.release?.version || null, downloadedVersion: window.__update.downloaded?.version || null };
    window.__listeners.state?.(clone(window.__state));
  };
  const emit = () => { summary(); listener?.(clone(window.__update)); };
  window.__emitUpdate = emit;
  window.__setUpdate = patch => { Object.assign(window.__update, patch); emit(); };
  const markDownloaded = () => {
    Object.assign(window.__update, { status: 'downloaded', release, downloaded: { name: release.asset.name, version: '0.5.1', size: release.asset.size, sha256: 'a'.repeat(64) }, canDownload: true, canInstall: window.__update.installation.available, progress: null, error: '' });
  };
  if (downloaded) markDownloaded();
  window.__finishUpdateDownload = (failure = '') => {
    if (!finishDownload) return;
    if (failure) Object.assign(window.__update, { status: 'available', error: failure, progress: null, downloaded: null, canInstall: false });
    else markDownloaded();
    emit(); const resolve = finishDownload; finishDownload = null; resolve(clone(window.__update));
  };
  window.__finishUpdateCheck = () => { if (!finishCheck) return; Object.assign(window.__update, { status: 'available', release, canDownload: true, lastChecked: '2026-09-28T09:30:00.000Z', error: '' }); emit(); const resolve = finishCheck; finishCheck = null; resolve(clone(window.__update)); };
  const call = (method, action) => async value => { window.__calls.push({ method, value }); window.__updateCalls.push({ method, value, repository: window.__updateRepository }); return action(value); };
  Object.assign(window.drift, {
    getUpdates: call('getUpdates', () => clone(window.__update)),
    onUpdates: callback => { listener = callback; return () => { listener = null; }; },
    updateUpdatePreferences: call('updateUpdatePreferences', patch => { Object.assign(window.__update.preferences, patch); if (!window.__update.preferences.autoCheck) window.__update.preferences.autoDownload = false; emit(); return clone(window.__update); }),
    checkForUpdates: call('checkForUpdates', () => {
      if (personal && !window.__privateUpdateAuthenticated) { Object.assign(window.__update, { status: 'error', error: 'For private updates, install GitHub CLI and run gh auth login for github.com with access to the private release repository. You can also download from Private releases.', release: null, canDownload: false }); emit(); return clone(window.__update); }
      Object.assign(window.__update, { status: 'checking', error: '' }); emit();
      if (window.__deferUpdateCheck) return new Promise(resolve => { finishCheck = resolve; });
      Object.assign(window.__update, { status: 'available', release, canDownload: true, lastChecked: '2026-09-28T09:30:00.000Z' }); emit(); return clone(window.__update);
    }),
    downloadUpdate: call('downloadUpdate', () => { Object.assign(window.__update, { status: 'downloading', progress: { received: 3 * 1024 ** 2, total: 12 * 1024 ** 2 }, error: '' }); emit(); return new Promise(resolve => { finishDownload = resolve; }); }),
    cancelUpdate: call('cancelUpdate', () => { Object.assign(window.__update, { status: window.__update.release ? 'available' : 'idle', error: 'Update operation cancelled.', progress: null }); emit(); for (const resolve of [finishDownload, finishCheck]) resolve?.(clone(window.__update)); finishDownload = null; finishCheck = null; return clone(window.__update); }),
    revealUpdateDownload: call('revealUpdateDownload', () => clone(window.__update)),
    openUpdateRelease: call('openUpdateRelease', () => { window.__openedUpdateUrl = 'https://github.com/' + repository + '/releases'; return clone(window.__update); }),
    installUpdate: call('installUpdate', () => { Object.assign(window.__update, { status: 'preparing', error: '' }); emit(); return new Promise(resolve => { window.__finishUpdateInstall = (failure = '') => { Object.assign(window.__update, { status: failure ? 'downloaded' : 'installing', error: failure }); emit(); resolve(clone(window.__update)); }; }); }),
  });
  summary();
};
