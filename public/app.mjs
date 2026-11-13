// Golf Ball Tracker: screen logic. Video never leaves the device.
import { createTracker, summarize } from './tracker.mjs';
import { createGuide, guideBall, createLiveSession } from './live.mjs';
import { drawGuide, drawPath } from './drawing.mjs';

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
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const x = (e.clientX - rect.left - (rect.width - video.videoWidth * scale) / 2) / scale;
  const y = (e.clientY - rect.top - (rect.height - video.videoHeight * scale) / 2) / scale;
  if (x < 0 || y < 0 || x > video.videoWidth || y > video.videoHeight) return;
  state.start = { x, y,
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
  drawGuide(ctx, overlay.width, overlay.height, createGuide($('hand').value === 'left'));
  drawPath(ctx, state.points, overlay.width);
  if (!state.tracking && video.readyState >= 2) {
    const { frame, scale } = grabFrame();
    const ball = guideBall(frame, createGuide($('hand').value === 'left'));
    state.guideStart = ball ? { x: ball.x / scale, y: ball.y / scale } : null;
    $('guideTrack').hidden = !ball;
  }
  if (state.start) {
    ctx.strokeStyle = '#5fd27a'; ctx.lineWidth = unit * 0.8;
    ctx.beginPath(); ctx.arc(state.start.x, state.start.y, unit * 5, 0, Math.PI * 2); ctx.stroke();
  }
}

$('guideTrack').addEventListener('click', () => {
  if (!state.guideStart || state.tracking) return;
  state.start = { ...state.guideStart, time: Math.floor(video.currentTime * fps() + 1e-6) / fps() };
  startTracking();
});

