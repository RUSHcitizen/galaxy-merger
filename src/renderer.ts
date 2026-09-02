/**
 * renderer.ts — canvas rendering.
 *
 * Performance notes (the target is a 2017 MacBook Pro):
 *
 *  1. Trails come from a *persistence buffer*: instead of clearing the canvas
 *     we erase it slightly with a `destination-out` fill. Cost is one GPU rect
 *     per frame regardless of how many bodies there are — vastly cheaper than
 *     keeping a point history per body and stroking thousands of segments.
 *  2. Glows are pre-rasterised radial-gradient sprites, cached by colour and
 *     radius bucket. `ctx.shadowBlur` is the obvious way to get neon and is
 *     also brutally slow on Intel integrated GPUs, so it is never used.
 *  3. The device pixel ratio is capped (RENDER.MAX_DPR) — a retina 15" panel
 *     at full DPR is ~5M pixels of fill per frame.
 *  4. A separate overlay canvas holds the aim arrow so transient UI never
 *     smears into the trail buffer, and it is only touched when dirty.
 *  5. Quality auto-degrades (smaller glows, plain discs for tiny bodies) when
 *     smoothed frame time drifts above RENDER.DEGRADE_MS.
 */

import { RENDER, type SandboxState } from './config';
import { hexToRgb, type Body, type Vec2 } from './physics';

type Ctx = CanvasRenderingContext2D;

/**
 * Snap a colour to a coarse grid before using it as a cache key. Merging bodies
 * blend their colours, which would otherwise mint a fresh gradient per body;
 * on a soft radial glow a 1/16th-of-a-channel step is invisible.
 */
function quantizeColor(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
}

interface Sprite {
  canvas: HTMLCanvasElement;
  /** Sprite half-size in CSS px — the draw offset. */
  half: number;
}

export class Renderer {
  private ctx: Ctx;
  private overlayCtx: Ctx;
  private sprites = new Map<string, Sprite>();
  private dpr = 1;
  private overlayDirty = false;

  /** 1 = full quality, 0 = degraded. Driven by smoothed frame time. */
  private quality = 1;
  private smoothedMs = 16;
  /** Gradients rasterised so far this frame, bounded by RENDER.SPRITE_BUDGET. */
  private spritesThisFrame = 0;

