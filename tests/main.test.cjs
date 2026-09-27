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
    async loadFile(file) { this.loadedFile = file; }
  }
  class FakeTray extends EventEmitter {
    constructor() { super(); trays.push(this); }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip() {}
  }
  const app = new EventEmitter();
  const paths = { appData: '/virtual/app-data', userData: '/virtual/user-data' };
  Object.assign(app, {
    isPackaged: false,
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
    clipboard: { read: () => { throw new Error('No clipboard access is permitted in controller tests.'); } },
  };
  const initialState = { hosts: options.activeTunnels?.length ? [{ ...siteHost }] : [], items: [], history: [], settings: { shakeEnabled: true, sensitivity: 'normal', viewMode: 'expanded' }, discovery: { warnings: [] }, environment: { sshAvailable: true } };
  let fakeService;
  class FakeService {
    constructor() { record('serviceCreated'); this.state = initialState; fakeService = this; }
    async getState() { return this.state; }
    async refreshHosts() { return this.state; }
    async probeHosts() { return this.state; }
  }
  let workerOptions, historyOptions, fakeTunnels;
  const modules = {
    '../package.json': { productName: options.productName || 'DropHarbor' },
    electron,
    'node:path': path,
    'node:url': { pathToFileURL },
    'node:fs/promises': new Proxy({}, { get: () => () => { throw new Error('No filesystem operations are permitted in controller tests.'); } }),
    './service.cjs': { DriftService: FakeService },
    './shake.cjs': shakeModule.exports,
    './clipboard.cjs': { captureClipboard: () => { throw new Error('No clipboard access is permitted in controller tests.'); } },
    './config.cjs': { createConfig: () => ({}), importConfiguration: async () => initialState },
    './migrate.cjs': { migrateLegacyData: async () => undefined },
    './tunnels.cjs': { TunnelManager: class { constructor() { fakeTunnels = this; this.state = { active: options.activeTunnels || [], history: [] }; this.initialized = Promise.resolve(); } get active() { return new Map(this.state.active.map(view => [view.id, { view: { ...view, hostId: siteHost.id }, endpoint: endpointKey(siteHost) }])); } snapshot() { return this.state; } async getState() { return this.state; } async stop(id) { record('tunnelStop', id); this.state.active = this.state.active.filter(tunnel => tunnel.id !== id); } async shutdown() { record('tunnelsShutdown'); } } },
    './tunnel-site.cjs': require('../desktop/tunnel-site.cjs'),
    './clipboard-history.cjs': { ClipboardHistory: class { constructor(options) { historyOptions = options; this.initialized = Promise.resolve(); } async tick() {} } },
    './worker.cjs': { acquireWorker: async args => {
      workerOptions = args; record('workerAcquire', args.background);
      if (options.workerError) throw new Error(options.workerError);
      return { primary: options.primary !== false, close: async () => record('workerClose') };
    } },
  };
  const context = {
    require(name) { if (!(name in modules)) throw new Error('Unmocked dependency: ' + name); return modules[name]; },
    __dirname: desktop,
    process: { getuid: () => 1000, platform: options.platform || 'darwin', argv: ['electron', '/virtual/main.cjs', ...(options.argv || [])], env: { LEX_DRIFT_DATA_DIR: '/virtual/user-data', ...(options.env || {}) }, resourcesPath: '/virtual/resources' },
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
  return { app, calls, windows, trays, timers, shortcuts, handlers, errors, invoke, shake, workerOptions, historyOptions, service: fakeService, tunnels: fakeTunnels, advance: milliseconds => { clock += milliseconds; } };
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
  for (const productName of ['DropHarbor', 'lex-drift']) {
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
  for (const property of ['authenticationSetup', 'configurationImport', 'tunnelSetup']) {
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
