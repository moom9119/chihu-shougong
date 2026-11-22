/**
 * ui/fox-scene.js —— 狐狸舞台上的羽毛 / 花瓣粒子（Canvas 2D）。
 * 素材只有狐狸立绘是图片，飘落物全部代码绘制，离线可用、缩放不失真。
 */

export function createFoxScene() {
  let canvas = null;
  let ctx = null;
  let raf = 0;
  let last = 0;
  let spawnAcc = 0;
  let particles = [];
  let mode = 'collect';
  let dpr = 1;
  let w = 0;
  let h = 0;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, Math.round(rect.width));
    h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn() {
    const kind = Math.random() < 0.34 ? 'petal' : Math.random() < 0.12 ? 'spark' : 'feather';
    particles.push({
      kind,
      x: rand(0, w),
      y: -20,
      vx: rand(-0.16, 0.16),
      vy: kind === 'feather' ? rand(0.22, 0.5) : rand(0.3, 0.62),
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.014, 0.014),
      size: kind === 'spark' ? rand(1.6, 3.2) : rand(5, 10),
      life: 1,
      sway: rand(0.4, 1.2),
      phase: rand(0, Math.PI * 2),
      color: kind === 'petal' ? pick(['#ff9fbd', '#ffc0d2', '#f7a8c4']) : kind === 'spark' ? '#ffe9a3' : pick(['#f6e7cf', '#ffd9b0', '#efe0c8']),
    });
    if (particles.length > 90) particles.splice(0, particles.length - 90);
  }

  function drawFeather(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = 0.85 * p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, p.size * 0.34, p.size, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,90,60,.45)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(0, -p.size);
    ctx.lineTo(0, p.size * 1.2);
    ctx.stroke();
    ctx.restore();
  }

  function drawPetal(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = 0.9 * p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, p.size * 0.72, p.size * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSpark(p) {
    ctx.save();
    ctx.globalAlpha = 0.7 * p.life;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    const now = ts || 0;
    const dt = Math.min(48, last ? now - last : 16);
    last = now;
    if (!ctx || !w) return;

    ctx.clearRect(0, 0, w, h);

    if (mode === 'collect' && !reduced) {
      spawnAcc += dt;
      const interval = 520;
      while (spawnAcc > interval) {
        spawnAcc -= interval;
        spawn();
      }
    }

    for (const p of particles) {
      p.phase += dt * 0.0016 * p.sway;
      p.x += p.vx * dt * 0.08 + Math.sin(p.phase) * 0.35;
      p.y += p.vy * dt * 0.14;
      p.rot += p.vr * dt * 0.06;
      if (p.y > h + 30) p.life = 0;
      if (p.life <= 0) continue;
      if (p.kind === 'feather') drawFeather(p);
      else if (p.kind === 'petal') drawPetal(p);
      else drawSpark(p);
    }
    particles = particles.filter((p) => p.life > 0);
  }

  function start() {
    cancelAnimationFrame(raf);
    if (!reduced) raf = requestAnimationFrame(frame);
    else {
      // 减少动效：只画一层静态装饰
      if (ctx && w) {
        for (let i = 0; i < 14; i += 1) spawn();
        for (const p of particles) {
          p.y = Math.random() * h;
          p.life = 1;
        }
      }
    }
  }

  function mount(el) {
    if (!el) return;
    if (canvas === el) {
      resize();
      return;
    }
    unmount();
    canvas = el;
    ctx = el.getContext('2d');
    particles = [];
    resize();
    window.addEventListener('resize', resize);
    start();
  }

  function unmount() {
    cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener('resize', resize);
    canvas = null;
    ctx = null;
    particles = [];
    last = 0;
  }

  function setMode(next) {
    mode = next;
    if (next === 'failed') {
      // 失败后停止飘落，粒子慢慢落完
      spawnAcc = 0;
    }
  }

  /** 一次性的庆祝爆发（成功结算时用） */
  function burst(count = 26) {
    if (!ctx || !w) return;
    for (let i = 0; i < count; i += 1) {
      spawn();
      const p = particles[particles.length - 1];
      p.y = rand(0.1, 0.7) * h;
      p.vy = rand(-0.2, 0.4);
    }
  }

  return { mount, unmount, setMode, burst, resize };
}
