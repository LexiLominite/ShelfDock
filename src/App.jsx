import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleAlert, Clipboard, Download, File, FileText, Folder, History, KeyRound, Laptop, Loader2, Monitor, MousePointer2, Network, Pencil, Plus, RefreshCw, Search, Send, Server, Settings2, Trash2, Upload, Wifi, X } from 'lucide-react';

const ITEM_MIME = 'application/x-drift-items';
const emptyState = { hosts: [], items: [], history: [], settings: { shakeEnabled: true, sensitivity: 'normal', viewMode: 'expanded' }, discovery: { warnings: [], lastScan: null }, environment: {} };
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
const statusLabel = (status) => ({ ready: 'Ready', 'auth-required': 'Needs key', offline: 'Offline', checking: 'Checking', unknown: 'Unchecked' })[status] || 'Unchecked';
const hostIcon = (host) => /spark|server/i.test(host.name) ? Server : /book|laptop/i.test(host.name) ? Laptop : Monitor;
const orderHosts = (hosts) => { const rank = { ready: 0, checking: 1, unknown: 2, 'auth-required': 3, offline: 4 }; return [...hosts].sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2)); };

function App() {
  const bridge = window.drift;
  const productName = bridge?.productName || 'DropHarbor';
  useEffect(() => { document.title = productName; }, [productName]);
  const isDemo = !bridge;
  const [state, setState] = useState(isDemo ? demoState : emptyState);
  const stateRef = useRef(state);
  const [loading, setLoading] = useState(!isDemo);
  const [machinesOpen, setMachinesOpen] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedHost, setSelectedHost] = useState('');
  const [selectedItems, setSelectedItems] = useState([]);
  const [trayDrag, setTrayDrag] = useState(false);
  const [dragHost, setDragHost] = useState('');
  const [dragging, setDragging] = useState(false);
  const [dragSnapshot, setDragSnapshot] = useState(null);
  const [modal, setModal] = useState(null);
  const [hostForm, setHostForm] = useState(freshHost);
  const [textDraft, setTextDraft] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reveal, setReveal] = useState(false);
  const fileInput = useRef(null);
  const noticeTimer = useRef(null);
  const dragDepth = useRef(0);
  const transferLock = useRef(false);
  const clipboardLock = useRef(false);
  const suppressPasteUntil = useRef(0);
  const modalRef = useRef(null);
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
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    Promise.resolve(bridge.getState()).then((next) => { if (mounted) applyState(next); }).catch((error) => noticeNow(error.message || `Could not load ${productName}.`, 'error')).finally(() => { if (mounted) setLoading(false); });
    const offState = bridge.onState?.(applyState);
    const offReveal = bridge.onReveal?.(() => { setReveal(true); setTimeout(() => setReveal(false), 600); });
    return () => { mounted = false; offState?.(); offReveal?.(); };
  }, [bridge, applyState, noticeNow]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    window.addEventListener('dragend', endDrag);
    window.addEventListener('blur', endDrag);
    return () => { window.removeEventListener('dragend', endDrag); window.removeEventListener('blur', endDrag); };
  }, [endDrag]);
  useEffect(() => { if (!dragging) setDragSnapshot(null); }, [dragging]);
  useEffect(() => {
    if (typeof bridge?.setInteraction !== 'function') return;
    Promise.resolve(bridge.setInteraction({ dragging: Boolean(dragging), editing: Boolean(modal) })).catch(() => {});
  }, [bridge, dragging, modal]);
  useEffect(() => { setSelectedItems((ids) => ids.filter((id) => state.items.some((item) => item.id === id))); }, [state.items]);
  useEffect(() => {
    if (!modal) return;
    const before = document.activeElement;
    setTimeout(() => (modalRef.current?.querySelector('input, textarea, select') || modalRef.current?.querySelector('button'))?.focus(), 0);
    const trap = (event) => {
      if (event.key === 'Escape') { setModal(null); return; }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(modalRef.current?.querySelectorAll('button:not(:disabled), input, textarea, select, [tabindex="0"]') || []);
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); before?.focus?.(); };
  }, [modal]);
  useEffect(() => {
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      endDrag();
      if (modal) return;
      if (historyOpen) { setHistoryOpen(false); return; }
      if (isDemo) { setMachinesOpen(false); return; }
      bridge.hideWindow();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [modal, historyOpen, bridge, isDemo, endDrag]);

  const demoCall = async (method, value) => {
    const current = stateRef.current;
    let next = structuredClone(current);
    if (method === 'enqueueFiles') next.items.push(...value.map((path) => ({ id: uid(), name: path.split(/[\\/]/).at(-1), path, kind: 'file', size: 0 })));
    if (method === 'enqueueText') next.items.push({ id: uid(), name: value.trim().split('\n')[0].slice(0, 36) || 'Text note', kind: 'text', preview: value, size: new TextEncoder().encode(value).length });
    if (['enqueueFiles', 'enqueueText'].includes(method)) next.enqueuedItemIds = next.items.slice(current.items.length).map((item) => item.id);
    if (method === 'removeItem') next.items = next.items.filter((item) => item.id !== value);
    if (method === 'clearItems') next.items = [];
    if (method === 'saveHost') {
      const index = next.hosts.findIndex((host) => host.id === value.id);
      const host = { ...value, id: value.id || uid(), source: 'Manual', status: 'unknown' };
      if (index >= 0) next.hosts[index] = host; else next.hosts.push(host);
    }
    if (method === 'removeHost') next.hosts = next.hosts.filter((host) => host.id !== value);
    if (method === 'updateSettings') next.settings = { ...next.settings, ...value };
    if (method === 'send') {
      next.history.unshift({ id: uid(), hostName: next.hosts.find((host) => host.id === value.hostId)?.name || 'Machine', itemCount: value.itemIds.length, status: 'failed', message: 'Demo preview: no files were transferred. Open the desktop application to send.', timestamp: new Date().toISOString() });
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
    setBusy(method);
    try { const next = await call(method, value); if (success) noticeNow(success); return next; }
    catch (error) { noticeNow(error.message || 'Something went wrong. Please try again.', 'error'); return null; }
    finally { setBusy(''); }
  };
  const addText = async (text) => {
    if (!text?.trim()) return null;
    return action('enqueueText', text, 'Text added to your shelf.');
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
    const editable = (event) => modal || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName || '') || event.target?.isContentEditable;
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
  }, [modal, isDemo, busy]);
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
    if (event.dataTransfer.types.includes(ITEM_MIME)) return;
    try { await extractExternal(event.dataTransfer); noticeNow('Added to your shelf. Drop it on a machine when you’re ready.'); }
    catch (error) { noticeNow(error.message, 'error'); }
  };
  const sendItems = async (hostId, ids) => {
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
    if (host.status !== 'ready' || busy === 'send') { noticeNow(host.status !== 'ready' ? 'This machine needs a successful SSH check before you can send.' : 'A transfer is already in progress.', 'error'); return; }
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
  const openHost = (host) => { setHostForm(host ? { ...host } : freshHost()); setModal('host'); };
  const activeHost = state.hosts.find((host) => host.id === selectedHost);
  const displayHosts = dragSnapshot ? dragSnapshot.map((host) => state.hosts.find((latest) => latest.id === host.id) || host) : orderHosts(state.hosts);
  const visibleHosts = displayHosts.filter((host) => (filter === 'all' || host.route === filter) && `${host.name} ${host.address} ${host.user} ${host.sshAlias || ''}`.toLowerCase().includes(search.toLowerCase()));
  const recentHistory = state.history.slice(0, 5);
  const warnings = state.discovery?.warnings || [];
  const lastSentItemIds = new Set(state.history.filter((entry) => entry.status === 'sent').flatMap((entry) => entry.itemIds || []));
  const sending = state.history.some((entry) => entry.status === 'sending') || busy === 'send';

  return (
    <div className={`app view-${state.settings?.viewMode || 'expanded'} ${machinesOpen ? 'machines-open' : ''} ${dragging ? 'is-dragging' : ''} ${reveal ? 'revealed' : ''}`} onDragEnter={() => { if (!dragging) { setDragSnapshot(orderHosts(stateRef.current.hosts)); setDragging(true); } setMachinesOpen(true); }} onDragLeave={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return; if (event.target === event.currentTarget || event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom || (event.clientX === 0 && event.clientY === 0)) endDrag(); }} onDragOver={(event) => { event.preventDefault(); if (!machinesOpen) setMachinesOpen(true); }} onDrop={(event) => { event.preventDefault(); endDrag(); }}>
      <header className="titlebar">
        <div className="brand"><span className="brand-icon"><span /><span /><span /></span><span>{productName}<span className="brand-period">.</span></span></div>
        <div className="header-actions">
          {isDemo && <span className="demo-label">Demo preview</span>}
          <button className={`machines-toggle ${machinesOpen ? 'active' : ''}`} onMouseEnter={() => setMachinesOpen(true)} onFocus={() => setMachinesOpen(true)} onClick={() => setMachinesOpen(true)} aria-expanded={machinesOpen} aria-controls="machines-pane"><Monitor size={15} /> Machines <span className="count">{state.hosts.length}</span><ChevronDown size={13} /></button>
          <button className="icon-button" aria-label="Settings" title="Settings" onClick={() => setModal('settings')}><Settings2 size={17} /></button>
          <span className="header-divider" />
          <button className="icon-button hide-button" aria-label={`Hide ${productName}`} title={`Hide ${productName} · shake or press ⌘ / Ctrl + Shift + Space to show it again`} onClick={() => isDemo ? noticeNow(`In the desktop app, ${productName} tucks into your menu bar.`) : bridge.hideWindow()}><X size={17} /></button>
        </div>
      </header>

      <main className="workspace">
        <section className="shelf-pane" aria-label="File and text shelf">
          <div className="shelf-heading"><div><p className="eyebrow">Your file & text shelf</p><h1>Pick it up.<br />Move it over.</h1></div><div className="shelf-counter" title="Items on your shelf">{state.items.length}<span>on your shelf</span></div></div>
          <div className={`drop-tray ${trayDrag ? 'drag-over' : ''} ${state.items.length ? 'has-items' : ''}`} onDragEnter={(event) => { event.preventDefault(); if (event.dataTransfer.types.includes(ITEM_MIME)) return; dragDepth.current += 1; setTrayDrag(true); }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) setTrayDrag(false); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={dropTray}>
            {!state.items.length ? <div className="empty-tray">
              <div className="file-illustration" aria-hidden="true"><div className="paper paper-back"><span /><span /><span /></div><div className="paper paper-front"><FileText size={26} strokeWidth={1.3} /><span /><span /></div><div className="floating-plus"><Plus size={17} /></div></div>
              <h2>{trayDrag ? 'Let it land here.' : 'Drop a little something.'}</h2><p>Files, folders, or a piece of text.<br />They stay here until you move them.</p>
              <div className="tray-actions"><button className="quiet-button" onClick={pickFiles}><Plus size={14} /> Add files</button><button className="quiet-button" disabled={!!busy} onClick={captureClipboard} title="Paste copied files, an image, or text · ⌘ / Ctrl + V">{busy === 'captureClipboard' ? <Loader2 size={14} className="spinning" /> : <Clipboard size={14} />} {busy === 'captureClipboard' ? 'Pasting…' : 'Paste from clipboard'}</button><button className="text-button" onClick={() => { setTextDraft(''); setModal('text'); }}>Add text <ArrowUpRight size={13} /></button></div>
            </div> : <>
              <div className="queue-toolbar"><span>{selectedItems.length ? `${selectedItems.length} selected` : 'Your shelf'}</span><div><button onClick={() => setSelectedItems(selectedItems.length === state.items.length ? [] : state.items.map((item) => item.id))}>{selectedItems.length === state.items.length ? 'Deselect' : 'Select all'}</button><button className="icon-button small" title="Add files" aria-label="Add files" onClick={pickFiles}><Plus size={15} /></button></div></div>
              <div className="item-list">{state.items.map((item) => { const Icon = item.kind === 'text' ? FileText : item.kind === 'folder' ? Folder : File; return <div key={item.id} className={`shelf-item ${selectedItems.includes(item.id) ? 'selected' : ''}`} draggable onDragStart={(event) => startItemDrag(event, item)} onDragEnd={() => { setDragging(false); setDragHost(''); }} title={`Drag ${item.name} onto a ready machine`}>
                <button className="item-select" aria-pressed={selectedItems.includes(item.id)} aria-label={`${selectedItems.includes(item.id) ? 'Deselect' : 'Select'} ${item.name}`} onClick={() => setSelectedItems((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id])}><span className={`item-icon ${item.kind}`}><Icon size={20} strokeWidth={1.6} />{selectedItems.includes(item.id) && <span className="selected-check"><Check size={9} strokeWidth={3} /></span>}</span><span className="item-description"><strong>{item.name}</strong><span>{item.kind === 'text' ? item.preview?.replace(/\s+/g, ' ').slice(0, 68) : item.kind === 'folder' ? 'Folder' : formatSize(item.size) || 'File'}{lastSentItemIds.has(item.id) ? ' · Sent' : ''}</span></span></button>
                <button className="icon-button item-remove" aria-label={`Remove ${item.name} from shelf`} onClick={() => action('removeItem', item.id)}><X size={13} /></button>
              </div>; })}</div>
              <div className="queue-foot"><span><MousePointer2 size={13} /> Drag onto a machine</span><div className="queue-actions"><button className="text-button" disabled={!!busy} onClick={captureClipboard} title="Paste copied files, an image, or text · ⌘ / Ctrl + V">{busy === 'captureClipboard' ? <Loader2 size={13} className="spinning" /> : <Clipboard size={13} />} {busy === 'captureClipboard' ? 'Pasting…' : 'Paste from clipboard'}</button><button className="text-button" onClick={() => { setTextDraft(''); setModal('text'); }}><Plus size={13} /> Add text</button></div></div>
            </>}
            {trayDrag && state.items.length > 0 && <div className="drop-overlay"><Plus size={25} /><strong>Add to your shelf</strong></div>}
          </div>
          <div className="shelf-bottom"><span title={`Shake once to show ${productName}. Pause briefly, then shake again to hide. ⌘ / Ctrl + Shift + Space also toggles the shelf.`}><MousePointer2 size={13} /> {isDemo ? 'Shake to show or hide in the desktop app' : state.settings?.shakeEnabled ? 'Shake to show / hide · ⌘ / Ctrl + Shift + Space' : state.environment?.shortcutAvailable === false ? `Open ${productName} from your tray` : 'Show / hide · ⌘ / Ctrl + Shift + Space'}</span>{state.items.length > 0 && <button className="text-button muted" onClick={() => action('clearItems')}>Clear shelf</button>}</div>
          {state.items.length > 0 && <div className="send-bar"><span>{activeHost ? <><span className={`tiny-dot ${activeHost.status}`} /> {activeHost.name}<small>{activeHost.destination || '~/Desktop'}</small></> : 'Choose a machine, or drop an item on one.'}</span><button className="primary-button compact" disabled={!activeHost || activeHost.status !== 'ready' || !selectedItems.length || sending} onClick={() => sendItems(activeHost.id, selectedItems)}>{sending ? <Loader2 size={14} className="spinning" /> : <Send size={13} />} Send{selectedItems.length > 0 ? ` ${selectedItems.length}` : ''}</button></div>}
        </section>

        {machinesOpen && <aside className="machines-pane" id="machines-pane" aria-label="Machines">
          <div className="pane-heading"><div><p className="eyebrow">LAN, Tailscale & SSH</p><h2>Machines</h2></div><button className="icon-button small" aria-label="Close machines" onClick={() => !dragging && setMachinesOpen(false)}><X size={15} /></button></div>
          <p className="machines-intro">Drop on a ready machine to send.<br />Clicking only selects it.</p>
          <div className="machine-search"><Search size={14} /><input aria-label="Search machines" placeholder="Find a machine…" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={12} /></button>}</div>
          <div className="route-tabs" role="group" aria-label="Connection route">{[['all', 'All'], ['tailscale', 'Tailscale'], ['lan', 'LAN'], ['ssh', 'SSH']].map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
          <div className="machine-list">{loading ? <div className="empty-machines"><Loader2 size={22} className="spinning" /><p>Finding your machines…</p></div> : visibleHosts.length === 0 ? <div className="empty-machines"><Network size={24} /><strong>{search ? 'No matches' : 'A place to start'}</strong><p>{search ? 'Try another name or address.' : 'Import Wave and SSH connections, or add a machine yourself.'}</p></div> : visibleHosts.map((host) => { const Icon = hostIcon(host); const ready = host.status === 'ready'; return <div key={host.id} className={`machine-target ${selectedHost === host.id ? 'selected' : ''} ${dragHost === host.id ? ready ? 'drop-ready' : 'drop-blocked' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragHost(host.id); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragHost(''); }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = ready && !sending ? 'copy' : 'none'; setDragHost(host.id); }} onDrop={(event) => dropHost(event, host)}>
            <button className="machine-main" aria-pressed={selectedHost === host.id} onClick={() => setSelectedHost(host.id)} title={host.error || `${host.user ? `${host.user}@` : ''}${host.address}:${host.port || 22}`} aria-label={`Select ${host.name}, ${routeLabel(host.route)}, ${statusLabel(host.status)}`}><span className="machine-icon"><Icon size={19} strokeWidth={1.6} /></span><span className="machine-info"><strong>{host.name}</strong><span>{host.user ? `${host.user}@` : ''}{host.address}</span></span>{selectedHost === host.id && <Check size={13} className="host-check" />}</button>
            <div className="machine-details"><span className={`host-status ${host.status}`}><span className={`tiny-dot ${host.status}`} />{statusLabel(host.status)}</span><span className="route-label">{host.route === 'tailscale' ? <Wifi size={10} /> : <Network size={10} />}{routeLabel(host.route)}</span><span className="source-label">{host.source}</span><button className="edit-host" title={`Edit ${host.name}`} aria-label={`Edit ${host.name}`} onClick={() => openHost(host)}><Pencil size={11} /></button></div>
            <div className="destination-line" title={host.destination || '~/Desktop'}>{dragHost === host.id ? ready ? <><ArrowDownToLine size={12} /> Release to send to {host.destination || '~/Desktop'}</> : <><KeyRound size={11} /> {host.status === 'offline' ? 'Machine unavailable' : 'Check SSH access first'}</> : <><Folder size={11} /> {host.destination || '~/Desktop'}</>}</div>
          </div>; })}</div>
          <div className="machine-pane-bottom"><button className="add-machine" onClick={() => openHost()}><Plus size={15} /> Add a machine <span>manually</span></button><div className="discovery-actions"><button disabled={!!busy} onClick={() => action('refreshHosts')}><RefreshCw size={12} className={busy === 'refreshHosts' ? 'spinning' : ''} /> Import / refresh</button><button disabled={!!busy} onClick={() => action('probeHosts')}><CheckCheck size={13} className={busy === 'probeHosts' ? 'spinning' : ''} /> Check SSH</button></div></div>
        </aside>}
      </main>

      <footer className="app-footer"><button className={`history-toggle ${historyOpen ? 'active' : ''}`} onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}><History size={13} /> Activity {state.history.length > 0 && <span>{state.history.length}</span>}<ChevronDown size={11} /></button><span className="footer-hint">{sending ? <><Loader2 size={11} className="spinning" /> Transfer in progress</> : <><span className="tiny-dot ready" /> {state.hosts.filter((host) => host.status === 'ready').length} ready {isDemo ? '· Preview' : '· SSH encrypted'}</>}</span>{warnings.length > 0 && <button className="warning-indicator" title="View discovery notices" onClick={() => setModal('settings')}><CircleAlert size={12} /> {warnings.length}</button>}</footer>
      {historyOpen && <section className="history-panel" aria-label="Transfer activity"><div className="history-heading"><strong>Transfer activity</strong><button className="icon-button small" aria-label="Close activity" onClick={() => setHistoryOpen(false)}><X size={14} /></button></div>{recentHistory.length ? recentHistory.map((entry) => <div className="history-row" key={entry.id}><span className={`history-icon ${entry.status}`}>{entry.status === 'sending' ? <Loader2 size={14} className="spinning" /> : entry.status === 'sent' ? <Check size={14} /> : <CircleAlert size={14} />}</span><div><strong>{entry.itemCount} {entry.itemCount === 1 ? 'item' : 'items'} → {entry.hostName}</strong><p>{entry.message || (entry.status === 'sent' ? 'Delivered. Your shelf items remain available.' : entry.status === 'sending' ? 'Sending securely over SSH…' : 'Transfer failed.')}</p></div><time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time></div>) : <div className="history-empty">Your transfers will appear here.</div>}</section>}
      {notice && <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' ? <Check size={15} /> : notice.kind === 'error' ? <CircleAlert size={15} /> : <span className="toast-dot" />}<span>{notice.message}</span><button aria-label="Dismiss notice" onClick={() => setNotice(null)}><X size={13} /></button></div>}

      {modal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}><section className={`modal ${modal === 'host' ? 'host-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={modalRef}>
        <div className="modal-header"><h2 id="modal-title">{modal === 'host' ? hostForm.id ? 'Edit machine' : 'Add a machine' : modal === 'text' ? 'Add text' : `${productName} settings`}</h2><button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}><X size={17} /></button></div>
        {modal === 'text' && <form onSubmit={async (event) => { event.preventDefault(); const next = await addText(textDraft); if (next) setModal(null); }}><p className="modal-intro">Paste a note, a link, or something worth keeping. It will wait on your shelf.</p><textarea className="text-editor" autoFocus rows={8} placeholder="Put your words here…" value={textDraft} onChange={(event) => setTextDraft(event.target.value)} /><div className="modal-actions"><span className="keyboard-hint">⌘ / Ctrl + V also works on the shelf</span><button className="primary-button" disabled={!textDraft.trim() || !!busy}><Plus size={14} /> Add to shelf</button></div></form>}
        {modal === 'host' && <form onSubmit={async (event) => { event.preventDefault(); const next = await action('saveHost', { ...hostForm, name: hostForm.name.trim(), address: hostForm.address.trim(), user: hostForm.user.trim(), port: Number(hostForm.port) }); if (next) { setModal(null); noticeNow('Machine saved. Use Check SSH to verify access.'); } }}>
          <p className="modal-intro">Use a LAN name, a Tailscale IP, or any SSH address. A successful SSH check makes it ready to receive.</p>
          {hostForm.error && <p className="settings-warning"><CircleAlert size={15} />{hostForm.error}</p>}
          <div className="form-grid"><label className="field">Machine name<input required autoFocus placeholder="e.g. Studio Mac" value={hostForm.name} onChange={(event) => setHostForm({ ...hostForm, name: event.target.value })} /></label><label className="field">Route<select value={hostForm.route} onChange={(event) => setHostForm({ ...hostForm, route: event.target.value })}><option value="ssh">SSH</option><option value="lan">LAN</option><option value="tailscale">Tailscale</option></select></label><label className="field wide">Address<input required placeholder="100.x.x.x or studio.local" value={hostForm.address} onChange={(event) => setHostForm({ ...hostForm, address: event.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label><label className="field">Login username<input required placeholder="Your remote account" value={hostForm.user} onChange={(event) => setHostForm({ ...hostForm, user: event.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label><label className="field">SSH port<input type="number" min="1" max="65535" required value={hostForm.port} onChange={(event) => setHostForm({ ...hostForm, port: event.target.value })} /></label><label className="field wide">Destination folder<input required placeholder={hostForm.os === 'windows' ? 'C:/Users/you/Desktop' : '~/Desktop'} value={hostForm.destination} onChange={(event) => setHostForm({ ...hostForm, destination: event.target.value })} spellCheck={false} /><small>Files are delivered in a new batch folder to prevent overwriting.</small></label><label className="field">Remote operating system<select value={hostForm.os || 'posix'} onChange={(event) => setHostForm({ ...hostForm, os: event.target.value })}><option value="posix">macOS / Linux</option><option value="windows">Windows</option></select></label><label className="field">SSH alias <span>optional</span><input placeholder="Existing SSH host alias" value={hostForm.sshAlias || ''} onChange={(event) => setHostForm({ ...hostForm, sshAlias: event.target.value })} spellCheck={false} /></label><label className="field wide">SSH key path <span>optional</span><input placeholder="~/.ssh/id_ed25519" value={hostForm.identityFile || ''} onChange={(event) => setHostForm({ ...hostForm, identityFile: event.target.value })} spellCheck={false} /><small>Leave empty to use your SSH agent or SSH configuration. Private keys stay on this device.</small></label></div>
          <div className="modal-actions">{hostForm.id && hostForm.source === 'Manual' ? <button type="button" className="danger-button" onClick={async () => { if (await action('removeHost', hostForm.id)) setModal(null); }}><Trash2 size={13} /> Remove</button> : <span className="keyboard-hint">{hostForm.id ? `Imported from ${hostForm.source}; edits are stored in ${productName}.` : 'You can edit this later.'}</span>}<button className="primary-button" disabled={!!busy}><Check size={14} /> Save machine</button></div>
        </form>}
        {modal === 'settings' && <div className="settings-content"><div className="setting-row"><div><strong>Shake to show or hide</strong><p>A quick back and forth shows the shelf. Pause briefly, then shake again to hide it. Dragging and open dialogs keep it visible.</p></div><button role="switch" aria-checked={!!state.settings?.shakeEnabled} aria-label="Shake to show or hide" className={`switch ${state.settings?.shakeEnabled ? 'on' : ''}`} onClick={() => action('updateSettings', { shakeEnabled: !state.settings?.shakeEnabled })}><span /></button></div><label className="setting-row"><div><strong>Shake sensitivity</strong><p>Choose how much movement shows or hides the shelf.</p></div><select value={state.settings?.sensitivity || 'normal'} onChange={(event) => action('updateSettings', { sensitivity: event.target.value })}><option value="gentle">More sensitive</option><option value="normal">Balanced</option><option value="strong">More deliberate</option></select></label>
          <label className="setting-row"><div><strong>View size</strong><p>Keep it compact, or make room for more items.</p></div><select aria-label="View size" disabled={!!busy} value={state.settings?.viewMode || 'expanded'} onChange={(event) => action('updateSettings', { viewMode: event.target.value })}><option value="compact">Compact</option><option value="expanded">Expanded</option><option value="large">Large</option></select></label>
          <div className="settings-note"><Clipboard size={17} /><div><strong>Paste when you choose.</strong><p>Use Paste from clipboard or ⌘ / Ctrl + V on the shelf to collect copied files, an image, or plain text. Pasting only adds items; drag them onto a machine to send. {productName} does not watch or share your clipboard in the background.</p></div></div>
          <div className="settings-note"><KeyRound size={17} /><div><strong>Ready means SSH is verified.</strong><p>Connect once in your terminal and verify the machine’s fingerprint. Use your existing SSH key or agent, then Check SSH. Keep Tailscale running for Tailscale routes. Drop items on a ready machine or press Send to transfer them.</p></div></div>
          {!isDemo && <div className="settings-note"><MousePointer2 size={17} /><div><strong>A keyboard shortcut, too.</strong><p>{state.environment?.shortcutAvailable === false ? `The keyboard shortcut couldn’t register on this device. Open ${productName} from the tray. Escape tucks it away.` : `Press ⌘ / Ctrl + Shift + Space to show or hide ${productName}. Escape also hides it.`}</p></div></div>}
          <div className="settings-note"><Folder size={17} /><div><strong>A fresh folder on the Desktop.</strong><p>Each transfer gets its own folder inside the machine’s destination. Your shelf keeps the original items so you can send them again.</p></div></div>
          {state.environment?.wayland && <p className="settings-warning"><CircleAlert size={15} />Global cursor detection is limited on Wayland. Open {productName} from the tray or use its shortcut.</p>}
          {state.environment?.sshAvailable === false && <p className="settings-warning"><CircleAlert size={15} />SSH is missing on this device. Install the OpenSSH client to enable transfers.</p>}
          {warnings.length > 0 && <div className="discovery-warnings"><strong>Discovery notices</strong>{warnings.map((warning, index) => <p key={index}>{typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)}</p>)}</div>}
          <div className="configuration-panel"><strong>Take your setup with you.</strong><p>Export machine names, routes, and preferences for another device. Passwords, private keys, and shelf or clipboard content are excluded. The new device still needs its own SSH access.</p><div className="configuration-actions"><button className="quiet-button" disabled={!!busy} onClick={async () => { if (await action('exportConfig')) noticeNow('Configuration exported.'); }}><Download size={13} /> Export configuration</button><button className="quiet-button" disabled={!!busy} onClick={async () => { if (await action('importConfig')) noticeNow('Configuration imported. Check SSH before sending.'); }}><Upload size={13} /> Import configuration</button></div></div>
          <div className="modal-actions"><button className="text-button" onClick={() => action('openSettingsFolder')}>Open settings folder <ArrowUpRight size={12} /></button><button className="quiet-button" onClick={() => isDemo ? noticeNow('Quit is available in the desktop app.') : bridge.quit()}>Quit {productName}</button></div>
        </div>}
      </section></div>}
      <input type="file" multiple ref={fileInput} hidden onChange={async (event) => { const paths = Array.from(event.target.files || []).map((file) => file.name); if (paths.length) await action('enqueueFiles', paths); event.target.value = ''; }} />
    </div>
  );
}

export default App;
