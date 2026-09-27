'use strict';

// Cursor samples stay in memory. Require several fast, wide reversals in a tight
// time window, so ordinary travel and tiny cursor jitter cannot open the shelf.
class ShakeDetector {
  constructor() {
    this.samples = [];
    this.lastTrigger = -Infinity;
    this.sensitivity = 'strong';
  }
  reset() { this.samples = []; }
  setSensitivity(value) {
    if (['gentle', 'normal', 'strong'].includes(value)) this.sensitivity = value;
    this.reset();
  }
  add(point, now = Date.now()) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (now - this.lastTrigger < 2400) return false;
    const tuning = {
      gentle: { span: 60, travel: 290, speed: 450, reversals: 3 },
      normal: { span: 90, travel: 420, speed: 650, reversals: 3 },
      strong: { span: 130, travel: 620, speed: 850, reversals: 4 },
    }[this.sensitivity];
    this.samples.push({ x: point.x, y: point.y, t: now });
    this.samples = this.samples.filter(s => now - s.t <= 850);
    if (this.samples.length < 7) return false;
    for (const axis of ['x', 'y']) {
      const values = this.samples.map(s => s[axis]);
      const extent = Math.max(...values) - Math.min(...values);
      if (extent < tuning.span || extent > 850) continue;
      let direction = 0, anchor = values[0], turns = 0, travel = 0, fastTravel = 0;
      for (let i = 1; i < values.length; i++) {
        const delta = values[i] - values[i - 1];
        const elapsed = Math.max(1, this.samples[i].t - this.samples[i - 1].t);
        travel += Math.abs(delta);
        if (Math.abs(delta) / elapsed * 1000 >= tuning.speed) fastTravel += Math.abs(delta);
        const sign = Math.sign(delta);
        if (sign === direction || direction === 0) {
          direction = sign || direction;
          if ((direction > 0 && values[i] > anchor) || (direction < 0 && values[i] < anchor)) anchor = values[i];
        } else if (Math.abs(values[i] - anchor) >= tuning.span * .48) {
          turns++;
          direction = sign;
          anchor = values[i];
        }
      }
      if (turns >= tuning.reversals && travel >= tuning.travel && fastTravel >= tuning.travel * .72) {
        this.lastTrigger = now;
        this.reset();
        return true;
      }
    }
    return false;
  }
}
module.exports = { ShakeDetector };
