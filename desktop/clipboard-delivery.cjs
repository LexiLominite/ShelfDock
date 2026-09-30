'use strict';
const { Blob } = require('node:buffer');

// All dependencies are injected: importing this module cannot read a clipboard.
async function deliverClipboard({ history, sync, clipboard, ClipboardItem }, item) {
  if (!item || !history?.toolsState().enabled || !sync?.canSend()) throw new Error('Clipboard sync is paused or disabled.');
  const epoch = sync.epoch, historyEpoch = history.epoch;
  const active = () => sync.epoch === epoch && history.epoch === historyEpoch && history.toolsState().enabled && sync.canSend();
  const native = () => active() && item.receiveMode === 'clipboard' && sync.state().receiveMode === 'clipboard' && (!sync.state().continuity || !sync.newestEvent || sync.newestEvent.eventId === item.eventId);
  const snapshot = async () => {
    try {
      const content = await history.readCurrent({ snapshot: true });
      if (!content || ['private', 'unsupported'].includes(content.kind)) return null;
      return history.contentHash(content);
    } catch { return null; } // Unsupported/private native formats stay untouched.
  };
  // The OS may contain a new local copy not yet observed by the polling timer.
  // Flush capture first; its opt-in baseline skips the pre-existing clipboard.
  if (native() && sync.state().continuity) await history.capture({ automatic: true });
  if (!active()) throw new Error('Clipboard sync was paused or disabled.');
  const before = native() ? await snapshot() : null;
  if (!active()) throw new Error('Clipboard sync was paused or disabled.');
  const content = item.kind === 'png' ? { kind: 'image', png: item.png } : { kind: 'text', text: item.text };
  const hash = history.contentHash(content);
  await history.ingestSync({ eventId: item.eventId, kind: item.kind, text: item.text, png: item.png, sourceLabel: item.originLabel });
  if (!active()) throw new Error('Clipboard sync was paused or disabled.');
  if (!native() || !before) return { applied: false };
  const after = await snapshot();
  if (!active()) throw new Error('Clipboard sync was paused or disabled.');
  if (!native() || !after) return { applied: false };
  if (before !== after) {
    // Publish the newer local copy before the engine considers relaying this
    // delayed event. Do not await network ACKs from inside an incoming delivery.
    if (sync.state().continuity) await history.capture({ automatic: true });
    return { applied: false };
  }
  history.noteSyncEvent(item.eventId, hash);
  if (item.kind === 'png') await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(item.png, 'base64')], { type: 'image/png' }) })]);
  else await clipboard.writeText(item.text);
  if (active()) history.acknowledgeSyncWrite(hash);
  return { applied: true };
}
module.exports = { deliverClipboard };
