'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, globalShortcut, ipcMain, dialog, shell, clipboard, safeStorage, ClipboardItem } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { DriftService } = require('./service.cjs');
const { ShakeDetector } = require('./shake.cjs');
const { captureClipboard } = require('./clipboard.cjs');
const { createConfig, importConfiguration } = require('./config.cjs');
const { migrateLegacyData } = require('./migrate.cjs');
const { acquireWorker } = require('./worker.cjs');
const { ClipboardHistory } = require('./clipboard-history.cjs');
const { TunnelManager } = require('./tunnels.cjs');
const { MacInstaller } = require('./mac-installer.cjs');
const { ReceivedManager } = require('./received.cjs');
const { UpdateManager } = require('./updates.cjs');
const { tunnelSiteURL, assertTunnelSiteEndpoint } = require('./tunnel-site.cjs');

const { productName = 'ShelfDock', version } = require('../package.json');
// Retain the existing data directory and singleton identity across editions.
app.setName('lex-drift');
if (process.env.LEX_DRIFT_DATA_DIR || process.env.DRIFT_DATA_DIR) app.setPath('userData', process.env.LEX_DRIFT_DATA_DIR || process.env.DRIFT_DATA_DIR);
const backgroundTest = process.env.LEX_DRIFT_BACKGROUND_TEST === '1';
const startHidden = backgroundTest || process.argv.includes('--background');
const singleton = app.requestSingleInstanceLock({ background: startHidden });
if (!singleton) app.quit();
let window, tray, service, poll, refreshTimer, clipboardTimer, clipboardHistory, tunnels, macInstaller, received, updates, worker, quitting = false, closingWorker = false;
let interaction = { dragging: false, editing: false };
let runtimeSettings = { shakeEnabled: true, sensitivity: 'strong', viewMode: 'expanded' };
const detector = new ShakeDetector();
const nativeStatus = { shortcut: 'CommandOrControl+Shift+Space', shortcutAvailable: false };
const entry = path.join(__dirname, '..', 'dist', 'index.html');
const entryURL = pathToFileURL(entry).href;

