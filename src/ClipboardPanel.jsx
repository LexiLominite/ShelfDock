import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronUp, Clipboard, Copy, File, FileText, Image, Pause, Pin, Play, Plus, Search, Settings2, Trash2, X } from 'lucide-react';
import './clipboard-workspace.css';

const emptySnapshot = { entries: [], settings: { enabled: false, paused: false, maxItems: 200, retentionDays: 30 }, available: true };
const sampleText = 'A small place for useful things.\nKeep a note, copy it when you need it, or add it to Transfers.';
const demoSnapshot = { ...emptySnapshot, entries: [
  { id: 'clip-demo-note', kind: 'text', title: 'A small place for useful things.', preview: sampleText, searchText: sampleText, pinned: true, createdAt: new Date().toISOString(), size: sampleText.length },
  { id: 'clip-demo-link', kind: 'text', title: 'https://example.com/project', preview: 'https://example.com/project', searchText: 'https://example.com/project', pinned: false, createdAt: new Date().toISOString(), size: 27 },
] };
const filters = [['all', 'All'], ['pinned', 'Pinned'], ['text', 'Text'], ['image', 'Images'], ['files', 'Files']];
const kindName = (kind) => ({ text: 'Text', image: 'Image', files: 'Files' })[kind] || 'Item';
const entrySource = (entry) => (typeof entry?.sourceLabel === 'string' ? entry.sourceLabel.trim() : '');
const KindIcon = ({ kind, ...props }) => { const Icon = kind === 'image' ? Image : kind === 'files' ? File : FileText; return <Icon {...props} />; };
const sizeLabel = (size) => size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size || 0} B`;
const timeLabel = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };

export default function ClipboardPanel({ bridge, onAddToShelf, onEditingChange, blocked = false, capturePaused = false, viewMode = 'expanded', uiState, onUIStateChange }) {
  const isDemo = !bridge;
  const density = viewMode === 'compact' ? 'compact' : viewMode === 'large' ? 'expanded' : 'balanced';
  const [snapshot, setSnapshot] = useState(isDemo ? demoSnapshot : emptySnapshot);
  const [loading, setLoading] = useState(!isDemo);
  const [query, setQuery] = useState(uiState?.query || '');
  const [filter, setFilter] = useState(filters.some(([value]) => value === uiState?.filter) ? uiState.filter : 'all');
  const [selectedId, setSelectedId] = useState(uiState?.selectedId || '');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
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
  const listRef = useRef(null);
  const panelRef = useRef(null);
  const panelReturnFocus = useRef(null);
  const clearButtonRef = useRef(null);
  const clearPanelRef = useRef(null);
  const previewButtonRef = useRef(null);
  const scrollTop = useRef(Math.max(0, Number(uiState?.scrollTop) || 0));
  const restoreScroll = useRef(true);
  const persistentState = useRef({ query, filter, selectedId });
  persistentState.current = { query, filter, selectedId };
  const instanceId = useId();
  const entryDOMId = (id) => `${instanceId}-clipboard-${id}`;
  const editorOpen = preferencesOpen || snippetOpen;
  const editing = editorOpen || inputFocused;
  const persist = useCallback(() => onUIStateChange?.({ ...persistentState.current, scrollTop: scrollTop.current }), [onUIStateChange]);
  useEffect(() => { persist(); }, [query, filter, selectedId, persist]);
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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; detailVersion.current += 1; }; }, []);
  useEffect(() => {
    if (!bridge) return;
    // Full-text matching stays in the main process. Renderer snapshots contain previews only.
    let timer = setTimeout(() => { void loadHistory(); }, query ? 180 : 0);
    const unsubscribe = bridge.onClipboardHistory?.(() => { clearTimeout(timer); timer = setTimeout(() => { void loadHistory({ quiet: true }); }, 100); });
    return () => { clearTimeout(timer); historyVersion.current += 1; unsubscribe?.(); };
  }, [bridge, loadHistory, query, filter]);
  useEffect(() => { onEditingChange?.(editing); return () => onEditingChange?.(false); }, [editing, onEditingChange]);
  useEffect(() => { setClearArmed(false); }, [query, filter, selectedId]);
  useEffect(() => {
    if (!editorOpen) return;
    const frame = requestAnimationFrame(() => (panelRef.current?.querySelector('input, textarea, select') || panelRef.current?.querySelector('button'))?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editorOpen, snippetOpen]);

  useEffect(() => {
    if (!clearArmed) return;
    const frame = requestAnimationFrame(() => clearPanelRef.current?.querySelector('button:last-child')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [clearArmed]);

  const entries = useMemo(() => {
    if (!isDemo) return snapshot.entries;
    const needle = query.trim().toLocaleLowerCase();
    return snapshot.entries.filter((entry) => (filter === 'all' || filter === 'pinned' ? filter !== 'pinned' || entry.pinned : entry.kind === filter) && (!needle || `${entry.title || ''}\n${entry.searchText || entry.preview || ''}`.toLocaleLowerCase().includes(needle)));
  }, [snapshot.entries, query, filter, isDemo]);
  const selected = entries.find((entry) => entry.id === selectedId);
  useEffect(() => { if (!loading && !entries.some((entry) => entry.id === selectedId)) setSelectedId(entries[0]?.id || ''); }, [entries, selectedId, loading]);
  useEffect(() => {
    if (loading || !listRef.current || !restoreScroll.current) return;
    listRef.current.scrollTop = scrollTop.current;
    restoreScroll.current = false;
  }, [loading, entries]);
  useEffect(() => {
    const version = ++detailVersion.current;
    setDetail(null);
    if (!selectedId) { setDetailLoading(false); return; }
    if (isDemo) { const entry = snapshotRef.current.entries.find((item) => item.id === selectedId); setDetail(entry ? { ...entry, text: entry.preview || '' } : null); setDetailLoading(false); return; }
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
      if (next) { if (isDemo) applySnapshot(next); else await loadHistory({ quiet: true }); if (success && mounted.current) setMessage({ kind: 'success', text: success, entryId: value?.id }); }
      return next;
    } catch (error) { if (mounted.current) setMessage({ kind: 'error', text: error.message || 'Could not complete this action. Please try again.' }); return null; }
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
    try { const next = await bridge.addClipboardEntryToShelf(selected.id); onAddToShelf?.(next); }
    catch (error) { if (mounted.current) setMessage({ kind: 'error', text: error.message || 'Could not add this item to Transfers.' }); }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  };
  const focusLater = (node) => {
    const previousFocus = document.activeElement;
    return requestAnimationFrame(() => {
      const currentFocus = document.activeElement;
      // Preserve a deliberate focus change made after the close was requested.
      if (currentFocus !== previousFocus && currentFocus !== document.body && currentFocus?.isConnected) return;
      if (node?.isConnected) node.focus();
      // A preference update can disable or replace the button that opened the editor.
      if (!node?.isConnected || document.activeElement !== node) listRef.current?.focus();
    });
  };
  const closeEditor = () => { setPreferencesOpen(false); setSnippetOpen(false); focusLater(panelReturnFocus.current); };
  const openEditor = (name, trigger) => {
    if ((name === 'snippet' && snippetOpen) || (name === 'preferences' && preferencesOpen)) { closeEditor(); return; }
    panelReturnFocus.current = trigger;
    setSnippetOpen(name === 'snippet'); setPreferencesOpen(name === 'preferences'); setClearArmed(false);
  };
  const changeQuery = (value) => { if (bridge && value !== query) setLoading(true); setQuery(value); scrollTop.current = 0; if (listRef.current) listRef.current.scrollTop = 0; };
  const changeFilter = (value) => { if (bridge && value !== filter) setLoading(true); setFilter(value); scrollTop.current = 0; if (listRef.current) listRef.current.scrollTop = 0; };
  const listKeys = (event) => {
    if (event.target !== event.currentTarget || loading) return;
    if (event.key === 'Enter') { event.preventDefault(); if (!detailLoading) void copy(); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !entries.length) return;
    event.preventDefault();
    const index = entries.findIndex((entry) => entry.id === selectedId);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    setSelectedId(entries[next].id);
    requestAnimationFrame(() => document.getElementById(entryDOMId(entries[next].id))?.scrollIntoView({ block: 'nearest' }));
  };
  const workspaceKeys = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchRef.current?.focus(); return; }
    if (event.key === 'Escape') {
      if (editorOpen) closeEditor();
      else if (clearArmed) { setClearArmed(false); focusLater(clearButtonRef.current); }
      else if (previewOpen) { setPreviewOpen(false); focusLater(previewButtonRef.current); }
      else return;
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.key === 'Tab' && (editorOpen || clearArmed)) {
      const focusPanel = editorOpen ? panelRef.current : clearPanelRef.current;
      const nodes = Array.from(focusPanel?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') || []);
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    }
  };
  useEffect(() => {
    if (blocked || (!editorOpen && !clearArmed)) return;
    // Disabling a focused control during an async action can move focus to body.
    // Keep Escape local to the open dialog even when it no longer bubbles here.
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (editorOpen) { setPreferencesOpen(false); setSnippetOpen(false); focusLater(panelReturnFocus.current); }
      else { setClearArmed(false); focusLater(clearButtonRef.current); }
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [editorOpen, clearArmed, blocked]);
  const unavailable = snapshot.available === false;
  const activeCapture = snapshot.settings.enabled && !snapshot.settings.paused && !editing && !capturePaused && !unavailable;
  const captureLabel = unavailable ? 'Clipboard unavailable' : !snapshot.settings.enabled ? 'History off' : snapshot.settings.paused ? 'History paused' : editing || capturePaused ? 'Paused while editing' : 'Recording locally';
  const imageSource = detail?.imageDataURL && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(detail.imageDataURL) ? detail.imageDataURL : null;
  const disabled = !!busy || blocked || loading;
  const filtered = Boolean(query || filter !== 'all');
  const resultCount = `${entries.length} ${filtered ? (entries.length === 1 ? 'result' : 'results') : (entries.length === 1 ? 'item' : 'items')}`;
  const previewVisible = density !== 'compact' || previewOpen;
  const copyFeedback = message?.kind === 'success' && message.text.startsWith('Copied') && message.entryId === selectedId;

  return <section className={`clipboard-pane clipboard-redesign clipboard-mode-${density} ${previewOpen ? 'preview-open' : ''}`} aria-label="Clipboard workspace" onFocusCapture={(event) => { if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) setInputFocused(true); }} onBlurCapture={(event) => { if (!/INPUT|TEXTAREA|SELECT/.test(event.relatedTarget?.tagName || '')) setInputFocused(false); }} onKeyDown={workspaceKeys}>
    <header className="clipboard-heading"><h1>Clipboard</h1><div className="clipboard-toolbar"><button className="quiet-button" disabled={disabled || unavailable} onClick={() => act('captureClipboardHistory', undefined, 'Current clipboard saved.')} title="Save the current system clipboard to this history"><Clipboard size={14} /><span>Save current</span></button><button className="icon-button" aria-label="New snippet" aria-expanded={snippetOpen} disabled={disabled} onClick={(event) => openEditor('snippet', event.currentTarget)}><Plus size={17} /></button><button className={`icon-button ${preferencesOpen ? 'active' : ''}`} aria-label="Clipboard preferences" aria-expanded={preferencesOpen} onClick={(event) => openEditor('preferences', event.currentTarget)}><Settings2 size={17} /></button></div></header>
    <div className={`clipboard-capture-state ${activeCapture ? 'active' : ''}`}><span role="status"><span className={`tiny-dot ${activeCapture ? 'ready' : ''}`} />{captureLabel}</span>{snapshot.settings.enabled ? <button className="text-button" disabled={disabled || unavailable} onClick={() => act('updateClipboardPreferences', { paused: !snapshot.settings.paused })}>{snapshot.settings.paused ? <Play size={12} /> : <Pause size={12} />}{snapshot.settings.paused ? 'Resume' : 'Pause'}</button> : <button className="text-button" disabled={disabled || unavailable} onClick={(event) => openEditor('preferences', event.currentTarget)}>Enable history…</button>}</div>
    {isDemo && <p className="clipboard-notice">Fictional preview · your clipboard is not being read.</p>}
    {(snapshot.error || unavailable) && <p className="clipboard-message error" role="alert">{snapshot.error || 'Clipboard access is unavailable on this device.'}</p>}
    <div className="clipboard-query-row"><div className="clipboard-search"><Search size={14} /><input ref={searchRef} aria-label="Search clipboard history" placeholder="Search text, links, files…" value={query} onChange={(event) => changeQuery(event.target.value)} />{query && <button aria-label="Clear clipboard search" onClick={() => { changeQuery(''); searchRef.current?.focus(); }}><X size={14} /></button>}</div>{density === 'compact' && <select className="clipboard-filter-select" aria-label="Clipboard filter" value={filter} onChange={(event) => changeFilter(event.target.value)}>{filters.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>}</div>
    {density !== 'compact' && <div className="clipboard-filters" role="group" aria-label="Clipboard filter">{filters.map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => changeFilter(value)}>{value === 'pinned' && <Pin size={12} />}{label}</button>)}</div>}
    <div className="clipboard-content"><div ref={listRef} className="clipboard-list" role="listbox" aria-label="Clipboard history" aria-busy={loading} aria-activedescendant={selected ? entryDOMId(selectedId) : undefined} tabIndex={0} onKeyDown={listKeys} onScroll={(event) => { scrollTop.current = event.currentTarget.scrollTop; persist(); }}>
      {loading ? <div className="clipboard-empty"><p>Loading saved items…</p></div> : !entries.length ? <div className="clipboard-empty"><Clipboard size={24} /><strong>{filtered ? 'No matching items' : 'Your useful things, close by'}</strong><p>{filtered ? 'Try another search or filter.' : 'Save your current clipboard or create a snippet. Automatic history is optional.'}</p></div> : entries.map((entry) => <div className={`clipboard-entry ${selectedId === entry.id ? 'selected' : ''}`} role="option" aria-selected={selectedId === entry.id} aria-label={`${entry.title || kindName(entry.kind)}, ${kindName(entry.kind)}${entry.pinned ? ', pinned' : ''}${entrySource(entry) ? `, from ${entrySource(entry)}` : ''}`} id={entryDOMId(entry.id)} key={entry.id} onClick={() => { setSelectedId(entry.id); listRef.current?.focus({ preventScroll: true }); }} title={`${entry.title || kindName(entry.kind)} · ${kindName(entry.kind)} · ${sizeLabel(entry.size)}${entry.pinned ? ' · Pinned' : ''}${entrySource(entry) ? ` · From ${entrySource(entry)}` : ''}`}><span className={`clipboard-kind ${entry.kind}`}><KindIcon kind={entry.kind} size={16} /></span><div className="clipboard-entry-copy"><strong className={entry.kind === 'files' ? 'clipboard-exact' : ''}>{entry.title || kindName(entry.kind)}</strong><small>{entry.preview || kindName(entry.kind)}</small>{entrySource(entry) ? <span className="clipboard-source">From {entrySource(entry)}</span> : null}</div><span className="clipboard-entry-meta">{entry.pinned && <Pin size={12} aria-label="Pinned" />}<span>{kindName(entry.kind)}</span></span></div>)}
    </div>
    {selected && previewVisible && <section className="clipboard-detail" aria-label="Clipboard item preview"><div className="clipboard-detail-heading"><strong>{kindName(selected.kind)} preview</strong><span>{sizeLabel(selected.size)}</span>{previewOpen && <button className="icon-button small" aria-label="Close clipboard preview" onClick={() => { setPreviewOpen(false); focusLater(previewButtonRef.current); }}><X size={14} /></button>}</div><div className="clipboard-detail-body" tabIndex={0} aria-label="Selected clipboard content">{detailLoading ? <p>Loading preview…</p> : imageSource ? <img src={imageSource} alt={selected.title || 'Saved clipboard image'} /> : selected.kind === 'files' ? <ul>{(detail?.files || []).map((file, index) => <li key={index}><File size={13} /><span className="clipboard-exact">{typeof file === 'string' ? file : file.name || file.path || 'File'}</span></li>)}</ul> : <pre>{detail?.text ?? selected.preview ?? ''}</pre>}</div>{density === 'expanded' && <div className="clipboard-detail-metadata"><span>{selected.pinned ? 'Pinned · kept until removed' : 'Saved on this device'}</span><time dateTime={selected.createdAt}>{timeLabel(selected.createdAt)}</time></div>}</section>}
    </div>
    <div className="clipboard-selection-actions" role="group" aria-label="Selected clipboard item actions"><div className="clipboard-action-primary"><button className="primary-button compact" disabled={disabled || !selected || unavailable || detailLoading} onClick={() => copy()}>{copyFeedback ? <Check size={14} /> : <Copy size={14} />}{copyFeedback ? 'Copied' : 'Copy'}</button>{(!selected || selected.kind === 'text') && <button className="quiet-button" disabled={disabled || !selected || unavailable || detailLoading} onClick={() => copy(true)}>Plain text</button>}<button className="quiet-button" disabled={disabled || !selected || detailLoading} onClick={addToShelf}><ArrowUpRight size={14} /><span>Add to Transfers</span></button></div><div className="clipboard-action-secondary"><button ref={previewButtonRef} className="text-button clipboard-preview-toggle" disabled={!selected} aria-expanded={previewOpen} onClick={() => setPreviewOpen(!previewOpen)}>{previewOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}Preview</button><button className={`text-button clipboard-pin-action ${selected?.pinned ? 'pinned' : ''}`} aria-pressed={!!selected?.pinned} disabled={disabled || !selected} onClick={() => act('setClipboardPinned', { id: selected.id, pinned: !selected.pinned })}><Pin size={13} />{selected?.pinned ? 'Unpin' : 'Pin'}</button><button className="text-button clipboard-delete" disabled={disabled || !selected} aria-label="Delete selected clipboard item" onClick={() => act('removeClipboardEntry', selected.id, 'Clipboard item removed. This does not remove an item already on Transfers.')}><Trash2 size={13} />Delete</button></div></div>
    <div className="clipboard-feedback" aria-live="polite">{copyFeedback && <span className="clipboard-sr-only">{message.text}</span>}{message && !copyFeedback && <div className={`clipboard-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : undefined}>{message.kind === 'success' && <Check size={13} />}<span>{message.text}</span><button aria-label="Dismiss clipboard notice" onClick={() => setMessage(null)}><X size={13} /></button></div>}</div>
    <footer className="clipboard-bottom"><span>{resultCount}{filtered ? ' shown' : ''}</span><button ref={clearButtonRef} className="text-button muted" disabled={disabled || (!filtered && !snapshot.entries.some((entry) => !entry.pinned))} aria-expanded={clearArmed} onClick={() => { setClearArmed(true); setPreferencesOpen(false); setSnippetOpen(false); }}>Clear unpinned…</button></footer>
    {clearArmed && <div ref={clearPanelRef} className="clipboard-clear-confirm" role="alertdialog" aria-modal="true" aria-label="Clear all unpinned clipboard history"><strong>Clear all unpinned history?</strong><p>This includes items outside the current search and filter. Pinned items stay. Clipboard deletion has no Undo.</p><div><button className="danger-button" disabled={disabled} onClick={async () => { if (await act('clearClipboardHistory', undefined, 'All unpinned clipboard history cleared. Pinned items kept.')) { setClearArmed(false); focusLater(clearButtonRef.current); } }}>Clear all unpinned history</button><button className="quiet-button" onClick={() => { setClearArmed(false); focusLater(clearButtonRef.current); }}>Cancel</button></div></div>}
    {editorOpen && <div className="clipboard-editor-backdrop"><section ref={panelRef} className="clipboard-editor" role="dialog" aria-modal="true" aria-label={snippetOpen ? 'New text snippet' : 'Clipboard history preferences'}><header><h2>{snippetOpen ? 'New text snippet' : 'History preferences'}</h2><button type="button" className="icon-button" aria-label={snippetOpen ? 'Close new snippet' : 'Close clipboard preferences'} onClick={closeEditor}><X size={17} /></button></header>{snippetOpen ? <form className="clipboard-snippet" onSubmit={async (event) => { event.preventDefault(); if (await act('saveClipboardSnippet', { text: snippetText, title: snippetTitle }, 'Snippet saved and pinned.')) { setSnippetText(''); setSnippetTitle(''); closeEditor(); } }}><label className="field">Title <span>optional</span><input maxLength={120} value={snippetTitle} onChange={(event) => setSnippetTitle(event.target.value)} placeholder="e.g. Meeting link" /></label><label className="field">Snippet<textarea required rows={5} value={snippetText} onChange={(event) => setSnippetText(event.target.value)} placeholder="Save something you use often…" /></label><p>Snippets are pinned and stay on this device until removed.</p><button className="primary-button compact" disabled={disabled || !snippetText.trim()}><Plus size={14} />Save snippet</button></form> : <div className="clipboard-preferences"><p>Automatic history saves new text, images and copied files on this device. It may include sensitive content. Pause it whenever you need. Continuity clipboard is separate and starts off. Enable it in Settings on each running app to copy here and paste on linked devices.</p><button className="quiet-button" disabled={disabled || unavailable} onClick={() => act('updateClipboardPreferences', { enabled: !snapshot.settings.enabled, ...(snapshot.settings.enabled ? {} : { paused: false }) }, snapshot.settings.enabled ? 'Automatic history turned off. Saved items remain available.' : 'Local clipboard history enabled. It resumes after you finish editing.')}><Play size={14} />{snapshot.settings.enabled ? 'Turn off automatic history' : 'Turn on clipboard history'}</button><label>Keep recent items<select aria-label="Clipboard history limit" disabled={disabled} value={snapshot.settings.maxItems} onChange={(event) => act('updateClipboardPreferences', { maxItems: Number(event.target.value) })}>{[20,50,100,200,500].map((number) => <option key={number} value={number}>{number} items</option>)}</select></label><label>Keep unpinned history<select aria-label="Clipboard retention" disabled={disabled} value={snapshot.settings.retentionDays} onChange={(event) => act('updateClipboardPreferences', { retentionDays: Number(event.target.value) })}>{[1,7,30,90].map((days) => <option key={days} value={days}>{days} {days === 1 ? 'day' : 'days'}</option>)}</select></label><p>Pins stay until removed. History is excluded from configuration exports. Automatic capture pauses while you edit in {bridge?.productName || 'ShelfDock'}.</p></div>}</section></div>}
  </section>;
}
