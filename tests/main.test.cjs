'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { endpointKey } = require('../desktop/password-auth.cjs');
const siteHost = { id: 'browser-test-host', name: 'Browser fixture', address: 'fixture.invalid', user: 'fixture', port: 22 };

const desktop = path.join(__dirname, '..', 'desktop');
const mainSource = fs.readFileSync(path.join(desktop, 'main.cjs'), 'utf8');
const shakeSource = fs.readFileSync(path.join(desktop, 'shake.cjs'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

// Execute the shipped controller with inert Electron, filesystem, network, and
// timer substitutes. These tests cannot create a real window or read a profile.
async function controller(options = {}) {
  let clock = 100000; let cursor = { x: 300, y: 200 };
  const calls = []; const windows = []; const trays = []; const timers = []; const shortcuts = new Map(); const handlers = new Map(); const errors = [];
  const record = (type, ...values) => calls.push({ type, values });
  class ClockDate extends Date { static now() { return clock; } }
  const shakeModule = { exports: {} };
  vm.runInNewContext(shakeSource, { module: shakeModule, Date: ClockDate }, { filename: path.join(desktop, 'shake.cjs') });
  class FakeWindow extends EventEmitter {
    constructor(config) {
      super(); this.options = config; this.visible = Boolean(config.show); this.bounds = { x: 20, y: 20, width: config.width, height: config.height }; windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.send = (...args) => record('webContents.send', ...args);
      this.webContents.setWindowOpenHandler = handler => { this.windowOpenHandler = handler; };
      this.webContents.session = { setPermissionRequestHandler: handler => { this.permissionHandler = handler; } };
    }
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    show() { this.visible = true; record('show'); }
    showInactive() { this.visible = true; record('showInactive'); }
    hide() { this.visible = false; record('hide'); }
    focus() { record('focus'); }
    getSize() { return [this.bounds.width, this.bounds.height]; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
    setMinimumSize() {}
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
    setVisibleOnAllWorkspaces() {}
    async loadFile(file) { this.loadedFile = file; record('windowLoaded', file); }
  }
  class FakeTray extends EventEmitter {
    constructor() { super(); trays.push(this); }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip() {}
  }
  const app = new EventEmitter();
  const paths = { appData: '/virtual/app-data', userData: '/virtual/user-data', desktop: '/virtual/Desktop' };
  Object.assign(app, {
    isPackaged: options.packaged === true,
    setName(name) { record('setName', name); },
    setPath(key, value) { paths[key] = value; },
    getPath(key) { return paths[key]; },
    requestSingleInstanceLock(data) { record('singleInstance', data); return options.singleton !== false; },
    whenReady: async () => undefined,
    quit() { record('quit'); },
  });
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const electron = {
    app, BrowserWindow: FakeWindow, Tray: FakeTray,
    Menu: { buildFromTemplate: value => value, setApplicationMenu: () => record('applicationMenu') },
    nativeImage: { createFromPath: () => ({ resize: () => ({ setTemplateImage() {} }) }) },
    screen: { getCursorScreenPoint: () => { record('cursorRead'); return cursor; }, getDisplayNearestPoint: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }) },
    globalShortcut: { register: (key, callback) => { record('shortcutRegister', key); shortcuts.set(key, callback); return true; }, unregisterAll: () => record('shortcutUnregister') },
    ipcMain: { handle: (key, callback) => handlers.set(key, callback) },
    dialog: { showErrorBox: (...args) => record('errorDialog', ...args), showOpenDialog: async () => { throw new Error('No native dialogs are permitted in controller tests.'); }, showSaveDialog: async () => { throw new Error('No native dialogs are permitted in controller tests.'); } },
    shell: { openPath: () => { throw new Error('No profile access is permitted in controller tests.'); }, openExternal: async url => { record('openExternal', url); if (options.openExternalError) throw new Error(options.openExternalError); } },
    clipboard: { writeText: value => record('clipboardWrite', value), read: () => { throw new Error('No clipboard access is permitted in controller tests.'); } },
  };
  const initialState = { hosts: options.hosts || (options.activeTunnels?.length ? [{ ...siteHost }] : []), items: [], history: [], settings: { shakeEnabled: true, sensitivity: 'normal', viewMode: 'expanded' }, discovery: { warnings: [] }, environment: { sshAvailable: true } };
  let fakeService;
  class FakeService {
    constructor() { record('serviceCreated'); this.state = initialState; fakeService = this; }
    async getState() { return this.state; }
    async refreshHosts() { return this.state; }
    async probeHosts() { return this.state; }
  }
  let workerOptions, historyOptions, fakeTunnels, fakeDesktop, fakeInstaller;
  const modules = {
    '../package.json': { productName: options.productName || 'ShelfDock', version: '0.4.1' },
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': new Proxy({}, { get: () => () => { throw new Error('No filesystem operations are permitted in controller tests.'); } }),
    './service.cjs': { DriftService: FakeService },
    './shake.cjs': shakeModule.exports,
    './native-glass.cjs': { applyNativeGlass: () => { record('nativeGlassApplied'); return options.glassStatus || { mode: 'native', applied: true, supported: true, reducedTransparency: false }; }, watchAccessibility: callback => { record('appearanceWatch'); return () => record('appearanceWatchStopped'); } },
    './clipboard.cjs': { captureClipboard: () => { throw new Error('No clipboard access is permitted in controller tests.'); } },
    './config.cjs': { createConfig: () => ({}), importConfiguration: async () => initialState },
    './migrate.cjs': { migrateLegacyData: async () => undefined },
    './tunnels.cjs': { TunnelManager: class { constructor() { fakeTunnels = this; this.state = { active: options.activeTunnels || [], history: [] }; this.initialized = Promise.resolve(); } get active() { return new Map(this.state.active.map(view => [view.id, { view: { ...view, hostId: siteHost.id }, endpoint: endpointKey(siteHost) }])); } snapshot() { return this.state; } async getState() { return this.state; } async stop(id) { record('tunnelStop', id); this.state.active = this.state.active.filter(tunnel => tunnel.id !== id); } async shutdown() { record('tunnelsShutdown'); } } },
    './mac-installer.cjs': { MacInstaller: class { constructor(args) { this.args = args; record('macInstallerCreated', args.platform, args.sourceApp); } getState() { return { available: this.args.platform === 'darwin' && this.args.isPackaged, operation: null }; } async preview(request) { record('macPreview', request); return { id: 'fictional-plan' }; } async install(request) { record('macInstall', request); return this.getState(); } async shutdown() { record('macInstallerShutdown'); await options.installerShutdown; } } },
    './remote-desktop.cjs': { RemoteDesktop: class { constructor(args) { this.args = args; this.session = options.remoteSession || null; fakeDesktop = this; record('desktopCreated', args.allowedOrigins); } getState() { return { session: this.session }; } async inspect(request) { record('desktopInspect', request); await options.desktopInspection; return { available: true }; } async previewSetup(request) { record('desktopPreview', request); return { id: 'desktop-plan' }; } async apply(request) { record('desktopApply', request); return this.getState(); } async start(request) { record('desktopStart', request); this.session = { id: 'desktop-session', status: 'waiting' }; return { session: this.session }; } async stop(request) { record('desktopStop', request); this.session = null; return this.getState(); } async shutdown() { record('desktopShutdown'); await options.desktopShutdown; } } },
    './remote-installer.cjs': { RemoteInstaller: class { constructor(args) { this.args = args; fakeInstaller = this; record('remoteInstallerCreated', args.edition); } getState() { return { available: true, operation: null }; } async preview(request) { record('remotePreview', request); return { id: 'remote-plan' }; } async install(request) { record('remoteInstall', request); return this.getState(); } async cancel(request) { record('remoteCancel', request); return this.getState(); } async shutdown() { record('remoteInstallerShutdown'); await options.remoteInstallerShutdown; } } },
    './received.cjs': { ReceivedManager: class { constructor(args) { this.args = args; this.initialized = Promise.resolve(); record('receivedCreated', args.enabled); } async getState() { return { received: [], unreadCount: 0 }; } async refresh() { record('receivedRefresh'); return this.getState(); } async markRead(value) { record('receivedRead', value); return this.getState(); } async openFolder(value) { record('receivedOpen', value); return this.getState(); } async addToShelf(value) { record('receivedShelf', value); return initialState; } start() { record('receivedStart'); } stop() { record('receivedStop'); } } },
    './updates.cjs': { UpdateManager: class { constructor(args) { this.args = args; this.initialized = Promise.resolve(); record('updatesCreated', args.enabled); } snapshot() { return { status: 'idle', version: '0.5.0' }; } async getState() { return this.snapshot(); } async check() { record('updatesCheck'); return this.getState(); } async install() { if (this.args.isBusy()) throw new Error('Finish active work first.'); this.args.onChange({status:'installing'}); record('updatesInstall'); } async confirmStartup() { record('startupConfirmed'); } start() { record('updatesStart'); } shutdown() { record('updatesShutdown'); } } },
    './tunnel-site.cjs': { ...require('../desktop/tunnel-site.cjs'), verifyTunnelSite: async (url, recordValue) => { record('verifyTunnelSite', url); if (options.siteProbe) await options.siteProbe(url, recordValue); if (options.siteProbeError) throw new Error(options.siteProbeError); } },
    './clipboard-sync.cjs': { ClipboardSync: class {
      constructor() { record('clipboardSyncCreated'); this.ready = Promise.resolve(); }
      state() { return { available: false, enabled: false, paused: false, receiveMode: 'history', pairing: null, peers: [] }; }
      async setEnabled(enabled) { record('clipboardSyncEnabled', enabled); }
      async setPaused() {}
      async setReceiveMode() {}
      async refreshOwnerBootstrap() { record('ownerBootstrapRefreshed'); }
      async beginPairing() { return { code: 'ABCDEFGH', expiresAt: new Date().toISOString() }; }
      async pairWith() { return this.state(); }
      async pairOwnedWith(request) { record('ownerClipboardConnected', request); await options.clipboardLink; return this.state(); }
      async updatePeer() {}
      async revoke() { return this.state(); }
      async submitLocal() {}
      async shutdown() { record('clipboardSyncShutdown'); }
    } },
    './clipboard-sync-ssh.cjs': { connectSsh() { throw new Error('No SSH in controller tests.'); }, buildSshArgs() { return []; } },
    './clipboard-history.cjs': { SYNC_EVENT_TYPE: 'application/x-shelfdock-sync-event', ClipboardHistory: class {
      constructor(args) { historyOptions = args; this.initialized = Promise.resolve(); this.tools = { enabled: options.clipboardToolsEnabled === true, showTab: true, historyEnabled: false }; }
      toolsState() { return { ...this.tools }; }
      requireTools() { if (!this.tools.enabled) throw new Error('Enable Clipboard tools in Settings first.'); }
      async updateTools(patch) { Object.assign(this.tools, patch); if (!this.tools.enabled) this.tools.historyEnabled = false; record('clipboardToolsUpdated', patch); }
      async getState() { return { entries: [], settings: { enabled: false }, tools: this.toolsState() }; }
      async tick() {}
      async capture() { record('historyCapture'); }
      async copy() { record('historyCopy'); }
      async detail() { record('historyDetail'); }
      async updatePreferences() { record('historyPreferences'); }
      async setPinned() { record('historyPin'); }
      async remove() { record('historyRemove'); }
      async clearUnpinned() { record('historyClear'); }
      async saveSnippet() { record('historySnippet'); }
      async addToShelf() { record('historyShelf'); return initialState; }
    } },
    './worker.cjs': { acquireWorker: async args => {
      workerOptions = args; record('workerAcquire', args.background);
      if (options.workerError) throw new Error(options.workerError);
      return { primary: options.primary !== false, close: async () => record('workerClose') };
    } },
  };
  const context = {
    require(name) { if (!(name in modules)) throw new Error('Unmocked dependency: ' + name); return modules[name]; },
    __dirname: desktop,
    process: { getuid: () => 1000, platform: options.platform || 'darwin', argv: ['electron', '/virtual/main.cjs', ...(options.argv || [])], env: { LEX_DRIFT_DATA_DIR: '/virtual/user-data', ...(options.env || {}) }, resourcesPath: '/virtual/resources', arch: 'arm64', execPath: '/virtual/ShelfDock.app/Contents/MacOS/ShelfDock' },
    Date: ClockDate,
    console: { error: (...values) => errors.push(values), warn: (...values) => errors.push(values) },
    setInterval(callback, milliseconds) { const timer = { callback, milliseconds, active: true }; timers.push(timer); return timer; },
    clearInterval(timer) { if (timer) timer.active = false; },
  };
  vm.runInNewContext(mainSource, context, { filename: path.join(desktop, 'main.cjs') });
  await flush(); await flush();
  const invoke = async (method, value) => {
    const window = windows[0];
    return handlers.get('drift:' + method)({ sender: window.webContents, senderFrame: { url: pathToFileURL(window.loadedFile).href } }, value);
  };
  const shake = () => {
    const poll = timers.find(timer => timer.milliseconds === 32 && timer.active);
    assert.ok(poll, 'normal operation installs cursor sampling');
    for (const x of [0, 50, 130, 50, 0, 60, 140, 60, 0, 60, 150]) { clock += 32; cursor = { x: 300 + x, y: 200 }; poll.callback(); }
  };
  return { app, calls, windows, trays, timers, shortcuts, handlers, errors, invoke, shake, workerOptions, historyOptions, service: fakeService, tunnels: fakeTunnels, desktop: fakeDesktop, installer: fakeInstaller, advance: milliseconds => { clock += milliseconds; } };
}

test('actual controller shows on a shake and hides on a later shake while respecting cooldown', async () => {
  const c = await controller({ argv: ['--background'] }); const window = c.windows[0];
  assert.deepEqual(c.errors, []); assert.equal(window.isVisible(), false);
  c.shake(); assert.equal(window.isVisible(), true);
  assert.equal(c.calls.filter(call => call.type === 'showInactive').length, 1);
  assert.equal(c.calls.filter(call => call.type === 'focus').length, 0, 'gesture reveal does not steal focus');
  c.shake(); assert.equal(window.isVisible(), true, 'a repeated shake inside the cooldown does not hide the shelf');
  c.advance(2500); c.shake(); assert.equal(window.isVisible(), false);
  assert.equal(c.calls.filter(call => call.type === 'hide').length, 1);
});

test('gesture toggles preserve an active drag or dialog but resume after interaction ends', async () => {
  const c = await controller({ argv: ['--background'] }); const window = c.windows[0]; c.shake();
  await c.invoke('setInteraction', { dragging: true, editing: false }); c.advance(2500); c.shake();
  assert.equal(window.isVisible(), true, 'a destination stays visible while dragging');
  await c.invoke('setInteraction', { dragging: false, editing: true }); c.advance(2500); c.shake();
  assert.equal(window.isVisible(), true, 'an open dialog stays visible');
  assert.equal(c.calls.filter(call => call.type === 'hide').length, 0);
  await c.invoke('setInteraction', { dragging: false, editing: false }); c.advance(2500); c.shake();
  assert.equal(window.isVisible(), false);
});

test('shortcut and tray clicks toggle the shelf, including a deliberate shortcut during editing', async () => {
  const c = await controller(); const window = c.windows[0]; const shortcut = [...c.shortcuts.values()][0];
  assert.equal(window.isVisible(), true);
  await c.invoke('setInteraction', { dragging: false, editing: true }); shortcut(); assert.equal(window.isVisible(), false);
  c.trays[0].emit('click'); assert.equal(window.isVisible(), true);
  c.trays[0].emit('click'); assert.equal(window.isVisible(), false);
  shortcut(); assert.equal(window.isVisible(), true);
});

test('configuration import accepts interaction release so the gesture can hide again while mutations stay blocked', async () => {
  const c = await controller({ argv: ['--background'] }); const window = c.windows[0];
  c.shake(); await c.invoke('setInteraction', { dragging: false, editing: true });
  c.service.configurationImport = true;
  await assert.rejects(c.invoke('refreshHosts'), /configuration import to finish/);
  const state = await c.invoke('getState'); assert.equal(state.items.length, 0);
  await assert.doesNotReject(c.invoke('setInteraction', { dragging: false, editing: false }));
  c.advance(2500); c.shake(); assert.equal(window.isVisible(), false, 'closing an editor during import cannot leave gesture hiding permanently blocked');
  await assert.rejects(c.invoke('refreshHosts'), /configuration import to finish/);
});

test('pending machine settings saves block native mutations and automatic scans while read and stop controls remain available', async () => {
  const c = await controller({ argv: ['--background'] }); let refreshed = 0, probed = 0;
  c.service.refreshHosts = async () => { refreshed++; return c.service.state; }; c.service.probeHosts = async () => { probed++; return c.service.state; };
  c.service.configurationSaving = true;
  for (const method of ['saveHost', 'startTunnel', 'previewMacInstall', 'installUpdate', 'captureClipboard']) await assert.rejects(c.invoke(method, {}), /settings to finish saving/);
  await c.invoke('getState'); await c.invoke('getTunnels'); await c.invoke('stopTunnel', 'fixture'); await c.invoke('setInteraction', { editing: false });
  const timer = c.timers.find(entry => entry.milliseconds === 90000); await timer.callback(); c.trays[0].menu.find(entry => entry.label === 'Refresh machines').click(); await flush();
  assert.equal(refreshed, 0); assert.equal(probed, 0);
  c.service.configurationSaving = false; let finishScan; c.service.refreshHosts = () => { refreshed++; return new Promise(resolve => { finishScan = resolve; }); };
  await timer.callback(); c.service.configurationSaving = true; finishScan(c.service.state); await flush(); assert.equal(refreshed, 1); assert.equal(probed, 0, 'a scan already running cannot start a new probe during the save');
});

test('silent background-test mode never shows, focuses, pins, registers shortcuts, creates a tray, or polls the cursor', async () => {
  const c = await controller({ env: { LEX_DRIFT_BACKGROUND_TEST: '1' } }); const window = c.windows[0];
  assert.equal(window.isVisible(), false); assert.equal(window.options.show, false); assert.equal(window.options.alwaysOnTop, false);
  c.app.emit('activate'); c.app.emit('second-instance', {}, [], '/virtual', { background: false }); c.workerOptions.onShow();
  assert.equal(c.trays.length, 0); assert.equal(c.shortcuts.size, 0);
  assert.equal(c.timers.some(timer => timer.milliseconds === 32), false);
  for (const type of ['show', 'showInactive', 'focus', 'shortcutRegister', 'cursorRead', 'errorDialog']) assert.equal(c.calls.some(call => call.type === type), false, type);
  assert.deepEqual(c.errors, []); assert.equal(c.workerOptions.background, true);
});

test('silent startup failures quit without displaying an error popup', async () => {
  const c = await controller({ env: { LEX_DRIFT_BACKGROUND_TEST: '1' }, workerError: 'Simulated worker error' });
  assert.equal(c.windows.length, 0); assert.equal(c.trays.length, 0);
  assert.ok(c.calls.some(call => call.type === 'quit')); assert.ok(c.errors.length > 0);
  assert.equal(c.calls.some(call => call.type === 'errorDialog'), false);
});

test('a shared-worker secondary quits before creating a service, window, tray, or timers', async () => {
  const c = await controller({ primary: false });
  assert.equal(c.windows.length, 0); assert.equal(c.trays.length, 0); assert.equal(c.timers.length, 0); assert.equal(c.shortcuts.size, 0);
  assert.equal(c.calls.some(call => call.type === 'serviceCreated'), false); assert.ok(c.calls.some(call => call.type === 'quit'));
});

test('background secondary-launch messages do not foreground an existing hidden shelf', async () => {
  const c = await controller({ argv: ['--background'] }); const window = c.windows[0];
  c.app.emit('second-instance', {}, [], '/virtual', { background: true });
  assert.equal(window.isVisible(), false); assert.equal(c.calls.some(call => call.type === 'focus'), false);
  c.app.emit('second-instance', {}, [], '/virtual', { background: false });
  assert.equal(window.isVisible(), true); assert.ok(c.calls.some(call => call.type === 'focus'));
});

test('Electron single-instance denial cannot create a second worker or user interface', async () => {
  const c = await controller({ singleton: false });
  assert.equal(c.windows.length, 0); assert.equal(c.trays.length, 0); assert.equal(c.timers.length, 0);
  assert.equal(c.calls.some(call => call.type === 'workerAcquire'), false); assert.ok(c.calls.some(call => call.type === 'quit'));
});

test('edition branding preserves the shared worker and existing data identity', async () => {
  let sharedRuntime;
  for (const productName of ['ShelfDock', 'lex-drift', 'LexBridge']) {
    const c = await controller({ productName, argv: ['--background'] });
    assert.equal(c.errors.length, 0);
    assert.equal(c.windows[0].options.title, productName);
    assert.equal(c.windows[0].options.webPreferences.additionalArguments[0], `--lex-drift-product-name=${productName}`);
    assert.equal(c.trays[0].menu[0].label, `Show ${productName}`);
    assert.ok(c.calls.some(call => call.type === 'setName' && call.values[0] === 'lex-drift'));
    if (sharedRuntime) assert.equal(c.workerOptions.runtimeDir, sharedRuntime);
    sharedRuntime = c.workerOptions.runtimeDir;
  }
});

test('connection setup blocks mutations but still allows hiding and releasing interaction', async () => {
  const c = await controller({ argv: ['--background'] });
  c.service.authenticationSetup = true;
  await assert.rejects(c.invoke('saveHost', {}), /connection setup to finish/);
  await assert.rejects(c.invoke('configureAccess', { hostId: 'example', mode: 'saved', password: 'fixture' }), /connection setup to finish/);
  await c.invoke('setInteraction', { dragging: false, editing: false });
  await c.invoke('hideWindow');
  assert.equal(c.windows[0].isVisible(), false);
  assert.equal(c.errors.length, 0);
});

test('hidden search focus permits clipboard monitoring but hidden password editing remains private', async () => {
  const c = await controller({argv:['--background']});
  await c.invoke('setInteraction',{editing:true});
  assert.equal(c.historyOptions.isBlocked(),false,'hidden non-sensitive fields must not pause history indefinitely');
  c.windows[0].show(); assert.equal(c.historyOptions.isBlocked(),true);
  c.windows[0].hide(); await c.invoke('setInteraction',{editing:true,sensitiveEditing:true});
  assert.equal(c.historyOptions.isBlocked(),true,'a hidden password form remains protected');
  await c.invoke('setInteraction',{editing:false,sensitiveEditing:false});
  assert.equal(c.historyOptions.isBlocked(),false);
  c.service.authenticationSetup=true; assert.equal(c.historyOptions.isBlocked(),true);
});

test('forwarding setup blocks connection mutations but permits status and Stop', async () => {
  const c=await controller({argv:['--background']}); c.service.tunnelSetup=1;
  await assert.rejects(c.invoke('saveHost',{}),/forwarding setup/); await c.invoke('getTunnels'); await c.invoke('stopTunnel','fixture');
  c.service.authenticationSetup=true; await c.invoke('stopTunnel','fixture'); c.service.configurationImport=true; await c.invoke('stopTunnel','fixture');
  assert.equal(c.calls.filter(call=>call.type==='tunnelStop').length,3);
});
test('quitting closes owned tunnels before releasing the worker lock', async()=>{
  const c=await controller(); let prevented=false; c.app.emit('before-quit',{preventDefault(){prevented=true;}}); await flush(); await flush();
  assert.equal(prevented,true); const types=c.calls.map(call=>call.type); assert.ok(types.indexOf('tunnelsShutdown')<types.indexOf('workerClose')); assert.ok(types.includes('quit'));
});

test('site IPC opens only a running local tunnel and rejects stale or forged sessions', async () => {
  const id = '04bd066c-be64-4d07-acf9-0e4a12e025b1';
  const tunnel = { id, mode: 'local', status: 'running', listenPort: 1331 };
  const c = await controller({ activeTunnels: [tunnel] });
  const request = { id, scheme: 'http:', path: '/dashboard?view=all#latest' };
  const result = await c.invoke('openTunnelSite', request);
  assert.equal(result.url, 'http://127.0.0.1:1331/dashboard?view=all#latest');
  assert.deepEqual(c.calls.filter(call => call.type === 'openExternal').map(call => call.values[0]), [result.url]);
  for (const update of [{ mode: 'remote' }, { status: 'failed' }, { status: 'starting' }]) {
    c.tunnels.state.active = [{ ...tunnel, ...update }];
    await assert.rejects(c.invoke('openTunnelSite', request), /not running/);
  }
  c.tunnels.state.active = [tunnel];
  await assert.rejects(c.invoke('openTunnelSite', { ...request, id: '5a75928b-ae27-4b64-ae93-008d98b3d705' }), /not running/);
  await assert.rejects(c.invoke('openTunnelSite', { ...request, path: '//example.com' }), /page path/);
  await c.invoke('stopTunnel', id);
  await assert.rejects(c.invoke('openTunnelSite', request), /not running/);
  assert.equal(c.calls.filter(call => call.type === 'openExternal').length, 1);
});

test('site IPC preserves sender, frame, and setup guards plus denied renderer navigation', async () => {
  const id = '04bd066c-be64-4d07-acf9-0e4a12e025b1';
  const c = await controller({ activeTunnels: [{ id, mode: 'local', status: 'running', listenPort: 1331 }] });
  const request = { id, scheme: 'https:', path: '/' };
  const handler = c.handlers.get('drift:openTunnelSite');
  const window = c.windows[0];
  const validFrame = { url: pathToFileURL(window.loadedFile).href };
  for (const event of [{ sender: {}, senderFrame: validFrame }, { sender: window.webContents, senderFrame: { url: 'https://example.com/' } }, { sender: window.webContents }]) {
    await assert.rejects(handler(event, request), /did not come from/);
  }
  for (const property of ['authenticationSetup', 'configurationImport', 'configurationSaving', 'tunnelSetup']) {
    c.service[property] = true;
    await assert.rejects(c.invoke('openTunnelSite', request), /Wait for/);
    c.service[property] = false;
  }
  assert.equal(c.calls.filter(call => call.type === 'openExternal').length, 0);
  assert.equal(window.windowOpenHandler({ url: 'https://example.com/' }).action, 'deny');
  let navigationPrevented = false;
  window.webContents.emit('will-navigate', { preventDefault() { navigationPrevented = true; } }, 'http://127.0.0.1:1331/');
  assert.equal(navigationPrevented, true);
});

test('a browser launch failure remains an actionable IPC rejection', async () => {
  const id = '04bd066c-be64-4d07-acf9-0e4a12e025b1';
  const c = await controller({ activeTunnels: [{ id, mode: 'local', status: 'running', listenPort: 1331 }], openExternalError: 'No browser is available.' });
  await assert.rejects(c.invoke('openTunnelSite', { id, scheme: 'http:', path: '/' }), /No browser is available/);
});

test('site IPC refuses the old session after its machine endpoint changes or disappears', async () => {
  const id = '04bd066c-be64-4d07-acf9-0e4a12e025b1';
  const c = await controller({ activeTunnels: [{ id, mode: 'local', status: 'running', listenPort: 1331 }] });
  const request = { id, scheme: 'http:', path: '/' };
  for (const change of [{ address: 'replacement.invalid' }, { user: 'another-user' }, { port: 2222 }, { sshAlias: 'another-alias' }]) {
    c.service.state.hosts = [{ ...siteHost, ...change }];
    await assert.rejects(c.invoke('openTunnelSite', request), /connection details changed/);
  }
  c.service.state.hosts = [];
  await assert.rejects(c.invoke('openTunnelSite', request), /was removed/);
  assert.equal(c.calls.filter(call => call.type === 'openExternal').length, 0);
  c.service.state.hosts = [{ ...siteHost, name: 'A new display name', destination: '~/Downloads' }];
  await assert.doesNotReject(c.invoke('openTunnelSite', request));
  assert.equal(c.calls.filter(call => call.type === 'openExternal').length, 1);
});

test('native Clipboard feature gate rejects history operations while explicit shelf paste stays independent', async () => {
  const c = await controller();
  assert.equal((await c.invoke('getState')).clipboardTools.enabled, false);
  for (const [method, value] of [['captureClipboardHistory'], ['getClipboardEntry', 'fixture'], ['copyClipboardEntry', { id: 'fixture' }], ['setClipboardPinned', { id: 'fixture', pinned: true }], ['removeClipboardEntry', 'fixture'], ['clearClipboardHistory'], ['saveClipboardSnippet', { text: 'fixture' }], ['addClipboardEntryToShelf', 'fixture'], ['updateClipboardPreferences', { enabled: true }]]) await assert.rejects(c.invoke(method, value), /Enable Clipboard tools/);
  await assert.rejects(c.invoke('captureClipboard'), /No clipboard access is permitted/, 'Shelf paste reaches its own explicit capture path, not the optional history gate');
  const enabled = await c.invoke('updateClipboardTools', { enabled: true }); assert.equal(enabled.clipboardTools.enabled, true);
  await c.invoke('captureClipboardHistory'); assert.equal(c.calls.filter(call => call.type === 'historyCapture').length, 1);
  await c.invoke('updateClipboardTools', { showTab: false }); await c.invoke('copyClipboardEntry', { id: 'fixture' });
  assert.equal(c.calls.filter(call => call.type === 'historyCopy').length, 1, 'Hide is presentation-only');
  await c.invoke('updateClipboardTools', { enabled: false }); await assert.rejects(c.invoke('captureClipboardHistory'), /Enable Clipboard tools/);
});


test('Mac installer IPC rejects foreign callers and keeps mutations blocked while allowing hide and status', async () => {
  const c = await controller({ argv: ['--background'] });
  assert.deepEqual(c.errors, []);
  const handler = c.handlers.get('drift:installOnMac');
  await assert.rejects(handler({ sender: {}, senderFrame: { url: 'https://example.test' } }, { planId: 'forged' }), /did not come from/);
  assert.equal(c.calls.some(call => call.type === 'macInstall'), false);
  c.service.macInstallation = true;
  for (const method of ['saveHost', 'refreshHosts', 'configureAccess', 'updateClipboardTools', 'previewMacInstall', 'installOnMac']) await assert.rejects(c.invoke(method, {}), /Mac installation to finish/);
  await c.invoke('getMacInstallState'); await c.invoke('setInteraction', { editing: false }); await c.invoke('hideWindow');
  assert.equal(c.windows[0].isVisible(), false);
  c.service.macInstallation = false;
  await c.invoke('previewMacInstall', { hostId: 'fictional' });
  assert.equal(c.calls.filter(call => call.type === 'macPreview').length, 1);
});

test('Mac installation drains before releasing the singleton worker on quit', async () => {
  let finish; const installerShutdown = new Promise(resolve => { finish = resolve; });
  const c = await controller({ installerShutdown }); let prevented = false;
  c.app.emit('before-quit', { preventDefault() { prevented = true; } });
  await flush(); assert.equal(prevented, true);
  assert.equal(c.calls.some(call => call.type === 'macInstallerShutdown'), true);
  assert.equal(c.calls.some(call => call.type === 'workerClose'), false);
  finish(); await flush(); await flush();
  const order = c.calls.map(call => call.type);
  assert.ok(order.indexOf('macInstallerShutdown') < order.indexOf('tunnelsShutdown'));
  assert.ok(order.indexOf('tunnelsShutdown') < order.indexOf('workerClose'));
});

test('Received is independent of Clipboard and native IPC rejects foreign receipt or update requests', async () => {
  const c = await controller({ clipboardToolsEnabled: false });
  assert.deepEqual(c.errors, []);
  assert.equal((await c.invoke('getReceived')).unreadCount, 0);
  await c.invoke('markReceivedRead', { id: 'fixture' });
  await c.invoke('addReceivedToShelf', { id: 'fixture', names: ['Notes.txt'] });
  assert.equal(c.calls.filter(call => call.type === 'receivedShelf').length, 1);
  for (const method of ['openReceivedFolder', 'addReceivedToShelf', 'installUpdate', 'downloadUpdate']) {
    await assert.rejects(c.handlers.get('drift:' + method)({ sender: {}, senderFrame: { url: 'https://example.test' } }, { id: 'fixture' }), /did not come from/);
  }
});

test('update installation waits for active operations and locks native mutations before restart', async () => {
  const c = await controller({ argv: ['--background'] });
  for (const flag of ['transferring', 'scanPromise', 'probePromise', 'authenticationSetup', 'configurationImport', 'configurationSaving', 'tunnelSetup', 'macInstallation']) {
    c.service[flag] = true;
    await assert.rejects(c.invoke('installUpdate'), /finish|Finish/);
    c.service[flag] = false;
  }
  await c.invoke('setInteraction', { dragging: true });
  await assert.rejects(c.invoke('installUpdate'), /Finish active work/);
  await c.invoke('setInteraction', { dragging: false });
  await c.invoke('installUpdate');
  assert.equal(c.service.appUpdating, true);
  assert.equal(c.historyOptions.isBlocked(), true, 'Automatic clipboard recording is suspended throughout installation');
  for (const method of ['send', 'sendMany', 'configureAccess', 'addReceivedToShelf', 'startTunnel', 'installOnMac']) await assert.rejects(c.invoke(method, {}), /app update to finish/);
  await c.invoke('getUpdates'); await c.invoke('hideWindow');
  const connected = await controller({ activeTunnels: [{ id: 'active', status: 'running' }] });
  await assert.rejects(connected.invoke('installUpdate'), /Finish active work/);
});

test('silent tests do not start Desktop scanning or update network checks', async () => {
  const c = await controller({ env: { LEX_DRIFT_BACKGROUND_TEST: '1' } });
  assert.equal(c.calls.find(call => call.type === 'receivedCreated').values[0], false);
  assert.equal(c.calls.find(call => call.type === 'updatesCreated').values[0], false);
  assert.equal(c.calls.some(call => ['receivedStart', 'updatesStart'].includes(call.type)), false);
});

test('site IPC waits for website readiness and Stop or endpoint changes prevent a late browser launch', async () => {
  const id = '04bd066c-be64-4d07-acf9-0e4a12e025b1'; const tunnel = { id, mode: 'local', status: 'running', listenPort: 8001 };
  const request = { id, scheme: 'http:', path: '/app?transient=1#detail' };
  const failed = await controller({ activeTunnels: [tunnel], siteProbeError: 'Start the service on the selected machine.' });
  await assert.rejects(failed.invoke('openTunnelSite', request), /Start the service/); assert.equal(failed.calls.filter(call => call.type === 'openExternal').length, 0);
  for (const change of ['stop', 'endpoint']) {
    let release; const wait = new Promise(resolve => { release = resolve; }); const c = await controller({ activeTunnels: [tunnel], siteProbe: () => wait });
    const opening = c.invoke('openTunnelSite', request); await flush();
    assert.equal(c.calls.filter(call => call.type === 'verifyTunnelSite').length, 1); assert.equal(c.calls.filter(call => call.type === 'openExternal').length, 0);
    if (change === 'stop') await c.invoke('stopTunnel', id); else c.service.state.hosts[0].address = 'changed.invalid';
    release(); await assert.rejects(opening, /not running|connection details changed/); assert.equal(c.calls.filter(call => call.type === 'openExternal').length, 0);
  }
});

test('Copy explicitly writes only the backend-derived live loopback URL and never opens a browser', async () => {
  const id = '04bd066c-be64-4d07-acf9-0e4a12e025b1'; const c = await controller({ activeTunnels: [{ id, mode: 'local', status: 'running', listenPort: 8002 }] });
  const request = { id, scheme: 'http:', path: '/app?temporary=1#detail' };
  const result = await c.invoke('copyTunnelSite', request);
  assert.equal(result.url, 'http://127.0.0.1:8002/app?temporary=1#detail');
  assert.deepEqual(c.calls.filter(call => call.type === 'clipboardWrite').map(call => call.values[0]), [result.url]);
  assert.equal(c.calls.filter(call => call.type === 'openExternal' || call.type === 'verifyTunnelSite').length, 0);
  await assert.rejects(c.invoke('copyTunnelSite', { ...request, path: '//external.invalid/' }), /page path/);
  await c.invoke('stopTunnel', id); await assert.rejects(c.invoke('copyTunnelSite', request), /not running/);
});

test('packaged public edition does not read or apply a personal preset', async () => {
  const c = await controller({ packaged: true, productName: 'ShelfDock', argv: ['--background'] });
  assert.equal(c.errors.length, 0, 'public startup never touches guarded preset filesystem');
  assert.equal(c.windows.length, 1);
});


test('startup confirmation follows loaded renderer and packaged editions keep installer feeds separate', async () => {
  const clean = await controller({ packaged: true, productName: 'ShelfDock' });
  assert.equal(clean.installer.args.edition, 'clean');
  assert.deepEqual(Array.from(clean.desktop.args.allowedOrigins), ['null']);
  assert.equal(clean.calls.some(call => call.type === 'startupConfirmed'), false, 'Native window load alone is not renderer health');
  await clean.invoke('confirmRendererReady');
  assert.ok(clean.calls.findIndex(call => call.type === 'startupConfirmed') > clean.calls.findIndex(call => call.type === 'windowLoaded'));
  const privateApp = await controller({ productName: 'LexBridge' });
  assert.equal(privateApp.installer.args.edition, 'personal');
  const silent = await controller({ env: { LEX_DRIFT_BACKGROUND_TEST: '1' } });
  assert.equal(silent.calls.some(call => call.type === 'startupConfirmed'), false);
});

test('remote setup preserves status and stop paths but blocks configuration, transfers and updates', async () => {
  const c = await controller();
  for (const flag of ['remoteInstallation', 'remoteDesktopSetup']) {
    c.service[flag] = true;
    for (const method of ['saveHost', 'send', 'installUpdate', 'captureClipboard', 'refreshHosts']) await assert.rejects(c.invoke(method, {}), /remote.*finish/);
    await c.invoke('getState'); await c.invoke('getRemoteInstallState'); await c.invoke('getRemoteDesktopState');
    await c.invoke('cancelRemoteInstall', {}); await c.invoke('stopRemoteDesktop', {}); await c.invoke('setInteraction', { editing: false });
    c.service[flag] = false;
  }
  c.desktop.session = { id: 'desktop-live', status: 'connected' };
  await assert.rejects(c.invoke('installUpdate'), /Finish active work/);
  await c.invoke('stopRemoteDesktop', { id: 'desktop-live' });
  await c.invoke('installUpdate');
});

test('desktop inspection holds the configuration guard until it settles and native requests reject foreign windows', async () => {
  let resolveInspection;
  const c = await controller({ desktopInspection: new Promise(resolve => { resolveInspection = resolve; }) });
  const work = c.invoke('inspectRemoteDesktop', { hostId: 'fixture' });
  await flush();
  assert.equal(c.service.remoteDesktopSetup, true);
  await assert.rejects(c.invoke('saveHost', {}), /remote desktop setup/);
  resolveInspection(); await work;
  assert.equal(c.service.remoteDesktopSetup, false);
  for (const method of ['inspectRemoteDesktop', 'previewRemoteInstall', 'installRemotely', 'cancelRemoteInstall', 'confirmRendererReady']) await assert.rejects(c.handlers.get('drift:' + method)({ sender: {}, senderFrame: { url: 'file:///elsewhere' } }, {}), /did not come from/);
});

test('own-device clipboard connection uses the saved SSH route without a pairing code and validates direction', async () => {
  const host = {...siteHost, sshAlias:'fixture-alias', identityFile:'/virtual/owned-key'};
  const c = await controller({hosts:[host],clipboardToolsEnabled:true});
  assert.equal(c.handlers.has('drift:beginClipboardPairing'),false);
  assert.equal(c.handlers.has('drift:pairClipboardSync'),false);
  await c.invoke('pairOwnedClipboardSync',{hostId:host.id,direction:'receive'});
  const request=c.calls.find(call=>call.type==='ownerClipboardConnected').values[0];
  assert.equal(request.hostLabel,host.name);assert.equal(request.direction,'receive');
  assert.equal(request.sshTarget.alias,'fixture-alias');assert.equal(request.sshTarget.identityFile,'/virtual/owned-key');
  assert.equal('code' in request,false);assert.equal(c.service.clipboardLinking,false);
  await assert.rejects(c.invoke('pairOwnedClipboardSync',{hostId:host.id,direction:'bad'}),/Choose send, receive, or both/);
  await assert.rejects(c.invoke('pairOwnedClipboardSync',{hostId:'absent'}),/Choose a saved machine/);
  const off = await controller({hosts:[host]});
  await assert.rejects(off.invoke('pairOwnedClipboardSync',{hostId:host.id}),/Enable Clipboard tools/);
  assert.equal(off.calls.some(call=>call.type==='ownerClipboardConnected'),false);
});

test('a pending own-device link blocks conflicting edits and update restart while allowing pause and disable', async () => {
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const c=await controller({hosts:[siteHost],clipboardToolsEnabled:true,clipboardLink:pending});
  const link=c.invoke('pairOwnedClipboardSync',{hostId:siteHost.id});await flush();
  assert.equal(c.service.clipboardLinking,true);
  await assert.rejects(c.invoke('pairOwnedClipboardSync',{hostId:siteHost.id}),/device connection to finish/);
  await assert.rejects(c.invoke('saveHost',siteHost),/device connection to finish/);
  await assert.rejects(c.invoke('installUpdate'),/device connection to finish/);
  await c.invoke('updateClipboardSync',{paused:true});await c.invoke('updateClipboardTools',{enabled:false});
  finish();await link;assert.equal(c.service.clipboardLinking,false);
  assert.ok(c.calls.some(call=>call.type==='ownerBootstrapRefreshed'));
});

test('native Mac appearance is published with solid accessibility fallback and skipped on other platforms', async () => {
  const mac=await controller({argv:['--background']});
  const state=await mac.invoke('getState');assert.equal(state.environment.nativeGlass.mode,'native');
  assert.equal(mac.windows[0].options.transparent,true);assert.equal(mac.windows[0].isVisible(),false);
  assert.ok(mac.calls.some(call=>call.type==='nativeGlassApplied'));
  const solid=await controller({glassStatus:{mode:'solid',applied:false,supported:true,reducedTransparency:true}});
  assert.equal((await solid.invoke('getState')).environment.nativeGlass.mode,'solid');
  const linux=await controller({platform:'linux'});assert.equal(linux.calls.some(call=>call.type==='nativeGlassApplied'),false);
  mac.app.emit('before-quit',{preventDefault(){}});assert.ok(mac.calls.some(call=>call.type==='appearanceWatchStopped'));
});

test('own-device connection acquires its lock before asynchronous host lookup', async () => {
 const c=await controller({hosts:[siteHost],clipboardToolsEnabled:true});
 const original=c.service.getState.bind(c.service);let lookup;
 c.service.getState=()=>new Promise(resolve=>{lookup=resolve;});
 const first=c.invoke('pairOwnedClipboardSync',{hostId:siteHost.id});
 assert.equal(c.service.clipboardLinking,true);
 await assert.rejects(c.invoke('pairOwnedClipboardSync',{hostId:siteHost.id}),/device connection to finish/);
 await assert.rejects(c.invoke('removeHost',siteHost.id),/device connection to finish/);
 c.service.getState=original;lookup(c.service.state);await first;
 assert.equal(c.calls.filter(call=>call.type==='ownerClipboardConnected').length,1);
 assert.equal(c.service.clipboardLinking,false);
});
