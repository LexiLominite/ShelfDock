import React, { useEffect, useRef, useState } from 'react';
import './remote-install.css';
import { ArrowLeft, Check, CircleAlert, Download, Laptop, Loader2 } from 'lucide-react';

const connectionKey = host => host ? JSON.stringify([host.id, host.address, host.user, host.port, host.sshAlias, host.identityFile, host.os]) : '';
const activeStatuses = new Set(['preparing', 'uploading', 'verifying', 'installing', 'cancelling']);

export default function RemoteInstallPanel({ bridge, hosts, initialHostId = '', onBusyChange, onClose, blocked = false }) {
  const [hostId, setHostId] = useState(initialHostId);
  const [plan, setPlan] = useState(null);
  const [consentPersonalPreset, setConsentPersonalPreset] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const previewGeneration = useRef(0);
  const mounted = useRef(true);
  const busy = checking || installing || activeStatuses.has(snapshot?.operation?.status);
  const candidates = hosts.filter(host => host.user || host.id === initialHostId);
  const currentHost = hosts.find(host => host.id === hostId);
  const operation = snapshot?.operation;

  useEffect(() => {
    mounted.current = true;
    let receivedEvent = false;
    const apply = next => { receivedEvent = true; if (mounted.current) setSnapshot(next); };
    Promise.resolve(bridge?.getRemoteInstallState?.()).then(next => {
      if (mounted.current && next && !receivedEvent) setSnapshot({...next, operation: activeStatuses.has(next.operation?.status) ? next.operation : null});
    }).catch(failure => { if (mounted.current) setError(failure.message || 'Could not load the installer.'); });
    const unsubscribe = bridge?.onRemoteInstall?.(apply);
    return () => { mounted.current = false; previewGeneration.current += 1; unsubscribe?.(); };
  }, [bridge]);

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    if (plan && (!currentHost || currentHost.address !== plan.address || currentHost.user !== plan.user || connectionKey(currentHost) !== plan.connectionKey)) {
      setPlan(null); setError('This machine changed. Check its destination again.');
    }
  }, [currentHost, plan]);

  async function checkMachine(event) {
    event.preventDefault();
    if (!hostId || lock.current || blocked) return;
    const generation = ++previewGeneration.current;
    lock.current = true; onBusyChange?.(true); setChecking(true); setError(''); setConsentPersonalPreset(false); setPlan(null); setSnapshot(previous => previous ? {...previous, operation: null} : previous);
    try { const next = await bridge.previewRemoteInstall({hostId}); if (mounted.current && generation === previewGeneration.current) setPlan({...next, connectionKey: connectionKey(currentHost)}); }
    catch (failure) { if (mounted.current && generation === previewGeneration.current) setError(failure.message || 'This machine could not be checked.'); }
    finally { if (generation === previewGeneration.current) { lock.current = false; if (mounted.current) setChecking(false); } }
  }

  function cancelPreview() {
    previewGeneration.current += 1; lock.current = false; setChecking(false); setPlan(null); onBusyChange?.(false);
    Promise.resolve(bridge.cancelRemoteInstall?.({})).catch(() => {});
    onClose?.();
  }

  async function install() {
    if (!plan || plan.canInstall === false || lock.current || blocked) return;
    lock.current = true; onBusyChange?.(true); setInstalling(true); setError('');
    try {
      const next = await bridge.installRemotely({planId: plan.id, consentPersonalPreset});
      if (mounted.current) { setSnapshot(next); setPlan(null); }
    } catch (failure) {
      if (mounted.current) { setError(failure.message || 'Installation did not finish. Check the destination before retrying.'); setPlan(null); }
    } finally { lock.current = false; if (mounted.current) setInstalling(false); }
  }

  async function cancelInstallation() {
    setError('');
    try {
      const next = await bridge.cancelRemoteInstall?.({});
      if (mounted.current && next) setSnapshot(next);
    } catch (failure) {
      if (mounted.current) setError(failure.message || 'Cancellation did not finish. Try again while the transfer is active.');
    }
  }

  if (snapshot?.available === false) return <div className="remote-install-panel"><p className="modal-intro">{snapshot.reason || 'Installation is currently unavailable.'}</p><button className="quiet-button" onClick={onClose}>Done</button></div>;
  
  return <div className="remote-install-panel" aria-busy={busy}>
    <p className="modal-intro">Remote installation works for Mac, Windows x64 and Linux. Check the selected device, then review its destination before choosing Install.</p>
    <p className="remote-install-help">Your clipboard, saved passwords, SSH keys, shelf and local settings stay on this device. The other machine needs trusted SSH access.</p>
    {!plan && !busy && operation?.status !== 'installed' && <form onSubmit={checkMachine}>
      <label className="field">Selected device<select aria-label="Device to install on" value={hostId} onChange={event => { setHostId(event.target.value); setError(''); }} disabled={blocked || !!initialHostId}>
        <option value="">Choose a saved machine…</option>
        {candidates.map(host => <option key={host.id} value={host.id}>{host.name} — {host.user}@{host.address}</option>)}
      </select></label>
      {!candidates.length && <p className="settings-warning">Add a machine in Machines and set up its SSH access first.</p>}
      <p className="remote-install-help">Check Machine confirms compatibility and prepares a preview.</p>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!hostId || blocked}><Laptop size={15} /> Check Machine</button></div>
    </form>}
    {plan && !busy && <section className="remote-install-review" aria-label="Installation destination">
      <h3>Review destination</h3>
      <dl><dt>Machine</dt><dd>{plan.hostName}</dd><dt>Connection</dt><dd className="remote-install-exact">{plan.user}@{plan.address}</dd><dt>OS</dt><dd>{plan.os === 'linux' ? 'Linux' : plan.os === 'windows' ? 'Windows' : plan.os === 'macos' ? 'Mac' : plan.os}</dd><dt>App</dt><dd>{plan.productName} {plan.version}</dd><dt>Processor</dt><dd>{plan.architecture}</dd><dt>Destination</dt><dd>{plan.destination}</dd></dl>
      {plan.includesPersonalPreset && <label className="remote-install-help"><input type="checkbox" checked={consentPersonalPreset} onChange={event => setConsentPersonalPreset(event.target.checked)} /> I agree to copy the bundled personal machine preset to this machine. Credentials remain on this device.</label>}
      {plan.canInstall === false && <p className="settings-warning"><CircleAlert size={15} />{plan.reason || 'This app is already installed there. Update it manually.'}</p>}
      <p className="remote-install-help">The app will not open automatically. Open it on the remote machine after installation.</p>
      <div className="modal-actions"><button className="quiet-button" onClick={() => { setPlan(null); }}><ArrowLeft size={14} /> Back</button><button className="primary-button" disabled={blocked || plan.canInstall === false || (plan.includesPersonalPreset && !consentPersonalPreset)} onClick={install}><Download size={15} /> Install on {plan.hostName}</button></div>
    </section>}
    {busy && <div className="remote-install-progress" role="status" aria-live="polite"><Loader2 size={19} className="spinning" /><div><strong>{checking ? 'Checking Machine…' : operation?.status === 'cancelling' ? 'Cancelling installation…' : operation?.status === 'uploading' ? 'Sending app…' : operation?.status === 'verifying' ? 'Verifying installation…' : 'Preparing app…'}</strong><p>{checking ? 'Confirming compatibility and destination.' : operation?.message || 'You can hide this window while installation finishes.'}</p></div>{checking && <button className="quiet-button" onClick={cancelPreview}>Cancel check</button>}{!checking && operation?.canCancel !== false && operation?.status !== 'installing' && <button className="quiet-button" onClick={cancelInstallation}>Cancel installation</button>}</div>}
    {!busy && operation?.status === 'installed' && <div className="remote-install-complete" role="status"><Check size={20} /><div><strong>Installed on {operation.hostName || 'the remote machine'}</strong><p>Open the app on that machine to get started.</p></div><button className="quiet-button" onClick={onClose}>Done</button></div>}
    {!busy && operation?.cleanupPending && <p className="settings-warning" role="status">The temporary installation folder could not be removed. Check <span className="remote-install-exact">{operation.stagingDirectory}</span> on the destination.</p>}
    {(error || (!busy && ['failed', 'cancelled'].includes(operation?.status))) && <p className="remote-install-error" role="alert"><CircleAlert size={16} />{error || operation.message || 'Installation did not finish. Check the destination before trying again.'}</p>}
  </div>;
}