const liveVideo = $('liveVideo'), liveCanvas = $('liveOverlay');
const liveCtx = liveCanvas.getContext('2d');
const liveAnalysis = document.createElement('canvas');
const liveRead = liveAnalysis.getContext('2d', { willReadFrequently: true });
const launchSnapshot = document.createElement('canvas');
let session, stream, generation = 0, previousSnapshot = null, capturedLaunch = false;
let fpsStart = 0, fpsFrames = 0;
let recorder, recordTimer, imageBlob, videoBlob, shotDate, imageToken = 0;
function stopRecording() { clearTimeout(recordTimer); if (recorder?.state === 'recording') recorder.stop(); }
function startRecording() {
  stopRecording(); videoBlob = null; live.videoBytes = 0; $('saveVideo').disabled = true;
  if (!window.MediaRecorder) return;
  const mimeType = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  try {
    const chunks = [];
    const current = new MediaRecorder(stream, mimeType ? { mimeType } : {}); recorder = current;
    current.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    current.onstop = () => { if (recorder !== current) return; videoBlob = new Blob(chunks, { type: current.mimeType }); live.videoBytes = videoBlob.size; $('saveVideo').disabled = !videoBlob.size; };
    current.start(200);
  } catch {}
}
function buildImage() {
  const token = ++imageToken; shotDate = new Date();
  const canvas = document.createElement('canvas'); canvas.width = liveCanvas.width; canvas.height = liveCanvas.height;
  const c = canvas.getContext('2d'); c.drawImage(liveCanvas, 0, 0);
  const size = Math.max(12, Math.round(canvas.width / 38));
  const lines = [...$('liveValues').children].reduce((rows, el, i, all) => { if (i % 2 === 0) rows.push(el.textContent + '：' + all[i + 1].textContent); return rows; }, []);
  lines.push(shotDate.toLocaleString('ja-JP') + ' / ' + live.captureFps + ' fps');
  c.fillStyle = '#102017e8'; c.fillRect(0, 0, canvas.width, size * (lines.length + 1) * 1.5);
  c.font = size + 'px sans-serif'; c.fillStyle = '#fff'; lines.forEach((line, i) => c.fillText(line, size, size * (i + 1) * 1.5, canvas.width - size * 2));
  canvas.toBlob(blob => { if (token !== imageToken) return; imageBlob = blob; live.imageBytes = blob?.size || 0; $('saveImage').disabled = !blob; }, 'image/png');
}
async function saveShot(blob, extension) {
  if (!blob) return;
  const d = shotDate || new Date(), pad = n => String(n).padStart(2, '0');
  const name = 'golf-shot-' + d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.' + extension;
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch {} return; }
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}
$('saveImage').onclick = () => saveShot(imageBlob, 'png');
$('saveVideo').onclick = () => saveShot(videoBlob, videoBlob?.type.includes('mp4') ? 'mp4' : 'webm');
const live = { phase: 'align', points: [] };
window.golfLive = live;
function resetLive() {
  session = createLiveSession({ guide: createGuide($('hand').value === 'left') });
  Object.assign(live, { phase: 'align', points: [], summary: null });
  stopRecording(); imageToken++; imageBlob = null; live.imageBytes = 0; $('saveImage').disabled = true;
  previousSnapshot = null; capturedLaunch = false;
  $('liveResults').hidden = true;
}
function stopCamera() {
  stopRecording();
  generation++;
  stream?.getTracks().forEach(track => track.stop());
  stream = null; liveVideo.srcObject = null;
  $('cameraStart').disabled = false; $('cameraStart').hidden = false;
}
function cameraError(error) {
  const denied = error.name === 'NotAllowedError' || error.name === 'SecurityError';
  $('liveStatus').textContent = 'カメラを使えません\n原因：' + (denied ? 'カメラの使用が許可されていません。' : error.name === 'NotFoundError' ? 'カメラが見つかりません。' : 'カメラを起動できません。') + '\n対処：' + (denied ? 'ブラウザのカメラ権限を許可し、HTTPSで開いてください。' : 'カメラの接続と他のアプリの使用状況を確認して、再試行してください。');
}
async function startCamera() {
  stopCamera(); resetLive();
  const token = generation;
  $('cameraStart').disabled = true;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } } });
    if (token !== generation) { acquired.getTracks().forEach(t => t.stop()); return; }
    stream = acquired;
    const track = stream.getVideoTracks()[0];
    const maximum = track.getCapabilities?.().frameRate?.max;
    let maximumApplied = false;
    if (maximum) {
      const rates = [...new Set([maximum, ...[120, 60, 30, 15].filter(rate => rate < maximum)])];
      for (const rate of rates) {
        try { await track.applyConstraints({ frameRate: { exact: rate }, width: { ideal: 1280 }, height: { ideal: 720 } }); maximumApplied = rate === maximum; break; }
        catch { try { await track.applyConstraints({ frameRate: { exact: rate } }); maximumApplied = rate === maximum; break; } catch {} }
      }
    }
    if (token !== generation) return;
    live.captureFps = track.getSettings().frameRate;
    $('captureFps').textContent = '撮影 ' + (live.captureFps ? fmt(live.captureFps, 0) : '不明') + ' fps' + (maximumApplied && live.captureFps >= maximum - 0.5 ? '（この端末で使える最大）' : '');
    liveVideo.srcObject = stream;
    await liveVideo.play();
    if (token !== generation) return;
    $('liveStage').hidden = false; $('cameraStart').hidden = true;
    liveCanvas.width = liveVideo.videoWidth; liveCanvas.height = liveVideo.videoHeight;
    const scale = Math.min(1, 960 / liveCanvas.width);
    liveAnalysis.width = Math.round(liveCanvas.width * scale); liveAnalysis.height = Math.round(liveCanvas.height * scale);
    launchSnapshot.width = liveCanvas.width; launchSnapshot.height = liveCanvas.height;
    fpsStart = performance.now(); fpsFrames = 0;
    let lastTime = -1;
    function schedule() {
      if (token !== generation) return;
      if (liveVideo.requestVideoFrameCallback) liveVideo.requestVideoFrameCallback((now, meta) => tick(now, meta.mediaTime));
      else requestAnimationFrame(now => tick(now, liveVideo.currentTime));
    }
    function tick(now, time) {
      if (token !== generation) return;
      if (time === lastTime || liveVideo.readyState < 2) { schedule(); return; }
      lastTime = time;
      liveRead.drawImage(liveVideo, 0, 0, liveAnalysis.width, liveAnalysis.height);
      const result = session.step(liveRead.getImageData(0, 0, liveAnalysis.width, liveAnalysis.height), time);
      if (live.phase === 'result' && result.phase !== 'result') { capturedLaunch = false; previousSnapshot = null; }
      // Capture the first moving frame, before launch confirmation.
      if (result.phase === 'ready' && result.ballStart) {
        const p = result.points.at(-1);
        const moving = p && Math.hypot(p.x - result.ballStart.x, p.y - result.ballStart.y) >= 3;
        if (p && !capturedLaunch) {
          launchSnapshot.getContext('2d').drawImage(liveVideo, 0, 0, launchSnapshot.width, launchSnapshot.height);
          previousSnapshot = true;
          if (moving) capturedLaunch = true;
        }
      }
      const oldPhase = live.phase;
      if (result.phase === 'ready' && oldPhase !== 'ready') startRecording();
      if (result.phase === 'align' && oldPhase !== 'align') stopRecording();
      const points = result.points.map(p => ({ ...p, x: p.x / scale, y: p.y / scale }));
      Object.assign(live, result, { points, summary: result.phase === 'result' ? summarize(points) : null });
      liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
      if (live.phase === 'result' && previousSnapshot) liveCtx.drawImage(launchSnapshot, 0, 0);
      else drawGuide(liveCtx, liveCanvas.width, liveCanvas.height, createGuide($('hand').value === 'left'));
      drawPath(liveCtx, points, liveCanvas.width);
      if (points.length) {
        liveCtx.strokeStyle = '#5fd27a'; liveCtx.lineWidth = Math.max(3, liveCanvas.width / 240);
        liveCtx.beginPath(); liveCtx.arc(points[0].x, points[0].y, Math.max(8, liveCanvas.width / 80), 0, Math.PI * 2); liveCtx.stroke();
      }
      $('liveStatus').textContent = live.message;
      $('liveResults').hidden = live.phase !== 'result';
      if (live.summary) {
        const s = live.summary;
        const rows = [['追跡できたフレーム', s.points + ' 点'], ['打ち出し直後の画面速度', fmt(s.launchSpeedPxPerSec, 0) + ' px/秒'], ['画面上の打ち出し角度', fmt(s.launchAngleDeg) + '°（' + (s.direction === 'right' ? '右' : '左') + '方向）'], ['画面上の移動距離', fmt(s.pathLengthPx, 0) + ' px'], ['打ち出し後の追跡時間', fmt(s.durationSec, 3) + ' 秒']];
        $('liveValues').replaceChildren(...rows.flatMap(([label, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; return [dt, dd]; }));
      }
      if (live.phase === 'result' && oldPhase !== 'result') { buildImage(); recordTimer = setTimeout(stopRecording, 1500); }
      fpsFrames++;
      if (now - fpsStart >= 1000) { $('liveFps').textContent = '解析：' + (fpsFrames * 1000 / (now - fpsStart)).toFixed(1) + ' コマ/秒'; fpsFrames = 0; fpsStart = now; }
      schedule();
    }
    schedule();
  } catch (error) { if (token === generation) { stopCamera(); cameraError(error); } }
}
$('cameraStart').addEventListener('click', startCamera);
$('nextShot').addEventListener('click', resetLive);
$('hand').addEventListener('change', () => { resetLive(); draw(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
window.addEventListener('pagehide', stopCamera);
resetLive();
function selectTab(camera) {
  $('cameraPanel').hidden = !camera; $('recorded').hidden = camera;
  $('cameraTab').setAttribute('aria-selected', String(camera)); $('videoTab').setAttribute('aria-selected', String(!camera));
  if (!camera) { stopCamera(); } else if (!stream) startCamera();
}
$('cameraTab').onclick = () => selectTab(true);
$('videoTab').onclick = () => selectTab(false);
startCamera();

video.addEventListener('play', () => {
  function update() {
    if (video.paused || video.ended || state.tracking) return;
    draw(); requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
});
