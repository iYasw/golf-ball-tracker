// Shared canvas drawing in source pixels.
export function drawGuide(ctx, width, height, guide) {
  ctx.save();
  ctx.strokeStyle = '#80efb0'; ctx.lineWidth = Math.max(2, width / 240);
  ctx.beginPath(); ctx.arc(guide.x * width, guide.y * height, guide.radius * width, 0, Math.PI * 2); ctx.stroke();
  const x = n => (guide.lefty ? 1 - n : n) * width;
  const y = n => n * height;
  ctx.beginPath(); ctx.ellipse(x(.64), y(.36), width * .045, height * .035, 0, 0, Math.PI * 2);
  ctx.moveTo(x(.64), y(.40)); ctx.lineTo(x(.69), y(.60));
  ctx.lineTo(x(.58), y(.82)); ctx.moveTo(x(.69), y(.60)); ctx.lineTo(x(.80), y(.82));
  ctx.moveTo(x(.65), y(.44)); ctx.lineTo(x(.51), y(.60)); ctx.lineTo(x(.32), y(.80));
  ctx.stroke(); ctx.restore();
}
export function drawPath(ctx, points, width) {
  if (!points.length) return;
  const line = Math.max(6, width / 120);
  ctx.save(); ctx.lineJoin = ctx.lineCap = 'round';
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.strokeStyle = '#102015'; ctx.lineWidth = line + Math.max(4, line * .65); ctx.stroke();
  ctx.strokeStyle = '#ffd84d'; ctx.lineWidth = line; ctx.stroke();
  for (const p of points) {
    ctx.beginPath(); ctx.arc(p.x, p.y, line * .65, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd84d'; ctx.strokeStyle = '#102015'; ctx.lineWidth = 2; ctx.stroke(); ctx.fill();
  }
  ctx.restore();
}
