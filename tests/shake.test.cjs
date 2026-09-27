'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShakeDetector } = require('../desktop/shake.cjs');
function exercise(points, interval = 30, detector = new ShakeDetector(), start = 0) {
  return points.some((x, i) => detector.add({ x, y: 120 }, start + i * interval));
}
test('deliberate fast horizontal shake opens once', () => {
  assert.equal(exercise([0, 50, 130, 50, 0, 60, 140, 60, 0, 60, 150]), true);
});
test('straight cursor travel does not open shelf', () => {
  assert.equal(exercise(Array.from({ length: 25 }, (_, i) => i * 35)), false);
});
test('tiny rapid jitter does not open shelf', () => {
  assert.equal(exercise(Array.from({ length: 25 }, (_, i) => i % 2 ? 12 : 0)), false);
});
test('slow to-and-fro motion does not open shelf', () => {
  assert.equal(exercise([0, 130, 0, 130, 0, 130, 0, 130], 300), false);
});
test('large cross-display jumps do not open shelf', () => {
  assert.equal(exercise([0, 2200, 0, 2200, 0, 2200, 0, 2200]), false);
});
test('cooldown blocks repeated activation', () => {
  const d = new ShakeDetector(), p = [0, 50, 130, 50, 0, 60, 140, 60, 0, 60, 150];
  assert.equal(exercise(p, 30, d), true);
  assert.equal(exercise(p, 30, d, 500), false);
  assert.equal(exercise(p, 30, d, 3500), true);
});
test('vertical shake also works', () => {
  const d = new ShakeDetector(), p = [0, 50, 130, 50, 0, 60, 140, 60, 0, 60, 150];
  assert.equal(p.some((y, i) => d.add({ x: 0, y }, i * 30)), true);
});
