import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, History, Loader2, Monitor, Network, Pencil, Play, Plus, Square, Trash2, X } from 'lucide-react';
import QuickConnect from './QuickConnect.jsx';
import { mutateForwardHistory, repeatSavedForward, stopForward } from './quick-connect.mjs';

const stateLabel = (status) => ({ starting: 'Connecting', running: 'Running', active: 'Running', stopping: 'Stopping', stopped: 'Stopped', failed: 'Failed' })[status] || status || 'Connecting';
const timeLabel = (value) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const Direction = ({ mode, hostName, listenPort, targetHost, targetPort }) => <div className="tunnel-direction" aria-label={mode === 'remote' ? 'SSH machine to this device to target' : 'This device to SSH machine to target'}><div><Monitor size={15} /><strong>{mode === 'remote' ? hostName || 'SSH machine' : 'This device'}</strong><span>127.0.0.1:{listenPort || 'port'}</span></div><ArrowRight size={16} /><div><Network size={15} /><strong>{mode === 'remote' ? 'This device' : hostName || 'SSH machine'}</strong><span>SSH connection</span></div><ArrowRight size={16} /><div><strong>Target</strong><span>{targetHost || '127.0.0.1'}:{targetPort || 'port'}</span></div></div>;

export default function TunnelPanel({ bridge, host, initialMode = 'local', initialTab = 'new', snapshot, onSnapshot, onBusyChange, onClose, onEditingChange, blocked = false }) {
  const [tab, setTab] = useState(host ? initialTab : 'active');
  const [editingNote, setEditingNote] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [stoppingIds, setStoppingIds] = useState([]);
  const lock = useRef(false);
  const stopLocks = useRef(new Set());
  const mounted = useRef(true);
  const active = (snapshot?.active || []).filter((entry) => !host || entry.hostId === host.id);
  const history = (snapshot?.history || []).filter((entry) => !host || entry.hostId === host.id);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const act = async (method, value, success) => {
    if (lock.current || blocked) return null;
    lock.current = true; setBusy(method); setMessage(null);
    try {
      const result = method === 'restartTunnel'
        ? await repeatSavedForward({ bridge, plan: (snapshot?.history || []).find(entry => entry.id === value), snapshot, onSnapshot, onBusyChange, open: false })
        : await mutateForwardHistory({ bridge, method, value, onSnapshot, onBusyChange });
      if (mounted.current && result.error) setMessage({ kind: 'error', text: result.error });
      else if (mounted.current && !result.superseded && !result.pending && success) setMessage({ kind: 'success', text: success });
      return result.error || result.superseded || result.pending ? null : result.snapshot;
    } finally { lock.current = false; if (mounted.current) setBusy(''); }
  };
  const stop = async (id) => {
    if (stopLocks.current.has(id)) return;
    stopLocks.current.add(id); setStoppingIds([...stopLocks.current]);
    try {
      const result = await stopForward({ bridge, id, onSnapshot });
      if (mounted.current) setMessage({ kind: result.error ? 'error' : 'success', text: result.error || 'SSH forwarding session stopped.' });
    } finally { stopLocks.current.delete(id); if (mounted.current) setStoppingIds([...stopLocks.current]); }
  };
  const disabled = !!busy || blocked;
  return <div className="tunnel-panel">
    <p className="modal-intro">{host ? <><strong>{host.name}</strong> · {host.user ? `${host.user}@` : ''}{host.address}</> : 'Your SSH forwards across all machines.'} Connections start only when you choose Go or Repeat.</p>
    <div className="tunnel-tabs" role="group" aria-label="Port forwarding view">{host && <button aria-pressed={tab === 'new'} className={tab === 'new' ? 'active' : ''} disabled={disabled} onClick={() => setTab('new')}><Plus size={13} /> New forward</button>}<button aria-pressed={tab === 'active'} className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}><Network size={13} /> Active <span>{active.length}</span></button><button aria-pressed={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><History size={13} /> History <span>{history.length}</span></button></div>
    {tab === 'new' && host && <QuickConnect bridge={bridge} host={host} initialMode={initialMode} snapshot={snapshot} onSnapshot={onSnapshot} onBusyChange={onBusyChange} onEditingChange={onEditingChange} blocked={blocked} />}
    {tab === 'active' && <div className="tunnel-entries">{active.length ? active.map((entry) => <article className="tunnel-entry" key={entry.id}><div className="tunnel-entry-heading"><strong>{entry.hostName || 'SSH machine'}</strong><span className={`tunnel-status ${entry.status}`}>{['starting','stopping'].includes(entry.status) && <Loader2 size={11} className="spinning" />}{stateLabel(entry.status)}</span></div><Direction {...entry} /><div className="tunnel-entry-meta"><span>{entry.mode === 'remote' ? 'Remote' : 'Local'} forward · {entry.pid ? `App SSH session · PID ${entry.pid}` : 'App SSH session'}</span>{entry.startedAt && <time>Started {timeLabel(entry.startedAt)}</time>}</div>{entry.note && <p className="tunnel-entry-note">{entry.note}</p>}{entry.error && <p className="tunnel-message error" role="alert">{entry.error}</p>}<button className="quiet-button" disabled={stoppingIds.includes(entry.id) || ['stopping','stopped'].includes(entry.status)} onClick={() => stop(entry.id)}><Square size={12} /> Stop forward</button></article>) : <div className="tunnel-empty">{busy === 'startTunnel' ? <Loader2 size={27} className="spinning" /> : <Network size={27} />}<strong>{busy === 'startTunnel' ? 'Starting SSH session…' : 'No active forwards'}</strong><p>{host ? 'Create a new forward, or repeat one from History.' : 'Open a machine’s connection menu to create a forward, or repeat one from History.'}</p></div>}</div>}
    {tab === 'history' && <div className="tunnel-entries">{history.length ? history.map((entry) => <article className="tunnel-entry" key={entry.id}><div className="tunnel-entry-heading"><strong>{entry.hostName || 'SSH machine'}</strong><span>{entry.mode === 'remote' ? 'Remote' : 'Local'} forward</span></div><Direction {...entry} /><p className="tunnel-entry-meta">{entry.lastUsedAt ? `Last used ${timeLabel(entry.lastUsedAt)}` : 'Saved forward'} · Starts only when you choose Repeat.</p>{editingNote === entry.id ? <form className="tunnel-note-editor" onSubmit={async (event) => { event.preventDefault(); if (await act('updateTunnelNote', { id: entry.id, note: noteDraft.trim() }, 'Notes saved.')) setEditingNote(null); }}><label className="field">Notes<textarea aria-label="Saved forward notes" rows={2} maxLength={500} value={noteDraft} disabled={disabled} onChange={(event) => setNoteDraft(event.target.value)} /></label><div><button type="button" className="text-button" disabled={disabled} onClick={() => setEditingNote(null)}>Cancel</button><button className="quiet-button" disabled={disabled}><Check size={12} /> Save notes</button></div></form> : <p className={`tunnel-entry-note ${entry.note ? '' : 'empty'}`}>{entry.note || 'No notes yet.'}</p>}<div className="tunnel-history-actions"><button className="primary-button compact" disabled={disabled} onClick={async () => { setTab('active'); await act('restartTunnel', entry.id); }}><Play size={12} /> Repeat</button><button className="quiet-button" disabled={disabled} onClick={() => { setEditingNote(entry.id); setNoteDraft(entry.note || ''); }}><Pencil size={12} /> Notes</button><button className="icon-button small" aria-label={`Remove saved ${entry.mode || 'local'} forward on ${entry.hostName || 'SSH machine'} port ${entry.listenPort}`} title="Remove saved forward; active connections stay running" disabled={disabled} onClick={() => act('removeTunnelHistory', entry.id, 'Saved forward removed. Active connections are unchanged.')}><Trash2 size={13} /></button></div></article>) : <div className="tunnel-empty"><History size={27} /><strong>No saved forwards</strong><p>Keep “Save in history” checked when starting a forward to add it here. Add notes to remember what each connection does.</p></div>}</div>}
    {message && <div className={`tunnel-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.kind === 'error' ? <CircleAlert size={14} /> : message.kind === 'success' ? <Check size={14} /> : null}<span>{message.text}</span><button aria-label="Dismiss connection notice" onClick={() => setMessage(null)}><X size={12} /></button></div>}
    {tab !== 'new' && <div className="modal-actions"><span className="keyboard-hint">Closing this panel keeps active forwards running.<br />Quit the app to stop its SSH sessions.</span><button className="quiet-button" disabled={disabled} onClick={onClose}>Done</button></div>}
  </div>;
}
