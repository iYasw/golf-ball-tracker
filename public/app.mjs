// Golf Ball Tracker: screen logic. Video never leaves the device.
import { createTracker, summarize } from './tracker.mjs';

const $ = id => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), ctx = overlay.getContext('2d');
const MAX_ANALYSIS_WIDTH = 1280; // larger frames are scaled down for speed on iPhone

const state = { start: null, points: [], tracking: false, stopRequested: false, objectUrl: null, name: '' };
window.golfTracker = state; // read by the browser test

const fps = () => Number($('fps').value) || 60;
const frameTime = () => 1 / fps();
const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? '-' : n.toFixed(d));

function setStatus(text) { $('status').textContent = text; }

// Resolves when `event` fires on the video, or rejects on error or after `ms`.
function waitFor(event, ms) {
  return new Promise((resolve, reject) => {
    const done = ok => { clearTimeout(timer); video.removeEventListener(event, onEvent); video.removeEventListener('error', onError); ok ? resolve() : reject(new Error(event)); };
    const onEvent = () => done(true), onError = () => done(false);
    const timer = setTimeout(() => done(false), ms);
    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

async function loadVideo(src, name) {
  resetTrack();
  if (state.objectUrl && state.objectUrl !== src) URL.revokeObjectURL(state.objectUrl);
  state.name = name;
  $('fileInfo').textContent = '読み込み中…';
  // iPhone Safari may not load picture data (no "loadeddata") until playback or a seek,
  // so wait only for metadata, then seek to the first frame to make it load.
  const metadata = waitFor('loadedmetadata', 20000);
  video.src = src;
  video.load();
  try {
    await metadata;
  } catch (e) {
    $('fileInfo').textContent = '読み込めませんでした\n原因：この端末のブラウザが対応していない形式か、ファイルが壊れているか、読み込みに時間がかかりすぎています。\n対処：iPhoneの「カメラ」で撮影したMP4/MOVでお試しください。長い動画は、写真アプリでスイングの部分だけに短くすると読み込みやすくなります。';
    return;
  }
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  $('stage').hidden = false; $('controls').hidden = false; $('trackCard').hidden = false;
  $('fileInfo').textContent = name + ' · ' + video.videoWidth + '×' + video.videoHeight + ' · ' + video.duration.toFixed(2) + ' 秒';
  $('duration').textContent = video.duration.toFixed(3);
  if (video.readyState < 2) {
    const firstFrame = waitFor('seeked', 5000).catch(() => {});
    video.currentTime = Math.min(0.001, video.duration || 0);
    await firstFrame;
  }
  updateTime();
  draw();
}

$('file').addEventListener('change', e => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  loadVideo(state.objectUrl, file.name);
});
$('sample').addEventListener('click', async () => {
  try {
    const meta = await (await fetch('samples/sample.json')).json();
    $('fps').value = String(meta.fps);
  } catch {}
  // Load the sample into memory first: some hosts (e.g. Cloudflare Pages) do not advertise
  // byte ranges, and browsers then refuse to seek a video streamed from its URL.
  $('fileInfo').textContent = 'サンプル動画を読み込み中…';
  try {
    const response = await fetch('samples/sample.mp4');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(await response.blob());
  } catch (e) {
    $('fileInfo').textContent = 'サンプル動画を読み込めませんでした\n原因：通信エラー（' + e.message + '）。\n対処：通信環境を確認し、ページを再読み込みしてください。';
    return;
  }
  loadVideo(state.objectUrl, 'サンプル動画（合成）');
});

// ---- Playback and position ----
function updateTime() {
  $('time').textContent = video.currentTime.toFixed(3);
  if (video.duration) $('seek').value = String(Math.round(video.currentTime / video.duration * 1000));
}
video.addEventListener('timeupdate', updateTime);
video.addEventListener('seeked', () => { updateTime(); draw(); });
video.addEventListener('play', () => { $('play').textContent = '一時停止'; });
video.addEventListener('pause', () => { $('play').textContent = '再生'; });
video.addEventListener('ended', () => { $('play').textContent = '再生'; });
$('play').addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
$('seek').addEventListener('input', e => { video.pause(); video.currentTime = Number(e.target.value) / 1000 * (video.duration || 0); });
$('back').addEventListener('click', () => stepFrames(-1));
$('forward').addEventListener('click', () => stepFrames(1));
function stepFrames(n) {
  video.pause();
  const k = Math.max(0, Math.floor(video.currentTime * fps() + 1e-6) + n);
  // Middle of frame k, so the browser shows exactly that frame.
  video.currentTime = Math.min(video.duration - 1e-4, (k + 0.5) / fps());
}

function seek(time) {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 1e-6 && video.readyState >= 2) { resolve(); return; }
    const timer = setTimeout(() => { video.removeEventListener('seeked', done); reject(new Error('seek timeout')); }, 5000);
    function done() { clearTimeout(timer); resolve(); }
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = time;
  });
}

// ---- Start position ----
overlay.addEventListener('click', e => {
  if (state.tracking || !video.videoWidth) return;
  const rect = overlay.getBoundingClientRect();
  state.start = {
    x: (e.clientX - rect.left) / rect.width * video.videoWidth,
    y: (e.clientY - rect.top) / rect.height * video.videoHeight,
    // The frame on screen, by frame number at the chosen frame rate.
    time: Math.floor(video.currentTime * fps() + 1e-6) / fps()
  };
  $('startInfo').textContent = '開始位置：x ' + state.start.x.toFixed(0) + ' / y ' + state.start.y.toFixed(0) + ' px（' + state.start.time.toFixed(3) + ' 秒）';
  $('track').disabled = false;
  draw();
  startTracking();
});

