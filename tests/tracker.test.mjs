import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, findBall, isBallPixel, summarize, DEFAULT_OPTIONS } from '../public/tracker.mjs';

// Draws a frame: green grass, optional noise, white balls and white rectangles.
function frame({ width = 640, height = 360, balls = [], rects = [], noise = 0, seed = 1, background = [47, 107, 52], darkFrom = Infinity } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < width * height; i++) {
    const n = noise ? (rand() - 0.5) * noise : 0;
    const color = i % width >= darkFrom ? [25, 40, 30] : background;
    data[i * 4] = color[0] + n; data[i * 4 + 1] = color[1] + n; data[i * 4 + 2] = color[2] + n; data[i * 4 + 3] = 255;
  }
  const paint = (x, y, v) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; };
  for (const b of balls) {
    const r = b.r ?? 5;
    for (let y = Math.floor(b.y - r - 1); y <= b.y + r + 1; y++)
      for (let x = Math.floor(b.x - r * (b.stretch ?? 1) - 1); x <= b.x + r * (b.stretch ?? 1) + 1; x++) {
        const d = Math.hypot((x - b.x) / (b.stretch ?? 1), y - b.y);
        if (d <= r) paint(x, y, b.value ?? 245);
        else if (d <= r + 1) paint(x, y, 150); // soft edge, like a compressed video
      }
  }
  for (const q of rects) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) paint(x, y, q.value ?? 250);
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
    tracker.step(frame({ balls: hidden ? [] : [flight(i)], noise: 4, seed: i + 1 }), i / 60);
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


const fastFlight = [
  { x: 60, y: 300 }, { x: 125, y: 275 }, { x: 182, y: 251 },
  { x: 227, y: 230 }, { x: 262, y: 212 }, { x: 290, y: 197 }
];

test('tracks fast unique frames repeated four times without adding duplicate points', () => {
  const tracker = createTracker(fastFlight[0]);
  for (const [i, position] of fastFlight.entries()) {
    const image = frame({ balls: [position] });
    for (let repeat = 0; repeat < 4; repeat++) {
      const result = tracker.step(image, (i * 4 + repeat) / 30);
      assert.equal(result.found, repeat === 0);
      assert.equal(result.done, false);
      if (repeat) assert.equal(result.duplicate, true);
      else assert.ok(Math.hypot(result.point.x - position.x, result.point.y - position.y) < 5);
      assert.equal(tracker.points.length, i + 1);
    }
  }
});

test('tracks a gray blurred ball over yellow grass without selecting static specks', () => {
  const tracker = createTracker(fastFlight[0]);
  const specks = [{ x: 235, y: 250 }, { x: 280, y: 215 }, { x: 320, y: 180 }];
  for (const [i, position] of fastFlight.entries()) {
    const result = tracker.step(frame({
      background: [200, 190, 120], noise: 8,
      balls: [{ ...position, value: 150, stretch: 2 }, ...specks]
    }), i / 30);
    // The initial gray ball has no motion reference and fails the brightness fallback.
    assert.equal(result.found, i > 0);
    if (result.found) assert.ok(Math.hypot(result.point.x - position.x, result.point.y - position.y) < 5);
  }
  assert.equal(tracker.points.length, fastFlight.length - 1);
});

test('tracks continuously from a gray ball on grass to a white ball over dark trees', () => {
  const tracker = createTracker(fastFlight[0]);
  for (const [i, position] of fastFlight.entries()) {
    const result = tracker.step(frame({
      background: [200, 190, 120], darkFrom: 210, noise: 8,
      balls: [{ ...position, value: i === 0 || position.x >= 210 ? 245 : 150, stretch: 2 },
        { x: 235, y: 250 }, { x: 280, y: 215 }]
    }), i / 30);
    assert.equal(result.found, true, `unique frame ${i}`);
    assert.ok(Math.hypot(result.point.x - position.x, result.point.y - position.y) < 5);
  }
  assert.equal(tracker.points.length, fastFlight.length);
});

