// Golf ball tracking on video frames. Pure JavaScript: runs in the browser and in Node tests.
// All positions are in video pixels. Values are what the camera image shows (観測値),
// not real-world speed or distance.

export const DEFAULT_OPTIONS = Object.freeze({
  minBrightness: 185,   // brightest RGB channel of a ball pixel (0-255)
  maxSaturation: 70,    // max - min of RGB; a white ball has little color
  minChange: 25,       // mean RGB change for a moving ball pixel
  motionSaturation: 40, // reject colored background exposed by the moving ball
  duplicateThreshold: 0.001, // sampled mean RGB difference
  searchRadius: 60,     // search window around the predicted position (px)
  missGrowth: 1.6,      // search window growth per missed frame
  maxWaitFrames: 600,  // distinct frames allowed before launch
  maxMisses: 6,         // stop after this many frames without the ball
  minArea: 3,           // smallest blob (pixels) that can be the ball
  maxArea: 2500,        // larger white areas (shirts, sky, lines) are not the ball
  maxJump: 0            // 0 = use searchRadius
});

export function isBallPixel(r, g, b, o = DEFAULT_OPTIONS) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max >= o.minBrightness && max - min <= o.maxSaturation;
}

// Finds the candidate blob nearest to `predicted` inside a square window.
// frame: { width, height, data: Uint8ClampedArray RGBA }
export function findBall(frame, predicted, radius, o = DEFAULT_OPTIONS, previous = null) {
  const { width, height, data } = frame;
  const x0 = Math.max(0, Math.floor(predicted.x - radius)), x1 = Math.min(width - 1, Math.ceil(predicted.x + radius));
  const y0 = Math.max(0, Math.floor(predicted.y - radius)), y1 = Math.min(height - 1, Math.ceil(predicted.y + radius));
  if (x0 > x1 || y0 > y1) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const mask = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const candidate = previous
        ? Math.max(r, g, b) - Math.min(r, g, b) <= Math.min(o.maxSaturation, o.motionSaturation)
          && (Math.abs(r - previous.data[i]) + Math.abs(g - previous.data[i + 1])
            + Math.abs(b - previous.data[i + 2])) / 3 >= o.minChange
        : isBallPixel(r, g, b, o);
      if (candidate) mask[(y - y0) * w + (x - x0)] = 1;
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
    if (area < o.minArea || area > o.maxArea || touchesEdge) continue;
    const cx = x0 + sx / area, cy = y0 + sy / area;
    const d = Math.hypot(cx - predicted.x, cy - predicted.y);
    if (d > radius) continue;
    const score = d;
    if (!best || score < best.score) best = { x: cx, y: cy, area, score };
  }
  return best && { x: best.x, y: best.y, area: best.area };
}

// Sample a dense grid so small moving balls still distinguish otherwise static frames.
function frameDifference(frame, previous) {
  if (frame.width !== previous.width || frame.height !== previous.height) return Infinity;
  let total = 0, samples = 0;
  for (let y = 0; y < frame.height; y += 4) {
    for (let x = 0; x < frame.width; x += 4) {
      const i = (y * frame.width + x) * 4;
      for (let c = 0; c < 3; c++) total += Math.abs(frame.data[i + c] - previous.data[i + c]);
      samples += 3;
    }
  }
  return total / samples;
}

// Tracks frame by frame from a manually chosen start position.
export function createTracker(start, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const points = [];
  let velocity = { x: 0, y: 0 };
  let misses = 0;
  let last = { x: start.x, y: start.y };
  let finished = false;
  let previous = null;
  let launched = false;
  let waitFrames = 0;
  let firstDetection = null;

  function step(frame, time) {
    if (finished) return { done: true };
    if (previous && frameDifference(frame, previous) <= o.duplicateThreshold) {
      return { found: false, duplicate: true, done: false };
    }
    const initializing = !launched;
    if (initializing) waitFrames++;
    const predicted = initializing ? start : { x: last.x + velocity.x * (misses + 1), y: last.y + velocity.y * (misses + 1) };
    const radius = Math.min(o.searchRadius * (initializing ? 2.5 : 1) * Math.pow(o.missGrowth, misses), Math.max(frame.width, frame.height));
    const reference = previous && previous.width === frame.width && previous.height === frame.height ? previous : null;
    // Keep visible still points so summaries can locate the start of launch.
    let hit = initializing ? findBall(frame, start, o.searchRadius / 2, o) : null;
    if (!hit) hit = findBall(frame, predicted, radius, o, reference);
    // Video/canvas buffers may be reused by the caller.
    previous = { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
    if (!hit) {
      if (launched) {
        misses++;
        if (misses > o.maxMisses) finished = true;
      } else if (waitFrames >= o.maxWaitFrames) finished = true;
      return { found: false, done: finished, predicted };
    }
    const still = initializing && Math.hypot(hit.x - start.x, hit.y - start.y) < 3;
    if (!firstDetection) firstDetection = hit;
    if (initializing && Math.hypot(hit.x - firstDetection.x, hit.y - firstDetection.y) >= 3) launched = true;
    if (points.length && !still) {
      const steps = misses + 1;
      const v = { x: (hit.x - last.x) / steps, y: (hit.y - last.y) / steps };
      // Smooth the velocity so one noisy detection does not throw the prediction off.
      velocity = points.length === 1 ? v : { x: velocity.x * 0.2 + v.x * 0.8, y: velocity.y * 0.2 + v.y * 0.8 };
    }
    misses = 0;
    last = { x: hit.x, y: hit.y };
    points.push({ x: hit.x, y: hit.y, time, area: hit.area });
    if (!launched && waitFrames >= o.maxWaitFrames) finished = true;
    return { found: true, done: finished, point: points[points.length - 1] };
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