// ---- Tracking ----
const analysis = document.createElement('canvas');
const actx = analysis.getContext('2d', { willReadFrequently: true });

function grabFrame() {
  const scale = Math.min(1, MAX_ANALYSIS_WIDTH / video.videoWidth);
  analysis.width = Math.round(video.videoWidth * scale);
  analysis.height = Math.round(video.videoHeight * scale);
  actx.drawImage(video, 0, 0, analysis.width, analysis.height);
  return { frame: actx.getImageData(0, 0, analysis.width, analysis.height), scale };
}

async function startTracking() {
  if (!state.start || state.tracking) return;
  video.pause();
  state.tracking = true; state.stopRequested = false; state.points = [];
  $('track').disabled = true; $('stop').disabled = false; $('progress').hidden = false;
  $('resultCard').hidden = true;
  const scale = Math.min(1, MAX_ANALYSIS_WIDTH / video.videoWidth);
  const tracker = createTracker({ x: state.start.x * scale, y: state.start.y * scale }, { searchRadius: Math.max(30, 60 * scale * (video.videoWidth / 1280)) });
  const rate = fps();
  // Count frames by index and seek to the middle of each frame, so rounding never lands on the previous frame.
  const firstFrame = Math.round(state.start.time * rate);
  const lastFrame = Math.max(firstFrame, Math.floor(video.duration * rate - 1e-6));
  let frames = 0, reason = '';
  try {
    for (let k = firstFrame; k <= lastFrame; k++) {
      if (state.stopRequested) { reason = '停止しました。'; break; }
      await seek(Math.min((k + 0.5) / rate, video.duration - 1e-4));
      const { frame } = grabFrame();
      const r = tracker.step(frame, k / rate);
      state.points = tracker.points.map(p => ({ x: p.x / scale, y: p.y / scale, time: p.time }));
      frames++;
      $('progress').value = Math.round((k - firstFrame) / Math.max(1, lastFrame - firstFrame) * 100);
      setStatus('追跡中… ' + state.points.length + ' 点（' + (k / rate).toFixed(3) + ' 秒）');
      draw();
      if (r.done) { reason = tracker.points.length ? 'ボールが見えなくなったため終了しました。' : ''; break; }
    }
    if (!reason) reason = '動画の最後まで追跡しました。';
  } catch (e) {
    reason = '途中で止まりました\n原因：動画の再生位置を移動できませんでした（' + e.message + '）。\n対処：もう一度お試しください。';
  }
  state.tracking = false;
  $('track').disabled = false; $('stop').disabled = true; $('progress').hidden = true;
  if (state.points.length < 2) {
    setStatus('追跡できませんでした\n原因：開始位置の近くに白いボールが見つかりませんでした。\n対処：ボールの中心をタップし直すか、ボールが打たれる直前のフレームに合わせてください。');
  } else {
    setStatus(reason + '（' + frames + ' フレームを確認、' + state.points.length + ' 点を検出）');
  }
  showResults();
  draw();
}
$('track').addEventListener('click', startTracking);
$('stop').addEventListener('click', () => { state.stopRequested = true; });
$('clear').addEventListener('click', () => { resetTrack(); draw(); });

function resetTrack() {
  state.points = []; state.summary = null; state.start = null;
  $('track').disabled = true; $('resultCard').hidden = true; $('startInfo').textContent = '開始位置：未指定'; setStatus('');
}

function showResults() {
  const s = summarize(state.points);
  state.summary = s;
  if (!s) { $('resultCard').hidden = true; return; }
  $('resultCard').hidden = false;
  $('rPoints').textContent = s.points + ' 点';
  $('rSpeed').textContent = fmt(s.launchSpeedPxPerSec, 0) + ' px/再生秒';
  $('rAngle').textContent = s.moved ? fmt(s.launchAngleDeg, 1) + '°（' + (s.direction === 'right' ? '右' : '左') + '方向）' : '-（ボールが動いていません）';
  if (!s.moved) $('rSpeed').textContent = '-（ボールが動いていません）';
  $('rPath').textContent = fmt(s.pathLengthPx, 0) + ' px';
  $('rDuration').textContent = fmt(s.durationSec, 3) + ' 秒';
}

// ---- Drawing ----
function draw() {
  if (!overlay.width) return;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const unit = Math.max(2, overlay.width / 400);
  if (state.points.length > 1) {
    ctx.strokeStyle = '#ffd84d'; ctx.lineWidth = unit; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    state.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  ctx.fillStyle = '#ffd84d';
  for (const p of state.points) { ctx.beginPath(); ctx.arc(p.x, p.y, unit * 0.9, 0, Math.PI * 2); ctx.fill(); }
  if (state.start) {
    ctx.strokeStyle = '#5fd27a'; ctx.lineWidth = unit * 0.8;
    ctx.beginPath(); ctx.arc(state.start.x, state.start.y, unit * 5, 0, Math.PI * 2); ctx.stroke();
  }
}
