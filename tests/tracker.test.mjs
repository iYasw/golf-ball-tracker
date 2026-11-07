import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, findBall, isBallPixel, summarize, DEFAULT_OPTIONS } from '../public/tracker.mjs';

// Draws a frame: green grass, optional noise, white balls and white rectangles.
function frame({ width = 640, height = 360, balls = [], rects = [], noise = 0, seed = 1 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < width * height; i++) {
    const n = noise ? (rand() - 0.5) * noise : 0;
    data[i * 4] = 47 + n; data[i * 4 + 1] = 107 + n; data[i * 4 + 2] = 52 + n; data[i * 4 + 3] = 255;
  }
  const paint = (x, y, v) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; };
  for (const b of balls) {
    const r = b.r ?? 5;
    for (let y = Math.floor(b.y - r - 1); y <= b.y + r + 1; y++)
      for (let x = Math.floor(b.x - r - 1); x <= b.x + r + 1; x++) {
        const d = Math.hypot(x - b.x, y - b.y);
        if (d <= r) paint(x, y, 245);
        else if (d <= r + 1) paint(x, y, 150); // soft edge, like a compressed video
      }
  }
  for (const q of rects) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) paint(x, y, 250);
  return { width, height, data };
}

const flight = i => ({ x: 60 + 8 * i, y: 300 - (9 * i - 0.12 * i * i) });

test('white low-saturation pixels count as ball pixels; green and yellow do not', () => {
  assert.equal(isBallPixel(240, 240, 235), true);
  assert.equal(isBallPixel(47, 107, 52), false);
  assert.equal(isBallPixel(250, 230, 40), false);
  assert.equal(isBallPixel(150, 150, 150), false);
});

test('finds a ball near the given position with sub-pixel accuracy', () => {
  const hit = findBall(frame({ balls: [{ x: 200.5, y: 120.5 }] }), { x: 195, y: 125 }, 30);
  assert.ok(hit);
  assert.ok(Math.hypot(hit.x - 200.5, hit.y - 120.5) < 1, JSON.stringify(hit));
});

test('tracks a ball in flight within 5 px on every frame', () => {
  const tracker = createTracker(flight(0));
  for (let i = 0; i < 50; i++) tracker.step(frame({ balls: [flight(i)], noise: 20, seed: i + 1 }), i / 60);
  assert.equal(tracker.points.length, 50);
  tracker.points.forEach((p, i) => assert.ok(Math.hypot(p.x - flight(i).x, p.y - flight(i).y) < 5, `frame ${i}`));
});

test('ignores a larger white object and another ball far from the path', () => {
  const tracker = createTracker(flight(0));
  for (let i = 0; i < 30; i++) tracker.step(frame({ balls: [flight(i), { x: 560, y: 60 }], rects: [{ x: 300, y: 320, w: 200, h: 30 }] }), i / 60);
  assert.equal(tracker.points.length, 30);
  assert.ok(tracker.points.every((p, i) => Math.hypot(p.x - flight(i).x, p.y - flight(i).y) < 5));
});

test('keeps tracking through a few missing frames, then stops when the ball is gone', () => {
  const tracker = createTracker(flight(0));
  for (let i = 0; i < 40; i++) {
    const hidden = (i >= 15 && i <= 17) || i >= 30;
    tracker.step(frame({ balls: hidden ? [] : [flight(i)] }), i / 60);
  }
  const found = tracker.points.map(p => Math.round((p.time) * 60));
  assert.ok(found.includes(18), 'reacquired after the gap');
  assert.ok(found.every(i => i < 30));
  assert.equal(tracker.finished, true);
  assert.equal(tracker.points.length, 27);
  assert.ok(DEFAULT_OPTIONS.maxMisses < 10);
});

test('summarizes on-screen launch speed and angle', () => {
  // 3 px right and 4 px up per frame at 60 frames per playback second: 300 px/s at 53.13°.
  const points = Array.from({ length: 10 }, (_, i) => ({ x: 10 + 3 * i, y: 100 - 4 * i, time: i / 60 }));
  const s = summarize(points);
  assert.ok(Math.abs(s.launchSpeedPxPerSec - 300) < 1e-6);
  assert.ok(Math.abs(s.launchAngleDeg - 53.130102) < 1e-4);
  assert.equal(s.direction, 'right');
  assert.equal(s.points, 10);
  const left = summarize(points.map(p => ({ ...p, x: 200 - p.x })));
  assert.equal(left.direction, 'left');
  assert.ok(Math.abs(left.launchAngleDeg - 53.130102) < 1e-4);
  assert.equal(summarize([points[0]]), null);
});

test('a start position away from any ball finds nothing instead of jumping elsewhere', () => {
  const tracker = createTracker({ x: 100, y: 100 });
  const r = tracker.step(frame({ balls: [{ x: 500, y: 300 }] }), 0);
  assert.equal(r.found, false);
  assert.equal(tracker.points.length, 0);
});

test('launch values start when the ball begins to move, not during the still frames before impact', () => {
  const still = Array.from({ length: 6 }, (_, i) => ({ x: 50, y: 200, time: i / 60 }));
  const flying = Array.from({ length: 8 }, (_, i) => ({ x: 50 + 3 * (i + 1), y: 200 - 4 * (i + 1), time: (i + 6) / 60 }));
  const s = summarize([...still, ...flying]);
  assert.equal(s.moved, true);
  assert.ok(Math.abs(s.launchAngleDeg - 53.130102) < 1e-4, String(s.launchAngleDeg));
  assert.ok(Math.abs(s.launchSpeedPxPerSec - 300) < 1e-6);
  assert.ok(Math.abs(s.launchTime - 5 / 60) < 1e-9);
  assert.equal(summarize(still).moved, false);
});
