import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleAlert, Clipboard, Download, File, FileText, Folder, History, KeyRound, Laptop, Loader2, Monitor, MoreHorizontal, MousePointer2, Network, Pencil, Plus, RefreshCw, Search, Send, Server, Settings2, Trash2, Undo2, Upload, Wifi, X } from 'lucide-react';
import ClipboardPanel from './ClipboardPanel';
import { tabbableElements } from './focus.mjs';
import TunnelPanel from './TunnelPanel';
import MachineCard from './MachineCard';
import MacInstallPanel from './MacInstallPanel';
import ReceivedPanel from './ReceivedPanel';
import UpdatesPanel from './UpdatesPanel';
import OnboardingPanel, { onboardingSettled, writeOnboardingRecord } from './OnboardingPanel';

const ITEM_MIME = 'application/x-drift-items';
const emptyState = { clipboardTools: { enabled: false, showTab: true, historyEnabled: false }, hosts: [], items: [], history: [], settings: { shakeEnabled: true, sensitivity: 'strong', viewMode: 'expanded' }, discovery: { warnings: [], lastScan: null }, environment: {} };
const demoState = {
  ...emptyState,
  hosts: [
    { id: 'demo-studio', name: 'Studio', address: '100.64.1.20', user: 'studio', port: 22, destination: '~/Desktop', route: 'tailscale', source: 'Wave', status: 'ready', os: 'posix' },
    { id: 'demo-laptop', name: 'Work laptop', address: 'work-laptop.local', user: 'alex', port: 22, destination: '~/Desktop', route: 'lan', source: 'SSH', status: 'ready', os: 'posix' },
    { id: 'demo-desktop', name: 'Home desktop', address: '100.64.1.21', user: 'alex', port: 22, destination: '~/Desktop', route: 'tailscale', source: 'Wave', status: 'auth-required', os: 'posix', error: 'SSH authentication needs a key.' },
  ],
  environment: { platform: 'Preview', sshAvailable: true, tailscaleAvailable: true },
};
const freshHost = () => ({ name: '', address: '', user: '', port: 22, identityFile: '', sshAlias: '', destination: '~/Desktop', route: 'ssh', os: 'posix', source: 'Manual', status: 'unknown' });
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const formatSize = (size) => size ? size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB` : '';
const routeLabel = (route) => route === 'tailscale' ? 'Tailscale' : route === 'lan' ? 'LAN' : 'SSH';
const statusLabel = (status) => ({ ready: 'Ready', 'auth-required': 'Needs access', offline: 'Offline', checking: 'Checking', unknown: 'Unchecked' })[status] || 'Unchecked';
const hostIcon = (host) => /spark|server/i.test(host.name) ? Server : /book|laptop/i.test(host.name) ? Laptop : Monitor;
const orderHosts = (hosts) => { const rank = { ready: 0, checking: 1, unknown: 2, 'auth-required': 3, offline: 4 }; return [...hosts].sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2)); };
const syncDirections = [['send', 'Send only'], ['receive', 'Receive only'], ['both', 'Both directions']];
const hostOptionLabel = (host) => (typeof host?.name === 'string' && host.name.trim()) || (typeof host?.label === 'string' && host.label.trim()) || 'Computer';
const peerOptionLabel = (peer) => (typeof peer?.label === 'string' && peer.label.trim()) || (typeof peer?.name === 'string' && peer.name.trim()) || 'Paired computer';
const peerDirection = (value) => (value === 'send' || value === 'receive' || value === 'both' ? value : 'both');
// Older snapshots omit clipboardSync. Treat that as sync off and no peers.
const clipboardSyncState = (state) => (state?.clipboardSync && typeof state.clipboardSync === 'object' ? state.clipboardSync : {});
const pairingDetails = (pairing) => {
  if (!pairing) return null;
  if (typeof pairing === 'string') { const code = pairing.trim(); return code ? { code, expiresAt: null } : null; }
  if (typeof pairing !== 'object') return null;
  const code = typeof pairing.code === 'string' ? pairing.code.trim() : '';
  const expiresAt = pairing.expiresAt ?? null;
  if (!code && (expiresAt == null || expiresAt === '')) return null;
  return { code, expiresAt };
};
const expiryLabel = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function ClipboardSyncSettings({ state, busy, action }) {
  const toolsOn = state.clipboardTools?.enabled === true;
  const sync = clipboardSyncState(state);
  const enabled = sync.enabled === true;
  const paused = sync.paused === true;
  const requestedReceive = sync.receiveMode ?? sync.receive;
  const receiveMode = requestedReceive === 'clipboard' ? 'clipboard' : 'history';
  const hosts = Array.isArray(state?.hosts) ? state.hosts.filter((host) => host && host.id != null && host.id !== '') : [];
  const peers = Array.isArray(sync.peers) ? sync.peers.filter((peer) => peer && peer.id != null && peer.id !== '') : [];
  const pairing = pairingDetails(sync.pairing);
  const error = typeof sync.error === 'string' ? sync.error.trim() : '';
  const locked = !toolsOn || !!busy;
  const [hostId, setHostId] = useState('');
  const [code, setCode] = useState('');
  const [direction, setDirection] = useState('both');
  const selectedHostId = hosts.some((host) => host.id === hostId) ? hostId : '';
  const expiryDate = pairing?.expiresAt == null || pairing.expiresAt === '' ? null : new Date(pairing.expiresAt);
  const expiryValid = expiryDate && !Number.isNaN(expiryDate.getTime());
  const pair = () => { if (locked || !selectedHostId || !code.trim()) return; void action('pairClipboardSync', { hostId: selectedHostId, code: code.trim(), direction }); };

  return <div className="clipboard-sync-settings">
    <div className="setting-row">
      <div>
        <strong>Sync between devices</strong>
        <p>Pair ShelfDock on another computer. Copying can send text, links, and images to the devices you approve. Files stay on the transfer shelf.</p>
        {!toolsOn && <p>Turn on Clipboard tools before pairing computers.</p>}
      </div>
      <button type="button" role="switch" aria-checked={enabled} aria-label="Sync between devices" disabled={locked} className={`switch ${enabled ? 'on' : ''}`} onClick={() => action('updateClipboardSync', { enabled: !enabled })}><span /></button>
    </div>
    {error && <p className="clipboard-sync-error" role="alert">{error}</p>}
    <fieldset className="clipboard-sync-receive">
      <legend>Receive preference</legend>
      <label className="clipboard-sync-choice"><input type="radio" name="clipboard-sync-receive" value="history" checked={receiveMode === 'history'} disabled={locked} onChange={() => action('updateClipboardSync', { receiveMode: 'history' })} /><span>Save to clipboard history</span></label>
      <label className="clipboard-sync-choice"><input type="radio" name="clipboard-sync-receive" value="clipboard" checked={receiveMode === 'clipboard'} disabled={locked} onChange={() => action('updateClipboardSync', { receiveMode: 'clipboard' })} /><span>Also place on the system clipboard</span></label>
      <p>Saving to clipboard history does not change what is currently copied.</p>
    </fieldset>
    {enabled && <div className="clipboard-sync-actions"><button type="button" className="quiet-button" aria-label={paused ? 'Resume clipboard sync' : 'Pause clipboard sync'} disabled={locked} onClick={() => action('updateClipboardSync', { paused: !paused })}>{paused ? 'Resume' : 'Pause'}</button></div>}
    <div className="clipboard-sync-actions"><button type="button" className="quiet-button" disabled={locked} onClick={() => action('beginClipboardPairing')}>Allow pairing</button></div>
    {pairing && <div className="clipboard-sync-pairing">
      {pairing.code && <p className="clipboard-sync-code" aria-label="Pairing code">{pairing.code}</p>}
      {pairing.expiresAt != null && pairing.expiresAt !== '' && <p className="clipboard-sync-expiry">Expires {expiryValid ? <time dateTime={expiryDate.toISOString()}>{expiryLabel(pairing.expiresAt)}</time> : expiryLabel(pairing.expiresAt)}</p>}
    </div>}
    <label className="clipboard-sync-field"><span aria-hidden="true">Machine</span><select aria-label="Machine" value={selectedHostId} disabled={locked} onChange={(event) => setHostId(event.target.value)}><option value="">Choose a machine</option>{hosts.map((host) => <option value={host.id} key={host.id}>{hostOptionLabel(host)}</option>)}</select></label>
    <label className="clipboard-sync-field"><span aria-hidden="true">Pairing code</span><input aria-label="Pairing code from the other computer" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={code} disabled={locked} onChange={(event) => setCode(event.target.value)} /></label>
    <label className="clipboard-sync-field"><span aria-hidden="true">Direction</span><select aria-label="Direction" value={direction} disabled={locked} onChange={(event) => setDirection(event.target.value)}>{syncDirections.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    <div className="clipboard-sync-actions"><button type="button" className="quiet-button" disabled={locked || !selectedHostId || !code.trim()} onClick={pair}>Pair this computer</button></div>
    {peers.length > 0 && <ul className="clipboard-sync-peers">{peers.map((peer) => {
      const label = peerOptionLabel(peer);
      const peerPaused = peer.paused === true;
      return <li className="clipboard-sync-peer" key={peer.id}>
        <div className="clipboard-sync-peer-head"><strong>{label}</strong><button type="button" className="danger-button" disabled={locked} onClick={() => action('revokeClipboardPeer', { id: peer.id })}>Revoke</button></div>
        <div className="clipboard-sync-field"><span aria-hidden="true">Direction</span><select aria-label={`Direction for ${label}`} value={peerDirection(peer.direction)} disabled={locked} onChange={(event) => action('updateClipboardPeer', { id: peer.id, direction: event.target.value })}>{syncDirections.map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></div>
        <button type="button" className="quiet-button" aria-label={peerPaused ? `Resume sync with ${label}` : `Pause sync with ${label}`} disabled={locked} onClick={() => action('updateClipboardPeer', { id: peer.id, paused: !peerPaused })}>{peerPaused ? 'Resume' : 'Pause'}</button>
      </li>;
    })}</ul>}
    {peers.length > 0 && <p className="clipboard-sync-revoke-note">Revoke stops that computer immediately. Clipboard history on this device stays here.</p>}
  </div>;
}

function App() {
  const bridge = window.drift;
  const productName = bridge?.productName || 'ShelfDock';
  useEffect(() => { document.title = productName; }, [productName]);
  const isDemo = !bridge;
  const [state, setState] = useState(isDemo ? demoState : emptyState);
  const [activeSection, setActiveSection] = useState('transfers');
  const clipboardVisible = state.clipboardTools?.enabled === true && state.clipboardTools?.showTab !== false;
  useEffect(() => { if (!clipboardVisible && activeSection === 'clipboard') setActiveSection('transfers'); }, [clipboardVisible, activeSection]);
  const [received, setReceived] = useState({ received: [], unreadCount: 0, scanning: false });
  const [receivedUIState, setReceivedUIState] = useState({ filter: 'received', query: '', selectedId: '' });
  const [deviceNameDraft, setDeviceNameDraft] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);
  const updateLock = useRef(false);
  const setUpdateOperation = useCallback(value => { updateLock.current = value; setUpdateBusy(value); }, []);
  const applyReceived = useCallback(next => { if (next?.received) setReceived(next); }, []);
  const [clipboardEditing, setClipboardEditing] = useState(false);
  const [clipboardUIState, setClipboardUIState] = useState({ query: '', filter: 'all', selectedId: '', scrollTop: 0 });
  const [quickHost, setQuickHost] = useState(null);
  const [quickPreferences, setQuickPreferences] = useState({});
  const [fieldFocused, setFieldFocused] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const stateRef = useRef(state);
  const [loading, setLoading] = useState(!isDemo);
  const [machinesOpen, setMachinesOpen] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedHost, setSelectedHost] = useState('');
  const [selectedHostIds, setSelectedHostIds] = useState([]);
  const [selectedItems, setSelectedItems] = useState([]);
  const [batchReview, setBatchReview] = useState(null);
  const [trayDrag, setTrayDrag] = useState(false);
  const [dragHost, setDragHost] = useState('');
  const [dragging, setDragging] = useState(false);
  const [dragSnapshot, setDragSnapshot] = useState(null);
  const [modal, setModal] = useState(null);
  const [onboardingMode, setOnboardingMode] = useState('quick');
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [windowSeen, setWindowSeen] = useState(() => globalThis.document?.visibilityState !== 'hidden');
  const onboardingOffered = useRef(false);
  const modalState = useRef(null);
  modalState.current = modal;
  const [hostForm, setHostForm] = useState(freshHost);
  const [accessHostId, setAccessHostId] = useState('');
  const [accessMode, setAccessMode] = useState('key');
  // Passwords are transient form input, separate from machine data and exports.
  const [accessPassword, setAccessPassword] = useState('');
  const [accessError, setAccessError] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [machineMenu, setMachineMenu] = useState(null);
  const [tunnels, setTunnels] = useState({ active: [], history: [] });
  const [tunnelEntry, setTunnelEntry] = useState({ hostId: '', mode: 'local', tab: 'active' });
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [macInstallBusy, setMacInstallBusy] = useState(false);
  const [installHostId, setInstallHostId] = useState('');
  const [undoClock, setUndoClock] = useState(Date.now);
  const [reveal, setReveal] = useState(false);
  const fileInput = useRef(null);
  const noticeTimer = useRef(null);
  const dragDepth = useRef(0);
  const transferLock = useRef(false);
  const clipboardLock = useRef(false);
  const accessLock = useRef(false);
  const tunnelLock = useRef(false);
  const macInstallLock = useRef(false);
  const undoLock = useRef(false);
  const demoUndo = useRef(null);
  const machineMenuRef = useRef(null);
  const suppressPasteUntil = useRef(0);
  const modalRef = useRef(null);
  const closeModal = useCallback(() => {
    const leavingOnboarding = modalState.current === 'onboarding';
    if (!leavingOnboarding && (accessLock.current || tunnelLock.current || macInstallLock.current || updateLock.current)) return;
    if (leavingOnboarding) writeOnboardingRecord('skipped');
    setAccessPassword(''); setAccessError(''); setAccessHostId(''); setModal(null);
  }, []);
  const finishOnboarding = useCallback(() => { writeOnboardingRecord('completed'); setModal(null); }, []);
  const replayQuickStart = useCallback(() => { setOnboardingMode('quick'); setOnboardingStep(0); setModal('onboarding'); }, []);
  const openFeatureGuide = useCallback(() => { setOnboardingMode('learn'); setModal('onboarding'); }, []);
  const navigateFromOnboarding = useCallback((target) => {
    writeOnboardingRecord('skipped'); setModal(null);
    if (target === 'density') requestAnimationFrame(() => document.querySelector('[aria-label="Display density"]')?.focus());
    if (target === 'settings') { setModal('settings'); return; }
    if (target === 'received') setActiveSection('received');
    if (target === 'shelf' || target === 'density') setActiveSection('transfers');
    if (target === 'machines') { setMachinesOpen(true); setActiveSection('transfers'); }
    if (target === 'activity') setHistoryOpen(true);
  }, []);
  const operationLocked = useCallback(() => tunnelLock.current || accessLock.current || transferLock.current || macInstallLock.current || updateLock.current, []);
  const closeQuick = useCallback(() => { if (!tunnelLock.current) setQuickHost(null); }, []);
  const setTunnelOperation = useCallback((value) => { tunnelLock.current = value; setTunnelBusy(value); }, []);
  const setMacInstallOperation = useCallback(value => { macInstallLock.current = value; setMacInstallBusy(value); }, []);
  const applyTunnels = useCallback((next) => { if (next?.active && next?.history) setTunnels(next); }, []);
  const noticeNow = useCallback((message, kind = 'info') => {
    setNotice({ message, kind });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), kind === 'error' ? 9000 : 4500);
  }, []);
  const endDrag = useCallback(() => { setDragging(false); setDragSnapshot(null); setTrayDrag(false); setDragHost(''); dragDepth.current = 0; }, []);
  const applyState = useCallback((next) => {
    if (next?.hosts && next?.items) { stateRef.current = next; setState(next); }
    return next;
  }, []);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { if (modal === 'settings') setDeviceNameDraft(stateRef.current.settings?.deviceName || ''); }, [modal]);
  useEffect(() => {
    if (!bridge?.getReceived) return;
    let mounted = true, eventReceived = false;
    const unsubscribe = bridge.onReceived?.(next => { eventReceived = true; if (mounted) applyReceived(next); });
    Promise.resolve(bridge.getReceived()).then(next => { if (mounted && !eventReceived) applyReceived(next); }).catch(() => {});
    return () => { mounted = false; unsubscribe?.(); };
  }, [bridge, applyReceived]);
  useEffect(() => {
    const expiresAt = Date.parse(state.clearShelfUndo?.expiresAt || '');
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    setUndoClock(Date.now());
    const tick = setInterval(() => setUndoClock(Date.now()), 1000);
    const expiry = setTimeout(() => { clearInterval(tick); setUndoClock(Date.now()); if (isDemo) demoUndo.current = null; }, Math.max(0, expiresAt - Date.now()) + 10);
    return () => { clearInterval(tick); clearTimeout(expiry); };
  }, [state.clearShelfUndo?.expiresAt, isDemo]);
  useEffect(() => { if (modal !== 'access') setAccessPassword(''); }, [modal]);
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    Promise.resolve(bridge.getState()).then((next) => { if (mounted) applyState(next); }).catch((error) => noticeNow(error.message || `Could not load ${productName}.`, 'error')).finally(() => { if (mounted) setLoading(false); });
    const offState = bridge.onState?.(applyState);
    const offReveal = bridge.onReveal?.(() => { setWindowSeen(true); setReveal(true); setTimeout(() => setReveal(false), 600); });
    return () => { mounted = false; offState?.(); offReveal?.(); };
  }, [bridge, applyState, noticeNow]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState !== 'hidden') setWindowSeen(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  useEffect(() => {
    if (onboardingOffered.current || !windowSeen || (!isDemo && loading)) return;
    onboardingOffered.current = true;
    if (!onboardingSettled()) { setOnboardingMode('quick'); setOnboardingStep(0); setModal((current) => current ?? 'onboarding'); }
  }, [windowSeen, isDemo, loading]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    if (typeof bridge?.getTunnels !== 'function') return;
    let mounted = true;
    Promise.resolve(bridge.getTunnels()).then((next) => { if (mounted) applyTunnels(next); }).catch(() => {});
    const unsubscribe = bridge.onTunnels?.(applyTunnels);
    return () => { mounted = false; unsubscribe?.(); };
  }, [bridge, applyTunnels]);
  useEffect(() => {
    if (!machineMenu) return;
    const previousFocus = document.activeElement;
    const timer = setTimeout(() => machineMenuRef.current?.querySelector('[role="menuitem"]')?.focus(), 0);
    const outside = (event) => { if (!machineMenuRef.current?.contains(event.target)) setMachineMenu(null); };
    const keys = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); setMachineMenu(null); previousFocus?.focus?.(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nodes = Array.from(machineMenuRef.current?.querySelectorAll('[role="menuitem"]') || []);
      if (!nodes.length) return;
      const index = nodes.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length;
      nodes[next]?.focus();
    };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', keys);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', keys); };
  }, [machineMenu]);
  useEffect(() => {
    window.addEventListener('dragend', endDrag);
    window.addEventListener('blur', endDrag);
    return () => { window.removeEventListener('dragend', endDrag); window.removeEventListener('blur', endDrag); };
  }, [endDrag]);
  useEffect(() => { if (!dragging) setDragSnapshot(null); }, [dragging]);
  useEffect(() => {
    if (quickHost && (!machinesOpen || !state.hosts.some(host => host.id === quickHost.id && (filter === 'all' || host.route === filter) && `${host.name} ${host.address} ${host.user} ${host.sshAlias || ''}`.toLowerCase().includes(search.toLowerCase())))) setQuickHost(null);
  }, [quickHost, machinesOpen, state.hosts, filter, search]);
  useEffect(() => {
    if (typeof bridge?.setInteraction !== 'function') return;
    Promise.resolve(bridge.setInteraction({ dragging: Boolean(dragging), editing: Boolean(modal || clipboardEditing || machineMenu || quickHost || fieldFocused || tunnelBusy), sensitiveEditing: modal === 'access' })).catch(() => {});
  }, [bridge, dragging, modal, clipboardEditing, machineMenu, quickHost, fieldFocused, tunnelBusy]);
  useEffect(() => { setSelectedItems((ids) => ids.filter((id) => state.items.some((item) => item.id === id))); }, [state.items]);
  useEffect(() => { setSelectedHostIds((ids) => ids.filter((id) => state.hosts.some((host) => host.id === id))); }, [state.hosts]);
  useEffect(() => {
    if (!modal) return;
    const before = document.activeElement;
    const returnTo = modal === 'install' ? document.querySelector(`[data-host-id="${CSS.escape(installHostId)}"] button[aria-haspopup="menu"]`) : before;
    const focusTimer = setTimeout(() => { const nodes = tabbableElements(modalRef.current); (nodes.find(node => node.matches('input, textarea, select')) || nodes[0])?.focus(); }, 0);
    const trap = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
      if (event.key !== 'Tab') return;
      const nodes = tabbableElements(modalRef.current);
      if (!nodes.length) return;
      if (!modalRef.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? nodes.at(-1) : nodes[0]).focus(); }
      else if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => {
      clearTimeout(focusTimer); document.removeEventListener('keydown', trap);
      if (modal === 'install') {
        const machine = returnTo?.closest('.machine-card')?.querySelector('.machine-main');
        machine?.focus();
        // Compact actions become visible once the machine has focus.
        requestAnimationFrame(() => { if (document.activeElement === machine && !modalRef.current) returnTo?.focus(); });
      } else returnTo?.focus?.();
    };
  }, [modal, closeModal, installHostId]);
  useEffect(() => {
    const escape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (machineMenu) return;
      if (quickHost) { event.preventDefault(); closeQuick(); return; }
      endDrag();
      if (modal) return;
      if (historyOpen) { setHistoryOpen(false); return; }
      if (machinesOpen) { event.preventDefault(); setMachinesOpen(false); return; }
      if (!isDemo) bridge.hideWindow();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [modal, historyOpen, bridge, isDemo, endDrag, machineMenu, quickHost, closeQuick, machinesOpen]);

  const demoCall = async (method, value) => {
    const current = stateRef.current;
    let next = structuredClone(current);
    if (method === 'enqueueFiles') next.items.push(...value.map((path) => ({ id: uid(), name: path.split(/[\\/]/).at(-1), path, kind: 'file', size: 0 })));
    if (method === 'enqueueText') next.items.push({ id: uid(), name: value.trim().split('\n')[0].slice(0, 36) || 'Text note', kind: 'text', preview: value, size: new TextEncoder().encode(value).length });
    if (['enqueueFiles', 'enqueueText'].includes(method)) next.enqueuedItemIds = next.items.slice(current.items.length).map((item) => item.id);
    if (method === 'removeItem') next.items = next.items.filter((item) => item.id !== value);
    if (method === 'clearItems' && next.items.length) {
      const expiresAt = new Date(Date.now() + 10000).toISOString();
      demoUndo.current = { items: [...next.items], expiresAt };
      next.clearShelfUndo = { count: next.items.length, expiresAt }; next.items = [];
    }
    if (method === 'undoClear') {
      const pending = demoUndo.current;
      if (!pending || Date.parse(pending.expiresAt) <= Date.now()) throw new Error('The undo window has expired. Add the items to your shelf again.');
      const restored = pending.items.filter((item) => !next.items.some((existing) => existing.id === item.id || (item.path && existing.path === item.path)));
      next.items.push(...restored); next.restoredItemIds = restored.map((item) => item.id); next.enqueuedItemIds = next.restoredItemIds;
      next.clearShelfUndo = null; demoUndo.current = null;
    }
    if (method === 'saveHost') {
      const index = next.hosts.findIndex((host) => host.id === value.id);
      const host = { ...value, id: value.id || uid(), source: 'Manual', status: 'unknown' };
      if (index >= 0) next.hosts[index] = host; else next.hosts.push(host);
    }
    if (method === 'removeHost') next.hosts = next.hosts.filter((host) => host.id !== value);
    if (method === 'updateClipboardTools') { next.clipboardTools = { ...next.clipboardTools, ...value }; if (!next.clipboardTools.enabled) next.clipboardTools.historyEnabled = false; }
    if (method === 'updateSettings') next.settings = { ...next.settings, ...value };
    const ensureSync = () => { if (!next.clipboardSync || typeof next.clipboardSync !== 'object') next.clipboardSync = { enabled: false, paused: false, receiveMode: 'history', peers: [] }; if (!Array.isArray(next.clipboardSync.peers)) next.clipboardSync.peers = []; return next.clipboardSync; };
    if (method === 'updateClipboardSync' && value && typeof value === 'object') Object.assign(ensureSync(), value);
    if (method === 'beginClipboardPairing') ensureSync().pairing = { code: 'PREVIEW', expiresAt: new Date(Date.now() + 300000).toISOString() };
    if (method === 'pairClipboardSync' && value && typeof value === 'object') { const sync = ensureSync(); const host = next.hosts.find((item) => item.id === value.hostId); sync.peers.push({ id: uid(), hostId: value.hostId, label: host?.name || host?.label || 'Computer', direction: peerDirection(value.direction), paused: false }); sync.pairing = null; }
    if (method === 'updateClipboardPeer' && value?.id) { const sync = ensureSync(); sync.peers = sync.peers.map((peer) => peer.id === value.id ? { ...peer, ...value } : peer); }
    if (method === 'revokeClipboardPeer' && value?.id) { const sync = ensureSync(); sync.peers = sync.peers.filter((peer) => peer.id !== value.id); }
    if (method === 'send' || method === 'sendMany') {
      for (const hostId of value.hostIds || [value.hostId]) next.history.unshift({ id: uid(), hostName: next.hosts.find((host) => host.id === hostId)?.name || 'Machine', itemCount: value.itemIds.length, status: 'failed', message: 'Demo preview: no files were transferred. Open the desktop application to send.', timestamp: new Date().toISOString() });
      noticeNow('Demo preview only. No files were transferred.', 'info');
    }
    if (['refreshHosts', 'probeHosts'].includes(method)) noticeNow('Demo preview. Live discovery is available in the desktop app.');
    if (method === 'openSettingsFolder') noticeNow('The desktop app opens its local settings folder here.');
    if (['captureClipboard', 'exportConfig', 'importConfig'].includes(method)) {
      noticeNow(method === 'captureClipboard' ? 'Open the desktop app to paste copied files, images, or text. You can paste text into this preview with ⌘ / Ctrl + V.' : 'Configuration import and export are available in the desktop app.');
      return null;
    }
    return applyState(next);
  };
  const call = async (method, value) => {
    if (isDemo) return demoCall(method, value);
    if (typeof bridge[method] !== 'function') throw new Error(`This version of ${productName} does not support ${method}.`);
    return applyState(await bridge[method](value));
  };
  const action = async (method, value, success) => {
    if (macInstallLock.current) { noticeNow('Wait for Mac installation to finish.'); return null; }
    if (tunnelLock.current) { noticeNow('Wait for forwarding setup to finish.'); return null; }
    setBusy(method);
    try { const next = await call(method, value); if (success) noticeNow(success); return next; }
    catch (error) { noticeNow(error.message || 'Something went wrong. Please try again.', 'error'); return null; }
    finally { setBusy(''); }
  };
  const addText = async (text) => {
    if (!text?.trim()) return null;
    return action('enqueueText', text, 'Text added to your shelf.');
  };
  const undoClearShelf = async () => {
    if (undoLock.current || busy) return;
    undoLock.current = true;
    try {
      const next = await action('undoClear');
      if (!next) return;
      const restoredIds = next.restoredItemIds || next.enqueuedItemIds || [];
      setSelectedItems((ids) => [...new Set([...ids, ...restoredIds])].filter((id) => next.items.some((item) => item.id === id)));
      noticeNow('Shelf restored. Items added since the clear are still here.', 'success');
    } finally { undoLock.current = false; }
  };
  const captureClipboard = async () => {
    if (clipboardLock.current || busy) return null;
    clipboardLock.current = true;
    try {
      const next = await action('captureClipboard');
      if (next?.enqueuedItemIds?.length) {
        setSelectedItems(next.enqueuedItemIds);
        noticeNow('Clipboard added to your shelf. Drag it onto a machine to send.');
      }
      return next;
    } finally { clipboardLock.current = false; }
  };
  useEffect(() => {
    const editable = (event) => activeSection !== 'transfers' || modal || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName || '') || event.target?.isContentEditable;
    const shortcut = (event) => {
      if (isDemo || editable(event) || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'v') return;
      event.preventDefault();
      if (event.repeat) return;
      suppressPasteUntil.current = Date.now() + 1000;
      void captureClipboard();
    };
    const paste = (event) => {
      if (editable(event)) return;
      if (!isDemo) {
        event.preventDefault();
        if (Date.now() >= suppressPasteUntil.current) void captureClipboard();
        return;
      }
      const text = event.clipboardData?.getData('text/plain');
      if (text?.trim()) { event.preventDefault(); addText(text); }
    };
    document.addEventListener('keydown', shortcut);
    document.addEventListener('paste', paste);
    return () => { document.removeEventListener('keydown', shortcut); document.removeEventListener('paste', paste); };
  }, [modal, isDemo, busy, activeSection]);
  const extractExternal = async (transfer) => {
    // Capture File objects and text before yielding: Chromium clears drag data after the event.
    const files = Array.from(transfer.files || []);
    const text = transfer.getData('text/plain');
    if (files.length) {
      const paths = files.map((file) => isDemo ? file.name : bridge.getFilePath(file)).filter(Boolean);
      if (paths.length !== files.length) throw new Error('One of these files has no accessible path. Try the Add files button.');
      return call('enqueueFiles', paths);
    }
    if (text?.trim()) return call('enqueueText', text);
    throw new Error('Drop a file, folder, or selected text here.');
  };
  const dropTray = async (event) => {
    event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setTrayDrag(false); setDragging(false);
    if (modal) return;
    if (event.dataTransfer.types.includes(ITEM_MIME)) return;
    try { await extractExternal(event.dataTransfer); noticeNow('Added to your shelf. Drop it on a machine when you’re ready.'); }
    catch (error) { noticeNow(error.message, 'error'); }
  };
  const sendItems = async (hostId, ids) => {
    if (accessLock.current) { noticeNow('Wait for access setup to finish before sending.', 'error'); return; }
    const host = stateRef.current.hosts.find((entry) => entry.id === hostId);
    if (!host || host.status !== 'ready') { noticeNow('Check SSH access for this machine before sending.', 'error'); return; }
    if (!ids.length) return;
    if (transferLock.current) { noticeNow('A transfer is already in progress.', 'error'); return; }
    transferLock.current = true;
    setSelectedHost(hostId);
    let next;
    try { next = await action('send', { hostId, itemIds: ids }); }
    finally { transferLock.current = false; }
    if (!next || isDemo) return;
    const recent = next.history.find((entry) => entry.hostName === host.name);
    if (recent?.status === 'failed') noticeNow(recent.message || 'Transfer failed. Your shelf items are still here.', 'error');
    else if (recent?.status === 'sent') noticeNow(`Sent to ${host.name}. Your shelf items are still here.`, 'success');
    else noticeNow(`Sending to ${host.name}…`);
  };
  const dropHost = async (event, host) => {
    event.preventDefault(); event.stopPropagation(); endDrag();
    if (modal) return;
    if (accessLock.current) { noticeNow('Wait for access setup to finish before sending.', 'error'); return; }
    if (host.status !== 'ready' || busy === 'send' || busy === 'sendMany') { noticeNow(host.status !== 'ready' ? 'This machine needs a successful SSH check before you can send.' : 'A transfer is already in progress.', 'error'); return; }
    const internal = event.dataTransfer.getData(ITEM_MIME);
    if (internal) {
      try { const ids = JSON.parse(internal).filter((id) => stateRef.current.items.some((item) => item.id === id)); await sendItems(host.id, ids); }
      catch { noticeNow('Could not read the dragged items. Try dragging again.', 'error'); }
      return;
    }
    try { const next = await extractExternal(event.dataTransfer); const ids = next.enqueuedItemIds || []; if (!ids.length) throw new Error('The drop did not contain an accessible file or text item.'); await sendItems(host.id, ids); }
    catch (error) { noticeNow(error.message, 'error'); }
  };
  const pickFiles = async () => {
    if (isDemo) { fileInput.current?.click(); return; }
    await action('pickFiles');
  };
  const startItemDrag = (event, item) => {
    const ids = selectedItems.includes(item.id) ? selectedItems : [item.id];
    event.dataTransfer.setData(ITEM_MIME, JSON.stringify(ids));
    if (item.kind === 'text') event.dataTransfer.setData('text/plain', item.preview || '');
    event.dataTransfer.effectAllowed = 'copy';
    setDragSnapshot(orderHosts(stateRef.current.hosts));
    setMachinesOpen(true); setDragging(true);
  };
  const openHost = (host) => { if (accessLock.current) return; setHostForm(host ? { ...host } : freshHost()); setModal('host'); };
  const openAccess = (host) => {
    if (accessLock.current || !host?.id) return;
    setAccessHostId(host.id); setAccessMode(host.hasSavedPassword && stateRef.current.environment?.passwordStorageAvailable !== false ? 'saved' : host.status === 'ready' ? 'key' : 'once');
    setAccessPassword(''); setAccessError(''); setModal('access');
  };
  const saveMachine = async (event) => {
    event.preventDefault();
    const previousIds = new Set(stateRef.current.hosts.map((host) => host.id));
    const next = await action('saveHost', { ...hostForm, name: hostForm.name.trim(), address: hostForm.address.trim(), user: hostForm.user.trim(), port: Number(hostForm.port) });
    if (!next) return;
    const host = next.hosts.find((entry) => hostForm.id ? entry.id === hostForm.id : !previousIds.has(entry.id));
    if (host) openAccess(host);
    else { closeModal(); noticeNow('Machine saved. Open its access settings to connect.'); }
  };
  const configureAccess = async (event) => {
    event.preventDefault();
    if (accessLock.current || busy || !accessHostId) return;
    if (transferLock.current || stateRef.current.history.some((entry) => entry.status === 'sending')) { setAccessError('Wait for the current transfer to finish before changing access.'); return; }
    if (isDemo) { setAccessError('Access setup is available in the desktop app. No connection was made.'); return; }
    if (accessMode === 'saved' && stateRef.current.environment?.passwordStorageAvailable === false) { setAccessError('Secure password storage is unavailable on this device. Use a password once to set up an SSH key instead.'); return; }
    const hostId = accessHostId;
    const mode = accessMode;
    const password = accessPassword;
    // Clear the input before IPC starts, including when setup later fails.
    setAccessPassword(''); setAccessError(''); accessLock.current = true; setBusy('configureAccess');
    try {
      if (mode === 'key' && stateRef.current.hosts.find((host) => host.id === hostId)?.hasSavedPassword) await call('forgetPassword', hostId);
      const next = mode === 'key' ? await call('probeHosts', { hostId }) : await call('configureAccess', { hostId, mode, password });
      const host = next?.hosts?.find((entry) => entry.id === hostId);
      if (host?.status !== 'ready') throw new Error(host?.error || 'Access could not be verified. Check the address, SSH service, and credentials, then try again.');
      setModal(null); setAccessHostId('');
      noticeNow(mode === 'once' ? 'SSH key access is ready. The password was not saved.' : mode === 'saved' ? 'Connected. Your password is stored securely on this device.' : 'SSH key access is ready.', 'success');
    } catch (error) {
      const message = error.message || 'Access setup failed. Check your connection and try again.';
      setAccessError(password ? message.split(password).join('[redacted]') : message);
    } finally { accessLock.current = false; setBusy(''); }
  };
  const forgetPassword = async () => {
    if (accessLock.current || busy || !accessHostId) return;
    accessLock.current = true; setBusy('forgetPassword'); setAccessPassword(''); setAccessError('');
    try { await call('forgetPassword', accessHostId); setAccessMode('key'); noticeNow('Saved password removed from this device.'); }
    catch (error) { setAccessError(error.message || 'Could not remove the saved password. Please try again.'); }
    finally { accessLock.current = false; setBusy(''); }
  };
  const accessHost = state.hosts.find((host) => host.id === accessHostId);
  const settingUpAccess = busy === 'configureAccess' || busy === 'forgetPassword';
  const showMachineMenu = (event, host) => {
    event.preventDefault(); event.stopPropagation();
    if (accessLock.current || tunnelLock.current || transferLock.current || macInstallLock.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.type === 'contextmenu' && event.clientX > 0 ? event.clientX : rect.right - 225;
    const y = event.type === 'contextmenu' && event.clientY > 0 ? event.clientY : rect.bottom + 5;
    setQuickHost(null); setRemoveArmed(false);
    setMachineMenu({ hostId: host.id, x: Math.max(10, Math.min(x, window.innerWidth - 250)), y: Math.max(10, Math.min(y, window.innerHeight - 410)) });
  };
  const openTunnels = (hostId = '', mode = 'local', tab = 'active') => {
    if (accessLock.current || (tunnelLock.current && tab === 'new')) return;
    setQuickHost(null); setMachineMenu(null); setHistoryOpen(false); setTunnelEntry({ hostId, mode, tab }); setModal('tunnels');
  };
  const openQuick = (hostId, mode = 'local', advanced = false) => {
    if (operationLocked()) return;
    setMachineMenu(null); setQuickHost({ id: hostId });
    setQuickPreferences(previous => ({...previous, [hostId]: {mode, advanced, revision: (previous[hostId]?.revision || 0) + 1}}));
  };
  const toggleBatchHost = (host) => {
    if (transferLock.current || accessLock.current) return;
    setSelectedHostIds((ids) => {
      if (ids.includes(host.id)) return ids.filter((id) => id !== host.id);
      if (host.status !== 'ready' || ids.length >= 20) return ids;
      return [...ids, host.id];
    });
  };
  const reviewBatch = () => {
    if (busy || !selectedItems.length || !selectedHostIds.length) return;
    setBatchReview({ hostIds: [...selectedHostIds], itemIds: [...selectedItems] }); setModal('batch');
  };
  const sendBatch = async () => {
    if (!batchReview || transferLock.current || accessLock.current || busy) return;
    const { hostIds, itemIds } = batchReview;
    const current = stateRef.current;
    if (hostIds.some((id) => current.hosts.find((host) => host.id === id)?.status !== 'ready') || itemIds.some((id) => !current.items.some((item) => item.id === id))) { noticeNow('A machine or item changed. Close this review and check your selections.', 'error'); return; }
    transferLock.current = true; setModal(null); setBatchReview(null); setHistoryOpen(true);
    try {
      const next = await action('sendMany', { hostIds, itemIds });
      if (next && !isDemo) noticeNow('Batch transfer finished. Activity shows the result for each machine.');
    } finally { transferLock.current = false; }
  };
  const activeHost = state.hosts.find((host) => host.id === selectedHost);
  const displayHosts = dragSnapshot ? dragSnapshot.map((host) => state.hosts.find((latest) => latest.id === host.id) || host) : orderHosts(state.hosts);
  const visibleHosts = displayHosts.filter((host) => (filter === 'all' || host.route === filter) && `${host.name} ${host.address} ${host.user} ${host.sshAlias || ''}`.toLowerCase().includes(search.toLowerCase()));
  // Keep every destination receipt from a full batch visible in the scrollable log.
  const recentHistory = state.history.slice(0, 50);
  const warnings = state.discovery?.warnings || [];
  const lastSentItemIds = new Set(state.history.filter((entry) => entry.status === 'sent').flatMap((entry) => entry.itemIds || []));
  const sending = state.history.some((entry) => entry.status === 'sending') || busy === 'send' || busy === 'sendMany';
  const batchHostsReady = selectedHostIds.every((id) => state.hosts.find((host) => host.id === id)?.status === 'ready');
  const reviewHosts = (batchReview?.hostIds || []).map((id) => state.hosts.find((host) => host.id === id));
  const reviewItems = (batchReview?.itemIds || []).map((id) => state.items.find((item) => item.id === id));
  const batchReviewValid = !!reviewHosts.length && !!reviewItems.length && reviewHosts.every((host) => host?.status === 'ready') && reviewItems.every(Boolean);
  const undoExpiresAt = Date.parse(state.clearShelfUndo?.expiresAt || '');
  const undoSeconds = Math.max(0, Math.ceil((undoExpiresAt - Math.max(undoClock, Date.now())) / 1000));
  const canUndoClear = state.clearShelfUndo?.count > 0 && undoSeconds > 0;
  const modalTitle = modal === 'onboarding' ? `${productName} ${onboardingMode === 'learn' ? 'feature guide' : 'quick start'}` : modal === 'updates' ? 'Updates' : modal === 'host' ? hostForm.id ? 'Edit machine' : 'Add a machine' : modal === 'install' ? 'Install on this device' : modal === 'tunnels' ? 'Port forwarding' : modal === 'batch' ? 'Review transfer' : modal === 'access' ? 'Set up access' : modal === 'text' ? 'Add text' : `${productName} settings`;

  return (
    <div className={`app view-${state.settings?.viewMode || 'expanded'} ${machinesOpen ? 'machines-open' : ''} ${dragging ? 'is-dragging' : ''} ${reveal ? 'revealed' : ''}`} onFocusCapture={event => setFieldFocused(/INPUT|TEXTAREA|SELECT/.test(event.target.tagName))} onBlurCapture={event => { if (!/INPUT|TEXTAREA|SELECT/.test(event.relatedTarget?.tagName || '')) setFieldFocused(false); }} onDragEnter={(event) => { if (modal) { event.preventDefault(); return; } if (!dragging) { setDragSnapshot(orderHosts(stateRef.current.hosts)); setDragging(true); } setMachinesOpen(true); }} onDragLeave={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return; if (event.target === event.currentTarget || event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom || (event.clientX === 0 && event.clientY === 0)) endDrag(); }} onDragOver={(event) => { event.preventDefault(); if (modal) return; if (!machinesOpen) setMachinesOpen(true); }} onDropCapture={endDrag} onDrop={(event) => { event.preventDefault(); endDrag(); }}>
      <header className="titlebar">
        <div className="brand"><span className="brand-icon"><span /><span /><span /></span><span>{productName}<span className="brand-period">.</span></span></div>
        <div className="header-actions">
          {isDemo && <span className="demo-label">Demo preview</span>}
          <button className={`machines-toggle ${machinesOpen ? 'active' : ''}`} onMouseEnter={() => setMachinesOpen(true)} onClick={() => setMachinesOpen(true)} aria-expanded={machinesOpen} aria-controls="machines-pane"><Monitor size={15} /> Machines <span className="count">{state.hosts.length} · {state.hosts.filter(host => host.status === 'ready').length} ready</span><ChevronDown size={13} /></button>
          <button className="icon-button settings-button" aria-label="Settings" title={state.updatesSummary?.downloadedVersion ? `Settings · Update ${state.updatesSummary.downloadedVersion} ready to install` : state.updatesSummary?.availableVersion ? `Settings · Update ${state.updatesSummary.availableVersion} available` : 'Settings'} onClick={() => setModal('settings')}><Settings2 size={17} />{state.updatesSummary?.availableVersion && <span className="settings-update-dot" aria-label="Update available" />}</button>
          <span className="header-divider" />
          <button className="icon-button hide-button" aria-label={`Hide ${productName}`} title={`Hide ${productName} · shake or press ⌘ / Ctrl + Shift + Space to show it again`} onClick={() => isDemo ? noticeNow(`In the desktop app, ${productName} tucks into your menu bar.`) : bridge.hideWindow()}><X size={17} /></button>
        </div>
      </header>

      <nav className="workspace-tabs" aria-label="Workspace"><button aria-current={activeSection === 'transfers' ? 'page' : undefined} className={activeSection === 'transfers' ? 'active' : ''} onClick={() => setActiveSection('transfers')}><Send size={15} /> Transfers{state.items.length > 0 && <span>{state.items.length}</span>}</button><button aria-current={activeSection === 'received' ? 'page' : undefined} className={activeSection === 'received' ? 'active' : ''} onClick={() => setActiveSection('received')}><ArrowDownToLine size={15} /> Received{received.unreadCount > 0 && <span aria-label={`${received.unreadCount} new arrivals`}>{received.unreadCount}</span>}</button>{clipboardVisible && <button aria-current={activeSection === 'clipboard' ? 'page' : undefined} className={activeSection === 'clipboard' ? 'active' : ''} onClick={() => setActiveSection('clipboard')}><Clipboard size={15} /> Clipboard</button>}<label className="density-picker"><span>View</span><select aria-label="Display density" disabled={!!busy || tunnelBusy || dragging} value={state.settings?.viewMode || 'expanded'} onChange={event => action('updateSettings', { viewMode: event.target.value })}><option value="compact">Compact</option><option value="expanded">Balanced</option><option value="large">Expanded</option></select></label></nav>

      <main className="workspace">
        {activeSection === 'transfers' ? <section className="shelf-pane" aria-label="File and text shelf">
          <div className="shelf-heading"><div><h1>Transfers</h1><p className="shelf-subtitle">Collect here. Drop onto a machine to send.</p></div><div className="shelf-counter" title="Items on your shelf">{state.items.length}<span>on your shelf</span></div></div>
          <div className={`drop-tray ${trayDrag ? 'drag-over' : ''} ${state.items.length ? 'has-items' : ''}`} onDragEnter={(event) => { event.preventDefault(); if (event.dataTransfer.types.includes(ITEM_MIME)) return; dragDepth.current += 1; setTrayDrag(true); }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) setTrayDrag(false); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={dropTray}>
            {!state.items.length ? <div className="empty-tray">
              <div className="file-illustration" aria-hidden="true"><div className="paper paper-back"><span /><span /><span /></div><div className="paper paper-front"><FileText size={26} strokeWidth={1.3} /><span /><span /></div><div className="floating-plus"><Plus size={17} /></div></div>
              <h2>{trayDrag ? 'Let it land here.' : 'Drop a little something.'}</h2><p>Files, folders, or a piece of text.<br />They stay here until you move them.</p>
              <div className="tray-actions"><button className="quiet-button" onClick={pickFiles}><Plus size={14} /> Add files</button><button className="quiet-button" disabled={!!busy} onClick={captureClipboard} title="Paste copied files, an image, or text · ⌘ / Ctrl + V">{busy === 'captureClipboard' ? <Loader2 size={14} className="spinning" /> : <Clipboard size={14} />} {busy === 'captureClipboard' ? 'Pasting…' : 'Paste from clipboard'}</button><button className="text-button" onClick={() => { setTextDraft(''); setModal('text'); }}>Add text <ArrowUpRight size={13} /></button></div>
            </div> : <>
              <div className="queue-toolbar"><span>{selectedItems.length ? `${selectedItems.length} selected` : 'Your shelf'}</span><div><button onClick={() => setSelectedItems(selectedItems.length === state.items.length ? [] : state.items.map((item) => item.id))}>{selectedItems.length === state.items.length ? 'Deselect' : 'Select all'}</button><button className="icon-button small" title="Add files" aria-label="Add files" onClick={pickFiles}><Plus size={15} /></button></div></div>
              <div className="item-list">{state.items.map((item) => { const Icon = item.kind === 'text' ? FileText : item.kind === 'folder' ? Folder : File; return <div key={item.id} className={`shelf-item ${selectedItems.includes(item.id) ? 'selected' : ''}`} draggable onDragStart={(event) => startItemDrag(event, item)} onDragEnd={() => { setDragging(false); setDragHost(''); }} title={`Drag ${item.name} onto a ready machine`}>
                <button className="item-select" aria-pressed={selectedItems.includes(item.id)} aria-label={`${selectedItems.includes(item.id) ? 'Deselect' : 'Select'} ${item.name}`} onClick={() => setSelectedItems((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id])}><span className={`item-icon ${item.kind}`}><Icon size={20} strokeWidth={1.6} />{selectedItems.includes(item.id) && <span className="selected-check"><Check size={9} strokeWidth={3} /></span>}</span><span className="item-description"><strong>{item.name}</strong><span>{item.kind === 'text' ? item.preview?.replace(/\s+/g, ' ').slice(0, 68) : item.kind === 'folder' ? 'Folder' : formatSize(item.size) || 'File'}{lastSentItemIds.has(item.id) ? ' · Sent before' : ''}</span></span></button>
                <button className="icon-button item-remove" aria-label={`Remove ${item.name} from shelf`} onClick={() => action('removeItem', item.id)}><X size={13} /></button>
              </div>; })}</div>
              <div className="queue-foot"><span><MousePointer2 size={13} /> Drag onto a machine</span><div className="queue-actions"><button className="text-button" disabled={!!busy} onClick={captureClipboard} title="Paste copied files, an image, or text · ⌘ / Ctrl + V">{busy === 'captureClipboard' ? <Loader2 size={13} className="spinning" /> : <Clipboard size={13} />} {busy === 'captureClipboard' ? 'Pasting…' : 'Paste from clipboard'}</button><button className="text-button" onClick={() => { setTextDraft(''); setModal('text'); }}><Plus size={13} /> Add text</button></div></div>
            </>}
            {trayDrag && state.items.length > 0 && <div className="drop-overlay"><Plus size={25} /><strong>Add to your shelf</strong></div>}
          </div>
          <div className="shelf-bottom"><span title={`Shake once to show ${productName}. Pause briefly, then shake again to hide. ⌘ / Ctrl + Shift + Space also toggles the shelf.`}><MousePointer2 size={13} /> {isDemo ? 'Shake to show or hide in the desktop app' : state.settings?.shakeEnabled ? 'Shake to show / hide · ⌘ / Ctrl + Shift + Space' : state.environment?.shortcutAvailable === false ? `Open ${productName} from your tray` : 'Show / hide · ⌘ / Ctrl + Shift + Space'}</span>{state.items.length > 0 && <button className="text-button muted" disabled={!!busy || sending} onClick={() => action('clearItems')}>Clear shelf</button>}</div>
          {state.items.length > 0 && selectedHostIds.length === 0 && <div className="send-bar"><span>{activeHost ? <><span className={`tiny-dot ${activeHost.status}`} /> {activeHost.name}<small>{activeHost.destination || '~/Desktop'}</small></> : 'Choose a machine, or drop an item on one.'}</span><button className="primary-button compact" disabled={!activeHost || activeHost.status !== 'ready' || !selectedItems.length || sending || settingUpAccess} onClick={() => sendItems(activeHost.id, selectedItems)}>{sending ? <Loader2 size={14} className="spinning" /> : <Send size={13} />} Send{selectedItems.length > 0 ? ` ${selectedItems.length}` : ''}</button></div>}
          {state.items.length > 0 && selectedHostIds.length > 0 && <div className="send-bar batch-send-bar"><span><strong>{selectedItems.length} {selectedItems.length === 1 ? 'item' : 'items'} → {selectedHostIds.length} {selectedHostIds.length === 1 ? 'machine' : 'machines'}</strong><small>{!selectedItems.length ? 'Select the items you want to send.' : !batchHostsReady ? 'A selected machine needs an SSH check.' : 'Review destinations before sending.'}</small></span><button className="primary-button compact" disabled={!selectedItems.length || !batchHostsReady || !!busy || sending} onClick={reviewBatch}><Send size={13} /> Review & send</button></div>}
        </section> : activeSection === 'received' ? <ReceivedPanel bridge={bridge} snapshot={received} onSnapshot={applyReceived} history={state.history} shelfItems={state.items} blocked={settingUpAccess || sending || tunnelBusy || macInstallBusy || updateBusy} uiState={receivedUIState} onUIStateChange={setReceivedUIState} onAddToShelf={next => { applyState(next); if (next?.enqueuedItemIds?.length) setSelectedItems(next.enqueuedItemIds); setActiveSection('transfers'); noticeNow('Added to Transfers. Choose a machine to send onward.'); }} onSelectSent={ids => { setSelectedItems(ids); setActiveSection('transfers'); noticeNow('Shelf items selected. Choose a machine; nothing has been sent.'); }} /> : <ClipboardPanel bridge={bridge} viewMode={state.settings?.viewMode || 'expanded'} uiState={clipboardUIState} onUIStateChange={setClipboardUIState} capturePaused={Boolean(modal || machineMenu || quickHost || fieldFocused || tunnelBusy)} blocked={settingUpAccess || sending || tunnelBusy} onEditingChange={setClipboardEditing} onAddToShelf={(next) => { applyState(next); if (next?.enqueuedItemIds?.length) setSelectedItems(next.enqueuedItemIds); setActiveSection('transfers'); noticeNow('Added to Transfers. Choose a machine or drag the item to send.'); }} />}

        {machinesOpen && <aside className="machines-pane" id="machines-pane" aria-label="Machines">
          <div className="pane-heading"><div><h2>Machines</h2></div><button className="icon-button small" aria-label="Close machines" disabled={tunnelBusy || dragging} onClick={() => !dragging && setMachinesOpen(false)}><X size={15} /></button></div>
          <p className="machines-intro">Drop to send. Use the globe to open a site.</p>
          {selectedHostIds.length > 0 && <div className="batch-machine-selection"><span>{selectedHostIds.length} selected for a batch</span><button className="text-button" disabled={sending || settingUpAccess} onClick={() => setSelectedHostIds([])}>Clear</button></div>}
          <div className="machine-search"><Search size={14} /><input disabled={tunnelBusy || dragging} aria-label="Search machines" placeholder="Find a machine…" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={12} /></button>}</div>
          <div className="route-tabs" role="group" aria-label="Connection route">{[['all', 'All'], ['tailscale', 'Tailscale'], ['lan', 'LAN'], ['ssh', 'SSH']].map(([value, label]) => <button key={value} disabled={tunnelBusy || dragging} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
          <div className="machine-list">{loading ? <div className="empty-machines"><Loader2 size={22} className="spinning" /><p>Finding your machines…</p></div> : visibleHosts.length === 0 ? <div className="empty-machines"><Network size={24} /><strong>{search ? 'No matches' : 'A place to start'}</strong><p>{search ? 'Try another name or address.' : 'Import Wave and SSH connections, or add a machine yourself.'}</p></div> : visibleHosts.map((host) => <MachineCard key={host.id} host={host} selected={selectedHost === host.id} onSelect={() => { setSelectedHost(host.id); openQuick(host.id); }} batchSelected={selectedHostIds.includes(host.id)} batchDisabled={sending || settingUpAccess || tunnelBusy || (!selectedHostIds.includes(host.id) && (host.status !== 'ready' || selectedHostIds.length >= 20))} onBatch={() => toggleBatchHost(host)} onAccess={() => openAccess(host)} onViewForwards={() => openTunnels(host.id, 'local', 'active')} onMenu={event => showMachineMenu(event,host)} menuOpen={machineMenu?.hostId === host.id} dropState={dragHost === host.id ? host.status === 'ready' ? 'drop-ready' : 'drop-blocked' : ''} dropHandlers={{
            onDragEnter: event => { event.preventDefault(); setDragHost(host.id); },
            onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragHost(''); },
            onDragOver: event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = host.status === 'ready' && !sending && !settingUpAccess && !tunnelBusy ? 'copy' : 'none'; setDragHost(host.id); },
            onDrop: event => dropHost(event,host),
          }} dragging={dragging} blocked={settingUpAccess || sending || !!busy} viewMode={state.settings?.viewMode || 'expanded'} bridge={bridge} snapshot={tunnels} onSnapshot={applyTunnels} onBusyChange={setTunnelOperation} operationLocked={operationLocked} quickOpen={quickHost?.id === host.id} quickMode={quickPreferences[host.id]?.mode || 'local'} quickAdvanced={quickPreferences[host.id]?.advanced || false} quickRevision={quickPreferences[host.id]?.revision || 0} onQuickOpen={() => openQuick(host.id)} onQuickClose={closeQuick} receipts={state.history.filter(entry => entry.hostId === host.id)} items={state.items} />)}</div>
          <div className="machine-pane-bottom"><button className="add-machine" disabled={settingUpAccess || sending} onClick={() => openHost()}><Plus size={15} /> Add a machine <span>manually</span></button><div className="discovery-actions"><button disabled={!!busy} onClick={() => action('refreshHosts')}><RefreshCw size={12} className={busy === 'refreshHosts' ? 'spinning' : ''} /> Import / refresh</button><button title="Check all machines using their saved SSH access, including saved passwords" disabled={!!busy} onClick={() => action('probeHosts')}><CheckCheck size={13} className={busy === 'probeHosts' ? 'spinning' : ''} /> Check SSH</button></div></div>
        </aside>}
      </main>

      <footer className="app-footer"><button className={`history-toggle ${historyOpen ? 'active' : ''}`} onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}><History size={13} /> Activity {state.history.length > 0 && <span>{state.history.length}</span>}<ChevronDown size={11} /></button><button className="history-toggle" onClick={() => openTunnels()} aria-label="Connections and forwarding history"><Network size={13} /> Connections{tunnels.active.length > 0 && <span>{tunnels.active.length}</span>}</button><span className="footer-hint">{sending ? <><Loader2 size={11} className="spinning" /> Transfer in progress</> : <><span className="tiny-dot ready" /> {state.hosts.filter((host) => host.status === 'ready').length} ready {isDemo ? '· Preview' : '· SSH encrypted'}</>}</span>{warnings.length > 0 && <button className="warning-indicator" title="View discovery notices" onClick={() => setModal('settings')}><CircleAlert size={12} /> {warnings.length}</button>}</footer>
      {historyOpen && <section className="history-panel" aria-label="Transfer activity"><div className="history-heading"><strong>Transfer activity</strong><button className="icon-button small" aria-label="Close activity" onClick={() => setHistoryOpen(false)}><X size={14} /></button></div>{recentHistory.length ? recentHistory.map((entry) => <div className="history-row" key={entry.id}><span className={`history-icon ${entry.status}`}>{entry.status === 'sending' ? <Loader2 size={14} className="spinning" /> : entry.status === 'sent' ? <Check size={14} /> : <CircleAlert size={14} />}</span><div><strong>{entry.itemCount} {entry.itemCount === 1 ? 'item' : 'items'} → {entry.hostName}</strong><p>{entry.message || (entry.status === 'sent' ? 'Delivered. Your shelf items remain available.' : entry.status === 'sending' ? 'Sending securely over SSH…' : 'Transfer failed.')}</p></div><time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time></div>) : <div className="history-empty">Your transfers will appear here.</div>}</section>}
      {notice && <div className={`toast ${notice.kind} ${canUndoClear ? 'above-undo' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' ? <Check size={15} /> : notice.kind === 'error' ? <CircleAlert size={15} /> : <span className="toast-dot" />}<span>{notice.message}</span><button aria-label="Dismiss notice" onClick={() => setNotice(null)}><X size={13} /></button></div>}
      {canUndoClear && <div className="shelf-undo" role="status" aria-live="polite"><Undo2 size={16} /><span><strong>{state.clearShelfUndo.count} {state.clearShelfUndo.count === 1 ? 'item' : 'items'} cleared from your shelf.</strong><small>You can undo this clear.</small></span><span className="undo-countdown" aria-hidden="true">{undoSeconds}s</span><button className="quiet-button" disabled={!!busy || sending} onClick={undoClearShelf} aria-label="Undo clear shelf">{busy === 'undoClear' ? <Loader2 size={13} className="spinning" /> : <Undo2 size={13} />} Undo</button></div>}

      {machineMenu && <div className="machine-context-menu" role="menu" aria-label="Machine connections" id="machine-context-menu" ref={machineMenuRef} style={{ left: machineMenu.x, top: machineMenu.y }}><span className="machine-context-title">{state.hosts.find(host => host.id === machineMenu.hostId)?.name || 'Machine'}</span>
        <button role="menuitem" onClick={() => openQuick(machineMenu.hostId, 'local', true)}><ArrowRight size={16} /><span><strong>Advanced local forward</strong><small>This device → SSH machine</small></span></button>
        <button role="menuitem" onClick={() => openQuick(machineMenu.hostId, 'remote', true)}><ArrowRight size={16} className="remote-arrow" /><span><strong>Remote port forward</strong><small>SSH machine → this device</small></span></button>
        <button role="menuitem" onClick={() => openTunnels(machineMenu.hostId, 'local', 'active')}><History size={15} /><span><strong>Active & saved forwards</strong><small>Stop, repeat, or edit notes</small></span></button>
        <button role="menuitem" onClick={() => { const host = state.hosts.find(host => host.id === machineMenu.hostId); setMachineMenu(null); openHost(host); }}><Pencil size={15} /><span><strong>Edit machine</strong><small>Rename, address, or destination folder</small></span></button>
        <button role="menuitem" onClick={() => { const host = state.hosts.find(host => host.id === machineMenu.hostId); setMachineMenu(null); openAccess(host); }}><KeyRound size={15} /><span><strong>SSH access</strong></span></button>
        {state.environment?.platform === 'darwin' && <button role="menuitem" onClick={() => { if (operationLocked()) return; setInstallHostId(machineMenu.hostId); setQuickHost(null); setMachineMenu(null); setModal('install'); }}><Download size={15} /><span><strong>Install on this device…</strong></span></button>}
        <button role="menuitem" className="danger-button" onClick={async () => { if (!removeArmed) { setRemoveArmed(true); return; } const id = machineMenu.hostId; setMachineMenu(null); await action('removeHost', id, 'Machine removed.'); }}><Trash2 size={15} /><span><strong>{removeArmed ? 'Confirm remove machine' : 'Remove machine…'}</strong></span></button>
      </div>}
      {modal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); }}><section className={`modal ${modal === 'onboarding' ? 'onboarding-modal' : modal === 'tunnels' ? 'tunnel-modal' : modal === 'host' || modal === 'access' || modal === 'install' ? 'host-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby={modal === 'onboarding' ? 'onboarding-progress' : undefined} ref={modalRef}>
        <div className="modal-header"><h2 id="modal-title">{modalTitle}</h2><button className="icon-button" aria-label="Close dialog" disabled={modal !== 'onboarding' && (settingUpAccess || tunnelBusy || macInstallBusy || updateBusy)} onClick={closeModal}><X size={17} /></button></div>
        {modal === 'onboarding' && <OnboardingPanel productName={productName} mode={onboardingMode} step={onboardingStep} onStep={setOnboardingStep} onMode={setOnboardingMode} onFinish={finishOnboarding} onSkip={closeModal} onNavigate={navigateFromOnboarding} wayland={Boolean(state.environment?.wayland)} shortcutAvailable={state.environment?.shortcutAvailable !== false} />}
        {modal === 'tunnels' && <TunnelPanel key={`${tunnelEntry.hostId}-${tunnelEntry.mode}-${tunnelEntry.tab}`} bridge={bridge} host={state.hosts.find((host) => host.id === tunnelEntry.hostId)} initialMode={tunnelEntry.mode} initialTab={tunnelEntry.tab} snapshot={tunnels} onSnapshot={applyTunnels} onBusyChange={setTunnelOperation} onClose={closeModal} blocked={settingUpAccess || sending} />}
        {modal === 'updates' && <UpdatesPanel bridge={bridge} onClose={closeModal} onBusyChange={setUpdateOperation} blocked={settingUpAccess || sending || tunnelBusy || macInstallBusy || dragging || tunnels.active.some(tunnel => ['starting', 'running', 'stopping'].includes(tunnel.status))} />}
        {modal === 'install' && <MacInstallPanel key={installHostId} bridge={bridge} hosts={state.hosts} initialHostId={installHostId} onBusyChange={setMacInstallOperation} onClose={closeModal} blocked={settingUpAccess || sending || tunnelBusy} />}
        {modal === 'text' && <form onSubmit={async (event) => { event.preventDefault(); const next = await addText(textDraft); if (next) setModal(null); }}><p className="modal-intro">Paste a note, a link, or something worth keeping. It will wait on your shelf.</p><textarea className="text-editor" autoFocus rows={8} placeholder="Put your words here…" value={textDraft} onChange={(event) => setTextDraft(event.target.value)} /><div className="modal-actions"><span className="keyboard-hint">⌘ / Ctrl + V also works on the shelf</span><button className="primary-button" disabled={!textDraft.trim() || !!busy}><Plus size={14} /> Add to shelf</button></div></form>}
        {modal === 'host' && <form onSubmit={saveMachine}>
          <p className="modal-intro">Use a LAN name, a Tailscale IP, or any SSH address. A successful SSH check makes it ready to receive.</p>
          {hostForm.error && <p className="settings-warning"><CircleAlert size={15} />{hostForm.error}</p>}
          <div className="form-grid"><label className="field">Machine name<input required autoFocus placeholder="e.g. Studio Mac" value={hostForm.name} onChange={(event) => setHostForm({ ...hostForm, name: event.target.value })} /></label><label className="field">Route<select value={hostForm.route} onChange={(event) => setHostForm({ ...hostForm, route: event.target.value })}><option value="ssh">SSH</option><option value="lan">LAN</option><option value="tailscale">Tailscale</option></select></label><label className="field wide">Address<input required placeholder="100.x.x.x or studio.local" value={hostForm.address} onChange={(event) => setHostForm({ ...hostForm, address: event.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label><label className="field">Login username<input required placeholder="Your remote account" value={hostForm.user} onChange={(event) => setHostForm({ ...hostForm, user: event.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label><label className="field">SSH port<input type="number" min="1" max="65535" required value={hostForm.port} onChange={(event) => setHostForm({ ...hostForm, port: event.target.value })} /></label><label className="field wide">Destination folder<input required placeholder={hostForm.os === 'windows' ? 'C:/Users/you/Desktop' : '~/Desktop'} value={hostForm.destination} onChange={(event) => setHostForm({ ...hostForm, destination: event.target.value })} spellCheck={false} /><small>Files are delivered in a new batch folder to prevent overwriting.</small></label><label className="field">Remote operating system<select value={hostForm.os || 'posix'} onChange={(event) => setHostForm({ ...hostForm, os: event.target.value })}><option value="posix">macOS / Linux</option><option value="windows">Windows</option></select></label><label className="field">SSH alias <span>optional</span><input placeholder="Existing SSH host alias" value={hostForm.sshAlias || ''} onChange={(event) => setHostForm({ ...hostForm, sshAlias: event.target.value })} spellCheck={false} /></label><label className="field wide">SSH key path <span>optional</span><input placeholder="~/.ssh/id_ed25519" value={hostForm.identityFile || ''} onChange={(event) => setHostForm({ ...hostForm, identityFile: event.target.value })} spellCheck={false} /><small>Leave empty to use your SSH agent or SSH configuration. Private keys stay on this device.</small></label></div>
          <div className="modal-actions">{hostForm.id && hostForm.source === 'Manual' ? <button type="button" className="danger-button" onClick={async () => { if (await action('removeHost', hostForm.id)) setModal(null); }}><Trash2 size={13} /> Remove</button> : <span className="keyboard-hint">{hostForm.id ? `Imported from ${hostForm.source}; edits are stored in ${productName}.` : 'You can edit this later.'}</span>}<button className="primary-button" disabled={!!busy}><Check size={14} /> Save & set up access</button></div>
        </form>}
        {modal === 'batch' && batchReview && <div className="batch-review"><p className="modal-intro">Send <strong>{reviewItems.length} {reviewItems.length === 1 ? 'item' : 'items'}</strong> to <strong>{reviewHosts.length} {reviewHosts.length === 1 ? 'machine' : 'machines'}</strong>. Each machine gets its own copy. Your shelf keeps the originals.</p><h3>Destination machines</h3><ul className="batch-review-hosts">{reviewHosts.map((host, index) => <li key={batchReview.hostIds[index]}><Monitor size={15} /><div><strong>{host?.name || 'Machine removed'}</strong><span>{host ? `${host.user ? `${host.user}@` : ''}${host.address}` : 'Close this review and update your selections.'}</span><small>{host?.destination || '~/Desktop'}</small></div><span className={`host-status ${host?.status}`}>{host ? statusLabel(host.status) : 'Missing'}</span></li>)}</ul><h3>Items to copy</h3><ul className="batch-review-items">{reviewItems.map((item, index) => <li key={batchReview.itemIds[index]}><File size={13} /><span>{item?.name || 'Item removed'}</span></li>)}</ul><p className="access-help">Transfers run on up to two machines at a time. Activity shows success or failure for each destination. Dropping on a machine still sends only to that machine.</p>{!batchReviewValid && <p className="access-error" role="alert">A selected machine or item is no longer ready. Close this review and check your selections.</p>}<div className="modal-actions"><button className="quiet-button" onClick={closeModal}>Cancel</button><button className="primary-button" disabled={!batchReviewValid || !!busy || sending} onClick={sendBatch}><Send size={14} /> Send {reviewItems.length} {reviewItems.length === 1 ? 'item' : 'items'} to {reviewHosts.length} {reviewHosts.length === 1 ? 'machine' : 'machines'}</button></div></div>}
        {modal === 'access' && accessHost && <form className="access-form" onSubmit={configureAccess} aria-busy={settingUpAccess}>
          <p className="modal-intro">Choose how to connect to <strong>{accessHost.name}</strong>. Setting up access does not send your shelf items.</p>
          <div className="access-machine"><Monitor size={17} /><div><strong>{accessHost.name}</strong><span>{accessHost.user ? `${accessHost.user}@` : ''}{accessHost.address}:{accessHost.port || 22}</span></div><span className={`host-status ${accessHost.status}`}>{statusLabel(accessHost.status)}</span></div>
          <fieldset className="access-options" disabled={!!busy}>
            <legend>Connection method</legend>
            {[
              ['key', 'Use an existing SSH key', 'Use the key or SSH agent already configured on this device.'],
              ['once', 'Use password once', 'Create a key on this device, install its public key on this machine, and verify access. The password is not saved.'],
              ['saved', 'Save password securely', 'Use this password for future connections until you remove or replace it. It stays in encrypted storage on this device.'],
            ].map(([mode, title, description]) => <label className={`access-option ${accessMode === mode ? 'selected' : ''} ${mode === 'saved' && state.environment?.passwordStorageAvailable === false ? 'unavailable' : ''}`} key={mode}><input type="radio" name="access-mode" value={mode} checked={accessMode === mode} disabled={mode === 'saved' && state.environment?.passwordStorageAvailable === false} onChange={() => { setAccessMode(mode); setAccessPassword(''); setAccessError(''); }} /><span><strong>{title}</strong><small>{description}</small></span></label>)}
          </fieldset>
          {accessHost.hasSavedPassword && <div className="saved-access"><span><KeyRound size={13} /> A password is saved on this device.</span><button type="button" className="text-button" disabled={!!busy || sending} onClick={forgetPassword}>Forget password</button></div>}
          {accessHost.passwordPaused && <p className="access-error" role="alert"><CircleAlert size={15} /><span>The saved password did not work. Automatic retries are paused. Re-enter your password to try again.</span></p>}
          {accessMode === 'key' && accessHost.hasSavedPassword && <p className="access-help">Switching to an SSH key removes this machine’s saved password from this device.</p>}
          {state.environment?.passwordStorageAvailable === false && <p className="access-help">Secure password storage is unavailable on this device. You can still use a password once to set up an SSH key.</p>}
          {accessMode !== 'key' && <label className="field access-password">{accessHost.hasSavedPassword && accessMode === 'saved' ? 'Replacement password' : 'Machine login password'}<input name="remote-password" type="password" autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={1024} disabled={!!busy || isDemo} value={accessPassword} onChange={(event) => setAccessPassword(event.target.value)} aria-describedby="access-password-help" /><small id="access-password-help">Use the password for {accessHost.user || 'your account'} on this machine. Passwords are excluded from configuration exports.</small></label>}
          <p className="access-prerequisites"><KeyRound size={14} /><span>SSH must already be running and reachable. Connect once in your terminal to verify and trust the machine’s SSH fingerprint. This setup cannot turn on a remote SSH server that is unavailable.</span></p>
          {isDemo && <p className="access-help">Preview only. Open the desktop app to set up access; password entry is disabled here.</p>}
          {accessError && <p className="access-error" role="alert"><CircleAlert size={15} /><span>{accessError}</span></p>}
          {settingUpAccess && <p className="access-progress" role="status"><Loader2 size={14} className="spinning" />{busy === 'forgetPassword' ? 'Removing the saved password…' : accessMode === 'once' ? 'Connecting, installing your public key, and verifying access…' : 'Connecting and verifying access…'}</p>}
          <div className="modal-actions"><button type="button" className="quiet-button" disabled={settingUpAccess} onClick={closeModal}>Done</button><button className="primary-button" disabled={!!busy || sending || isDemo || (accessMode !== 'key' && !accessPassword)}>{settingUpAccess ? <Loader2 size={14} className="spinning" /> : <KeyRound size={14} />}{accessMode === 'once' ? 'Set up SSH key' : accessMode === 'saved' ? accessHost.hasSavedPassword ? 'Replace & connect' : 'Save & connect' : accessHost.hasSavedPassword ? 'Use SSH key' : 'Check SSH access'}</button></div>
        </form>}
        {modal === 'settings' && <div className="settings-content"><div className="setting-row"><div><strong>Shake to show or hide</strong><p>A quick back and forth shows the shelf. Pause briefly, then shake again to hide it. Dragging and open dialogs keep it visible.</p></div><button role="switch" aria-checked={!!state.settings?.shakeEnabled} aria-label="Shake to show or hide" className={`switch ${state.settings?.shakeEnabled ? 'on' : ''}`} onClick={() => action('updateSettings', { shakeEnabled: !state.settings?.shakeEnabled })}><span /></button></div><label className="setting-row"><div><strong>Shake sensitivity</strong><p>Choose how much movement shows or hides the shelf. More deliberate is the default.</p></div><select value={state.settings?.sensitivity || 'strong'} onChange={(event) => action('updateSettings', { sensitivity: event.target.value })}><option value="gentle">More sensitive</option><option value="normal">Balanced</option><option value="strong">More deliberate</option></select></label>
          <label className="setting-row"><div><strong>Display density</strong><p>Choose how much detail appears in each row.</p></div><select aria-label="View size" disabled={!!busy} value={state.settings?.viewMode || 'expanded'} onChange={(event) => action('updateSettings', { viewMode: event.target.value })}><option value="compact">Compact</option><option value="expanded">Balanced</option><option value="large">Expanded</option></select></label>
          <div className="setting-row"><div><strong>Enable Clipboard tools</strong><p>Optional history, favourites and snippets. Off by default. Turning this off stops recording and keeps saved items; re-enable history separately when ready.</p></div><button role="switch" aria-checked={state.clipboardTools?.enabled === true} aria-label="Enable Clipboard tools" disabled={!!busy} className={`switch ${state.clipboardTools?.enabled ? 'on' : ''}`} onClick={() => action('updateClipboardTools', { enabled: !state.clipboardTools?.enabled })}><span /></button></div>
          <div className="setting-row"><div><strong>Show Clipboard tab</strong><p>Hide the tab to keep the workspace focused. Hiding does not pause history that you have enabled. {state.clipboardTools?.historyEnabled ? 'Automatic history is on.' : 'Automatic history is off.'}</p></div><button role="switch" aria-checked={state.clipboardTools?.showTab !== false} aria-label="Show Clipboard tab" disabled={!!busy || !state.clipboardTools?.enabled} className={`switch ${state.clipboardTools?.showTab !== false ? 'on' : ''}`} onClick={() => action('updateClipboardTools', { showTab: state.clipboardTools?.showTab === false })}><span /></button></div>
          <ClipboardSyncSettings state={state} busy={busy} action={action} />
          <div className="settings-note"><Clipboard size={17} /><div><strong>Paste when you choose.</strong><p>Use Paste from clipboard or ⌘ / Ctrl + V on the shelf to collect copied files, an image, or plain text. Pasting only adds items; drag them onto a machine to send. Clipboard tools are optional. After enabling them in Settings, separately choose automatic history in Clipboard; enabling tools alone does not record anything. When enabled, it saves copies locally and pauses during editing or password setup. Copies are never sent automatically.</p></div></div>
          <div className="settings-note"><KeyRound size={17} /><div><strong>Ready means SSH is verified.</strong><p>Use a machine’s Access button to connect with an SSH key, set one up with a password used once, or securely save a password. SSH must already be running, and the machine’s fingerprint must be trusted. Keep Tailscale running for Tailscale routes. Drop items on a ready machine or press Send to transfer them.</p></div></div>
          {!isDemo && <div className="settings-note"><MousePointer2 size={17} /><div><strong>A keyboard shortcut, too.</strong><p>{state.environment?.shortcutAvailable === false ? `The keyboard shortcut couldn’t register on this device. Open ${productName} from the tray. Escape tucks it away.` : `Press ⌘ / Ctrl + Shift + Space to show or hide ${productName}. Escape also hides it.`}</p></div></div>}
          <div className="settings-note"><Folder size={17} /><div><strong>A fresh folder on the Desktop.</strong><p>Each transfer gets its own folder inside the machine’s destination. Your shelf keeps the original items so you can send them again.</p></div></div>
          {state.environment?.wayland && <p className="settings-warning"><CircleAlert size={15} />Global cursor detection is limited on Wayland. Open {productName} from the tray or use its shortcut.</p>}
          {state.environment?.sshAvailable === false && <p className="settings-warning"><CircleAlert size={15} />SSH is missing on this device. Install the OpenSSH client to enable transfers.</p>}
          {warnings.length > 0 && <div className="discovery-warnings"><strong>Discovery notices</strong>{warnings.map((warning, index) => <p key={index}>{typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)}</p>)}</div>}
          <div className="setting-row"><div><strong>Name this device</strong><p>Optional name shown on new arrivals sent from here. Leave blank to use “Another computer”.</p></div></div><form className="device-name-setting" onSubmit={async event => { event.preventDefault(); if (await action('updateSettings', { deviceName: deviceNameDraft })) noticeNow('Device name saved. Future transfers will use it.'); }}><input aria-label="This device’s name" maxLength={64} placeholder="For example, Work laptop" value={deviceNameDraft} onChange={event => setDeviceNameDraft(event.target.value)} /><button className="quiet-button" disabled={!!busy} type="submit">Save name</button></form>
          <div className="setting-row"><div><strong>Quick start</strong><p>Replay the short introduction. It only explains {productName} and does not change settings.</p></div><button type="button" className="quiet-button" aria-label="Replay quick start" onClick={replayQuickStart}>Replay</button></div>
          <div className="setting-row"><div><strong>Feature guide</strong><p>Two or three steps for each part of {productName}, whenever you want them.</p></div><button type="button" className="quiet-button" aria-label="Open feature guide" onClick={openFeatureGuide}>Open</button></div>
          <div className="setting-row"><div><strong>Updates</strong><p>Check releases, choose automatic checks, and download a verified update. Restart only when you are ready.</p></div><button className="quiet-button" onClick={() => setModal('updates')}><Download size={14} /> {state.updatesSummary?.downloadedVersion ? 'Update ready' : state.updatesSummary?.availableVersion ? 'Update available' : 'Manage updates'}</button></div>
          <div className="configuration-panel"><strong>Take your setup with you.</strong><p>Export machine names, routes, and preferences for another device. Passwords, private keys, and shelf or clipboard content are excluded. The new device still needs its own SSH access.</p><div className="configuration-actions"><button className="quiet-button" disabled={!!busy} onClick={async () => { if (await action('exportConfig')) noticeNow('Configuration exported.'); }}><Download size={13} /> Export configuration</button><button className="quiet-button" disabled={!!busy} onClick={async () => { if (await action('importConfig')) noticeNow('Configuration imported. Check SSH before sending.'); }}><Upload size={13} /> Import configuration</button></div></div>
          <div className="modal-actions"><button className="text-button" onClick={() => action('openSettingsFolder')}>Open settings folder <ArrowUpRight size={12} /></button><button className="quiet-button" onClick={() => isDemo ? noticeNow('Quit is available in the desktop app.') : bridge.quit()}>Quit {productName}</button></div>
        </div>}
      </section></div>}
      <input type="file" multiple ref={fileInput} hidden onChange={async (event) => { const paths = Array.from(event.target.files || []).map((file) => file.name); if (paths.length) await action('enqueueFiles', paths); event.target.value = ''; }} />
    </div>
  );
}

export default App;
