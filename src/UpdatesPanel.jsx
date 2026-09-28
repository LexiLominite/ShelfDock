import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, Check, Download, ExternalLink, FolderOpen, RefreshCw, ShieldCheck, X } from 'lucide-react';
import './updates.css';

const busyStates = new Set(['checking', 'downloading', 'preparing', 'installing']);
const installStates = new Set(['preparing', 'installing']);
const size = value => value > 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
const instruction = platform => platform === 'darwin'
  ? 'Quit the app, unzip the verified package, then replace the app in your Applications folder. Keep a copy of the previous app until the new version opens successfully.'
  : platform === 'win32'
    ? 'Quit the app, keep a backup of your current portable executable, then replace it with this verified download. Open the new executable from the same folder.'
    : 'Quit the app and unpack this verified archive into a new folder you own. Keep the previous app folder until the new version opens successfully.';

export default function UpdatesPanel({ bridge, onClose, blocked = false, onBusyChange }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState(false);
  const mounted = useRef(true);
  const lock = useRef(false);
  const busy = pending || busyStates.has(state?.status);
  const installing = installStates.has(state?.status);
  useEffect(() => {
    mounted.current = true; let eventReceived = false;
    const unsubscribe = bridge?.onUpdates?.(value => { eventReceived = true; if (mounted.current) setState(value); });
    Promise.resolve(bridge?.getUpdates?.()).then(value => { if (mounted.current && !eventReceived) setState(value || { unavailable: true }); }).catch(failure => { if (mounted.current) setError(failure.message || 'Could not load updates.'); });
    return () => { mounted.current = false; unsubscribe?.(); };
  }, [bridge]);
  useEffect(() => { onBusyChange?.(installing); }, [installing, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  async function run(method, value) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError('');
    try { const next = await bridge[method](value); if (mounted.current && next) setState(next); }
    catch (failure) { if (mounted.current) setError(failure.message || 'This update action did not finish.'); }
    finally { lock.current = false; if (mounted.current) setPending(false); }
  }
  const progress = state?.progress;
  const percentage = progress?.total ? Math.min(100, Math.round(progress.received / progress.total * 100)) : 0;
  const release = state?.release;
  const statusText = state?.status === 'checking' ? 'Checking GitHub…'
    : state?.status === 'downloading' ? 'Downloading and verifying…'
      : state?.status === 'preparing' ? 'Preparing your update…'
        : state?.status === 'installing' ? 'Restarting to install…'
          : state?.status === 'current' ? 'You have the latest version in this channel.'
            : state?.status === 'downloaded' ? `Version ${state.downloaded?.version} is ready.`
              : release ? `Version ${release.version} is available.` : 'Check when you want, or let the app check quietly.';
  if (state?.unavailable) return <div className="updates-panel"><p className="modal-intro">Updates are available from the installed desktop app.</p><button className="quiet-button" onClick={onClose}>Done</button></div>;
  return <div className="updates-panel" aria-busy={busy}>
    <div className="updates-installed"><ArrowUpCircle size={24} /><div><strong>Updates, on your terms</strong><span>{state ? `Installed version ${state.currentVersion}` : 'Loading update settings…'}</span></div></div>
    {state?.personal && <div className="updates-private"><p className="modal-intro">LexBridge updates come only from your private repository. Your bundled configuration stays separate from ShelfDock.</p><p className="updates-help">Private checks use GitHub CLI on this device. If needed, install GitHub CLI and sign in with <code>gh auth login</code>. The app does not store or ask you to paste a GitHub token.</p><button className="quiet-button" disabled={installing} onClick={() => run('openUpdateRelease')}><ExternalLink size={14} /> Private releases</button></div>}
    {state && <>
      <div className="updates-preferences">
        <label><input type="checkbox" checked={!!state.preferences?.autoCheck} disabled={busy} onChange={event => run('updateUpdatePreferences', { autoCheck: event.target.checked })} /><span><strong>Check automatically</strong><small>Check GitHub about once a day. No pop-up windows or interruptions.</small></span></label>
        <label className="updates-preference-child"><input type="checkbox" checked={!!state.preferences?.autoDownload} disabled={busy || !state.preferences?.autoCheck} onChange={event => run('updateUpdatePreferences', { autoDownload: event.target.checked })} /><span><strong>Download updates in the background</strong><small>You still choose when to restart and install.</small></span></label>
        <label><input type="checkbox" checked={!!state.preferences?.includePrereleases} disabled={busy} onChange={event => { setReview(false); run('updateUpdatePreferences', { includePrereleases: event.target.checked }); }} /><span><strong>Include preview releases</strong><small>{state.personal ? 'Include private preview builds. Turn this off to check stable releases only.' : 'ShelfDock is currently a public preview. Turn this off to check stable releases only.'}</small></span></label>
      </div>
      <section className="updates-status" aria-label="Update status">
        <div className="updates-status-heading"><strong role="status" aria-live="polite">{statusText}</strong>{release?.prerelease && <span className="updates-preview">Preview</span>}</div>
        {state.lastChecked && <p className="updates-help">Last checked {new Date(state.lastChecked).toLocaleString()}</p>}
        {state.status === 'downloading' && <div className="updates-progress"><progress max="100" value={percentage} aria-label="Update download progress" /><span>{progress ? `${size(progress.received)} of ${size(progress.total)} · ${percentage}%` : 'Verifying the release checksum list…'}</span></div>}
        {state.downloaded && <p className="updates-verified"><ShieldCheck size={16} /> SHA-256 matched the published release.</p>}
        {state.downloaded && <p className="updates-help">This checks download integrity. It is separate from publisher code signing.</p>}
        {!busy && <div className="updates-actions">
          <button className="quiet-button" onClick={() => run('checkForUpdates')}><RefreshCw size={14} /> Check for updates</button>
          {release && !state.downloaded && state.canDownload && <button className="primary-button" onClick={() => run('downloadUpdate')}><Download size={15} /> Download {release.asset?.size ? size(release.asset.size) : 'update'}</button>}
          {release && !state.downloaded && !state.canDownload && <button className="quiet-button" onClick={() => run('openUpdateRelease')}><ExternalLink size={14} /> View release</button>}
          {state.downloaded && <button className="quiet-button" onClick={() => run('revealUpdateDownload')}><FolderOpen size={14} /> Show download</button>}
          {state.canInstall && !review && <button className="primary-button" disabled={blocked} onClick={() => setReview(true)}><ArrowUpCircle size={15} /> Install update…</button>}
        </div>}
        {['checking', 'downloading'].includes(state.status) && <button className="quiet-button" onClick={() => bridge.cancelUpdate().catch(failure => setError(failure.message))}><X size={14} /> Cancel</button>}
        {state.downloaded && !state.canInstall && <div className="updates-manual"><strong>Install this package manually</strong><p>{state.installation?.reason}</p><p>{instruction(state.platform)}</p></div>}
        {review && state.canInstall && <div className="updates-review" aria-label="Review update installation">
          <h3>Restart and install {state.downloaded?.version}</h3>
          <p>The app will close, keep a backup of this version, replace only its application files, then reopen quietly. Your shelf, clipboard, machine settings and keys stay in place.</p>
          <p className="updates-path">{state.installation?.target}</p>
          <p>These preview packages are unsigned. Your operating system may ask you to approve the new app; its security settings stay unchanged.</p>
          {blocked && <p className="settings-warning">Finish active work and stop live forwards before restarting.</p>}
          <div className="updates-actions"><button className="quiet-button" disabled={installing} onClick={() => setReview(false)}>Later</button><button className="primary-button" disabled={busy || blocked} onClick={() => run('installUpdate')}><ArrowUpCircle size={15} /> Restart and install</button></div>
        </div>}
      </section>
      {release?.notes && <details className="updates-notes"><summary>What’s new in {release.version}</summary><pre>{release.notes}</pre><button className="quiet-button" disabled={installing} onClick={() => run('openUpdateRelease')}><ExternalLink size={14} /> Release on GitHub</button></details>}
      {state.result?.status === 'installed' && <p className="updates-verified"><Check size={16} /> Updated to {state.result.version}.{state.result.backupRetained ? ' The previous app backup is retained beside the installation.' : ''}</p>}
      {state.result && state.result.status !== 'installed' && <p className="settings-warning">The last update did not complete in this running app.{state.result.backupRetained ? ' The previous app backup is retained beside the installation.' : ''} You can retry or use the verified download.</p>}
      <p className="updates-help">Automatic checks and downloads are off until you enable them. Installing always needs your choice.</p>
      <div className="modal-actions"><button className="quiet-button" disabled={installing} onClick={onClose}>Done</button></div>
    </>}
    {(error || state?.error) && <p className="updates-error" role="alert">{error || state.error}</p>}
  </div>;
}
