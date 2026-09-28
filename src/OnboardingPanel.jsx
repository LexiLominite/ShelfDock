import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import './onboarding.css';

export const onboardingStorageKey = 'lex-drift.onboarding.v1';
const ONBOARDING_VERSION = 1;
let memoryRecord = null;
let memoryOnly = false;

export function readOnboardingRecord() {
  if (memoryOnly) return memoryRecord;
  try {
    const raw = localStorage.getItem(onboardingStorageKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== ONBOARDING_VERSION) return null;
      if (parsed.status !== 'completed' && parsed.status !== 'skipped') return null;
      return parsed;
    } catch {
      return null;
    }
  } catch {
    memoryOnly = true;
    return memoryRecord;
  }
}

export function writeOnboardingRecord(status) {
  if (status !== 'completed' && status !== 'skipped') return memoryRecord;
  const record = { version: ONBOARDING_VERSION, status };
  memoryRecord = record;
  try {
    localStorage.setItem(onboardingStorageKey, JSON.stringify(record));
  } catch {
    memoryOnly = true;
  }
  return record;
}

export function onboardingSettled() {
  const record = readOnboardingRecord();
  return record?.status === 'completed' || record?.status === 'skipped';
}

const features = [
  { id: 'show', title: 'Show and hide', steps: ['Shake deliberately to show the shelf; pause, then shake again to hide it.', 'Use ⌘ / Ctrl + Shift + Space or the tray icon as an alternative. On Wayland, use the tray or an available shortcut.', 'Tab moves between controls; Enter activates the focused control.'] },
  { id: 'shelf', title: 'Shelf and undo', steps: ['Drop files, folders or text onto the shelf, or use Add files and Add text.', 'Clear shelf has a ten-second Undo. Your original files stay in their folders.', 'Sending keeps items on the shelf for another destination.'], actions: [{ target: 'shelf', label: 'Show the shelf' }] },
  { id: 'machines', title: 'Machines, LAN, and Tailscale', steps: ['Open Machines to find saved Wave, SSH and online Tailscale routes, or add an address yourself.', 'The receiving machine needs a running SSH server, a trusted fingerprint and an account you can use.', 'Check access until the machine is Ready. LAN and Tailscale routes can be chosen separately.'], actions: [{ target: 'machines', label: 'Show machines' }] },
  { id: 'access', title: 'Passwords and SSH keys', steps: ['Choose the key icon on a machine to set up access.', 'Use a password once to create a dedicated SSH key and verify it. The password is not saved.', 'Or choose a saved password, encrypted on this device. Configuration exports exclude credentials.'], actions: [{ target: 'machines', label: 'Show machines' }] },
  { id: 'batch', title: 'Several items and machines', steps: ['Select the shelf items and check each Ready destination machine.', 'Review & send shows the items and recipients before you send.', 'Each machine receives its own copy, with a separate result.'], actions: [{ target: 'shelf', label: 'Show the shelf' }] },
  { id: 'received', title: 'Received and sent', steps: ['Received lists completed transfers delivered to this computer’s Desktop by version 0.5 or newer.', 'Switch to Sent for outgoing results, or use Activity for recent transfers.', 'Choose Add to shelf to collect received files before sending them onward.'], actions: [{ target: 'received', label: 'Show Received' }, { target: 'activity', label: 'Show activity' }] },
  { id: 'clipboard', title: 'Clipboard, recording, and hiding', steps: ['Enable Clipboard tools in Settings when you want them. Search, pin favourites, save snippets and copy items back.', 'Automatic history is a separate choice. Pause recording before copying sensitive information.', 'Hiding the tab keeps saved items and does not pause recording. Nothing is shared automatically.'], actions: [{ target: 'settings', label: 'Review clipboard in Settings' }] },
  { id: 'remote', title: 'Open a remote service', steps: ['Click a machine and enter localhost:8000 or another URL as reached from that machine.', 'Go forwards it here and opens your browser. Busy local ports increment automatically; Advanced offers a custom port.', 'Copy the local URL for another client. Stop with the live chip; saved forwards and notes are in History.'], actions: [{ target: 'machines', label: 'Show machines' }] },
  { id: 'density', title: 'Display density', steps: ['Choose Compact, Balanced or Expanded from the View control.', 'Compact fits a longer list. Balanced shows everyday actions. Expanded adds room, with details available when you open them.', 'Your chosen view is remembered.'], actions: [{ target: 'density', label: 'Show the View control' }] },
  { id: 'config', title: 'Import and export', steps: ['Export machines and preferences from Settings, then import the file on another computer.', 'Passwords, private keys, shelf items and clipboard history are excluded. Review network addresses before sharing.', 'Set up SSH access on the new computer before sending.'], actions: [{ target: 'settings', label: 'Review import and export in Settings' }] },
  { id: 'updates', title: 'Updates and restart', steps: ['Open Manage updates in Settings to check when you choose. Automatic checks start off.', 'Download a verified update and keep working.', 'Installation waits until you explicitly choose Restart and install. Finish transfers and stop forwards first.'], actions: [{ target: 'settings', label: 'Show update settings' }] },
  { id: 'mac', title: 'Install on a Mac', steps: ['On a Mac, open a machine’s More menu and choose Install on this device.', 'Review the destination Mac and installation details before confirming.', 'This convenience is Mac-only; ordinary SSH transfers still work across platforms.'], actions: [{ target: 'machines', label: 'Show machines' }] },
];

