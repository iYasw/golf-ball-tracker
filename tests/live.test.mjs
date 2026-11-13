import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSession, createGuide, guideBall } from '../public/live.mjs';
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

const ball = { x: 192, y: 295.2 };
function ready(session) {
  let r;
  for (let i = 0; i <= 40; i++) r = session.step(frame({ balls: [ball] }), i / 60);
  assert.equal(r.phase, 'ready');
}
test('live align, ready, tracking, result and next shot', () => {
  const s = createLiveSession();
  assert.equal(s.step(frame(), 0).phase, 'align');
  ready(s);
  let r;
  for (let i = 1; i <= 20; i++) r = s.step(frame({ balls: [{ x: ball.x + i * 8, y: ball.y - i * 9 }] }), 1 + i / 60);
  assert.equal(r.phase, 'tracking');
  r = s.step(frame(), 5);
  assert.equal(r.phase, 'result'); assert.ok(r.summary.moved); assert.ok(r.points.length > 10);
  assert.equal(s.step(frame({ balls: [ball] }), 6).phase, 'result');
  assert.equal(s.step(frame({ balls: [ball] }), 7.1).phase, 'align');
  s.reset(); assert.equal(s.step(frame(), 8).phase, 'align');
});
test('picked-up ball returns to align without launch', () => {
  const s = createLiveSession(); ready(s);
  s.step(frame(), 1); assert.equal(s.step(frame(), 2.6).phase, 'align');
});
test('moving club near resting ball never launches', () => {
  const s = createLiveSession(); ready(s);
  for (let i = 0; i < 30; i++) assert.equal(s.step(frame({ balls: [ball], rects: [{ x: 210 + i, y: 270, w: 28, h: 10 }] }), 1 + i / 60).phase, 'ready');
});
test('left guide mirrors the ball and detects it', () => {
  assert.ok(Math.abs(createGuide(true).x - (1 - createGuide().x)) < 1e-9);
  const s = createLiveSession({ guide: createGuide(true) }); let r;
  for (let i = 0; i < 40; i++) r = s.step(frame({ balls: [{ x: 448, y: ball.y }] }), i / 60);
  assert.equal(r.phase, 'ready');
});

for (const gain of [1, 0.85, 0.75]) {
  test(`guide detects a shaded ball and launches at exposure ${gain}`, () => {
    const image = balls => {
      const f = frame({ balls: balls.map(p => ({ ...p, value: 195 })) });
      for (let i = 0; i < f.data.length; i += 4) {
        for (let c = 0; c < 3; c++) f.data[i + c] *= gain;
      }
      return f;
    };
    const hit = guideBall(image([ball]));
    assert.ok(hit && Math.hypot(hit.x - ball.x, hit.y - ball.y) < 1);
    const s = createLiveSession();
    let r;
    for (let i = 0; i <= 40; i++) r = s.step(image([ball]), i / 60);
    assert.equal(r.phase, 'ready');
    const anchor = r.ballStart;
    for (const time of [1, 1.3, 1.7]) {
      r = s.step(image([]), time);
      assert.equal(r.phase, 'ready');
      assert.deepEqual(r.ballStart, anchor);
    }
    r = s.step(image([ball]), 1.8);
    assert.equal(r.phase, 'ready');
    for (let i = 1; i <= 8; i++) {
      r = s.step(image([{ x: ball.x + i * 8, y: ball.y - i * 9 }]), 2 + i / 60);
    }
    assert.equal(r.phase, 'tracking');
    assert.ok(r.points.some(p => p.y < ball.y - 60));
  });
}

test('guide rejects tiny specks and oversized white areas at bright and dark exposure', () => {
  for (const [background, value] of [[160, 245], [60, 110]]) {
    const hit = guideBall(frame({
      background: [background, background, background],
      balls: [{ ...ball, x: ball.x + 8, value }, { ...ball, r: 1, value: 255 }],
      rects: [{ x: 170, y: 274, w: 45, h: 3 }]
    }));
    assert.ok(hit && Math.hypot(hit.x - ball.x - 8, hit.y - ball.y) < 1);
  }
});

test('next shot resets ready immediately', () => {
  const s = createLiveSession();
  ready(s);
  s.reset();
  const r = s.step(frame({ balls: [ball] }), 1);
  assert.equal(r.phase, 'align');
  assert.deepEqual(r.points, []);
});
