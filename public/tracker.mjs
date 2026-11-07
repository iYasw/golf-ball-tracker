// Golf ball tracking on video frames. Pure JavaScript: runs in the browser and in Node tests.
// All positions are in video pixels. Values are what the camera image shows (観測値),
// not real-world speed or distance.

export const DEFAULT_OPTIONS = Object.freeze({
  minBrightness: 185,   // brightest RGB channel of a ball pixel (0-255)
  maxSaturation: 70,    // max - min of RGB; a white ball has little color
  searchRadius: 60,     // search window around the predicted position (px)
  missGrowth: 1.6,      // search window growth per missed frame
  maxMisses: 6,         // stop after this many frames without the ball
  minArea: 3,           // smallest blob (pixels) that can be the ball
  maxArea: 2500,        // larger white areas (shirts, sky, lines) are not the ball
  maxJump: 0            // 0 = use searchRadius
});

export function isBallPixel(r, g, b, o = DEFAULT_OPTIONS) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max >= o.minBrightness && max - min <= o.maxSaturation;
}

// Finds the white blob nearest to `predicted` inside a square window.
// frame: { width, height, data: Uint8ClampedArray RGBA }
export function findBall(frame, predicted, radius, o = DEFAULT_OPTIONS) {
  const { width, height, data } = frame;
  const x0 = Math.max(0, Math.floor(predicted.x - radius)), x1 = Math.min(width - 1, Math.ceil(predicted.x + radius));
  const y0 = Math.max(0, Math.floor(predicted.y - radius)), y1 = Math.min(height - 1, Math.ceil(predicted.y + radius));
  if (x0 > x1 || y0 > y1) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const mask = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      if (isBallPixel(data[i], data[i + 1], data[i + 2], o)) mask[(y - y0) * w + (x - x0)] = 1;
    }
  }
  let best = null;
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    // Flood fill one connected blob (4-neighbour).
    let area = 0, sx = 0, sy = 0, touchesEdge = false;
    mask[start] = 2; stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const px = p % w, py = (p - px) / w;
      area++; sx += px; sy += py;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) touchesEdge = true;
      if (px > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack.push(p - 1); }
      if (px < w - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack.push(p + 1); }
      if (py > 0 && mask[p - w] === 1) { mask[p - w] = 2; stack.push(p - w); }
      if (py < h - 1 && mask[p + w] === 1) { mask[p + w] = 2; stack.push(p + w); }
    }
    if (area < o.minArea || area > o.maxArea) continue;
    const cx = x0 + sx / area, cy = y0 + sy / area;
    const d = Math.hypot(cx - predicted.x, cy - predicted.y);
    if (d > radius) continue;
    // A blob cut by the window edge may be a large white object; prefer whole blobs.
    const score = d + (touchesEdge ? radius : 0);
    if (!best || score < best.score) best = { x: cx, y: cy, area, score };
  }
  return best && { x: best.x, y: best.y, area: best.area };
}

// Tracks frame by frame from a manually chosen start position.
export function createTracker(start, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const points = [];
  let velocity = { x: 0, y: 0 };
  let misses = 0;
  let last = { x: start.x, y: start.y };
  let finished = false;

  function step(frame, time) {
    if (finished) return { done: true };
    const predicted = { x: last.x + velocity.x * (misses + 1), y: last.y + velocity.y * (misses + 1) };
    const radius = Math.min(o.searchRadius * Math.pow(o.missGrowth, misses), Math.max(frame.width, frame.height));
    const hit = findBall(frame, points.length ? predicted : start, points.length ? radius : o.searchRadius / 2, o);
    if (!hit) {
      misses++;
      if (misses > o.maxMisses) finished = true;
      return { found: false, done: finished, predicted };
    }
    if (points.length) {
      const steps = misses + 1;
      const v = { x: (hit.x - last.x) / steps, y: (hit.y - last.y) / steps };
      // Smooth the velocity so one noisy detection does not throw the prediction off.
      velocity = points.length === 1 ? v : { x: velocity.x * 0.4 + v.x * 0.6, y: velocity.y * 0.4 + v.y * 0.6 };
    }
    misses = 0;
    last = { x: hit.x, y: hit.y };
    points.push({ x: hit.x, y: hit.y, time, area: hit.area });
    return { found: true, done: false, point: points[points.length - 1] };
  }

  return { step, points, get finished() { return finished; } };
}

// Screen-space values from the tracked points (観測値). time is media time in seconds.
// The launch is the first frame where the ball starts moving (it may sit still before impact).
export function launchIndex(points, minStepPx = 1.5) {
  for (let i = 0; i + 1 < points.length; i++) {
    if (Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y) > minStepPx) return i;
  }
  return -1;
}

export function summarize(points, launchSamples = 5) {
  if (!points || points.length < 2) return null;
  const li = launchIndex(points);
  const base = li < 0 ? 0 : li;
  const first = points[base];
  const k = Math.min(base + launchSamples, points.length - 1);
  const p = points[k];
  const dt = p.time - first.time;
  const dx = p.x - first.x, dy = p.y - first.y;
  let path = 0;
  for (let i = 1; i < points.length; i++) path += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  const duration = points[points.length - 1].time - first.time;
  return {
    launchSpeedPxPerSec: dt > 0 ? Math.hypot(dx, dy) / dt : null,
    // Angle above the horizontal on screen; up is positive (image y grows downward).
    launchAngleDeg: Math.atan2(-dy, Math.abs(dx)) * 180 / Math.PI,
    direction: dx >= 0 ? 'right' : 'left',
    pathLengthPx: path,
    durationSec: duration,
    averageSpeedPxPerSec: duration > 0 ? path / duration : null,
    launchTime: li < 0 ? null : first.time,
    moved: li >= 0,
    points: points.length
  };
}
