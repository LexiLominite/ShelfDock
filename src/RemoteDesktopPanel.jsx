import React, { useEffect, useRef, useState } from 'react';
import './remote-desktop.css';
import { CircleAlert, Loader2, Maximize, Monitor, MousePointer2 } from 'lucide-react';
import RFB from '@novnc/novnc';

export default function RemoteDesktopPanel({ bridge, host, onClose, onBusyChange, blocked = false }) {
  const [info, setInfo] = useState(null);
  const [session, setSession] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('waiting');
  const [viewOnly, setViewOnly] = useState(true);
  const [fit, setFit] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [credentialsNeeded, setCredentialsNeeded] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const validTemporaryPassword = /^[\x21-\x7e]{6,8}$/.test(password);
  const container = useRef(null), viewer = useRef(null), rfb = useRef(null);
  const currentSession = useRef(null), mounted = useRef(true), generation = useRef(0), locked = useRef(false);
  const owned = useRef(false), temporaryPassword = useRef('');

  useEffect(() => { onBusyChange?.(busy || status === 'connecting'); }, [busy, status, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; generation.current += 1;
      rfb.current?.disconnect(); rfb.current = null;
      if (currentSession.current || owned.current) bridge.stopRemoteDesktop({ id: currentSession.current?.session?.id }).catch(() => {});
      temporaryPassword.current = ''; onBusyChange?.(false);
    };
  }, [bridge, onBusyChange]);
  useEffect(() => {
    let cancelled = false;
    if (blocked) return;
    setBusy(true);
    bridge.inspectRemoteDesktop({ hostId: host.id }).then(value => { if (!cancelled) setInfo(value); }).catch(failure => { if (!cancelled) setError(failure.message); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [bridge, host.id, blocked]);

  const disconnect = async (close = false) => {
    generation.current += 1;
    rfb.current?.disconnect(); rfb.current = null;
    setCredentialsNeeded(false); setPassword(''); temporaryPassword.current = '';
    if (document.fullscreenElement === viewer.current) await document.exitFullscreen().catch(() => {});
    try {
      await bridge.stopRemoteDesktop({ id: currentSession.current?.session?.id });
      owned.current = false; currentSession.current = null;
      if (mounted.current) { setSession(null); setStatus('disconnected'); if (close) { onBusyChange?.(false); onClose(); } }
    } catch (failure) { if (mounted.current) setError(failure.message || 'Disconnect could not clean up the temporary server. Retry Disconnect.'); }
  };
  const operation = async action => {
    if (locked.current || blocked) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { if (mounted.current) { setError(failure.message || 'Remote desktop could not complete the operation.'); if (!currentSession.current) setStatus('disconnected'); } }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const connect = () => operation(async () => {
    const attempt = ++generation.current;
    setViewOnly(true); setFit(true); setStatus('connecting');
    const result = await bridge.startRemoteDesktop({ hostId: host.id, port: info.port });
    if (!mounted.current || attempt !== generation.current) { await bridge.stopRemoteDesktop({ id: result.session.id }); return; }
    currentSession.current = result; setSession(result);
  });
  const review = () => operation(async () => { const value = await bridge.previewRemoteDesktopSetup({ hostId: host.id, port: info.port }); if (mounted.current) { if (value.available) setPlan(value); else setError(value.reason); } });
  const setup = () => operation(async () => {
    const secret = password; setPassword('');
    const attempt = generation.current;
    try { await bridge.applyRemoteDesktopSetup({ planId: plan.id, credentials: { password: secret } }); }
    catch (failure) { if (mounted.current) setPlan(null); temporaryPassword.current = ''; throw failure; }
    owned.current = true;
    if (!mounted.current || attempt !== generation.current) { await bridge.stopRemoteDesktop({}); owned.current = false; return; }
    temporaryPassword.current = secret; setPlan(null); setInfo({ ...info, installed: true, available: true });
  });

  useEffect(() => {
    if (!session?.connection || !container.current) return;
    const client = new RFB(container.current, session.connection.url, { wsProtocols: [session.connection.token, 'binary'], credentials: temporaryPassword.current ? { password: temporaryPassword.current } : undefined });
    rfb.current = client; client.viewOnly = true; client.scaleViewport = true; client.resizeSession = false;
    const connected = () => { if (mounted.current) { setStatus('connected'); temporaryPassword.current = ''; } };
    const credentials = () => { if (mounted.current) setCredentialsNeeded(true); };
    const security = event => { if (mounted.current) setError(event.detail?.reason || 'VNC authentication was rejected.'); };
    const disconnected = event => {
      if (rfb.current === client) rfb.current = null;
      if (mounted.current) { setStatus('disconnected'); setCredentialsNeeded(false); setPassword(''); if (!event.detail?.clean) setError('The desktop connection closed. Check the server and authentication.'); }
      bridge.stopRemoteDesktop({ id: session.session.id }).then(() => { owned.current = false; }).catch(failure => { if (mounted.current) setError(failure.message); });
    };
    client.addEventListener('connect', connected); client.addEventListener('credentialsrequired', credentials);
    client.addEventListener('securityfailure', security); client.addEventListener('disconnect', disconnected);
    return () => {
      client.removeEventListener('connect', connected); client.removeEventListener('credentialsrequired', credentials);
      client.removeEventListener('securityfailure', security); client.removeEventListener('disconnect', disconnected);
      client.disconnect(); if (rfb.current === client) rfb.current = null;
    };
  }, [bridge, session]);
  useEffect(() => { if (rfb.current) rfb.current.viewOnly = viewOnly; }, [viewOnly]);
  useEffect(() => { if (rfb.current) rfb.current.scaleViewport = fit; }, [fit]);
  useEffect(() => { const changed = () => setFullscreen(document.fullscreenElement === viewer.current); document.addEventListener('fullscreenchange', changed); return () => document.removeEventListener('fullscreenchange', changed); }, []);
  const toggleFullscreen = () => { const promise = fullscreen ? document.exitFullscreen() : viewer.current?.requestFullscreen(); promise?.catch(() => setError('Fullscreen is unavailable in this window.')); };

  return <div className="remote-desktop-panel" aria-busy={busy}>
    {error && <p className="remote-desktop-error" role="alert"><CircleAlert size={16} />{error}</p>}
    {!session ? <>
      <p className="modal-intro">View the existing desktop through this machine's saved SSH connection.</p>
      {busy && <p role="status"><Loader2 className="spinning" size={18} /> Checking desktop access…</p>}
      {info && <section className="remote-desktop-review"><h3>Remote Desktop for {host.name}</h3><p>{info.reason}</p>
        <p>{info.available ? 'Remote desktop is available.' : 'Remote desktop is currently unavailable.'}</p>
        {plan && <><ul>{plan.changes.map(change => <li key={change}>{change}</li>)}</ul><label>Temporary VNC password<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} minLength={6} maxLength={8} /></label><p>Use 6 to 8 printable characters. This password is removed when the temporary server stops.</p></>}
        <div className="modal-actions"><button className="quiet-button" onClick={() => disconnect(true)}>Cancel</button>
          {plan ? <><button className="quiet-button" disabled={busy} onClick={() => { setPlan(null); setPassword(''); setError(''); }}>Back to desktop options</button><button className="primary-button" disabled={busy || blocked || !validTemporaryPassword} onClick={setup}>Set up desktop sharing</button></> : <>
            {info.provider === 'linux-x11' && info.available && !owned.current && <button className="quiet-button" disabled={busy || blocked} onClick={review}>Review temporary sharing setup</button>}
            {info.available && <button className="primary-button" disabled={busy || blocked} onClick={connect}><Monitor size={15} /> Connect</button>}
          </>}
        </div></section>}
      {!info && <button className="quiet-button" onClick={() => disconnect(true)}>{busy ? 'Cancel' : 'Close'}</button>}
    </> : <div className="remote-desktop-viewer" ref={viewer}>
      <div className="vnc-container"><div className="vnc-screen" ref={container} />
        {status !== 'connected' && <div className="vnc-overlay"><div className="vnc-overlay-content">
          <p>{status === 'connecting' ? `Connecting to ${host.name}…` : 'Disconnected.'}</p>
          {credentialsNeeded && <form onSubmit={event => { event.preventDefault(); rfb.current?.sendCredentials({ username, password }); setPassword(''); setCredentialsNeeded(false); }}>
            <label>VNC username (if required)<input autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} /></label>
            <label>VNC password<input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} /></label><button className="primary-button" type="submit">Authenticate</button>
          </form>}
        </div></div>}
      </div>
      <div className="vnc-status-bar"><div className="vnc-status-left"><span className={`vnc-indicator ${status}`} /><strong>{host.name}</strong><span>{status}</span></div>
        <div className="vnc-status-actions"><button className="vnc-mode-btn" disabled={status !== 'connected'} onClick={() => setViewOnly(!viewOnly)}><MousePointer2 size={14} />{viewOnly ? 'View mode' : 'Control mode'}</button>
          <button className="vnc-action-btn" disabled={status !== 'connected'} onClick={() => setFit(!fit)}>{fit ? 'Fit to window' : 'Actual size'}</button>
          <button className="vnc-action-btn" onClick={toggleFullscreen}><Maximize size={14} />{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>
          <button className="vnc-disconnect-btn" onClick={() => disconnect()}>Disconnect</button>
        </div></div>
    </div>}
  </div>;
}
