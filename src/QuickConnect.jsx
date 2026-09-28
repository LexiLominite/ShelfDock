import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Copy, ExternalLink, Square, X } from 'lucide-react';
import { activeForPlan, latestSavedPlan, localSiteUrl, parseQuickUrl, quickConnectDefaults, quickPlanForUrl, sameForward, sitePreferences, startQuickForward, stopForward, urlForPlan } from './quick-connect.mjs';
import './quick-connect.css';

const noop = () => {};

export default function QuickConnect({ bridge, host, snapshot, onSnapshot, onBusyChange = noop, blocked = false, expanded = false, initialAdvanced = false, autoFocus = !expanded, onClose, onEditingChange = noop, initialMode = 'local' }) {
  const initial = quickConnectDefaults(snapshot, host?.id, { mode: initialMode, advanced: initialAdvanced || expanded });
  const saved = initial.saved;
  const [address, setAddress] = useState(initial.address);
  const [mode, setMode] = useState(initial.mode);
  const [destination, setDestination] = useState(null);
  const [listener, setListener] = useState(() => saved?.listenPort && saved.listenPort !== saved.targetPort ? String(saved.listenPort) : '');
  const [advanced, setAdvanced] = useState(initialAdvanced);
  const [portChoice, setPortChoice] = useState(() => saved && !saved.autoListen && (initialAdvanced || expanded) ? 'custom' : 'automatic');
  const [copied, setCopied] = useState(false);
  const [remember, setRemember] = useState(true);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState('');
  const [requestPlan, setRequestPlan] = useState(null);
  const cancelRequested = useRef(false);
  const mounted = useRef(true);
  const submitLock = useRef(false);
  const editing = useRef(false);
  const editingCallback = useRef(onEditingChange);
  editingCallback.current = onEditingChange;
  const form = useRef(null);
  const addressInput = useRef(null);
  const id = useId();
  const currentSnapshot = useRef(snapshot);
  currentSnapshot.current = snapshot;
  const effectiveMode = advanced || expanded ? mode : 'local';
  const automaticPort = effectiveMode === 'local' && (!(advanced || expanded) || portChoice === 'automatic');
  let site = null;
  let draft = null;
  try { site = parseQuickUrl(address); draft = quickPlanForUrl({ hostId: host?.id, mode: effectiveMode, site, targetPort: destination, listenPort: automaticPort ? undefined : listener, remember, note, autoListen: automaticPort }); } catch { /* Validation is shown after a deliberate Go. */ }
  const entry = activeForPlan(snapshot, pending && requestPlan ? requestPlan : draft);
  const matchingSaved = (snapshot?.history || []).find(plan => sameForward(plan, draft));
  const running = entry && ['running', 'active'].includes(entry.status);
  const connecting = pending || entry?.status === 'starting';
  const liveUrl = running && site ? localSiteUrl(entry, site) : '';
  const disabled = blocked || pending || stopping;

  useEffect(() => {
    mounted.current = true;
    if (autoFocus) addressInput.current?.focus();
    return () => { mounted.current = false; if (editing.current) editingCallback.current(false); };
  }, []);

  useEffect(() => {
    if (!cancelRequested.current || !entry?.id || stopping) return;
    setStopping(true);
    stopForward({ bridge, id: entry.id, onSnapshot }).then(result => {
      if (mounted.current) { setMessage(result.error || 'Forward stopped.'); setStopping(false); }
      cancelRequested.current = false;
    });
  }, [entry?.id, bridge, onSnapshot, stopping]);

  const changeMode = (next) => {
    setMode(next); setDestination(null); setMessage(''); setCopied(false);
    const previous = latestSavedPlan(currentSnapshot.current, host.id, next);
    if (previous) { setAddress(urlForPlan(previous)); setListener(previous.listenPort !== previous.targetPort ? String(previous.listenPort) : ''); setPortChoice(previous.autoListen ? 'automatic' : 'custom'); }
    else { setListener(''); setPortChoice('automatic'); }
  };

  const go = async (event) => {
    event.preventDefault();
    if (submitLock.current || disabled) return;
    let parsed; let plan;
    try { parsed = parseQuickUrl(address); plan = quickPlanForUrl({ hostId: host?.id, mode: effectiveMode, site: parsed, targetPort: destination, listenPort: automaticPort ? undefined : listener, remember, note: note.trim(), autoListen: automaticPort }); }
    catch (error) { setMessage(error.message); addressInput.current?.focus(); return; }
    submitLock.current = true; cancelRequested.current = false; setPending(true); setMessage(''); setCopied(false); setRequestPlan(plan);
    try {
      const result = await startQuickForward({ bridge, plan, site: parsed, snapshot: currentSnapshot.current, onSnapshot, onBusyChange, isCancelled: () => cancelRequested.current });
      if (cancelRequested.current && result.entry?.id) {
        const stopped = await stopForward({ bridge, id: result.entry.id, onSnapshot });
        if (mounted.current) setMessage(stopped.error || 'Forward stopped.');
        cancelRequested.current = false;
      } else if (mounted.current && result.error) setMessage(result.error);
      else if (mounted.current && !result.superseded && result.entry?.mode === 'remote') setMessage(`Live on ${host.name} at 127.0.0.1:${result.entry.listenPort}.`);
    } finally { submitLock.current = false; if (mounted.current) { setPending(false); setRequestPlan(null); } }
  };

  const stop = async () => {
    if (stopping) return;
    if (!entry?.id) { cancelRequested.current = true; setMessage('Stopping as soon as the SSH session is created…'); return; }
    cancelRequested.current = false;
    setStopping(true);
    const result = await stopForward({ bridge, id: entry.id, onSnapshot });
    if (mounted.current) { setStopping(false); setMessage(result.error || 'Forward stopped.'); }
  };

  const acceptAddressDrop = (event) => {
    event.stopPropagation(); event.preventDefault();
    if (disabled) return;
    if (event.dataTransfer.files?.length) { setMessage('Drop files on the machine or Transfers shelf. This field accepts a website address.'); return; }
    const value = event.dataTransfer.getData('text/uri-list').split(/\r?\n/).find(line => line && !line.startsWith('#')) || event.dataTransfer.getData('text/plain');
    if (value) { setAddress(value.trim()); setDestination(null); setMessage(''); setCopied(false); addressInput.current?.focus(); }
  };

  const toggleAdvanced = () => {
    if (advanced && mode !== 'local') {
      const basic = quickConnectDefaults(currentSnapshot.current, host.id);
      setMode('local'); setAddress(basic.address); setDestination(null); setListener(''); setPortChoice('automatic');
    }
    setAdvanced(value => !value); setMessage('');
  };

  const copyAddress = async () => {
    try { if (bridge?.copyTunnelSite) await bridge.copyTunnelSite({ id: entry.id, scheme: site.scheme, path: site.path || '/' }); else await navigator.clipboard.writeText(liveUrl); if (mounted.current) { setCopied(true); setMessage('Local address copied. Open it in any browser or client on this device.'); } }
    catch { if (mounted.current) setMessage('Select the local address and copy it to use in another browser or client.'); }
  };

  const changeDestination = (value) => {
    setDestination(value); setMessage(''); setCopied(false);
    if (site && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535) {
      const url = new URL(site.url); url.port = value; setAddress(url.href);
    }
  };

  return <form ref={form} className={`quick-connect ${expanded ? 'is-expanded' : ''}`} onSubmit={go} onClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()} onDragStart={event => event.stopPropagation()} onDragEnter={event => event.stopPropagation()} onDragLeave={event => event.stopPropagation()} onDragOver={event => { event.stopPropagation(); event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={acceptAddressDrop} onFocus={() => { if (!editing.current) { editing.current = true; onEditingChange(true); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { editing.current = false; onEditingChange(false); } }} aria-label={`Connect to a website through ${host?.name || 'this machine'}`}>
    <div className="quick-connect-heading"><span><strong>{effectiveMode === 'local' ? 'Remote machine’s service' : 'This device’s service'}</strong> · {effectiveMode === 'local' ? `on ${host?.name || 'the selected machine'}, open here` : `open on ${host?.name || 'the selected machine'}`}</span>{onClose && <button type="button" className="icon-button small" aria-label="Close quick connect" onClick={onClose}><X size={13} /></button>}</div>
    <div className="quick-url-row"><label className="sr-only" htmlFor={`${id}-address`}>Website address</label><input ref={addressInput} id={`${id}-address`} className="quick-url-input" type="text" inputMode="url" placeholder="http://localhost:8000" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={address} disabled={disabled} maxLength={4096} onChange={event => { setAddress(event.target.value); setDestination(null); setMessage(''); setCopied(false); }} /><button className="primary-button quick-go" disabled={disabled || !address.trim() || entry?.status === 'stopping' || (running && mode === 'remote')} aria-label={running ? mode === 'local' ? `Open live website on port ${entry.listenPort}` : `Remote forward live on port ${entry.listenPort}` : connecting ? 'Forwarding' : 'Go: connect website'}>{connecting ? 'Forwarding…' : running ? `Live · :${entry.listenPort}` : 'Go'}</button>{(entry || pending) && <button type="button" className="quick-stop" onClick={stop} disabled={stopping || entry?.status === 'stopping'} aria-label={`Stop forward${entry?.listenPort ? ` on port ${entry.listenPort}` : ''}`} title="Stop this forward"><Square size={12} /><span>{stopping ? 'Stopping…' : 'Stop'}</span></button>}</div>
    <p className="quick-route-hint">{mode === 'local' ? <>This device <ArrowRight size={11} /> <span>{host?.name}</span></> : <><span>{host?.name}</span> <ArrowRight size={11} /> This device</>}<span> · loopback only</span></p>
    {effectiveMode === 'local' && <p className="quick-note">localhost and other addresses are reached from {host?.name || 'the selected machine'}. Go opens the forwarded address in your default browser.</p>}
    {(advanced || expanded) && matchingSaved && !sitePreferences(matchingSaved).known && <p className="quick-note">This saved forward has no website URL yet. Check HTTP or HTTPS before choosing Go.</p>}
    {!expanded && <button type="button" className="quick-disclosure" aria-expanded={advanced} aria-controls={`${id}-advanced`} disabled={disabled} onClick={toggleAdvanced}><ChevronDown size={13} className={advanced ? 'is-open' : ''} /> Advanced</button>}
    {(advanced || expanded) && <div className="quick-advanced" id={`${id}-advanced`}>
      <p className="quick-note">SSH direction: Local opens the selected machine’s service here. Remote makes this device’s service available on the selected machine.</p>
      <div className="quick-segments" role="group" aria-label="Forwarding direction"><button type="button" disabled={disabled} aria-pressed={mode === 'local'} onClick={() => changeMode('local')}>Local →</button><button type="button" disabled={disabled} aria-pressed={mode === 'remote'} onClick={() => changeMode('remote')}>← Remote</button></div>
      {mode === 'local' && <div className="quick-segments" role="group" aria-label="Local listening port"><button type="button" disabled={disabled} aria-pressed={portChoice === 'automatic'} onClick={() => setPortChoice('automatic')}>Automatic port</button><button type="button" disabled={disabled} aria-pressed={portChoice === 'custom'} onClick={() => setPortChoice('custom')}>Custom port</button></div>}
      <div className="quick-ports"><label htmlFor={`${id}-listen`}>{mode === 'local' ? 'This device' : host?.name} · listen<input id={`${id}-listen`} type="number" min="1" max="65535" inputMode="numeric" value={automaticPort ? '' : listener} placeholder={automaticPort ? 'Automatic' : String(site?.targetPort || 8000)} disabled={disabled || automaticPort} onChange={event => setListener(event.target.value)} aria-label="Listening port" /></label><ArrowRight size={14} aria-hidden="true" /><label htmlFor={`${id}-destination`}>{mode === 'local' ? host?.name : 'This device'} · destination<input id={`${id}-destination`} type="number" min="1" max="65535" inputMode="numeric" value={destination ?? (site ? String(site.targetPort) : '')} placeholder="1331" disabled={disabled} onChange={event => changeDestination(event.target.value)} aria-label="Destination port" /></label></div>
      {automaticPort && <p className="quick-note">Tries the destination port locally, then the next available port. Ports below 1024 start at 8080, or 8443 for destination port 443. The live address shows the chosen port.</p>}
      {matchingSaved ? <p className="quick-note">Saved in History · ready to repeat</p> : <label className="quick-remember"><input type="checkbox" checked={remember} disabled={disabled} onChange={event => setRemember(event.target.checked)} /> Save this forward in History</label>}
      <details className="quick-notes"><summary>Notes and saved website details</summary>{matchingSaved ? <p className="quick-note">{matchingSaved.note || 'No note saved.'} Edit notes in forwarding History.</p> : <label className="quick-note-field" htmlFor={`${id}-note`}>Note <span>optional</span><input id={`${id}-note`} value={note} maxLength={500} disabled={disabled} onChange={event => setNote(event.target.value)} placeholder="What this service is for" /></label>}<p className="quick-note">Website scheme and path stay on this device. Query strings and fragments are kept only for this app session.</p></details>
    </div>}
    {running && liveUrl && <div className="quick-live-address"><ExternalLink size={12} /><label className="sr-only" htmlFor={`${id}-live`}>Local website address</label><input id={`${id}-live`} value={liveUrl} readOnly onFocus={event => event.target.select()} /><button type="button" className="quiet-button" onClick={copyAddress} aria-label="Copy local website address">{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}</button></div>}
    {site?.scheme === 'https:' && <p className="quick-note">HTTPS is preserved. The site’s certificate must also support the local address.</p>}
    {message && <p className="quick-feedback" role="status">{message}</p>}
  </form>;
}