test('duplicates preserve misses and a copied reference when the input buffer is reused', () => {
  const tracker = createTracker(fastFlight[0], { maxMisses: 1 });
  const image = frame({ balls: [fastFlight[0]] });
  assert.equal(tracker.step(image, 0).found, true);
  image.data.set(frame({ balls: [fastFlight[1]] }).data);
  assert.equal(tracker.step(image, 0.5).found, true);
  image.data.set(frame().data);
  assert.equal(tracker.step(image, 1).found, false);
  for (let i = 0; i < 12; i++) {
    assert.deepEqual(tracker.step(image, 2 + i), { found: false, duplicate: true, done: false });
  }
  image.data.set(frame({ noise: 8 }).data);
  assert.equal(tracker.step(image, 14).done, true);
  assert.equal(tracker.points.length, 2);
});

for (const value of [245, 150]) {
  test(`waits through noisy still frames before tracking a ${value === 245 ? 'white' : 'gray'} ball`, () => {
    const start = { x: 60, y: 200 };
    const tracker = createTracker(start);
    const image = (position, seed) => frame({
      background: [200, 190, 120], noise: 8, seed,
      balls: [{ ...position, value }]
    });
    for (let i = 0; i < 30; i++) {
      const result = tracker.step(image(start, i + 1), i / 240);
      assert.equal(result.done, false, `still frame ${i}`);
      assert.equal(result.duplicate, undefined);
      assert.equal(result.found, value === 245);
      assert.equal(tracker.finished, false);
    }
    for (let i = 0; i < 30; i++) {
      const position = { x: start.x + 8 * (i + 1), y: start.y };
      const result = tracker.step(image(position, i + 31), (i + 30) / 240);
      assert.equal(result.found, true, `flight frame ${i}`);
      assert.equal(result.done, false);
      assert.ok(Math.hypot(result.point.x - position.x, result.point.y - position.y) < 5, `flight frame ${i}`);
    }
    if (value === 245) assert.equal(summarize(tracker.points).launchTime, 29 / 240);
  });
}

test('limits waiting by distinct frames even when the still ball is visible', () => {
  assert.equal(DEFAULT_OPTIONS.maxWaitFrames, 600);
  for (const balls of [[], [{ x: 60, y: 200 }]]) {
    const tracker = createTracker({ x: 60, y: 200 }, { maxWaitFrames: 3, maxMisses: 0 });
    for (let i = 0; i < 3; i++) {
      const image = frame({ balls, noise: 8, seed: i + 1 });
      assert.equal(tracker.step(image, i).done, i === 2);
      if (i < 2) assert.equal(tracker.step(image, i + 0.5).duplicate, true);
    }
    assert.equal(tracker.finished, true);
  }
});

const deceleratingFlight = [
  { x: 100, y: 1200 }, { x: 120, y: 1097 }, { x: 160, y: 850 },
  { x: 190, y: 683 }, { x: 210, y: 555 }, { x: 230, y: 472 },
  { x: 240, y: 393 }
];

for (const distraction of ['none', 'trailing club', 'static balls']) {
  test(`tracks large decelerating jumps with ${distraction}`, () => {
    const tracker = createTracker(deceleratingFlight[0]);
    for (const [i, position] of deceleratingFlight.entries()) {
      const balls = [{ ...position, r: 9 }];
      if (distraction === 'trailing club' && i) {
        balls.push({ x: position.x - 8, y: position.y + 65, r: 18, value: 100 });
      }
      if (distraction === 'static balls') {
        balls.push({ x: 50, y: 1250, r: 9 }, { x: 185, y: 700, r: 9 }, { x: 260, y: 480, r: 9 });
      }
      const image = frame({ width: 400, height: 1300, balls });
      for (let repeat = 0; repeat < 4; repeat++) {
        const result = tracker.step(image, (i * 4 + repeat) / 30);
        if (repeat) assert.equal(result.duplicate, true);
        else {
          assert.equal(result.found, true, `frame ${i}`);
          assert.ok(Math.hypot(result.point.x - position.x, result.point.y - position.y) < 3, `frame ${i}`);
        }
      }
    }
    assert.equal(tracker.points.length, deceleratingFlight.length);
  });
}

