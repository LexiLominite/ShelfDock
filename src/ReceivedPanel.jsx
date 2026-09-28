import React, { useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, CheckCheck, ChevronDown, File, FolderOpen, Inbox, Plus, RefreshCw, Search, Send, X } from 'lucide-react';
import './received.css';

const timeLabel = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
};
const title = entry => entry.items?.length ? `${entry.items[0].name}${entry.items.length > 1 ? ` + ${entry.items.length - 1}` : ''}` : `${entry.itemCount || 0} items`;

export default function ReceivedPanel({ bridge, snapshot, onSnapshot, history, shelfItems, blocked, uiState, onUIStateChange, onAddToShelf, onSelectSent }) {
  const { filter = 'received', query = '', selectedId = '' } = uiState;
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [selectedNames, setSelectedNames] = useState([]);
  const operation = useRef(false);
  const isSent = filter === 'sent';
  const records = isSent ? history : (snapshot.received || []).filter(entry => filter !== 'unread' || entry.unread);
  const needle = query.trim().toLocaleLowerCase();
  const entries = records.filter(entry => !needle || [title(entry), entry.senderLabel, entry.hostName, entry.destination, entry.folderName, timeLabel(entry.receivedAt || entry.timestamp), ...(entry.items || []).map(item => item.name)].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle));
  const updateUI = patch => onUIStateChange({ ...uiState, ...patch });
  const run = async (name, value, add = false) => {
    if (operation.current || blocked) return;
    if (!bridge?.[name]) { setMessage({ error: false, text: 'Open the desktop app to manage received files.' }); return; }
    operation.current = true; setBusy(name); setMessage(null);
    try {
      const next = await bridge[name](value);
      if (add) onAddToShelf(next);
      else if (next?.received) onSnapshot(next);
      else if (name === 'openReceivedFolder') setMessage({ text: 'Opened the transfer folder.' });
    } catch (error) { setMessage({ error: true, text: error.message || 'Could not complete this action. Try Refresh.' }); }
    finally { operation.current = false; setBusy(''); }
  };
  const disabled = blocked || !!busy;
  return <section className="received-pane" aria-label="Received and sent files">
    <div className="received-heading"><div><h1>Received</h1><p>What arrived. What you sent.</p></div><button className="icon-button" aria-label="Refresh received files" title="Check Desktop for completed transfers" disabled={disabled || snapshot.scanning} onClick={() => run('refreshReceived')}><RefreshCw size={17} className={snapshot.scanning || busy === 'refreshReceived' ? 'spinning' : ''} /></button></div>
    <div className="received-filters" role="group" aria-label="Transfer history filter">{[['received', 'Received'], ['unread', 'New'], ['sent', 'Sent']].map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => { updateUI({ filter: value, selectedId: '' }); setSelectedNames([]); setMessage(null); }}>{label}{value === 'unread' && snapshot.unreadCount > 0 && <span>{snapshot.unreadCount}</span>}</button>)}</div>
    <label className="received-search"><Search size={15} /><input aria-label="Search received and sent files" value={query} placeholder="File, device, or date…" onChange={event => updateUI({ query: event.target.value })} />{query && <button type="button" aria-label="Clear transfer search" onClick={() => updateUI({ query: '' })}><X size={13} /></button>}</label>
    {!isSent && snapshot.unreadCount > 0 && <div className="received-summary"><span>{snapshot.unreadCount} new {snapshot.unreadCount === 1 ? 'arrival' : 'arrivals'}</span><button className="text-button" disabled={disabled} onClick={() => run('markReceivedRead', { all: true })}><CheckCheck size={13} /> Mark all seen</button></div>}
    {(message || snapshot.error) && <p className={`received-message ${message?.error || snapshot.error ? 'error' : ''}`} role={message?.error || snapshot.error ? 'alert' : 'status'}>{message?.text || snapshot.error}</p>}
    <div className="received-list" aria-label={isSent ? 'Sent transfers' : 'Received transfers'}>
      {entries.length ? entries.map(entry => {
        const expanded = selectedId === entry.id;
        const missing = !isSent && entry.available === false;
        const availableShelfIds = (entry.itemIds || []).filter(id => shelfItems.some(item => item.id === id));
        const items = entry.items || [];
        return <article className={`received-record ${entry.unread && !isSent ? 'unread' : ''}`} key={entry.id}>
          <button className="received-record-toggle" aria-expanded={expanded} aria-label={`${isSent ? 'Sent' : 'Received'} ${title(entry)}`} onClick={() => { updateUI({ selectedId: expanded ? '' : entry.id }); setSelectedNames(items.map(item => item.name)); setMessage(null); }}>
            <span className="received-direction" aria-hidden="true">{isSent ? <ArrowUpRight size={18} /> : <ArrowDownToLine size={18} />}</span>
            <span className="received-record-copy"><strong title={title(entry)}>{title(entry)}</strong><small>{isSent ? `To ${entry.hostName || 'another computer'}` : `From ${entry.senderLabel || 'another computer'}`} · {timeLabel(entry.receivedAt || entry.timestamp)}</small></span>
            {entry.unread && !isSent && <span className="arrival-dot" aria-label="New arrival" />}<ChevronDown size={14} className={expanded ? 'expanded' : ''} />
          </button>
          <div className="received-record-status"><span className={isSent && entry.status === 'failed' ? 'attention' : missing ? 'attention' : ''}>{isSent ? ({ sent: 'Delivered', sending: 'Sending…', failed: 'Failed' }[entry.status] || entry.status) : missing ? 'Items moved or changed' : 'On this device'}</span>{isSent && entry.receiptWarning && <span className="attention">Arrival listing unavailable</span>}</div>
          {expanded && <div className="received-detail">
            {items.length > 0 ? <ul className="received-files">{items.map((item, index) => <li key={`${index}-${item.name}`}>{!isSent ? <label><input type="checkbox" disabled={disabled || missing} checked={selectedNames.includes(item.name)} onChange={() => setSelectedNames(names => names.includes(item.name) ? names.filter(name => name !== item.name) : [...names, item.name])} /><File size={13} /><span title={item.name}>{item.name}</span></label> : <span><File size={13} /><span>{item.name}</span></span>}</li>)}</ul> : <p className="received-help">This older transfer recorded its item count. New transfers also keep their file names.</p>}
            {(entry.folderName || entry.destination) && <p className="received-path" title={entry.folderName || entry.destination}>{entry.folderName || entry.destination}</p>}
            {isSent && <p className="received-help">{entry.message || (entry.status === 'sent' ? 'Delivered over SSH. This does not indicate whether someone has opened the files.' : 'Check the transfer status before retrying.')}</p>}
            <div className="received-actions">{isSent ? <button className="quiet-button" disabled={disabled || !availableShelfIds.length || entry.status === 'sending'} onClick={() => onSelectSent(availableShelfIds)}><Send size={13} /> Use {availableShelfIds.length || ''} shelf {availableShelfIds.length === 1 ? 'item' : 'items'}</button> : <>
              <button className="quiet-button" disabled={disabled} onClick={() => run('openReceivedFolder', { id: entry.id })}><FolderOpen size={13} /> Open folder</button>
              <button className="quiet-button" disabled={disabled || missing || !selectedNames.length} onClick={() => run('addReceivedToShelf', { id: entry.id, names: selectedNames }, true)}><Plus size={13} /> To shelf{selectedNames.length > 0 ? ` · ${selectedNames.length}` : ''}</button>
              {entry.unread && <button className="text-button" disabled={disabled} onClick={() => run('markReceivedRead', { id: entry.id })}><Check size={13} /> Mark seen</button>}
            </>}</div>
          </div>}
        </article>;
      }) : <div className="received-empty"><Inbox size={32} strokeWidth={1.3} /><h2>{needle ? 'No matching transfers' : filter === 'unread' ? 'You’re all caught up' : isSent ? 'Your sent files, in one place' : 'A place for every arrival'}</h2><p>{needle ? 'Try a file name, a device name, or a date.' : isSent ? 'Send from Transfers. The file names and destination will stay here after clearing your shelf.' : filter === 'unread' ? 'New completed transfers will get a quiet badge here.' : 'Send to this device’s Desktop from ShelfDock 0.5 or later. Completed transfers appear here, even if this app was closed when they arrived.'}</p></div>}
    </div>
    <p className="received-footnote">{isSent ? 'Sent keeps the latest 100 transfers. Use shelf items to send again; nothing sends automatically.' : 'Checks Desktop transfer folders. Files stay where they arrived. No automatic opening or clipboard sync.'}</p>
  </section>;
}