  width = 0;
  height = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLCanvasElement,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true });
    const octx = overlay.getContext('2d', { alpha: true });
    if (!ctx || !octx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.overlayCtx = octx;
    this.resize();
  }

  /** Match the backing store to the CSS size, capped at RENDER.MAX_DPR. */
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, RENDER.MAX_DPR);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    if (w === this.width && h === this.height && dpr === this.dpr) return;

    this.width = w;
    this.height = h;
    this.dpr = dpr;

    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    // Draw in CSS pixels; the transform handles the scale-up.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Sprites are rasterised at the current DPR, so they must be rebuilt.
    this.sprites.clear();
  }

  get centerX(): number {
    return this.width / 2;
  }

  get centerY(): number {
    return this.height / 2;
  }

  /** Wipe both layers immediately (used by Clear / trail-length changes). */
  clearAll(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.clearOverlay();
  }

  /** Feed real frame time in ms so quality can adapt. */
  reportFrameTime(ms: number): void {
    this.smoothedMs += (ms - this.smoothedMs) * 0.08;
    if (this.quality === 1 && this.smoothedMs > RENDER.DEGRADE_MS) this.quality = 0;
    else if (this.quality === 0 && this.smoothedMs < RENDER.RECOVER_MS) this.quality = 1;
  }

  get fps(): number {
    return this.smoothedMs > 0 ? 1000 / this.smoothedMs : 0;
  }

  get degraded(): boolean {
    return this.quality === 0;
  }

  /**
   * Trail persistence. `trail` 0 -> hard clear, 1 -> ~1.5s of afterglow.
   * The exponential mapping keeps the slider's feel even across its range.
   */
  private fade(trail: number): void {
    const ctx = this.ctx;
    if (trail <= 0.001) {
      ctx.clearRect(0, 0, this.width, this.height);
      return;
    }
    // Frames of visible persistence: 3 at trail=0, ~90 at trail=1.
    const frames = 3 * Math.pow(30, trail);
    const alpha = Math.min(1, Math.max(0.012, 1 / frames));

    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Pre-rendered glow sprite for a colour/radius pair, or `null` when this
   * frame's rasterisation budget is spent (the caller then falls back to a
   * plain disc).
   *
   * Three things keep this cache from becoming the bottleneck:
   *  - radii are bucketed, so a body growing through merges reuses sprites;
   *  - colours are quantised, because merges produce arbitrary blended hexes
   *    that would otherwise mint a unique key per body;
   *  - eviction is LRU rather than a wholesale flush, and only
   *    RENDER.SPRITE_BUDGET gradients may be rasterised per frame. Together
   *    those bound the per-frame cost no matter how varied the scene is.
   */
  private sprite(color: string, radius: number): Sprite | null {
    const bucket = radius < 8 ? Math.max(1, Math.round(radius)) : Math.round(radius / 4) * 4;
    const key = `${quantizeColor(color)}|${bucket}`;

    const hit = this.sprites.get(key);
    if (hit) {
      // Re-insert to mark as most-recently-used (Map keeps insertion order).
      this.sprites.delete(key);
      this.sprites.set(key, hit);
      return hit;
    }

    if (this.spritesThisFrame >= RENDER.SPRITE_BUDGET) return null;
    this.spritesThisFrame++;

    while (this.sprites.size >= RENDER.SPRITE_CACHE_LIMIT) {
      const oldest = this.sprites.keys().next().value;
      if (oldest === undefined) break;
      this.sprites.delete(oldest);
    }

    const r = bucket;
    const glow = Math.min(RENDER.MAX_SPRITE_RADIUS, r * RENDER.GLOW_MULT);
    const size = Math.ceil(glow * 2) + 2;
    const half = size / 2;

    const c = document.createElement('canvas');
    c.width = Math.ceil(size * this.dpr);
    c.height = Math.ceil(size * this.dpr);
    const g = c.getContext('2d') as Ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const [cr, cg, cb] = hexToRgb(color);
    const grad = g.createRadialGradient(half, half, 0, half, half, glow);
    const core = Math.min(0.5, r / glow);
    // Only a small white-hot centre: with 'lighter' blending a wide white core
    // washes every overlapping trail out to grey.
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(core * 0.42, `rgba(${cr},${cg},${cb},0.98)`);
    grad.addColorStop(core, `rgba(${cr},${cg},${cb},0.6)`);
    grad.addColorStop(Math.min(0.98, core + 0.3), `rgba(${cr},${cg},${cb},0.13)`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);

    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    const sprite: Sprite = { canvas: c, half };
    this.sprites.set(key, sprite);
    return sprite;
  }

  /** Draw one simulation frame. */
  render(bodies: Body[], state: SandboxState): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    this.spritesThisFrame = 0;
    this.fade(state.trail);

    const lowQ = this.quality === 0;
    // Additive blending is what makes overlapping glows read as light.
    ctx.globalCompositeOperation = state.glow ? 'lighter' : 'source-over';

    this.drawStreaks(bodies, w, h);

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const r = b.radius;

      // Cull off-screen bodies before touching the rasteriser.
      const pad = r * RENDER.GLOW_MULT + 4;
      if (b.x < -pad || b.y < -pad || b.x > w + pad || b.y > h + pad) continue;

      const s = state.glow && !(lowQ && r < 2.5) ? this.sprite(b.color, r) : null;
      if (s) {
        const scale = lowQ ? 0.6 : 1;
        const size = s.half * 2 * scale;
        ctx.drawImage(s.canvas, b.x - s.half * scale, b.y - s.half * scale, size, size);
      } else {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalCompositeOperation = 'source-over';

    // Black holes are drawn last and opaquely: an event horizon punched out of
    // whatever glow surrounds it, plus a thin accretion ring.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.kind !== 'blackhole') continue;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fillStyle = '#05050b';
      ctx.fill();
      ctx.lineWidth = Math.max(1, b.radius * 0.09);
      ctx.strokeStyle = b.color;
      ctx.stroke();
    }

    if (state.showVectors) this.drawVectors(bodies);
  }

  /**
   * Motion blur: a round-capped line from each body's previous position to its
   * current one. Without it a body travelling faster than its own diameter per
   * frame paints a dotted line into the persistence buffer instead of a track.
   * Bodies that barely moved are skipped, so in a slow dense cluster this pass
   * costs almost nothing.
   */
  private drawStreaks(bodies: Body[], w: number, h: number): void {
    const ctx = this.ctx;
    const maxStreak2 = RENDER.MAX_STREAK * RENDER.MAX_STREAK;
    ctx.lineCap = 'round';

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const dx = b.x - b.px;
      const dy = b.y - b.py;
      const d2 = dx * dx + dy * dy;
      // Too small to matter, or a merge teleporting a body to the barycentre.
      if (d2 < 1 || d2 > maxStreak2) continue;

      const pad = b.radius + RENDER.MAX_STREAK;
      if (b.x < -pad || b.y < -pad || b.x > w + pad || b.y > h + pad) continue;

      ctx.strokeStyle = b.color;
      // Slightly wider than the body and nearly opaque, so the streak reads as
      // one continuous track rather than beads on a faint thread.
      ctx.lineWidth = Math.max(1.5, b.radius * 1.6);
      ctx.globalAlpha = 0.82;
      ctx.beginPath();
      ctx.moveTo(b.px, b.py);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawVectors(bodies: Body[]): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x + b.vx * 6, b.y + b.vy * 6);
    }
    ctx.stroke();
  }

  /* ------------------------------------------------------------- overlay */

  clearOverlay(): void {
    if (!this.overlayDirty) return;
    this.overlayCtx.clearRect(0, 0, this.width, this.height);
    this.overlayDirty = false;
  }

  /** Slingshot preview: ghost body, aim line and a launch arrow. */
  drawAim(from: Vec2, to: Vec2, radius: number, color: string): void {
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    this.overlayDirty = true;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.globalAlpha = 0.55;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ghost of the body about to be spawned.
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.arc(from.x, from.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(from.x, from.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    if (len > 12) {
      const ux = dx / len;
      const uy = dy / len;
      const head = Math.min(14, len * 0.3);
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - ux * head - uy * head * 0.45, to.y - uy * head + ux * head * 0.45);
      ctx.lineTo(to.x - ux * head + uy * head * 0.45, to.y - uy * head - ux * head * 0.45);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}
