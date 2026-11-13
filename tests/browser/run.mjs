// End-to-end check in a real browser: sample video → tap start → track → path and results.
// Needs Playwright with Chromium (not part of `npm test`, which must run without a browser).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4' };

// Static server with HTTP Range support (Safari/Chromium seek inside MP4 with ranges).
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(file).size, type = types[path.extname(file)] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : 0, end = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    // Like Cloudflare Pages: full responses do not advertise Accept-Ranges.
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
// LIVE_URL runs the same checks against the published site.
const url = process.env.LIVE_URL || `http://127.0.0.1:${server.address().port}/`;

const truth = t => {
  if (t < 0.25) return { x: 100, y: 620 };
  const s = t - 0.25;
  return { x: 100 + 600 * s, y: 620 - (900 * s - 600 * s * s) };
};

const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + path.resolve(root, '../tests/fixtures/fake-camera.mjpeg')] });
let failed = false;
const check = (ok, label) => { console.log((ok ? 'ok    ' : 'FAIL  ') + label); if (!ok) failed = true; };
try {
  const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.click('#sample');
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2 && !document.getElementById('stage').hidden);
  check(await page.textContent('#fileInfo').then(t => t.includes('1280×720')), 'sample video loads (1280×720)');

  // Playback: play briefly, then pause.
  await page.click('#play');
  await page.waitForFunction(() => document.getElementById('video').currentTime > 0.2, null, { timeout: 5000 });
  await page.click('#play');
  check(await page.evaluate(() => document.getElementById('video').paused), 'plays and pauses');

  // Position adjustment: slider to the start, then one frame forward and back.
  await page.evaluate(() => { const s = document.getElementById('seek'); s.value = '0'; s.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => document.getElementById('video').currentTime < 0.001);
  await page.click('#forward');
  await page.waitForFunction(() => Math.abs(document.getElementById("video").currentTime - 1.5 / 60) < 0.002);
  await page.click('#back');
  await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 0.5 / 60) < 0.002);
  check(true, 'slider and frame step move the position');

  // Tap the ball at video pixel (100, 620).
  const box = await page.locator('#overlay').boundingBox();
  await page.mouse.click(box.x + 100 / 1280 * box.width, box.y + 620 / 720 * box.height);
  check(await page.evaluate(() => !!window.golfTracker.start && window.golfTracker.tracking), 'tap sets start position and starts tracking automatically');

  await page.waitForFunction(() => !window.golfTracker.tracking && window.golfTracker.points.length > 0, null, { timeout: 60000 });
  const { points, summary } = await page.evaluate(() => ({ points: window.golfTracker.points, summary: window.golfTracker.summary }));
  const moving = points.filter(p => p.time > 0.25 + 1e-6);
  const errs = moving.map(p => { const q = truth(p.time); return Math.hypot(p.x - q.x, p.y - q.y); });
  const within = errs.filter(e => e < 5).length;
  console.log(`      ${points.length} points, ${moving.length} while moving, ${within} within 5 px, max error ${Math.max(...errs).toFixed(2)} px`);
  check(moving.length >= 70 && within === moving.length, 'every moving frame tracked within 5 px of the true position');
  check(!points.some(p => p.x > 1100 && p.y < 160), 'stationary white marker is never picked up');
  check(summary && summary.launchAngleDeg > 45 && summary.launchAngleDeg < 60, `on-screen launch angle ${summary && summary.launchAngleDeg.toFixed(1)}° (expected about 55°)`);
  check(await page.isVisible('#resultCard') && (await page.textContent('#rSpeed')).includes('px/再生秒'), 'results shown in px per playback second');
  check(await page.evaluate(() => { const c = document.getElementById('overlay'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 180 && d[i + 2] < 120 && d[i + 3] > 0) n++; return n > 500; }), 'yellow path drawn on the video');
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  const camera = await browser.newPage();
  const cameraErrors = [];
  camera.on('pageerror', e => cameraErrors.push(e.message));
  await camera.goto(url);
  await camera.click('#cameraStart');
  await camera.waitForFunction(() => window.golfLive.phase === 'result', null, { timeout: 20000 });
  check(await camera.evaluate(() => window.golfLive.points.length > 10 && window.golfLive.summary.moved), 'fake camera reaches result with a measured flight');
  check(await camera.evaluate(() => {
    const c = document.getElementById('liveOverlay'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let pixels = 0, widest = 0;
    for (let y = 0; y < c.height; y++) {
      let run = 0;
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] > 220 && d[i + 1] > 180 && d[i + 2] < 120) { pixels++; run++; widest = Math.max(widest, run); } else run = 0;
      }
    }
    return pixels > 500 && widest >= 6;
  }), 'live snapshot has a thick yellow path');
  check(cameraErrors.length === 0, 'camera has no page errors');
  await camera.evaluate(() => document.dispatchEvent(new Event('pagehide')));
  await camera.close();
  // iPhone Safari may never fire "loadeddata" for a picked file until playback or a seek.
  const safariLike = await browser.newPage({ viewport: { width: 393, height: 852 } });
  await safariLike.addInitScript(() => document.addEventListener('loadeddata', e => e.stopImmediatePropagation(), true));
  await safariLike.goto(url);
  await safariLike.setInputFiles('#file', path.join(root, 'samples', 'sample.mp4'));
  const picked = await safariLike.waitForFunction(() => /1280×720/.test(document.getElementById('fileInfo').textContent), null, { timeout: 15000 }).then(() => true, () => false);
  check(picked && await safariLike.isVisible('#stage'), 'a picked file loads even when the browser never fires loadeddata');
  await safariLike.close();
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
