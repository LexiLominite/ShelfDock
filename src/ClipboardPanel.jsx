import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, Clipboard, Copy, File, FileText, Image, Loader2, Pause, Pin, Play, Plus, Search, Settings2, Trash2, X } from 'lucide-react';

const emptySnapshot = { entries: [], settings: { enabled: false, paused: false, maxItems: 200, retentionDays: 30 }, available: true };
const sampleText = 'A small place for useful things.\nKeep a note, copy it when you need it, or add it to Transfers.';
const demoSnapshot = { ...emptySnapshot, entries: [
  { id: 'clip-demo-note', kind: 'text', title: 'A small place for useful things.', preview: sampleText, searchText: sampleText, pinned: true, createdAt: new Date().toISOString(), size: sampleText.length },
  { id: 'clip-demo-link', kind: 'text', title: 'https://example.com/project', preview: 'https://example.com/project', searchText: 'https://example.com/project', pinned: false, createdAt: new Date().toISOString(), size: 27 },
] };
const kindName = (kind) => ({ text: 'Text', image: 'Image', files: 'Files' })[kind] || 'Item';
const KindIcon = ({ kind, ...props }) => { const Icon = kind === 'image' ? Image : kind === 'files' ? File : FileText; return <Icon {...props} />; };
const sizeLabel = (size) => size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size || 0} B`;

export default function ClipboardPanel({ bridge, onAddToShelf, onEditingChange, blocked = false }) {
  const isDemo = !bridge;
  const [snapshot, setSnapshot] = useState(isDemo ? demoSnapshot : emptySnapshot);
  const [loading, setLoading] = useState(!isDemo);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [snippetText, setSnippetText] = useState('');
  const [snippetTitle, setSnippetTitle] = useState('');
  const [clearArmed, setClearArmed] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const snapshotRef = useRef(snapshot);
  const lock = useRef(false);
  const mounted = useRef(true);
  const detailVersion = useRef(0);
  const historyVersion = useRef(0);
  const historyQuery = useRef({ query, filter });
  historyQuery.current = { query, filter };
  const searchRef = useRef(null);
  const applySnapshot = useCallback((next) => {
    if (next?.entries && next?.settings) { snapshotRef.current = next; if (mounted.current) setSnapshot(next); }
    return next;
  }, []);
  const loadHistory = useCallback(async ({ quiet = false } = {}) => {
    if (!bridge) return null;
    const version = ++historyVersion.current;
    if (!quiet) setLoading(true);
    try {
      const next = await bridge.getClipboardHistory(historyQuery.current);
      if (mounted.current && version === historyVersion.current) applySnapshot(next);
      return next;
    } catch (error) { if (mounted.current && version === historyVersion.current) setMessage({ kind: 'error', text: error.message || 'Could not load clipboard history.' }); return null; }
    finally { if (mounted.current && version === historyVersion.current) setLoading(false); }
  }, [bridge, applySnapshot]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!bridge) return;
    // Full-text matching stays in the main process. Renderer snapshots contain previews only.
    let timer = setTimeout(() => { void loadHistory(); }, query ? 180 : 0);
    const unsubscribe = bridge.onClipboardHistory?.(() => { clearTimeout(timer); timer = setTimeout(() => { void loadHistory({ quiet: true }); }, 100); });
    return () => { clearTimeout(timer); historyVersion.current += 1; unsubscribe?.(); };
  }, [bridge, loadHistory, query, filter]);
  useEffect(() => { onEditingChange(Boolean(snippetOpen || preferencesOpen || inputFocused)); return () => onEditingChange(false); }, [snippetOpen, preferencesOpen, inputFocused, onEditingChange]);
  useEffect(() => { setClearArmed(false); }, [query, filter, selectedId]);

  const entries = useMemo(() => {
    if (!isDemo) return snapshot.entries;
    const needle = query.trim().toLocaleLowerCase();
    return snapshot.entries.filter((entry) => (filter === 'all' || filter === 'pinned' ? filter !== 'pinned' || entry.pinned : entry.kind === filter) && (!needle || `${entry.title || ''}\n${entry.searchText || entry.preview || ''}`.toLocaleLowerCase().includes(needle)));
  }, [snapshot.entries, query, filter, isDemo]);
  const selected = entries.find((entry) => entry.id === selectedId);
  useEffect(() => { if (!entries.some((entry) => entry.id === selectedId)) setSelectedId(entries[0]?.id || ''); }, [entries, selectedId]);
  useEffect(() => {
    const version = ++detailVersion.current;
    setDetail(null);
    if (!selectedId) { setDetailLoading(false); return; }
    if (isDemo) { const entry = snapshotRef.current.entries.find((item) => item.id === selectedId); setDetail(entry ? { ...entry, text: entry.preview || '' } : null); return; }
    setDetailLoading(true);
    Promise.resolve(bridge.getClipboardEntry(selectedId)).then((next) => { if (mounted.current && version === detailVersion.current) setDetail(next); }).catch((error) => { if (mounted.current && version === detailVersion.current) setMessage({ kind: 'error', text: error.message || 'Could not open this item.' }); }).finally(() => { if (mounted.current && version === detailVersion.current) setDetailLoading(false); });
  }, [selectedId, bridge, isDemo]);

  const demoCall = async (method, value) => {
    const next = structuredClone(snapshotRef.current);
    if (method === 'setClipboardPinned') next.entries = next.entries.map((entry) => entry.id === value.id ? { ...entry, pinned: value.pinned } : entry);
    if (method === 'removeClipboardEntry') next.entries = next.entries.filter((entry) => entry.id !== value);
    if (method === 'clearClipboardHistory') next.entries = next.entries.filter((entry) => entry.pinned);
    if (method === 'updateClipboardPreferences') next.settings = { ...next.settings, ...value };
    if (method === 'saveClipboardSnippet') next.entries.unshift({ id: `snippet-${Date.now()}`, kind: 'text', title: value.title || value.text.split('\n')[0], preview: value.text, searchText: value.text, pinned: true, createdAt: new Date().toISOString(), size: value.text.length });
    if (method === 'captureClipboardHistory' || method === 'copyClipboardEntry') { setMessage({ kind: 'info', text: 'Preview only. The desktop app can read and write your clipboard when you choose.' }); return null; }
    return next;
  };
  const act = async (method, value, success) => {
    if (lock.current || blocked) return null;
    lock.current = true; setBusy(method); setMessage(null);
    try {
      const next = isDemo ? await demoCall(method, value) : await bridge[method](value);
      if (next) { if (isDemo) applySnapshot(next); else await loadHistory({ quiet: true }); if (success) setMessage({ kind: 'success', text: success }); }
      return next;
    } catch (error) { setMessage({ kind: 'error', text: error.message || 'Could not complete this action. Please try again.' }); return null; }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  };
  const copy = async (plainText = false) => {
    if (!selected) return;
    await act('copyClipboardEntry', { id: selected.id, plainText }, plainText ? 'Copied as plain text.' : 'Copied to your clipboard.');
  };
  const addToShelf = async () => {
    if (!selected || lock.current || blocked) return;
    if (isDemo) { setMessage({ kind: 'info', text: 'Preview only. Open the desktop app to add this item to Transfers.' }); return; }
    lock.current = true; setBusy('addClipboardEntryToShelf'); setMessage(null);
    try { const next = await bridge.addClipboardEntryToShelf(selected.id); onAddToShelf(next); }
    catch (error) { setMessage({ kind: 'error', text: error.message || 'Could not add this item to Transfers.' }); }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  };
  const listKeys = (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter') { event.preventDefault(); void copy(); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !entries.length) return;
    event.preventDefault();
    const index = entries.findIndex((entry) => entry.id === selectedId);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    setSelectedId(entries[next].id);
    requestAnimationFrame(() => document.getElementById(`clipboard-${entries[next].id}`)?.scrollIntoView({ block: 'nearest' }));
  };
  const unavailable = snapshot.available === false;
  const activeCapture = snapshot.settings.enabled && !snapshot.settings.paused;
  const imageSource = detail?.imageDataURL && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(detail.imageDataURL) ? detail.imageDataURL : null;
  const disabled = !!busy || blocked;

  return <section className="clipboard-pane" aria-label="Clipboard workspace" onFocusCapture={(event) => { if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) setInputFocused(true); }} onBlurCapture={(event) => { if (!/INPUT|TEXTAREA|SELECT/.test(event.relatedTarget?.tagName || '')) setInputFocused(false); }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchRef.current?.focus(); } }}>
    <div className="clipboard-heading"><div><p className="eyebrow">A little less copying twice</p><h1>Clipboard</h1></div><button className={`icon-button ${preferencesOpen ? 'active' : ''}`} aria-label="Clipboard preferences" aria-expanded={preferencesOpen} onClick={() => { setPreferencesOpen(!preferencesOpen); setSnippetOpen(false); }}><Settings2 size={17} /></button></div>
    <div className="clipboard-toolbar"><button className="quiet-button" disabled={disabled || unavailable} onClick={() => act('captureClipboardHistory', undefined, 'Current clipboard saved.')}><Clipboard size={13} /> Save current clipboard</button><button className="quiet-button" disabled={disabled} onClick={() => { setSnippetOpen(!snippetOpen); setPreferencesOpen(false); }}><Plus size={13} /> New snippet</button></div>
    {preferencesOpen && <div className="clipboard-preferences"><div className="clipboard-preferences-heading"><strong>History preferences</strong><button className="icon-button small" aria-label="Close clipboard preferences" onClick={() => setPreferencesOpen(false)}><X size={14} /></button></div><label>Keep recent items<select aria-label="Clipboard history limit" disabled={disabled} value={snapshot.settings.maxItems} onChange={(event) => act('updateClipboardPreferences', { maxItems: Number(event.target.value) })}>{[20,50,100,200,500].map((number) => <option key={number} value={number}>{number} items</option>)}</select></label><label>Keep unpinned history<select aria-label="Clipboard retention" disabled={disabled} value={snapshot.settings.retentionDays} onChange={(event) => act('updateClipboardPreferences', { retentionDays: Number(event.target.value) })}>{[1,7,30,90].map((days) => <option key={days} value={days}>{days} {days === 1 ? 'day' : 'days'}</option>)}</select></label><p>Pinned items stay until you remove them. History stays on this device and is excluded from configuration exports.</p>{snapshot.settings.enabled && <button className="text-button" disabled={disabled} onClick={() => act('updateClipboardPreferences', { enabled: false }, 'Automatic history turned off. Saved items remain available.')}>Turn off automatic history</button>}</div>}
    {snippetOpen && <form className="clipboard-snippet" onSubmit={async (event) => { event.preventDefault(); if (await act('saveClipboardSnippet', { text: snippetText, title: snippetTitle }, 'Snippet saved.')) { setSnippetText(''); setSnippetTitle(''); setSnippetOpen(false); } }}><div className="clipboard-preferences-heading"><strong>New text snippet</strong><button type="button" className="icon-button small" aria-label="Close new snippet" onClick={() => setSnippetOpen(false)}><X size={14} /></button></div><label className="field">Title <span>optional</span><input maxLength={120} value={snippetTitle} onChange={(event) => setSnippetTitle(event.target.value)} placeholder="e.g. Meeting link" /></label><label className="field">Snippet<textarea required rows={3} value={snippetText} onChange={(event) => setSnippetText(event.target.value)} placeholder="Save something you use often…" /></label><button className="primary-button compact" disabled={disabled || !snippetText.trim()}><Plus size={13} /> Save snippet</button></form>}
    {isDemo && <p className="clipboard-notice">Fictional preview items. Your real clipboard is not being read.</p>}
    {!isDemo && !snapshot.settings.enabled && <div className="clipboard-opt-in"><strong>Make room for what you copy.</strong><p>Turn on local history to save new text, images, and copied files. It may include sensitive content; pause it whenever you need. No automatic sharing.</p><button className="quiet-button" disabled={disabled || unavailable} onClick={() => act('updateClipboardPreferences', { enabled: true, paused: false }, 'Local clipboard history is on.')}><Play size={12} /> Turn on clipboard history</button></div>}
    {snapshot.settings.enabled && <div className={`clipboard-capture-state ${activeCapture ? 'active' : ''}`}><span><span className={`tiny-dot ${activeCapture ? 'ready' : ''}`} />{activeCapture ? 'Saving new copies locally' : 'History paused'}</span><button className="text-button" disabled={disabled || unavailable} onClick={() => act('updateClipboardPreferences', { paused: !snapshot.settings.paused })}>{activeCapture ? <Pause size={12} /> : <Play size={12} />}{activeCapture ? 'Pause' : 'Resume'}</button></div>}
    {(snapshot.error || unavailable) && <p className="clipboard-message error" role="alert">{snapshot.error || 'Clipboard access is unavailable on this device.'}</p>}
    <div className="clipboard-search"><Search size={14} /><input ref={searchRef} aria-label="Search clipboard history" placeholder="Search text, links, and filenames…" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="Clear clipboard search" onClick={() => setQuery('')}><X size={13} /></button>}</div>
    <div className="clipboard-filters" role="group" aria-label="Clipboard filter">{[['all','All'],['pinned','Pinned'],['text','Text'],['image','Images'],['files','Files']].map(([value,label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{value === 'pinned' && <Pin size={10} />}{label}</button>)}</div>
    <div className="clipboard-content"><div className="clipboard-list" role="listbox" aria-label="Clipboard history" aria-activedescendant={selectedId ? `clipboard-${selectedId}` : undefined} tabIndex={0} onKeyDown={listKeys}>
      {loading ? <div className="clipboard-empty"><Loader2 size={21} className="spinning" /><p>Loading your saved items…</p></div> : !entries.length ? <div className="clipboard-empty"><Clipboard size={26} /><strong>{query || filter !== 'all' ? 'Nothing matches yet.' : 'Useful things belong here.'}</strong><p>{query || filter !== 'all' ? 'Try another search or filter.' : 'Save your current clipboard, create a snippet, or turn on local history.'}</p></div> : entries.map((entry) => <div className={`clipboard-entry ${selectedId === entry.id ? 'selected' : ''}`} role="option" aria-selected={selectedId === entry.id} id={`clipboard-${entry.id}`} key={entry.id}><button className="clipboard-entry-main" tabIndex={-1} onClick={() => setSelectedId(entry.id)}><span className={`clipboard-kind ${entry.kind}`}><KindIcon kind={entry.kind} size={17} /></span><span><strong>{entry.title || kindName(entry.kind)}</strong><small>{entry.preview || kindName(entry.kind)}</small><span className="clipboard-entry-meta">{kindName(entry.kind)} · {sizeLabel(entry.size)}{entry.pinned ? ' · Pinned' : ''}</span></span></button><button className={`clipboard-pin ${entry.pinned ? 'pinned' : ''}`} aria-label={`${entry.pinned ? 'Unpin' : 'Pin'} ${entry.title || kindName(entry.kind)}`} disabled={disabled} onClick={(event) => { event.stopPropagation(); void act('setClipboardPinned', { id: entry.id, pinned: !entry.pinned }); }}><Pin size={13} /></button></div>)}
    </div>
    {selected && <section className="clipboard-detail" aria-label="Clipboard item preview"><div className="clipboard-detail-heading"><span>{kindName(selected.kind)} preview</span><button className="icon-button small" disabled={disabled} aria-label="Delete clipboard item" title="Delete this item" onClick={() => act('removeClipboardEntry', selected.id, 'Item removed.')}><Trash2 size={13} /></button></div><div className="clipboard-detail-body">{detailLoading ? <Loader2 size={18} className="spinning" /> : imageSource ? <img src={imageSource} alt={selected.title || 'Saved clipboard image'} /> : selected.kind === 'files' ? <ul>{(detail?.files || []).map((file, index) => <li key={index}><File size={12} />{typeof file === 'string' ? file : file.name || file.path || 'File'}</li>)}</ul> : <pre>{detail?.text ?? selected.preview ?? ''}</pre>}</div><div className="clipboard-detail-actions"><button className="primary-button compact" disabled={disabled || unavailable || detailLoading} onClick={() => copy()}><Copy size={12} /> Copy</button>{selected.kind === 'text' && <button className="quiet-button" disabled={disabled || unavailable || detailLoading} onClick={() => copy(true)}>Plain text</button>}<button className="quiet-button" disabled={disabled || detailLoading} onClick={addToShelf}><ArrowUpRight size={13} /> Add to Transfers</button></div></section>}
    </div>
    {message && <div className={`clipboard-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.kind === 'success' && <Check size={13} />}<span>{message.text}</span><button aria-label="Dismiss clipboard notice" onClick={() => setMessage(null)}><X size={12} /></button></div>}
    <div className="clipboard-bottom"><span>{entries.length} {entries.length === 1 ? 'item' : 'items'} · {snapshot.entries.filter((entry) => entry.pinned).length} pinned</span>{clearArmed ? <div className="clipboard-clear-confirm"><span>Remove unpinned?</span><button className="danger-button" disabled={disabled} onClick={async () => { if (await act('clearClipboardHistory', undefined, 'Unpinned history cleared.')) setClearArmed(false); }}>Clear</button><button className="text-button" onClick={() => setClearArmed(false)}>Cancel</button></div> : <button className="text-button muted" disabled={disabled || !snapshot.entries.some((entry) => !entry.pinned)} onClick={() => setClearArmed(true)}>Clear unpinned</button>}</div>
  </section>;
}
