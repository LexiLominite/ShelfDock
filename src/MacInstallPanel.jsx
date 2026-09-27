import React, { useEffect, useRef, useState } from 'react';
import './mac-install.css';
import { ArrowLeft, Check, CircleAlert, Download, Laptop, Loader2 } from 'lucide-react';

const connectionKey = host => host ? JSON.stringify([host.id, host.address, host.user, host.port, host.sshAlias, host.identityFile, host.os]) : '';
const activeStatuses = new Set(['preparing', 'uploading', 'verifying']);

export default function MacInstallPanel({ bridge, hosts, initialHostId = '', onBusyChange, onClose, blocked = false }) {
  const [hostId, setHostId] = useState(initialHostId);
  const [plan, setPlan] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirmPreset, setConfirmPreset] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const busy = checking || installing || activeStatuses.has(snapshot?.operation?.status);
  const candidates = hosts.filter(host => host.user || host.id === initialHostId);
  const currentHost = hosts.find(host => host.id === hostId);
  const operation = snapshot?.operation;

  useEffect(() => {
    mounted.current = true;
    let receivedEvent = false;
    const apply = next => { receivedEvent = true; if (mounted.current) setSnapshot(next); };
    Promise.resolve(bridge?.getMacInstallState?.()).then(next => {
      if (mounted.current && next && !receivedEvent) setSnapshot({...next, operation: activeStatuses.has(next.operation?.status) ? next.operation : null});
    }).catch(failure => { if (mounted.current) setError(failure.message || 'Could not load the installer.'); });
    const unsubscribe = bridge?.onMacInstallState?.(apply);
    return () => { mounted.current = false; unsubscribe?.(); };
  }, [bridge]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => {
    if (plan && (!currentHost || currentHost.address !== plan.address || currentHost.user !== plan.user || connectionKey(currentHost) !== plan.connectionKey)) {
      setPlan(null); setConfirmPreset(false); setError('This machine changed. Check its destination again.');
    }
  }, [currentHost, plan]);

  async function checkMac(event) {
    event.preventDefault();
    if (!hostId || lock.current || blocked) return;
    lock.current = true; onBusyChange?.(true); setChecking(true); setError(''); setPlan(null); setConfirmPreset(false); setSnapshot(previous => previous ? {...previous, operation: null} : previous);
    try { const next = await bridge.previewMacInstall({hostId}); if (mounted.current) setPlan({...next, connectionKey: connectionKey(currentHost)}); }
    catch (failure) { if (mounted.current) setError(failure.message || 'This Mac could not be checked.'); }
    finally { lock.current = false; if (mounted.current) setChecking(false); }
  }
  async function install() {
    if (!plan || plan.canInstall === false || lock.current || blocked || (plan.includesPersonalPreset && !confirmPreset)) return;
    lock.current = true; onBusyChange?.(true); setInstalling(true); setError('');
    try {
      const next = await bridge.installOnMac({planId: plan.id, confirmPreset});
      if (mounted.current) { setSnapshot(next); setPlan(null); }
    } catch (failure) {
      if (mounted.current) { setError(failure.message || 'Installation did not finish. Check the destination before retrying.'); setPlan(null); }
    } finally { lock.current = false; if (mounted.current) setInstalling(false); }
  }

  if (snapshot?.available === false) return <div className="mac-install-panel"><p className="modal-intro">{snapshot.reason || 'Install on another Mac is available from the installed macOS app.'}</p><button className="quiet-button" onClick={onClose}>Done</button></div>;
  return <div className="mac-install-panel" aria-busy={busy}>
    <p className="modal-intro">Installation currently supports Macs only. Check the selected device, then review its destination before choosing Install.</p>
    <p className="mac-install-help">Only the app bundle is copied. Your clipboard, saved passwords, SSH keys, shelf and local settings stay on this device. The other Mac needs Remote Login and trusted SSH access.</p>
    {!plan && !busy && operation?.status !== 'installed' && <form onSubmit={checkMac}>
      <label className="field">Selected device<select aria-label="Device to install on" value={hostId} onChange={event => { setHostId(event.target.value); setError(''); }} disabled={blocked || !!initialHostId}>
        <option value="">Choose a saved machine…</option>
        {candidates.map(host => <option key={host.id} value={host.id}>{host.name} — {host.user}@{host.address}</option>)}
      </select></label>
      {!candidates.length && <p className="settings-warning">Add a Mac in Machines and set up its SSH access first.</p>}
      <p className="mac-install-help">Check Mac confirms macOS and a compatible processor. Existing apps are left in place.</p>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!hostId || blocked}><Laptop size={15} /> Check Mac</button></div>
    </form>}
    {plan && !busy && <section className="mac-install-review" aria-label="Installation destination">
      <h3>Review destination</h3>
      <dl><dt>Mac</dt><dd>{plan.hostName}</dd><dt>Connection</dt><dd className="mac-install-exact">{plan.user}@{plan.address}</dd><dt>Install folder</dt><dd className="mac-install-exact">{plan.destination}</dd><dt>App</dt><dd>{plan.productName} {plan.version}</dd><dt>Processor</dt><dd>{plan.architecture === 'arm64' ? 'Apple Silicon' : plan.architecture === 'x64' ? 'Intel' : plan.architecture}</dd>{plan.existingVersion && <><dt>Installed version</dt><dd>{plan.existingVersion}</dd></>}</dl>
      {plan.canInstall === false && <p className="settings-warning"><CircleAlert size={15} />{plan.reason || 'This app is already installed there. Update it manually; the existing app will not be replaced.'}</p>}
      {plan.includesPersonalPreset && <label className="mac-install-consent"><input type="checkbox" checked={confirmPreset} onChange={event => setConfirmPreset(event.target.checked)} /> <span>This personal edition includes my bundled machine list. Include that preset on this Mac.</span></label>}
      <p className="mac-install-help">The app will not open automatically. Open it on the other Mac after installation. Any macOS security prompts remain under your control.</p>
      <div className="modal-actions"><button className="quiet-button" onClick={() => { setPlan(null); setConfirmPreset(false); }}><ArrowLeft size={14} /> Back</button><button className="primary-button" disabled={blocked || plan.canInstall === false || (plan.includesPersonalPreset && !confirmPreset)} onClick={install}><Download size={15} /> Install on {plan.hostName}</button></div>
    </section>}
    {busy && <div className="mac-install-progress" role="status" aria-live="polite"><Loader2 size={19} className="spinning" /><div><strong>{checking ? 'Checking Mac…' : operation?.status === 'uploading' ? 'Sending app…' : operation?.status === 'verifying' ? 'Verifying installation…' : 'Preparing app…'}</strong><p>{checking ? 'Confirming macOS, compatibility and destination.' : operation?.message || 'You can hide this window while installation finishes.'}</p></div></div>}
    {!busy && operation?.status === 'installed' && <div className="mac-install-complete" role="status"><Check size={20} /><div><strong>Installed on {operation.hostName || 'your Mac'}</strong><p className="mac-install-exact">{operation.destination}</p><p>Open the app on that Mac to get started.</p></div><button className="quiet-button" onClick={onClose}>Done</button></div>}
    {!busy && operation?.localCleanupPending && <p className="settings-warning" role="status">A temporary installer file on this Mac could not be removed. The installation result above is unchanged.</p>}
    {!busy && operation?.cleanupPending && <p className="settings-warning" role="status">The temporary installation folder could not be removed. Check <span className="mac-install-exact">{operation.stagingDirectory}</span> on the destination Mac.</p>}
    {!busy && (error || operation?.status === 'failed') && <p className="mac-install-error" role="alert"><CircleAlert size={16} />{error || operation.message || 'Installation did not finish. Check the destination before trying again.'}</p>}
  </div>;
}
