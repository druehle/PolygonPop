(() => {
  'use strict';

  // Version (loaded from version.txt; defaults to 0 if unavailable)
  let VERSION = '0';
  function loadVersion() {
    try {
      fetch('version.txt?cb=' + Date.now())
        .then(r => (r.ok ? r.text() : '0'))
        .then(t => { VERSION = String(t).trim() || '0'; })
        .catch(() => {});
    } catch {}
  }
  loadVersion();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadVersion();
  });

  // Canvas setup with DPR scaling
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  // Layout constants (CSS pixels)
  const UI_H = 140; // bottom UI palette height
  const PATH_MARGIN = 24; // margin from playfield edges

  // Game state
  let W = 0, H = 0, PLAY_W = 0, PLAY_H = 0;
  let safeTop = 0, safeBottom = 0; // iOS safe-area approximations
  let lastTs = 0; // last timestamp for rAF

  const game = {
    towers: [],
    bullets: [],
    creeps: [],
    money: 100,
    lives: 20,
    score: 0,
    wave: 1,
    spawnTimer: 0,
    spawnEvery: 2.2, // seconds between hex spawns
    running: true
  };

  // Palette (bottom bar): 4 slots, only first active for now
  const TOWER_PIXEL = {
    key: 'pixel',
    name: 'Pixel Tower',
    cost: 25,
    range: 160,
    fireRate: 2.5, // bullets per second
    bulletSpeed: 480,
    dmg: 1,
    color: '#6cf0ff'
  };

  const palette = [
    { tower: TOWER_PIXEL, active: true },
    { tower: null, active: false, label: 'Coming' },
    { tower: null, active: false, label: 'Soon' },
    { tower: null, active: false, label: 'Soon' },
  ];

  // Drag state
  const pointer = { x: 0, y: 0, active: false };
  let dragging = null; // { type: 'tower', def: TOWER, ox, oy }

  // Path as waypoints through the play area
  let waypoints = [];

  function resize() {
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    // Approximate safe-areas
    safeTop = 0;
    safeBottom = 10;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = cssW; H = cssH;
    PLAY_W = W;
    PLAY_H = Math.max(200, H - UI_H - safeBottom);
    buildPath();
  }

  function buildPath() {
    const yMid = Math.round(PLAY_H * 0.45);
    const yA = Math.max(PATH_MARGIN, yMid - 80);
    const yB = Math.min(PLAY_H - PATH_MARGIN, yMid + 80);
    const x0 = -40;
    const x1 = Math.round(PLAY_W * 0.18);
    const x2 = Math.round(PLAY_W * 0.42);
    const x3 = Math.round(PLAY_W * 0.66);
    const x4 = Math.round(PLAY_W * 0.9);
    const x5 = PLAY_W + 40;
    waypoints = [
      {x:x0, y:yA}, {x:x1, y:yB}, {x:x2, y:yA}, {x:x3, y:yB}, {x:x4, y:yA}, {x:x5, y:yB}
    ];
  }

  // Geometry helpers
  function dist(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by; return Math.hypot(dx, dy);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Creep factory
  function creepRadiusForSides(s) { return 8 + s * 3; }
  function creepColorForSides(s) {
    switch (s) {
      case 6: return '#ff9f43';
      case 5: return '#f368e0';
      case 4: return '#54a0ff';
      case 3: return '#1dd1a1';
      default: return '#c8d6e5';
    }
  }
  function makeCreep(sides, x, y) {
    return {
      sides,
      x, y,
      r: creepRadiusForSides(sides),
      color: creepColorForSides(sides),
      hp: Math.max(1, Math.round(sides * 2)),
      maxHp: Math.max(1, Math.round(sides * 2)),
      speed: 48 + (6 - sides) * 8,
      rot: 0,
      rotSpeed: (Math.random() * 0.6 - 0.3),
      wpIndex: 0,
      reachedEnd: false
    };
  }

  function spawnHex() {
    if (!waypoints.length) return;
    const p = waypoints[0];
    const c = makeCreep(6, p.x, p.y);
    game.creeps.push(c);
  }

  // Tower factory
  function makeTower(def, x, y) {
    return {
      type: def.key,
      def,
      x, y,
      cooldown: 0
    };
  }

  // Bullets
  function makeBullet(x, y, vx, vy, dmg, color) {
    return { x, y, vx, vy, dmg, color, alive: true };
  }

  // Input (Pointer events unify mouse + touch)
  canvas.addEventListener('pointerdown', (e) => {
    const pos = eventPos(e);
    pointer.x = pos.x; pointer.y = pos.y; pointer.active = true;
    handlePointerDown(pos.x, pos.y);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointer.active && !dragging) return;
    const pos = eventPos(e);
    pointer.x = pos.x; pointer.y = pos.y;
  });
  canvas.addEventListener('pointerup', (e) => {
    const pos = eventPos(e);
    pointer.x = pos.x; pointer.y = pos.y; pointer.active = false;
    handlePointerUp(pos.x, pos.y);
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  });

  function eventPos(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);
    return { x, y };
  }

  function inPlayArea(x, y) {
    return y >= 0 && y <= PLAY_H && x >= 0 && x <= PLAY_W;
  }

  function paletteRects() {
    const pad = 12;
    const h = UI_H - safeBottom;
    const y = H - UI_H + pad;
    const slotW = Math.min(120, (W - pad * 5) / 4);
    const rects = [];
    for (let i = 0; i < 4; i++) {
      const x = pad + i * (slotW + pad);
      rects.push({ x, y, w: slotW, h: h - pad * 2, i });
    }
    return rects;
  }

  function handlePointerDown(x, y) {
    const rects = paletteRects();
    for (const r of rects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        const slot = palette[r.i];
        if (slot.active && slot.tower && game.money >= slot.tower.cost) {
          dragging = { type: 'tower', def: slot.tower, ox: r.x + r.w/2, oy: r.y + r.h/2 };
        }
        return;
      }
    }
  }

  function handlePointerUp(x, y) {
    if (dragging && dragging.type === 'tower') {
      if (inPlayArea(x, y) && game.money >= dragging.def.cost) {
        game.towers.push(makeTower(dragging.def, x, y));
        game.money -= dragging.def.cost;
      }
    }
    dragging = null;
  }

  // Update loop
  function update(dt) {
    if (!game.running) return;

    // Spawning
    game.spawnTimer += dt;
    const targetEvery = Math.max(1.0, game.spawnEvery - (game.wave - 1) * 0.1);
    while (game.spawnTimer >= targetEvery) {
      game.spawnTimer -= targetEvery;
      spawnHex();
    }

    // Creeps movement
    for (const c of game.creeps) {
      if (c.reachedEnd) continue;
      const i = c.wpIndex;
      const a = waypoints[i];
      const b = waypoints[i + 1];
      if (!b) { c.reachedEnd = true; continue; }
      const dx = b.x - c.x, dy = b.y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      const step = c.speed * dt;
      if (step >= len) {
        c.x = b.x; c.y = b.y; c.wpIndex++;
      } else {
        c.x += dx / len * step;
        c.y += dy / len * step;
      }
      c.rot += c.rotSpeed * dt;
    }

    // End reached
    for (const c of game.creeps) {
      if (!c.reachedEnd) continue;
      if (c.wpIndex >= waypoints.length - 1) {
        c.dead = true;
        game.lives -= 1;
        if (game.lives <= 0) game.running = false;
      } else {
        c.reachedEnd = false;
      }
    }

    // Towers fire
    for (const t of game.towers) {
      t.cooldown -= dt;
      if (t.cooldown <= 0) {
        let best = null, bestD = Infinity;
        for (const c of game.creeps) {
          if (c.dead) continue;
          const d = dist(t.x, t.y, c.x, c.y);
          if (d < t.def.range && d < bestD) { best = c; bestD = d; }
        }
        if (best) {
          const angle = Math.atan2(best.y - t.y, best.x - t.x);
          const speed = t.def.bulletSpeed;
          const vx = Math.cos(angle) * speed;
          const vy = Math.sin(angle) * speed;
          game.bullets.push(makeBullet(t.x, t.y, vx, vy, t.def.dmg, t.def.color));
          t.cooldown = 1 / t.def.fireRate;
        }
      }
    }

    // Bullets + collisions
    for (const b of game.bullets) {
      if (!b.alive) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) b.alive = false;
    }
    for (const b of game.bullets) {
      if (!b.alive) continue;
      for (const c of game.creeps) {
        if (c.dead) continue;
        if (dist(b.x, b.y, c.x, c.y) <= c.r) {
          c.hp -= b.dmg; b.alive = false;
          if (c.hp <= 0) {
            c.dead = true;
            game.score += c.maxHp;
            game.money += 6;
            if (c.sides > 3) {
              for (let i = 0; i < 2; i++) {
                const jitter = (i === 0 ? -1 : 1) * (4 + Math.random() * 3);
                const child = makeCreep(c.sides - 1, c.x + jitter, c.y + jitter);
                child.wpIndex = Math.max(0, c.wpIndex - 1);
                game.creeps.push(child);
              }
            }
          }
          break;
        }
      }
    }

    // Cleanup
    game.bullets = game.bullets.filter(b => b.alive);
    game.creeps = game.creeps.filter(c => !c.dead);
  }

  // Rendering
  function drawBackground() {
    ctx.fillStyle = '#0e0f12';
    ctx.fillRect(0, 0, W, H);

    // Subtle grid in play area
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, PLAY_W, PLAY_H);
    ctx.clip();
    const grid = 24;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= PLAY_W; x += grid) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, PLAY_H); ctx.stroke();
    }
    for (let y = 0; y <= PLAY_H; y += grid) {
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(PLAY_W, y + 0.5); ctx.stroke();
    }
    ctx.restore();

    // Path ribbon
    ctx.strokeStyle = 'rgba(100,200,255,0.25)';
    ctx.lineWidth = 10; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < waypoints.length; i++) {
      const p = waypoints[i];
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  function drawCreep(c) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.fillStyle = c.color;
    const n = c.sides; const r = c.r;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    if (c.hp < c.maxHp) {
      const w = r * 1.8, h = 4;
      ctx.rotate(-c.rot);
      ctx.translate(-w/2, -r - 10);
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, w, h);
      const pct = Math.max(0, c.hp / c.maxHp);
      ctx.fillStyle = '#52ffa8'; ctx.fillRect(0, 0, w * pct, h);
    }
    ctx.restore();
  }

  function drawTower(t) {
    const sz = 16;
    ctx.strokeStyle = 'rgba(108,240,255,0.15)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(t.x, t.y, t.def.range, 0, Math.PI * 2); ctx.stroke();

    ctx.fillStyle = '#11222a'; ctx.strokeStyle = '#6cf0ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(t.x - sz/2, t.y - sz/2, sz, sz); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#6cf0ff';
    ctx.fillRect(t.x - 2, t.y - 2, 4, 4);
  }

  function drawBullet(b) {
    ctx.fillStyle = b.color || '#fff';
    ctx.fillRect(b.x - 1, b.y - 1, 2, 2);
  }

  function drawUI() {
    // Bottom bar background
    ctx.fillStyle = '#0b1116';
    ctx.fillRect(0, H - UI_H, W, UI_H);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, H - UI_H, W, 1);

    // HUD (top-left)
    ctx.fillStyle = '#cfe7ff';
    ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`Money: $${game.money}`, 10, 8);
    ctx.fillText(`Lives: ${game.lives}`, 10, 28);
    ctx.fillText(`Score: ${game.score}`, 10, 48);

    // Version (lower-right)
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(200,230,255,0.9)';
    ctx.fillText(`v${VERSION}`, W - 10, H - 10);

    // Palette slots
    const rects = paletteRects();
    rects.forEach((r, idx) => {
      const slot = palette[idx];
      const active = !!slot.active && !!slot.tower;
      ctx.save();
      ctx.fillStyle = active ? '#0f1a22' : '#0a0f14';
      ctx.strokeStyle = active ? 'rgba(108,240,255,0.5)' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 2;
      roundRect(ctx, r.x, r.y, r.w, r.h, 10);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (active) {
        ctx.fillStyle = '#11222a'; ctx.strokeStyle = '#6cf0ff';
        const cx = r.x + r.w/2, cy = r.y + r.h/2 - 8;
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - 14, cy - 14, 28, 28);
        ctx.fillRect(cx - 14, cy - 14, 28, 28);
        ctx.fillStyle = '#6cf0ff';
        ctx.fillRect(cx - 2, cy - 2, 4, 4);
        ctx.fillStyle = '#cfe7ff';
        ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
        ctx.fillText(`${slot.tower.name}`, cx, r.y + r.h - 26);
        ctx.fillStyle = game.money >= slot.tower.cost ? '#9bffc6' : '#ffd1d1';
        ctx.fillText(`$${slot.tower.cost}`, cx, r.y + r.h - 10);
      } else {
        ctx.fillStyle = '#8b9bb0';
        ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
        ctx.fillText(slot.label || 'Locked', r.x + r.w/2, r.y + r.h/2);
      }
      ctx.restore();
    });

    // Drag ghost
    if (dragging && dragging.type === 'tower') {
      const x = pointer.x, y = pointer.y;
      const def = dragging.def;
      ctx.strokeStyle = 'rgba(108,240,255,0.2)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, def.range, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(108,240,255,0.35)';
      ctx.fillRect(x - 8, y - 8, 16, 16);
    }

    // Game over overlay
    if (!game.running) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold 24px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
      ctx.fillText('Game Over', W/2, H/2 - 10);
      ctx.font = '16px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
      ctx.fillText('Refresh to play again', W/2, H/2 + 18);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function render() {
    drawBackground();
    for (const c of game.creeps) drawCreep(c);
    for (const t of game.towers) drawTower(t);
    for (const b of game.bullets) drawBullet(b);
    drawUI();
  }

  function tick(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.033, Math.max(0.001, (ts - lastTs) / 1000));
    lastTs = ts;
    update(dt);
    render();
    requestAnimationFrame(tick);
  }

  // Init
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(tick);
})();