function decorate(state) {
  const warnings = [nativeStatus.migrationWarning, nativeStatus.presetWarning].filter(Boolean);
  const updateState = updates?.snapshot();
  return { ...state, updatesSummary: updateState ? { status: updateState.status, availableVersion: updateState.release?.version, downloadedVersion: updateState.downloaded?.version } : null, clipboardTools: clipboardHistory?.toolsState?.() || { enabled: false, showTab: true, historyEnabled: false }, discovery: { ...state.discovery, warnings: [...(state.discovery?.warnings || []), ...warnings] }, environment: { ...state.environment, ...nativeStatus } };
}
function publish(state) {
  if (runtimeSettings.sensitivity !== state.settings.sensitivity) detector.setSensitivity(state.settings.sensitivity);
  if (runtimeSettings.viewMode !== state.settings.viewMode) resizeForMode(state.settings.viewMode);
  runtimeSettings = state.settings;
  if (window && !window.isDestroyed()) window.webContents.send('drift:state', decorate(state));
  if (tray) tray.setToolTip(`${productName} — ${state.items.length} held item${state.items.length === 1 ? '' : 's'}`);
}
function reveal(reason = 'manual') {
  if (backgroundTest) return;
  if (!window || window.isDestroyed()) return;
  if (!window.isVisible()) {
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const [width, height] = window.getSize();
    const x = Math.max(area.x, Math.min(cursor.x + 28, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(cursor.y - 100, area.y + area.height - height));
    window.setPosition(Math.round(x), Math.round(y));
  }
  if (reason === 'shake') window.showInactive();
  else { window.show(); window.focus(); }
  window.webContents.send('drift:reveal', { reason });
}



function toggleShelf(reason = 'manual') {
  if (backgroundTest || !window || window.isDestroyed()) return;
  if (window.isVisible()) {
    // A gesture must not remove a drop target or interrupt an open editor.
    if (reason === 'shake' && (interaction.dragging || interaction.editing)) return;
    window.hide();
    detector.reset();
  } else reveal(reason);
}

function resizeForMode(mode = 'expanded') {
  if (!window || window.isDestroyed()) return;
  const sizes = { compact: [650, 540], expanded: [840, 680], large: [1100, 800] };
  const [preferredWidth, preferredHeight] = sizes[mode] || sizes.expanded;
  const bounds = window.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(preferredWidth, area.width);
  const height = Math.min(preferredHeight, area.height);
  window.setMinimumSize(Math.min(650, area.width), Math.min(540, area.height));
  window.setBounds({ width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
}

function safeHandler(method, fn) {
  ipcMain.handle(`drift:${method}`, async (event, ...args) => {
    // Native capabilities are callable only by our packaged local window.
    if (!window || event.sender !== window.webContents || event.senderFrame?.url !== entryURL) {
      throw new Error(`This request did not come from ${productName}.`);
    }
    if (service?.appUpdating && !['getState', 'getUpdates', 'hideWindow', 'setInteraction'].includes(method)) throw new Error('Wait for the app update to finish.');
    if (service?.authenticationSetup && !['getState', 'getTunnels', 'stopTunnel', 'hideWindow', 'quit', 'setInteraction'].includes(method)) throw new Error('Wait for connection setup to finish.');
    if (service?.configurationImport && !['getState', 'getTunnels', 'stopTunnel', 'hideWindow', 'quit', 'setInteraction'].includes(method)) throw new Error('Wait for configuration import to finish.');
    if (service?.tunnelSetup && !['getState', 'getTunnels', 'stopTunnel', 'hideWindow', 'quit', 'setInteraction'].includes(method)) throw new Error('Wait for forwarding setup to finish.');
    if (service?.macInstallation && !['getState', 'getTunnels', 'getMacInstallState', 'stopTunnel', 'hideWindow', 'quit', 'setInteraction'].includes(method)) throw new Error('Wait for Mac installation to finish.');
    return fn(...args);
  });
}

if (singleton) app.whenReady().then(async () => {
  worker = await acquireWorker({ runtimeDir: process.platform === 'win32' ? path.join(app.getPath('appData'), 'lex-drift-runtime') : path.join('/tmp', 'lex-drift-' + process.getuid()), onShow: () => reveal('launch'), background: startHidden });
  if (!worker.primary) { quitting = true; app.quit(); return; }
  if (!process.env.LEX_DRIFT_DATA_DIR && !process.env.DRIFT_DATA_DIR) {
    try { await migrateLegacyData({ target: app.getPath('userData'), legacy: path.join(app.getPath('appData'), 'Drift') }); }
    catch (error) { nativeStatus.migrationWarning = error.message; console.warn(error.message); }
  }
  clipboardHistory = new ClipboardHistory({ dataDir: app.getPath('userData'), clipboard, ClipboardItem, safeStorage, isBlocked: () => backgroundTest || !!service?.appUpdating || interaction.sensitiveEditing || !!(window?.isVisible() && interaction.editing) || !!service?.authenticationSetup, onChange: state => { if (window && !window.isDestroyed()) window.webContents.send('drift:clipboard-history', state); if (service?.state) publish(service.state); } });
  await clipboardHistory.initialized;
  service = new DriftService({ dataDir: app.getPath('userData'), onChange: publish, safeStorage });
  await service.getState();
  if (app.isPackaged) {
    try {
    const preset = path.join(process.resourcesPath, 'personal-config.json');
    const marker = path.join(app.getPath('userData'), 'personal-preset-v1-applied');
    let alreadyApplied = false;
    try { await fs.access(marker); alreadyApplied = true; } catch {}
    if (!alreadyApplied) {
      let config;
      try { config = JSON.parse(await fs.readFile(preset, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (config) {
        await service.refreshHosts();
        await importConfiguration(service, config);
        await fs.writeFile(marker, 'Imported personal routes. Credentials stay local.\n', { mode: 0o600 });
      }
    }
    } catch (error) { nativeStatus.presetWarning = 'Personal setup could not be loaded. Import your configuration again from Settings. ' + error.message; console.warn(nativeStatus.presetWarning); }
  }
  tunnels = new TunnelManager({ dataDir: app.getPath('userData'), service, onChange: state => { if (window && !window.isDestroyed()) window.webContents.send('drift:tunnels', state); } });
  await tunnels.initialized;
  macInstaller = new MacInstaller({ service, sourceApp: process.platform === 'darwin' && app.isPackaged ? path.resolve(path.dirname(process.execPath), '../..') : null, platform: process.platform, arch: process.arch, version, productName, isPackaged: app.isPackaged, onChange: state => { if (window && !window.isDestroyed()) window.webContents.send('drift:mac-install', state); } });
  received = new ReceivedManager({ dataDir: app.getPath('userData'), desktopDir: app.getPath('desktop'), service, enabled: !backgroundTest, openPath: folder => shell.openPath(folder), onChange: state => { if (window && !window.isDestroyed()) window.webContents.send('drift:received', state); } });
  await received.initialized;
  updates = new UpdateManager({ dataDir: app.getPath('userData'), version, platform: process.platform, arch: process.arch, personal: ['lex-drift', 'LexBridge'].includes(productName), isPackaged: app.isPackaged && !backgroundTest, enabled: !backgroundTest, execPath: process.execPath, portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE, onChange: state => { service.appUpdating = ['preparing', 'installing'].includes(state.status); if (window && !window.isDestroyed()) { window.webContents.send('drift:updates', state); publish(service.state); } }, isBusy: () => !!(clipboardHistory?.busy || service.transferring || service.scanPromise || service.probePromise || service.authenticationSetup || service.configurationImport || service.tunnelSetup || service.macInstallation || interaction.dragging || tunnels.snapshot().active.some(tunnel => ['starting', 'running', 'stopping'].includes(tunnel.status))), quit: async () => { await service.shelfMutation?.catch(() => {}); await clipboardHistory.queue; await service.writeChain; received.stop(); await received.operations.catch(() => {}); quitting = true; app.quit(); }, openExternal: url => shell.openExternal(url), revealFile: file => shell.showItemInFolder(file) });
  await updates.initialized;
  const initial = await service.getState();
  runtimeSettings = initial.settings;
  detector.setSensitivity(initial.settings.sensitivity);
  window = new BrowserWindow({
    width: 840, height: 680, minWidth: 650, minHeight: 540,
    frame: false, show: false, alwaysOnTop: !backgroundTest, backgroundColor: '#E8EBF6',
    title: productName, autoHideMenuBar: true, roundedCorners: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: [`--lex-drift-product-name=${productName}`],
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, spellcheck: false,
    },
  });
  resizeForMode(initial.settings.viewMode);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== entryURL) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  for (const method of ['getState', 'refreshHosts', 'probeHosts', 'saveHost', 'removeHost', 'enqueueFiles', 'enqueueText', 'removeItem', 'clearItems', 'undoClear', 'send', 'sendMany', 'updateSettings', 'configureAccess', 'forgetPassword']) {
    safeHandler(method, async (...args) => decorate(await service[method](...args)));
  }
  for (const [method, operation] of Object.entries({ getReceived: () => received.getState(), refreshReceived: () => received.refresh(), markReceivedRead: request => received.markRead(request), openReceivedFolder: request => received.openFolder(request), addReceivedToShelf: async request => decorate(await received.addToShelf(request)) })) safeHandler(method, operation);
  for (const [method, operation] of Object.entries({ getUpdates: () => updates.getState(), checkForUpdates: () => updates.check(), updateUpdatePreferences: patch => updates.updatePreferences(patch), downloadUpdate: () => updates.download(), cancelUpdate: () => updates.cancel(), installUpdate: () => updates.install(), openUpdateRelease: () => updates.openRelease(), revealUpdateDownload: () => updates.revealDownload() })) safeHandler(method, operation);
  safeHandler('updateClipboardTools', async patch => { await clipboardHistory.updateTools(patch); return decorate(await service.getState()); });
  for (const [method, operation] of Object.entries({ getClipboardHistory: options => clipboardHistory.getState(options), updateClipboardPreferences: patch => clipboardHistory.updatePreferences(patch), captureClipboardHistory: () => clipboardHistory.capture(), getClipboardEntry: id => clipboardHistory.detail(id), copyClipboardEntry: request => clipboardHistory.copy(request), setClipboardPinned: request => clipboardHistory.setPinned(request), removeClipboardEntry: id => clipboardHistory.remove(id), clearClipboardHistory: () => clipboardHistory.clearUnpinned(), saveClipboardSnippet: request => clipboardHistory.saveSnippet(request), addClipboardEntryToShelf: async id => decorate(await clipboardHistory.addToShelf(id, service)) })) safeHandler(method, (...args) => { if (method !== 'getClipboardHistory') clipboardHistory.requireTools(); return operation(...args); });
  for (const [method, operation] of Object.entries({ getTunnels: () => tunnels.getState(), startTunnel: request => tunnels.start(request), stopTunnel: id => tunnels.stop(id), restartTunnel: id => tunnels.restart(id), removeTunnelHistory: id => tunnels.removeHistory(id), updateTunnelNote: request => tunnels.updateNote(request) })) safeHandler(method, operation);
  for (const [method, operation] of Object.entries({ getMacInstallState: () => macInstaller.getState(), previewMacInstall: request => macInstaller.preview(request), installOnMac: request => macInstaller.install(request) })) safeHandler(method, operation);
  safeHandler('openTunnelSite', async request => {
    const state = await service.getState();
    const url = tunnelSiteURL(request, tunnels.snapshot());
    const record = tunnels.active.get(request.id);
    assertTunnelSiteEndpoint(record, state.hosts.find(host => host.id === record?.view.hostId));
    await shell.openExternal(url);
    return { url };
  });
  safeHandler('pickFiles', async () => {
    const selection = await dialog.showOpenDialog(window, {
      title: `Add files to ${productName}`, properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    return decorate(selection.canceled ? await service.getState() : await service.enqueueFiles(selection.filePaths));
  });
  safeHandler('setInteraction', value => {
    interaction = { dragging: value?.dragging === true, editing: value?.editing === true, sensitiveEditing: value?.sensitiveEditing === true };
  });
  safeHandler('captureClipboard', async () => decorate(await captureClipboard({ clipboard, service })));
  safeHandler('exportConfig', async () => {
    const file = await dialog.showSaveDialog(window, { title: `Export ${productName} configuration`, defaultPath: `${productName}-config.json`, filters: [{ name: 'Configuration', extensions: ['json'] }] });
    if (file.canceled || !file.filePath) return null;
    const config = createConfig(await service.getState());
    await fs.writeFile(file.filePath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    return { filePath: file.filePath };
  });
  safeHandler('importConfig', async () => {
    const selection = await dialog.showOpenDialog(window, { title: `Import ${productName} configuration`, properties: ['openFile'], filters: [{ name: 'Configuration', extensions: ['json'] }] });
    if (selection.canceled || !selection.filePaths.length) return null;
    const file = selection.filePaths[0];
    const info = await fs.stat(file);
    if (info.size > 1024 * 1024) throw new Error('Configuration files must be smaller than 1 MB.');
    const config = await fs.readFile(file, 'utf8');
    return decorate(await importConfiguration(service, config));
  });
  safeHandler('hideWindow', () => window.hide());
  safeHandler('quit', () => { quitting = true; app.quit(); });
  safeHandler('openSettingsFolder', () => shell.openPath(app.getPath('userData')));

  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  if (!backgroundTest) {
  tray = new Tray(trayIcon);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Show ${productName}`, click: () => reveal('tray') },
    { label: 'Refresh machines', click: () => { if (service.configurationImport || service.authenticationSetup || service.tunnelSetup || service.macInstallation || service.transferring || service.appUpdating) return; service.refreshHosts().then(() => (service.configurationImport || service.authenticationSetup || service.tunnelSetup || service.macInstallation) ? null : service.probeHosts()).catch(console.error); reveal('tray'); } },
    { type: 'separator' },
    { label: `Quit ${productName}`, click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => toggleShelf('tray'));
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: productName, submenu: [
      { label: `Show ${productName}`, click: () => reveal() },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
  ]));
  nativeStatus.shortcutAvailable = !backgroundTest && globalShortcut.register(nativeStatus.shortcut, () => toggleShelf('shortcut'));
  await window.loadFile(entry);
  if (!startHidden) reveal('launch');
  publish(await service.getState());
  service.refreshHosts().then(() => (service.configurationImport || service.authenticationSetup || service.tunnelSetup || service.macInstallation) ? null : service.probeHosts({ automatic: true })).catch(console.error);
  // Poll position only: never install keyboard/mouse hooks or record cursor history on disk.
  if (!backgroundTest && !(process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY))) {
    poll = setInterval(() => {
      if (!runtimeSettings.shakeEnabled) { detector.reset(); return; }
      if (detector.add(screen.getCursorScreenPoint())) toggleShelf('shake');
    }, 32);
  }
  if (!backgroundTest) { received.start(); updates.start(); }
  if (!backgroundTest) clipboardTimer = setInterval(() => clipboardHistory.tick().catch(() => {}), 1500);
  refreshTimer = setInterval(async () => {
    const state = await service.getState();
    if (service.configurationImport || service.authenticationSetup || service.tunnelSetup || service.macInstallation || service.transferring || service.appUpdating) return;
    if (state.history.some(receipt => receipt.status === 'sending')) return;
    service.refreshHosts().then(() => (service.configurationImport || service.authenticationSetup || service.tunnelSetup || service.macInstallation) ? null : service.probeHosts({ automatic: true })).catch(console.error);
  }, 90000);
}).catch(error => {
  console.error(error);
  if (!backgroundTest) dialog.showErrorBox(`${productName} could not start`, error.message);
  quitting = true;
  app.quit();
});

app.on('second-instance', (_event, _argv, _directory, data) => { if (!data?.background) reveal('launch'); });
app.on('activate', () => reveal('dock'));
app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('before-quit', event => {
  quitting = true; clearInterval(poll); clearInterval(refreshTimer); clearInterval(clipboardTimer); received?.stop(); updates?.shutdown();
  if (worker?.primary && !closingWorker) {
    event.preventDefault(); closingWorker = true;
    Promise.resolve(macInstaller?.shutdown()).catch(console.error).then(() => Promise.all([service?.shelfMutation?.catch(() => {}), clipboardHistory?.queue, service?.writeChain, received?.operations?.catch(() => {})])).catch(console.error).then(() => tunnels?.shutdown()).catch(console.error).then(() => worker.close()).catch(console.error).finally(() => app.quit());
  }
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); worker?.close().catch(console.error); });
