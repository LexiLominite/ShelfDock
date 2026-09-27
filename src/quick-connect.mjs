const preferenceKey = 'dropharbor.site-preferences.v1';
const controllers = new WeakMap();
const transientSites = new Map();

const liveStatuses = new Set(['starting', 'running', 'active', 'stopping']);
const runningStatuses = new Set(['running', 'active']);
const controller = (bridge) => {
  if (!controllers.has(bridge)) controllers.set(bridge, { version: 0, pending: false, stops: new Map() });
  return controllers.get(bridge);
};

export function portNumber(value, label = 'Port') {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${label} must be between 1 and 65535.`);
  return Number(value);
}

export function parseQuickUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Enter the website address on the selected machine.');
  if (input.length > 4096) throw new Error('Use a website address no longer than 4096 characters.');
  if (/[\u0000-\u001f\u007f\\]|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(input)) throw new Error('Use a website address without control characters or backslashes.');
  const value = input.trim();
  if (/\s/.test(value)) throw new Error('Remove spaces from the website address.');
  let candidate = value;
  if (!/^https?:\/\//i.test(value)) {
    if (value.includes('://') || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^/?#:]+:\d+(?:[/?#]|$)/.test(value))) throw new Error('Use an http:// or https:// website address.');
    candidate = `http://${value}`;
  }
  let url;
  try { url = new URL(candidate); } catch { throw new Error('Enter a valid hostname or IP address and a port from 1 to 65535.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS websites can be opened here.');
  if (url.username || url.password || candidate.slice(candidate.indexOf('//') + 2).split(/[/?#]/, 1)[0].includes('@')) throw new Error('Remove the username or password from the website address.');
  const authority = candidate.slice(candidate.indexOf('//') + 2).split(/[/?#]/, 1)[0];
  if (authority.endsWith(':')) throw new Error('Enter a port after the colon, or remove it.');
  const targetHost = url.hostname.replace(/^\[|\]$/g, '');
  if (!targetHost || targetHost.length > 253 || (!targetHost.includes(':') && (!/^[a-z0-9][a-z0-9.-]*$/i.test(targetHost) || targetHost.includes('..') || targetHost.split('.').some(label => label.length > 63 || label.startsWith('-') || label.endsWith('-'))))) throw new Error('Enter a valid hostname or IP address.');
  const targetPort = portNumber(url.port || (url.protocol === 'https:' ? 443 : 80), 'Destination port');
  const path = `${url.pathname || '/'}${url.search}${url.hash}`;
  if (path.startsWith('//')) throw new Error('The website path must begin with a single slash.');
  return { scheme: url.protocol, targetHost, targetPort, path, pathname: url.pathname || '/', url: url.href };
}

export function latestSavedPlan(snapshot, hostId, mode = 'local') {
  return (snapshot?.history || []).filter(plan => plan.hostId === hostId && plan.mode === mode).reduce((latest, plan) => !latest || (Date.parse(plan.lastUsedAt) || 0) > (Date.parse(latest.lastUsedAt) || 0) ? plan : latest, null);
}

export function sameForward(left, right) {
  return !!left && !!right && ['hostId', 'mode', 'targetHost', 'targetPort', 'listenPort'].every(key => String(left[key]) === String(right[key]));
}

export function activeForPlan(snapshot, plan) {
  return (snapshot?.active || []).find(entry => sameForward(entry, plan) && liveStatuses.has(entry.status)) || null;
}

export function quickPlanForUrl({ hostId, mode = 'local', site, targetPort, listenPort, savedPlan, remember = true, note = '' }) {
  if (!hostId) throw new Error('Choose a machine before connecting.');
  if (!['local', 'remote'].includes(mode)) throw new Error('Choose Local or Remote forwarding.');
  const destinationPort = portNumber(targetPort ?? site.targetPort, 'Destination port');
  return { hostId, mode, targetHost: site.targetHost, targetPort: destinationPort, listenPort: portNumber(listenPort || savedPlan?.listenPort || destinationPort, 'Listening port'), remember, note };
}

function planKey(plan) {
  return JSON.stringify([plan.id || plan.historyId || '', plan.hostId, plan.mode, plan.targetHost, Number(plan.targetPort), Number(plan.listenPort)]);
}

function readPreferences(storage) {
  try { const value = JSON.parse(storage?.getItem(preferenceKey) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

function safeSite(site) {
  if (!site || !['http:', 'https:'].includes(site.scheme)) return null;
  const path = site.path || site.pathname || '/';
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\u0000-\u001f\u007f\\]|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)) return null;
  const pathname = new URL(path, 'https://localhost').pathname;
  return { scheme: site.scheme, path, pathname, known: true };
}

export function sitePreferences(plan, storage = globalThis.localStorage) {
  if (!plan) return { scheme: 'http:', path: '/', pathname: '/', known: false };
  const key = planKey(plan);
  const stored = readPreferences(storage)[key];
  // Query strings and fragments only survive in this renderer session.
  return safeSite(transientSites.get(key)) || safeSite(stored && { scheme: stored.scheme, path: stored.pathname }) || { scheme: 'http:', path: '/', pathname: '/', known: false };
}

export function rememberSitePreferences(plan, site, storage = globalThis.localStorage) {
  const safe = safeSite(site);
  if (!plan || !safe) return;
  const key = planKey(plan);
  transientSites.set(key, safe);
  const previous = readPreferences(storage);
  previous[key] = { scheme: safe.scheme, pathname: safe.pathname };
  const trimmed = Object.fromEntries(Object.entries(previous).slice(-100));
  try { storage?.setItem(preferenceKey, JSON.stringify(trimmed)); } catch { /* Storage can be disabled; the current session still remembers the URL. */ }
}

export function urlForPlan(plan, site = sitePreferences(plan)) {
  if (!plan) return '';
  const host = plan.targetHost.includes(':') ? `[${plan.targetHost}]` : plan.targetHost;
  return `${site.scheme}//${host}:${plan.targetPort}${site.path || '/'}`;
}

export function localSiteUrl(entry, site) {
  if (!entry || entry.mode !== 'local') return '';
  return `${site.scheme}//127.0.0.1:${entry.listenPort}${site.path || '/'}`;
}

export async function openForwardSite({ bridge, entry, site }) {
  if (entry?.mode !== 'local' || !runningStatuses.has(entry.status) || !site?.known || typeof bridge?.openTunnelSite !== 'function') return {};
  try { return await bridge.openTunnelSite({ id: entry.id, scheme: site.scheme, path: site.path || '/' }); }
  catch (error) { return { error: `Forward is live. ${error.message || 'The website could not be opened.'}`, errorKind: 'open' }; }
}

async function runForward({ bridge, method, value, plan, site, snapshot, onSnapshot, onBusyChange, open, isCancelled }) {
  if (!bridge || typeof bridge[method] !== 'function') return { error: 'Preview only. Open the desktop app to connect to a machine.' };
  const state = controller(bridge);
  const current = activeForPlan(snapshot, plan);
  if (current) {
    const saved = (snapshot.history || []).find(item => item.id === current.historyId) || (snapshot.history || []).find(item => sameForward(item, plan));
    if (saved && site?.known) rememberSitePreferences(saved, site);
    return { snapshot, entry: current, site, needsUrl: !site?.known, ...await (open && !isCancelled?.() ? openForwardSite({ bridge, entry: current, site }) : {}) };
  }
  if (state.pending) return { pending: true };
  const version = ++state.version;
  state.pending = true;
  onBusyChange?.(true);
  try {
    const next = await bridge[method](value);
    if (version !== state.version) return { superseded: true };
    if (next?.active && next?.history) onSnapshot?.(next);
    const entry = (next?.active || []).filter(item => sameForward(item, plan)).at(-1);
    if (!entry) return { snapshot: next, error: 'The forwarding session did not start. Check its status and try again.' };
    if (entry.status === 'failed' || entry.error) return { snapshot: next, entry, site, error: entry.error || 'SSH forwarding failed. Check the connection settings and try again.' };
    const saved = (next.history || []).find(item => item.id === entry.historyId) || (next.history || []).find(item => sameForward(item, plan));
    if (saved && site?.known) rememberSitePreferences(saved, site);
    return { snapshot: next, entry, site, needsUrl: !site?.known, ...await (open && !isCancelled?.() ? openForwardSite({ bridge, entry, site }) : {}) };
  } catch (error) { return version === state.version ? { error: error.message || 'Could not start forwarding. Check SSH access and try again.' } : { superseded: true }; }
  finally { state.pending = false; onBusyChange?.(false); }
}

export function repeatSavedForward({ bridge, plan, snapshot, onSnapshot, onBusyChange, open = true }) {
  if (!plan?.id) return Promise.resolve({ needsUrl: true });
  return runForward({ bridge, method: 'restartTunnel', value: plan.id, plan, site: sitePreferences(plan), snapshot, onSnapshot, onBusyChange, open });
}

export function startQuickForward({ bridge, plan, site, snapshot, onSnapshot, onBusyChange, open = true, isCancelled }) {
  const saved = (snapshot?.history || []).find(item => sameForward(item, plan));
  return runForward({ bridge, method: saved ? 'restartTunnel' : 'startTunnel', value: saved ? saved.id : plan, plan, site: { ...site, known: true }, snapshot, onSnapshot, onBusyChange, open, isCancelled });
}

export function stopForward({ bridge, id, onSnapshot }) {
  if (typeof bridge?.stopTunnel !== 'function') return Promise.resolve({ error: 'Open the desktop app to stop this forwarding session.' });
  const state = controller(bridge);
  if (state.stops.has(id)) return state.stops.get(id);
  const version = ++state.version;
  const operation = (async () => {
    try { const snapshot = await bridge.stopTunnel(id); if (version === state.version && snapshot?.active && snapshot?.history) onSnapshot?.(snapshot); return { snapshot }; }
    catch (error) { return { error: error.message || 'The forwarding session could not be stopped.' }; }
    finally { state.stops.delete(id); }
  })();
  state.stops.set(id, operation);
  return operation;
}

export async function mutateForwardHistory({ bridge, method, value, onSnapshot, onBusyChange }) {
  if (!['updateTunnelNote', 'removeTunnelHistory'].includes(method) || typeof bridge?.[method] !== 'function') return { error: 'Open the desktop app to edit saved forwards.' };
  const state = controller(bridge);
  if (state.pending) return { pending: true };
  const version = ++state.version;
  state.pending = true; onBusyChange?.(true);
  try { const snapshot = await bridge[method](value); if (version !== state.version) return { superseded: true }; if (snapshot?.active && snapshot?.history) onSnapshot?.(snapshot); return { snapshot }; }
  catch (error) { return { error: error.message || 'The saved forward could not be updated.' }; }
  finally { state.pending = false; onBusyChange?.(false); }
}
