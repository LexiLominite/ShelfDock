import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, History, Loader2, Monitor, Network, Pencil, Play, Plus, Square, Trash2, X } from 'lucide-react';

const stateLabel = (status) => ({ starting: 'Connecting', running: 'Running', active: 'Running', stopping: 'Stopping', stopped: 'Stopped', failed: 'Failed' })[status] || status || 'Connecting';
const timeLabel = (value) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const Direction = ({ mode, hostName, listenPort, targetHost, targetPort }) => <div className="tunnel-direction" aria-label={mode === 'remote' ? 'SSH machine to this device to target' : 'This device to SSH machine to target'}><div><Monitor size={15} /><strong>{mode === 'remote' ? hostName || 'SSH machine' : 'This device'}</strong><span>127.0.0.1:{listenPort || 'port'}</span></div><ArrowRight size={16} /><div><Network size={15} /><strong>{mode === 'remote' ? 'This device' : hostName || 'SSH machine'}</strong><span>SSH connection</span></div><ArrowRight size={16} /><div><strong>Target</strong><span>{targetHost || '127.0.0.1'}:{targetPort || 'port'}</span></div></div>;

export default function TunnelPanel({ bridge, host, initialMode = 'local', initialTab = 'new', snapshot, onSnapshot, onBusyChange, onClose, blocked = false }) {
  const [tab, setTab] = useState(host ? initialTab : 'active');
  const [mode, setMode] = useState(initialMode);
  const [targetHost, setTargetHost] = useState('127.0.0.1');
  const [targetPort, setTargetPort] = useState('');
  const [listenPort, setListenPort] = useState('');
  const [remember, setRemember] = useState(true);
  const [note, setNote] = useState('');
  const [editingNote, setEditingNote] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [stoppingIds, setStoppingIds] = useState([]);
  const lock = useRef(false);
  const stopLocks = useRef(new Set());
  const mutationVersion = useRef(0);
  const mounted = useRef(true);
  const isDemo = !bridge;
  const active = (snapshot?.active || []).filter((entry) => !host || entry.hostId === host.id);
  const history = (snapshot?.history || []).filter((entry) => !host || entry.hostId === host.id);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusyChange(false); }; }, [onBusyChange]);
  const act = async (method, value, success) => {
    if (lock.current || blocked) return null;
    if (isDemo) { setMessage({ kind: 'info', text: 'Preview only. Open the desktop app to start or manage SSH connections.' }); return null; }
    if (typeof bridge?.[method] !== 'function') { setMessage({ kind: 'error', text: 'This app version does not include port forwarding. Install the latest release.' }); return null; }
    const version = ++mutationVersion.current;
    const previousActiveIds = new Set((snapshot?.active || []).map((entry) => entry.id));
    lock.current = true; setBusy(method); setMessage(null); onBusyChange(true);
    try {
      const next = await bridge[method](value);
      // Stop can finish before a pending Start returns. Its newer snapshot wins.
      if (version === mutationVersion.current) {
        if (next?.active && next?.history) onSnapshot(next);
        if (mounted.current && ['startTunnel', 'restartTunnel'].includes(method)) {
          const entry = next?.active?.filter((item) => !previousActiveIds.has(item.id)).at(-1);
          if (entry?.status === 'failed' || entry?.error) setMessage({ kind: 'error', text: entry.error || 'SSH forwarding failed. Check the connection settings and try again.' });
          else if (entry && ['running', 'active'].includes(entry.status)) setMessage({ kind: 'success', text: 'SSH forwarding is running.' });
          else setMessage({ kind: 'info', text: 'Check Active for the current connection status.' });
        } else if (mounted.current && success) setMessage({ kind: 'success', text: success });
      }
      return next;
    } catch (error) { if (mounted.current && version === mutationVersion.current) setMessage({ kind: 'error', text: error.message || 'The connection could not be changed. Check SSH access and try again.' }); return null; }
    finally { lock.current = false; onBusyChange(false); if (mounted.current) setBusy(''); }
  };
  const start = async (event) => {
    event.preventDefault();
    if (!host || lock.current || blocked) return;
    if (!isDemo) setTab('active');
    const next = await act('startTunnel', { hostId: host.id, mode, targetHost: targetHost.trim(), targetPort: Number(targetPort), listenPort: Number(listenPort), remember, note: note.trim() }, 'SSH forwarding session started. Its status appears below.');
    if (next) setTab('active');
  };
  const stop = async (id) => {
    if (stopLocks.current.has(id)) return;
    if (isDemo || typeof bridge?.stopTunnel !== 'function') { setMessage({ kind: 'info', text: 'Open the desktop app to stop an SSH forwarding session.' }); return; }
    // Stopping a session must remain available while another connection is starting.
    mutationVersion.current += 1;
    stopLocks.current.add(id); setStoppingIds([...stopLocks.current]);
    try { const next = await bridge.stopTunnel(id); if (next?.active && next?.history) onSnapshot(next); if (mounted.current) setMessage({ kind: 'success', text: 'SSH forwarding session stopped.' }); }
    catch (error) { if (mounted.current) setMessage({ kind: 'error', text: error.message || 'Could not stop this forwarding session. Try again.' }); }
    finally { stopLocks.current.delete(id); if (mounted.current) setStoppingIds([...stopLocks.current]); }
  };
  const disabled = !!busy || blocked;
  return <div className="tunnel-panel">
    <p className="modal-intro">{host ? <><strong>{host.name}</strong> · {host.user ? `${host.user}@` : ''}{host.address}</> : 'Your SSH forwards across all machines.'} Connections start only when you choose Start or Repeat.</p>
    <div className="tunnel-tabs" role="group" aria-label="Port forwarding view">{host && <button aria-pressed={tab === 'new'} className={tab === 'new' ? 'active' : ''} disabled={disabled} onClick={() => setTab('new')}><Plus size={13} /> New forward</button>}<button aria-pressed={tab === 'active'} className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}><Network size={13} /> Active <span>{active.length}</span></button><button aria-pressed={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><History size={13} /> History <span>{history.length}</span></button></div>
    {tab === 'new' && host && <form className="tunnel-form" onSubmit={start}>
      <fieldset className="tunnel-mode" disabled={disabled}><legend>Direction</legend><label className={mode === 'local' ? 'selected' : ''}><input type="radio" name="tunnel-mode" value="local" checked={mode === 'local'} onChange={() => setMode('local')} /><span><strong>Local forward</strong><small>This device → {host.name}</small></span></label><label className={mode === 'remote' ? 'selected' : ''}><input type="radio" name="tunnel-mode" value="remote" checked={mode === 'remote'} onChange={() => setMode('remote')} /><span><strong>Remote forward</strong><small>{host.name} → this device</small></span></label></fieldset>
      <Direction mode={mode} hostName={host.name} targetHost={targetHost} targetPort={targetPort} listenPort={listenPort} />
      <div className="form-grid"><label className="field wide">Destination domain or IP<input required maxLength={253} disabled={disabled} value={targetHost} onChange={(event) => setTargetHost(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="127.0.0.1 or service.internal" /><small>Reached from {mode === 'local' ? host.name : 'this device'}. Use 127.0.0.1 for a service running there.</small></label><label className="field">Destination port<input required type="number" min="1" max="65535" disabled={disabled} value={targetPort} onChange={(event) => setTargetPort(event.target.value)} placeholder="e.g. 3000" /></label><label className="field">Listening port<input required type="number" min="1" max="65535" disabled={disabled} value={listenPort} onChange={(event) => setListenPort(event.target.value)} placeholder="e.g. 8080" /><small>Opened on {mode === 'local' ? 'this device' : host.name}.</small></label></div>
      <p className="tunnel-private"><Network size={14} /><span>{mode === 'local' ? <>Listens on <strong>127.0.0.1</strong> only — private to this device. Other network devices cannot connect to this listening port.</> : <>Requests a private <strong>127.0.0.1</strong> listener on {host.name} and checks its binding before reporting Running. The remote SSH server controls its forwarding policy.</>}</span></p>
      <label className="tunnel-remember"><input type="checkbox" checked={remember} disabled={disabled} onChange={(event) => setRemember(event.target.checked)} /> Save in history so I can repeat it</label>
      <label className="field tunnel-note">Notes <span>optional</span><textarea aria-label="Forward notes" rows={2} maxLength={500} disabled={disabled} value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Local access to the development server" /><small>Saved with this forward when history is enabled. Passwords and SSH keys are not stored in the history entry.</small></label>
      <div className="modal-actions"><span className="keyboard-hint">Uses this machine’s configured SSH access.</span><button className="primary-button" disabled={disabled || !targetHost.trim() || !targetPort || !listenPort}>{busy === 'startTunnel' ? <Loader2 size={14} className="spinning" /> : <Play size={14} />} {busy === 'startTunnel' ? 'Connecting…' : 'Start forward'}</button></div>
    </form>}
    {tab === 'active' && <div className="tunnel-entries">{active.length ? active.map((entry) => <article className="tunnel-entry" key={entry.id}><div className="tunnel-entry-heading"><strong>{entry.hostName || 'SSH machine'}</strong><span className={`tunnel-status ${entry.status}`}>{['starting','stopping'].includes(entry.status) && <Loader2 size={11} className="spinning" />}{stateLabel(entry.status)}</span></div><Direction {...entry} /><div className="tunnel-entry-meta"><span>{entry.mode === 'remote' ? 'Remote' : 'Local'} forward · {entry.pid ? `App SSH session · PID ${entry.pid}` : 'App SSH session'}</span>{entry.startedAt && <time>Started {timeLabel(entry.startedAt)}</time>}</div>{entry.note && <p className="tunnel-entry-note">{entry.note}</p>}{entry.error && <p className="tunnel-message error" role="alert">{entry.error}</p>}<button className="quiet-button" disabled={stoppingIds.includes(entry.id) || ['stopping','stopped'].includes(entry.status)} onClick={() => stop(entry.id)}><Square size={12} /> Stop forward</button></article>) : <div className="tunnel-empty">{busy === 'startTunnel' ? <Loader2 size={27} className="spinning" /> : <Network size={27} />}<strong>{busy === 'startTunnel' ? 'Starting SSH session…' : 'No active forwards'}</strong><p>{host ? 'Create a new forward, or repeat one from History.' : 'Open a machine’s connection menu to create a forward, or repeat one from History.'}</p></div>}</div>}
    {tab === 'history' && <div className="tunnel-entries">{history.length ? history.map((entry) => <article className="tunnel-entry" key={entry.id}><div className="tunnel-entry-heading"><strong>{entry.hostName || 'SSH machine'}</strong><span>{entry.mode === 'remote' ? 'Remote' : 'Local'} forward</span></div><Direction {...entry} /><p className="tunnel-entry-meta">{entry.lastUsedAt ? `Last used ${timeLabel(entry.lastUsedAt)}` : 'Saved forward'} · Starts only when you choose Repeat.</p>{editingNote === entry.id ? <form className="tunnel-note-editor" onSubmit={async (event) => { event.preventDefault(); if (await act('updateTunnelNote', { id: entry.id, note: noteDraft.trim() }, 'Notes saved.')) setEditingNote(null); }}><label className="field">Notes<textarea aria-label="Saved forward notes" rows={2} maxLength={500} value={noteDraft} disabled={disabled} onChange={(event) => setNoteDraft(event.target.value)} /></label><div><button type="button" className="text-button" disabled={disabled} onClick={() => setEditingNote(null)}>Cancel</button><button className="quiet-button" disabled={disabled}><Check size={12} /> Save notes</button></div></form> : <p className={`tunnel-entry-note ${entry.note ? '' : 'empty'}`}>{entry.note || 'No notes yet.'}</p>}<div className="tunnel-history-actions"><button className="primary-button compact" disabled={disabled} onClick={async () => { setTab('active'); await act('restartTunnel', entry.id); }}><Play size={12} /> Repeat</button><button className="quiet-button" disabled={disabled} onClick={() => { setEditingNote(entry.id); setNoteDraft(entry.note || ''); }}><Pencil size={12} /> Notes</button><button className="icon-button small" aria-label={`Remove saved ${entry.mode || 'local'} forward on ${entry.hostName || 'SSH machine'} port ${entry.listenPort}`} title="Remove saved forward; active connections stay running" disabled={disabled} onClick={() => act('removeTunnelHistory', entry.id, 'Saved forward removed. Active connections are unchanged.')}><Trash2 size={13} /></button></div></article>) : <div className="tunnel-empty"><History size={27} /><strong>No saved forwards</strong><p>Keep “Save in history” checked when starting a forward to add it here. Add notes to remember what each connection does.</p></div>}</div>}
    {message && <div className={`tunnel-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.kind === 'error' ? <CircleAlert size={14} /> : message.kind === 'success' ? <Check size={14} /> : null}<span>{message.text}</span><button aria-label="Dismiss connection notice" onClick={() => setMessage(null)}><X size={12} /></button></div>}
    {tab !== 'new' && <div className="modal-actions"><span className="keyboard-hint">Closing this panel keeps active forwards running.<br />Quit the app to stop its SSH sessions.</span><button className="quiet-button" disabled={disabled} onClick={onClose}>Done</button></div>}
  </div>;
}