test('does not mistake a new speck near the start for a ball already in flight', () => {
  const start = { x: 100, y: 200 };
  const tracker = createTracker(start);
  tracker.step(frame({ balls: [start] }), 0);
  const position = { x: 112, y: 127 };
  const result = tracker.step(frame({ balls: [position, { x: 94, y: 197, r: 1 }] }), 4 / 30);
  assert.equal(result.found, true);
  assert.ok(Math.hypot(result.point.x - position.x, result.point.y - position.y) < 3);
});


for (const occlusion of [1, 3]) {
  test(`ignores club and shaft at address, recovers after ${occlusion} hidden frames`, () => {
    const start = { x: 120, y: 260 };
    const tracker = createTracker(start);
    const image = (i, balls) => frame({ balls, noise: 4, seed: i + 1,
      rects: [{ x: 135 + i % 30, y: 270, w: 30, h: 18, value: 80 },
        { x: 150 + i % 30, y: 270, w: 2, h: 75, value: 170 }] });
    for (let i = 0; i < 60; i++) tracker.step(image(i, [start]), i / 60);
    for (let i = 60; i < 60 + occlusion; i++) {
      // A ball-sized reflection can briefly tempt the motion tracker.
      const reflection = { x: 140 + (i - 60) * 12, y: 230, value: 160 };
      const f = image(i, [reflection]);
      tracker.step(f, i / 60);
      assert.equal(tracker.step(f, (i + 0.25) / 60).duplicate, true);
    }
    const resumed = 60 + occlusion;
    tracker.step(image(resumed, [start]), resumed / 60);
    assert.equal(tracker.points.length, 61, 'tentative points removed when tee ball returns');
    assert.ok(tracker.points.every(p => Math.hypot(p.x - start.x, p.y - start.y) < 1));
    for (let i = 1; i <= 12; i++) {
      const ball = { x: start.x + i * 12, y: start.y - i * 9 };
      tracker.step(image(resumed + i, [ball]), (resumed + i) / 60);
    }
    const flightPoints = tracker.points.filter(p => p.time > resumed / 60);
    assert.equal(flightPoints.length, 12);
    flightPoints.forEach((p, i) => assert.ok(Math.hypot(p.x - start.x - (i + 1) * 12, p.y - start.y + (i + 1) * 9) < 1));
    assert.equal(summarize(tracker.points).launchTime, resumed / 60);
  });
}


test('confirms launch only after two distinct frames without the tee ball', () => {
  const start = { x: 100, y: 250 };
  const tracker = createTracker(start);
  tracker.step(frame({ balls: [start] }), 0);
  const first = frame({ balls: [{ x: 120, y: 230 }] });
  tracker.step(first, 1);
  assert.equal(tracker.launched, false);
  tracker.step(first, 1.1);
  assert.equal(tracker.launched, false, 'duplicates do not confirm launch');
  tracker.step(frame({ balls: [{ x: 140, y: 210 }] }), 2);
  assert.equal(tracker.launched, true);
});

test('acquires a shaded ball at the tap before nearby motion', () => {
  const start = { x: 100, y: 250 };
  const tracker = createTracker(start);
  for (let i = 0; i < 30; i++) {
    tracker.step(frame({ balls: [{ ...start, value: 175 }, { x: 130 + i, y: 240, r: 12, value: 85 }], noise: 4, seed: i + 1 }), i / 60);
  }
  assert.equal(tracker.points.length, 30);
  assert.equal(tracker.launched, false);
  assert.ok(tracker.points.every(p => Math.hypot(p.x - start.x, p.y - start.y) < 1));
});
