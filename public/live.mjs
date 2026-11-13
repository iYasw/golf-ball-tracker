// Pure live state and normalized alignment geometry.
import { createTracker, findBall, summarize, DEFAULT_OPTIONS } from './tracker.mjs';
export function createGuide(lefty = false) {
  return { x: lefty ? 0.70 : 0.30, y: 0.82, radius: 0.03, lefty };
}
export function guideBall(frame, guide = createGuide()) {
  const center = { x: guide.x * frame.width, y: guide.y * frame.height };
  return findBall(frame, center, guide.radius * frame.width * 1.5, DEFAULT_OPTIONS);
}
export function createLiveSession({ guide = createGuide(), options = {} } = {}) {
  let phase, anchor, since, tracker, launchTime, resultTime, missingSince;
  function reset() { phase = 'align'; anchor = null; since = null; tracker = null; launchTime = null; missingSince = null; }
  reset();
  function step(frame, time) {
    const ball = guideBall(frame, guide);
    if (phase === 'result') {
      if (time - resultTime >= 2 && ball) reset();
      else return output();
    }
    if (phase === 'align') {
      if (!ball) { anchor = null; since = null; }
      else if (!anchor || Math.hypot(ball.x - anchor.x, ball.y - anchor.y) > Math.max(2, Math.sqrt(ball.area) * 0.3)) {
        anchor = ball; since = time;
      } else if (time - since >= 0.5) {
        phase = 'ready';
        tracker = createTracker(anchor, { searchRadius: Math.max(30, frame.width / 20), maxWaitFrames: Infinity, ...options });
        tracker.step(frame, time);
      }
    } else {
      tracker.step(frame, time);
      if (tracker.launched) {
        if (phase !== 'tracking') { phase = 'tracking'; launchTime = time; }
        if (tracker.finished || time - launchTime >= 3) { phase = 'result'; resultTime = time; }
      } else {
        const present = ball && Math.hypot(ball.x - anchor.x, ball.y - anchor.y) < Math.max(3, Math.sqrt(anchor.area) * 0.5);
        if (present) missingSince = null;
        else if (missingSince == null) missingSince = time;
        else if (time - missingSince >= 0.25) reset();
      }
    }
    return output();
  }
  function output() {
    const points = tracker?.points.map(p => ({ ...p })) ?? [];
    const summary = phase === 'result' ? summarize(points) : undefined;
    const message = { align: 'ボールを枠に合わせてください', ready: '準備OK：打ってください', tracking: '追跡中…', result: '解析結果（観測値）' }[phase];
    return { phase, message, ballStart: anchor, points, summary };
  }
  return { step, reset };
}