export default function OnboardingPanel({ productName, mode, step, onStep, onMode, onFinish, onSkip, onNavigate, wayland = false, shortcutAvailable = true }) {
  const [openTopic, setOpenTopic] = useState('');
  const steps = [
    {
      id: 'show',
      kicker: 'Show and hide',
      title: `Bring ${productName} up when you want it`,
      points: [
        `A deliberate shake shows ${productName}. Pause, then shake again to hide it.`,
        shortcutAvailable ? `Or press ⌘ / Ctrl + Shift + Space, or open ${productName} from the tray.` : `Open ${productName} from the tray. The global shortcut is not registered on this device.`,
        'Use Tab to move between controls and Enter to choose one.',
      ],
      extra: wayland ? 'This computer is using Wayland, so shake may not be available.' : '',
    },
    {
      id: 'collect',
      kicker: 'Collect',
      title: 'Files and text wait on the shelf',
      points: [
        'Drop files or folders on the shelf, or choose Add files.',
        'Choose Add text for a note, or paste explicitly onto the shelf.',
        'Collecting keeps items here. It does not send them.',
      ],
      action: { target: 'shelf', label: 'Show the shelf' },
    },
    {
      id: 'send',
      kicker: 'Send',
      title: 'You choose when to send',
      points: [
        'Clicking a machine never sends. Hovering a machine never sends.',
        'A Ready machine has passed its SSH access check.',
        'Drag an item onto that machine, or select items and machines, then choose Review & send.',
      ],
      action: { target: 'machines', label: 'Show machines' },
    },
    {
      id: 'find',
      kicker: 'Find it later',
      title: 'Received items and an optional clipboard',
      points: [
        'Open Received for items that arrived from another computer.',
        'Activity lists what was sent.',
        'Clipboard tools start off. Enable them in Settings if useful; automatic history is a separate choice.',
      ],
      action: { target: 'received', label: 'Show Received' },
    },
  ];
  const index = Math.min(Math.max(step, 0), steps.length - 1);
  const current = steps[index];
  const last = index === steps.length - 1;
  return <div className="onboarding-panel">
    <div className="onboarding-status">
      <p className="onboarding-progress" id="onboarding-progress" aria-live="polite">{mode === 'quick' ? `Step ${index + 1} of ${steps.length}` : 'Feature guide'}</p>
      {mode === 'quick' && <ol className="onboarding-dots" aria-hidden="true">{steps.map((item, itemIndex) => <li key={item.id} className={itemIndex === index ? 'current' : itemIndex < index ? 'done' : ''} />)}</ol>}
    </div>
    <div className="onboarding-scroll">
      {mode === 'quick' ? <article className="onboarding-step" aria-labelledby="onboarding-step-title">
        <p className="eyebrow">{current.kicker}</p>
        <h3 id="onboarding-step-title">{current.title}</h3>
        <ol className="onboarding-points">{current.points.map((point) => <li key={point}>{point}</li>)}</ol>
        {current.extra && <p className="onboarding-note">{current.extra}</p>}
        {current.id === 'send' && <p className="onboarding-note">A dropped item <strong>sends immediately</strong>. Nothing is sent before that drop, and the shelf keeps its copy.</p>}
      </article> : <div className="onboarding-guide">
        <p className="onboarding-intro">Choose a topic for a short guide. Settings always has this guide when you need it.</p>
        <div className="onboarding-topics">{features.map((feature) => {
          const open = openTopic === feature.id;
          const buttonId = `onboarding-topic-${feature.id}`;
          const regionId = `onboarding-topic-panel-${feature.id}`;
          return <div className="onboarding-topic" key={feature.id}>
            <button type="button" className="onboarding-topic-button" id={buttonId} aria-expanded={open} aria-controls={regionId} onClick={() => setOpenTopic(open ? '' : feature.id)}><span>{feature.title}</span><ChevronDown size={15} aria-hidden="true" /></button>
            {open && <div className="onboarding-topic-body" id={regionId} role="region" aria-labelledby={buttonId}>
              <ol>{feature.steps.map((item) => <li key={item}>{item}</li>)}</ol>
              {feature.actions?.length > 0 && <div className="onboarding-topic-actions">{feature.actions.map((action) => <button type="button" className="quiet-button" key={action.label} onClick={() => onNavigate(action.target)}>{action.label}</button>)}</div>}
            </div>}
          </div>;
        })}</div>
      </div>}
    </div>
    <div className="onboarding-footer">
      <p className="keyboard-hint">Escape closes this guide and leaves {productName} open.</p>
      <div className="onboarding-actions">
        <button type="button" className="quiet-button" onClick={onSkip}>Skip</button>
        {mode === 'quick' ? <button type="button" className="quiet-button" onClick={() => onStep(index - 1)} disabled={index === 0}>Back</button> : <button type="button" className="quiet-button" onClick={() => onMode('quick')}>Quick start</button>}
        {mode === 'quick' && last && <button type="button" className="quiet-button" onClick={() => onMode('learn')}>Feature guide</button>}
        {mode === 'quick' && !last && <button type="button" className="primary-button" onClick={() => onStep(index + 1)}>Next</button>}
        {(mode === 'learn' || last) && <button type="button" className="primary-button" onClick={onFinish}>Finish</button>}
      </div>
    </div>
  </div>;
}
