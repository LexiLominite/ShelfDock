import React, { useEffect, useId, useRef, useState } from 'react';
import { Globe, ChevronDown, KeyRound, MoreHorizontal, Folder, Square, X, Check } from 'lucide-react';
import QuickConnect from './QuickConnect';
import { latestWebsitePlan, repeatSavedForward, stopForward } from './quick-connect.mjs';

const statusLabel = status => ({ready:'Ready',checking:'Checking',offline:'Offline','auth-required':'Needs access',unknown:'Unchecked'})[status] || 'Unchecked';
const routeLabel = route => ({tailscale:'Tailscale',lan:'LAN',ssh:'SSH'})[route] || 'SSH';

export default function MachineCard({ host, selected, batchSelected, batchDisabled, onSelect, onBatch, onAccess, onViewForwards, onMenu, menuOpen, dropState, dropHandlers, dragging, blocked, viewMode, bridge, snapshot, onSnapshot, onBusyChange, operationLocked, quickOpen, onQuickOpen, onQuickClose, quickMode = 'local', quickAdvanced = false, quickRevision = 0, receipts = [], items = [] }) {
  const [message, setMessage] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const [connecting, setConnecting] = useState(false);
  const [stopping, setStopping] = useState([]);
  const trigger = useRef(null);
  const popup = useRef(null);
  const alive = useRef(true);
  const expanded = viewMode === 'large';
  useEffect(() => { setDetailsOpen(false); }, [viewMode]);
  const active = snapshot.active.filter(entry => entry.hostId === host.id && ['starting','running'].includes(entry.status));
  const localActive = active.find(entry => entry.mode === 'local');
  const saved = latestWebsitePlan(snapshot, host.id);
  const metadata = `${host.user ? `${host.user}@` : ''}${host.address}:${host.port || 22} · ${routeLabel(host.route)} · ${host.destination || '~/Desktop'} · ${statusLabel(host.status)}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!quickOpen) return;
    const outside = event => { if (!popup.current?.contains(event.target) && !trigger.current?.contains(event.target) && !operationLocked()) onQuickClose(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [quickOpen, onQuickClose, operationLocked]);
  const close = () => { onQuickClose(); trigger.current?.focus(); };
  const connect = async event => {
    event.stopPropagation();
    if (dragging || blocked || connecting || operationLocked()) return;
    setMessage('');
    if (!saved || !bridge) { onQuickOpen(); return; }
    setConnecting(true);
    try {
      const result = await repeatSavedForward({ bridge, plan:saved, snapshot, onSnapshot, onBusyChange, open:true });
      if (result?.error) { setMessage(typeof result.error === 'string' ? result.error : result.error.message); onQuickOpen(); }
      else if (result?.needsUrl || !bridge.openTunnelSite || result?.entry?.status === 'starting') onQuickOpen();
    } catch (error) { if (alive.current) { setMessage(error.message || 'Could not connect.'); onQuickOpen(); } }
    finally { if (alive.current) setConnecting(false); }
  };
  const stop = async (event, id) => {
    event.stopPropagation();
    if (stopping.includes(id)) return;
    setStopping(ids => [...ids,id]); setMessage('');
    try { const result = await stopForward({bridge,id,onSnapshot}); if (result?.error && alive.current) setMessage(typeof result.error === 'string' ? result.error : result.error.message); }
    catch (error) { if (alive.current) setMessage(error.message || 'Could not stop the forward.'); }
    finally { if (alive.current) setStopping(ids => ids.filter(value => value !== id)); }
  };
  return <article className={`machine-target machine-card ${selected ? 'selected' : ''} ${dropState || ''} ${quickOpen ? 'quick-open' : ''}`} data-host-id={host.id} {...dropHandlers} onContextMenu={onMenu} onKeyDown={event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); onMenu(event); }
    if (event.key === 'Escape' && quickOpen && !operationLocked()) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <div className="machine-summary">
      <label className="batch-host-choice" title={`Include ${host.name} in a batch transfer`}><input type="checkbox" aria-label={`Include ${host.name} in batch transfer`} checked={batchSelected} disabled={batchDisabled} onChange={onBatch} /></label>
      <button className="machine-main" aria-pressed={selected} title={metadata} aria-description={metadata} aria-label={`Select ${host.name}, ${routeLabel(host.route)}, ${statusLabel(host.status)}`} onClick={onSelect}>
        <span className={`tiny-dot ${host.status}`} aria-hidden="true" /><strong>{host.name}</strong><span className="machine-status-label">{statusLabel(host.status)}</span>{selected && <Check size={12} className="host-check" />}
      </button>
      <div className="machine-actions">
        <button ref={trigger} className={`machine-action site-action ${active.length ? 'is-live' : ''}`} aria-label={`Open site on ${host.name}`} title={connecting ? 'Forwarding…' : saved ? `Open saved site on port ${saved.listenPort}` : 'Connect a website through this machine'} disabled={blocked || dragging || connecting} onClick={connect}><Globe size={15} />{active.length > 0 && <span className="site-live-dot" />}</button>
        <button className="machine-action" aria-label={`Set up access for ${host.name}`} title="SSH access" disabled={blocked || dragging} onClick={onAccess}><KeyRound size={14} /></button>
        <button className="machine-action" aria-label={`Connections for ${host.name}`} title="Machine options" aria-haspopup="menu" aria-expanded={menuOpen} disabled={blocked || dragging} onClick={onMenu}><MoreHorizontal size={16} /></button>
      </div>
      <div className="machine-tags" title={metadata}>
        <span className="machine-pill">{routeLabel(host.route)}</span><span className="machine-pill machine-path"><Folder size={10} />{host.destination || '~/Desktop'}</span>
        {expanded && <button className="machine-pill machine-details-toggle" aria-label={`${detailsOpen ? 'Hide' : 'Show'} details for ${host.name}`} aria-expanded={detailsOpen} aria-controls={detailsOpen ? detailsId : undefined} disabled={dragging} onClick={() => setDetailsOpen(value => !value)}><ChevronDown size={11} /> Details</button>}
        {active.slice(0,1).map(entry => <button key={entry.id} className="live-forward-chip" disabled={stopping.includes(entry.id) || dragging} aria-label={`Stop ${entry.mode} forward on ${host.name} port ${entry.listenPort}`} title={`${entry.mode === 'remote' ? 'Remote' : 'Local'} forward · Stop :${entry.listenPort}`} onClick={event => stop(event,entry.id)}><Square size={9} />{entry.status === 'starting' ? 'Starting' : 'Live'} · :{entry.listenPort}</button>)}
        {active.length > 1 && <button className="live-forward-chip forwards-overflow" disabled={dragging} onClick={event => {event.stopPropagation();onViewForwards();}} aria-label={`View all ${active.length} forwards on ${host.name}`} title="View and stop each forward">+{active.length-1}</button>}
      </div>
    </div>
    {dropState && <div className="machine-drop-hint" aria-live="polite">{host.status === 'ready' ? `Release to send to ${host.destination || '~/Desktop'}` : host.status === 'offline' ? 'Machine unavailable' : 'Set up SSH access first'}</div>}
    {message && <p className="machine-inline-error" role="alert">{message}<button aria-label="Dismiss connection error" onClick={() => setMessage('')}><X size={12} /></button></p>}
    {quickOpen && <div ref={popup} className="machine-quick-connect popover" role="region" aria-label={`Quick connect to ${host.name}`}>
      <QuickConnect key={`${host.id}-${quickRevision}`} bridge={bridge} host={host} snapshot={snapshot} onSnapshot={onSnapshot} onBusyChange={onBusyChange} blocked={blocked} autoFocus expanded={false} initialAdvanced={quickAdvanced} initialMode={quickMode} onClose={close} />
    </div>}
    {expanded && detailsOpen && <div id={detailsId} className="machine-activity"><span className="machine-endpoint" title={metadata}>{host.user ? `${host.user}@` : ''}{host.address}:{host.port || 22}</span><strong>Recent transfers</strong>{receipts.length ? receipts.slice(0,3).map((entry,index) => {
      const names = (entry.itemIds || []).map(id => items.find(item => item.id === id)?.name).filter(Boolean);
      return <div className="machine-receipt" key={entry.id || index}><span title={names.join(', ')}>{names.length === entry.itemCount ? names.join(', ') : `${entry.itemCount || entry.itemIds?.length || 0} items`}</span><small>{entry.status === 'sent' ? 'Sent' : entry.status === 'failed' ? 'Failed' : 'Sending'}{entry.timestamp ? ` · ${new Date(entry.timestamp).toLocaleDateString([], {month:'short',day:'numeric'})}` : ''}</small></div>;
    }) : <p>No transfers recorded yet.</p>}</div>}
  </article>;
}
