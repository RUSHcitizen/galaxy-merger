/**
 * renderer.ts — canvas rendering.
 *
 * ONE visible canvas. Everything else is an offscreen buffer composited into it
 * each frame:
 *
 *   starBuf   parallax starfield, redrawn only when the camera moves
 *   trailBuf  the persistence buffer: trails, glows, bodies, debris
 *   bloomA/B  quarter-resolution downsample and blur of trailBuf
 *
 * An earlier version used four stacked <canvas> elements and got the additive
 * bloom for free via CSS `mix-blend-mode: screen`. Measured, that was the most
 * expensive thing on the page: every extra full-screen composited layer costs
 * real time, and a blend mode forces the compositor to read the backdrop back.
 * Doing the same compositing inside one canvas with `globalCompositeOperation`
 * is several full-screen blits, which is cheaper and far more predictable.
 *
 * Performance notes (the target is a 2017 MacBook Pro):
 *
 *  1. Trails come from a *persistence buffer*: instead of clearing the canvas
 *     we erase it slightly with a `destination-out` fill. Cost is one GPU rect
 *     per frame regardless of how many bodies there are — vastly cheaper than
 *     keeping a point history per body and stroking thousands of segments.
 *     Panning translates that buffer rather than discarding it; only zoom,
 *     which cannot be salvaged, forces a clear.
 *  2. Glows are pre-rasterised radial-gradient sprites, cached by colour and
 *     *screen* radius. `ctx.shadowBlur` is the obvious way to get neon and is
 *     also brutally slow on Intel integrated GPUs, so it is never used.
 *  3. Bloom is done at quarter resolution: one downscale, one blurred upscale.
 *     At full resolution it would cost more than everything else combined.
 *  4. The device pixel ratio is capped (RENDER.MAX_DPR) — a retina 15" panel
 *     at full DPR is ~5M pixels of fill per frame.
 *  5. Quality auto-degrades (smaller glows, plain discs for tiny bodies, bloom
 *     off) when smoothed frame time drifts above RENDER.DEGRADE_MS.
 */

import { COLORS, RENDER, type SandboxState } from './config';
import type { QualityProfile } from './quality';
import type { Camera } from './camera';
import { hexToRgb, type Body, type Vec2 } from './physics';
import type { OrbitElements } from './orbits';
import type { Sparks } from './particles';

type Ctx = CanvasRenderingContext2D;

interface Sprite {
  canvas: HTMLCanvasElement;
  /** Sprite half-size in CSS px — the draw offset. */
  half: number;
  /** Backing-store size, so the cache can be bounded by memory not just count. */
  bytes: number;
}

/**
 * Snap a colour to a coarse grid before using it as a cache key. Merging bodies
 * blend their colours, which would otherwise mint a fresh gradient per body;
 * on a soft radial glow a 1/16th-of-a-channel step is invisible.
 */
function quantizeColor(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
}

export class Renderer {
  /** The one canvas the user actually sees. */
  private view: Ctx;

  /** Persistence buffer holding trails and bodies. */
  private trailBuf = document.createElement('canvas');
  private ctx: Ctx;
  /** Starfield, redrawn only when the camera moves. */
  private starBuf = document.createElement('canvas');
  private starCtx: Ctx;
  /**
   * Quarter-resolution ping-pong buffers for the bloom pass. Two of them,
   * because the blur must be applied while the image is still small.
   */
  private bloomA = document.createElement('canvas');
  private bloomACtx: Ctx;
  private bloomB = document.createElement('canvas');
  private bloomBCtx: Ctx;
  /** Scratch used to translate the trail buffer when the camera pans. */
  private scratch = document.createElement('canvas');
  private scratchCtx: Ctx;

  private sprites = new Map<string, Sprite>();
  private dpr = 1;
  private spritesThisFrame = 0;
  private supportsFilter: boolean;

  /** Star positions within one wrapping tile, per parallax layer. */
  private starLayers: Array<{ pts: Float32Array; parallax: number; size: number; alpha: number }> = [];

  width = 0;
  height = 0;

  /** Total backing-store bytes held by the sprite cache. */
  private spriteBytes = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private profile: QualityProfile,
  ) {
    this.view = ctx2d(canvas);
    this.ctx = ctx2d(this.trailBuf);
    this.starCtx = ctx2d(this.starBuf);
    this.bloomACtx = ctx2d(this.bloomA);
    this.bloomBCtx = ctx2d(this.bloomB);
    this.scratchCtx = ctx2d(this.scratch);

    this.supportsFilter = typeof this.bloomACtx.filter === 'string';
    this.buildStars();
    this.resize();
  }

  /**
   * Swap quality profile. Forces a full reallocation because the pixel ratio
   * and the starfield density both change with it.
   */
  setProfile(profile: QualityProfile): void {
    this.profile = profile;
    this.buildStars();
    // Defeat the early-out in resize() so the buffers are actually rebuilt.
    this.dpr = -1;
    this.resize();
    this.camera.setZoom(this.camera.zoom);
  }

  /* ------------------------------------------------------------- viewport */

  /** Match the backing stores to the CSS size, capped at RENDER.MAX_DPR. */
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.profile.dprCap);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    if (w === this.width && h === this.height && dpr === this.dpr) return;

    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.camera.setViewport(w, h);

    for (const c of [this.canvas, this.trailBuf, this.starBuf]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    // The pan scratch buffer is another full-screen surface; leave it
    // unallocated until the camera actually moves.
    this.scratch.width = 0;
    this.scratch.height = 0;
    const bw = Math.max(1, Math.round(w * dpr * this.profile.bloomScale));
    const bh = Math.max(1, Math.round(h * dpr * this.profile.bloomScale));
    this.bloomA.width = bw;
    this.bloomA.height = bh;
    this.bloomB.width = bw;
    this.bloomB.height = bh;

    // Draw in CSS pixels; the transform handles the scale-up.
    for (const c of [this.view, this.ctx, this.starCtx]) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // The bloom buffers work in their own (already reduced) pixel space.
    this.bloomACtx.setTransform(1, 0, 0, 1, 0, 0);
    this.bloomBCtx.setTransform(1, 0, 0, 1, 0, 0);

    // Sprites are rasterised at the current DPR, so they must be rebuilt.
    this.dropSprites();
  }

  private dropSprites(): void {
    for (const s of this.sprites.values()) {
      s.canvas.width = 0;
      s.canvas.height = 0;
    }
    this.sprites.clear();
    this.spriteBytes = 0;
  }

  get centerX(): number {
    return this.camera.worldX(this.width / 2);
  }

  get centerY(): number {
    return this.camera.worldY(this.height / 2);
  }

  /** Wipe the persistence buffer immediately (used by Clear). */
  clearAll(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.view.clearRect(0, 0, this.width, this.height);
  }

  /* ------------------------------------------------------------ starfield */

  private buildStars(): void {
    const mk = (n: number, parallax: number, size: number, alpha: number) => {
      const pts = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        pts[i * 2] = Math.random() * RENDER.STAR_TILE;
        pts[i * 2 + 1] = Math.random() * RENDER.STAR_TILE;
      }
      return { pts, parallax, size, alpha };
    };
    // Three depths: the slowest layer reads as furthest away.
    const n = this.profile.starsPerLayer;
    this.starLayers = [
      mk(n, 0.12, 1.0, 0.34),
      mk(Math.round(n * 0.7), 0.26, 1.5, 0.5),
      mk(Math.round(n * 0.35), 0.45, 2.1, 0.72),
    ];
  }

  /**
   * Redraw the parallax starfield. Positions wrap on a STAR_TILE grid, so the
   * field is infinite in every direction from a few hundred stored points.
   * Only called when the camera actually moved.
   */
  private drawStars(enabled: boolean): void {
    enabled = enabled && this.profile.stars;
    const ctx = this.starCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!enabled) return;

    const tile = RENDER.STAR_TILE;
    ctx.fillStyle = '#ffffff';

    for (const layer of this.starLayers) {
      ctx.globalAlpha = layer.alpha;
      // Offset this layer by a fraction of the camera position; nearer layers
      // (higher parallax) slide further for the same camera movement.
      const ox = ((-this.camera.x * layer.parallax) % tile + tile) % tile;
      const oy = ((-this.camera.y * layer.parallax) % tile + tile) % tile;
      const cols = Math.ceil(this.width / tile) + 1;
      const rows = Math.ceil(this.height / tile) + 1;
      const s = layer.size;

      for (let gx = -1; gx < cols; gx++) {
        for (let gy = -1; gy < rows; gy++) {
          const bx = ox + gx * tile;
          const by = oy + gy * tile;
          for (let i = 0; i < layer.pts.length; i += 2) {
            const x = bx + layer.pts[i];
            const y = by + layer.pts[i + 1];
            if (x < -s || y < -s || x > this.width + s || y > this.height + s) continue;
            ctx.fillRect(x, y, s, s);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- trails */

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
   * Keep the trail buffer aligned with the world when the camera moves. A pure
   * pan is just a translation, so the buffer is blitted through a scratch
   * canvas (a canvas cannot reliably draw itself in place). Zoom changes the
   * scale of everything already drawn and cannot be fixed up, so the buffer is
   * dropped instead.
   */
  private reprojectTrails(): void {
    const cam = this.camera;
    if (!cam.moved) return;

    if (cam.zoomed) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      return;
    }

    const dx = cam.panScreenX;
    const dy = cam.panScreenY;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

    if (this.scratch.width !== this.trailBuf.width || this.scratch.height !== this.trailBuf.height) {
      this.scratch.width = this.trailBuf.width;
      this.scratch.height = this.trailBuf.height;
      this.scratchCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    this.scratchCtx.clearRect(0, 0, this.width, this.height);
    this.scratchCtx.drawImage(this.trailBuf, 0, 0, this.width, this.height);
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.drawImage(this.scratch, dx, dy, this.width, this.height);
  }

  /* --------------------------------------------------------------- sprites */

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

    // Evict by *bytes* as well as by count. A single sprite for a large merged
    // body can be several megabytes of backing store, so a count-only limit
    // would happily hold hundreds of megabytes — fine on a workstation, fatal
    // on a Chromebook.
    this.evict(0);

    const r = bucket;
    const glow = Math.min(RENDER.MAX_SPRITE_RADIUS, r * RENDER.GLOW_MULT);
    const size = Math.ceil(glow * 2) + 2;
    const half = size / 2;

    const c = document.createElement('canvas');
    c.width = Math.ceil(size * this.dpr);
    c.height = Math.ceil(size * this.dpr);
    const g = ctx2d(c);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const [cr, cg, cb] = hexToRgb(color);
    const grad = g.createRadialGradient(half, half, 0, half, half, glow);
    const core = Math.min(0.5, r / glow);
    // Only a small white-hot centre: with 'lighter' blending a wide white core
    // washes every overlapping trail out to grey.
    grad.addColorStop(0, 'rgba(255,255,255,0.72)');
    grad.addColorStop(core * 0.42, `rgba(${cr},${cg},${cb},0.98)`);
    grad.addColorStop(core, `rgba(${cr},${cg},${cb},0.6)`);
    grad.addColorStop(Math.min(0.98, core + 0.3), `rgba(${cr},${cg},${cb},0.13)`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);

    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    const bytes = c.width * c.height * 4;
    const sprite: Sprite = { canvas: c, half, bytes };
    this.sprites.set(key, sprite);
    this.spriteBytes += bytes;
    this.evict(bytes);
    return sprite;
  }

  /** Drop least-recently-used sprites until both budgets are satisfied. */
  private evict(keepBytes: number): void {
    const maxBytes = this.profile.spriteBudgetBytes;
    while (
      this.sprites.size > RENDER.SPRITE_CACHE_LIMIT ||
      (this.spriteBytes > maxBytes && this.spriteBytes > keepBytes)
    ) {
      const oldestKey = this.sprites.keys().next().value;
      if (oldestKey === undefined) break;
      const victim = this.sprites.get(oldestKey);
      if (!victim) break;
      // Never evict the sprite we are about to return.
      if (this.sprites.size === 1 && victim.bytes === keepBytes) break;
      this.sprites.delete(oldestKey);
      this.spriteBytes -= victim.bytes;
      // Release the backing store eagerly rather than waiting for GC.
      victim.canvas.width = 0;
      victim.canvas.height = 0;
    }
  }

  /** Sprite cache size in MB, for the HUD. */
  get spriteMB(): number {
    return this.spriteBytes / (1 << 20);
  }

  /* ----------------------------------------------------------------- scene */

  /** Draw one simulation frame. */
  render(bodies: Body[], state: SandboxState, sparks: Sparks): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const zoom = cam.zoom;

    if (cam.moved) {
      this.reprojectTrails();
      this.drawStars(state.stars);
      cam.clearMoved();
    }

    this.spritesThisFrame = 0;
    this.fade(state.trail);

    // Additive blending is what makes overlapping glows read as light.
    ctx.globalCompositeOperation = state.glow ? 'lighter' : 'source-over';

    this.drawStreaks(bodies, state);

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const r = Math.max(0.7, b.radius * zoom);
      const x = cam.screenX(b.x);
      const y = cam.screenY(b.y);

      // Cull off-screen bodies before touching the rasteriser.
      const pad = r * RENDER.GLOW_MULT + 4;
      if (x < -pad || y < -pad || x > this.width + pad || y > this.height + pad) continue;

      // Below the profile's threshold a glow sprite is not worth its cost, and
      // at this size a plain disc is nearly indistinguishable anyway.
      const wantGlow = state.glow && r >= this.profile.discBelow;
      const s = wantGlow ? this.sprite(b.color, r) : null;
      if (s) {
        const scale = this.profile.glowScale;
        const size = s.half * 2 * scale;
        ctx.drawImage(s.canvas, x - s.half * scale, y - s.half * scale, size, size);
      } else {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (sparks.count > 0) {
      sparks.draw(ctx, (wx) => cam.screenX(wx), (wy) => cam.screenY(wy), zoom);
    }

    ctx.globalCompositeOperation = 'source-over';

    // Black holes are drawn last and opaquely: an event horizon punched out of
    // whatever glow surrounds it, plus a thin accretion ring.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.kind !== 'blackhole') continue;
      const r = Math.max(1.5, b.radius * zoom);
      const x = cam.screenX(b.x);
      const y = cam.screenY(b.y);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#05050b';
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.09);
      ctx.strokeStyle = b.color;
      ctx.stroke();
    }

    if (state.showVectors) this.drawVectors(bodies);

    // Flatten everything onto the visible canvas. Vector overlays (aim arrow,
    // orbit ellipse, selection) are drawn straight onto it afterwards by the
    // UI, so they never smear into the persistence buffer.
    this.composite(state, this.buildBloom(state));
  }

  /**
   * Motion blur: a round-capped line from each body's previous position to its
   * current one. Without it a body travelling faster than its own diameter per
   * frame paints a dotted line into the persistence buffer instead of a track.
   * Bodies that barely moved are skipped, so in a slow dense cluster this pass
   * costs almost nothing.
   */
  private drawStreaks(bodies: Body[], state: SandboxState): void {
    if (state.paused) return;
    const ctx = this.ctx;
    const cam = this.camera;
    const zoom = cam.zoom;
    const maxStreak2 = RENDER.MAX_STREAK * RENDER.MAX_STREAK;
    ctx.lineCap = 'round';

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const dx = b.x - b.px;
      const dy = b.y - b.py;
      const d2 = dx * dx + dy * dy;
      // Too small to matter, or a merge teleporting a body to the barycentre.
      if (d2 * zoom * zoom < 1 || d2 > maxStreak2) continue;

      const x = cam.screenX(b.x);
      const y = cam.screenY(b.y);
      const r = b.radius * zoom;
      const pad = r + RENDER.MAX_STREAK * zoom;
      if (x < -pad || y < -pad || x > this.width + pad || y > this.height + pad) continue;

      ctx.strokeStyle = b.color;
      // The streak has to be at least as bright along its length as the sprite
      // core is at its endpoint, or the trail reads as beads on a faint thread
      // rather than one continuous track.
      ctx.lineWidth = Math.max(2, r * 2);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(cam.screenX(b.px), cam.screenY(b.py));
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawVectors(bodies: Body[]): void {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      ctx.moveTo(cam.screenX(b.x), cam.screenY(b.y));
      ctx.lineTo(cam.screenX(b.x + b.vx * 6), cam.screenY(b.y + b.vy * 6));
    }
    ctx.stroke();
  }

  /* ----------------------------------------------------------------- bloom */

  /**
   * Downscale the scene, blur it, and draw it back at full size on the bloom
   * layer. That layer is composited by the browser with `mix-blend-mode:
   * screen`, so the additive step costs nothing on the JS side. Working at
   * quarter resolution makes the blur 16x cheaper and, since the result is
   * blurred anyway, costs no visible detail.
   */
  /**
   * Build the bloom image: downsample the trail buffer, blur it while it is
   * still small, and leave the result in a buffer ready to be stretched over
   * the viewport. Blurring at full resolution instead would cost ~16x more for
   * an identical-looking result, since the source has already lost that detail.
   * Returns the buffer to composite, or null when bloom is off.
   */
  private buildBloom(state: SandboxState): HTMLCanvasElement | null {
    if (state.bloom <= 0.001 || !this.profile.bloom) return null;

    const bw = this.bloomA.width;
    const bh = this.bloomA.height;
    const a = this.bloomACtx;
    const b = this.bloomBCtx;

    // 1. Downsample the scene.
    a.clearRect(0, 0, bw, bh);
    a.drawImage(this.trailBuf, 0, 0, bw, bh);

    /*
     * 2. Threshold, so only genuinely bright things bloom. In this buffer
     *    brightness lives mostly in the alpha channel — fading a trail lowers
     *    its alpha and leaves its colour alone — so the threshold has to act on
     *    alpha. 'destination-in' multiplies destination alpha by source alpha,
     *    squaring it: a core at 1.0 survives untouched while a faint trail at
     *    0.08 collapses to 0.006.
     *
     *    'multiply' is the tempting operator here and is wrong: it squares the
     *    colour channels but *unions* alpha, so it brightens faint residue
     *    instead of removing it. Without a correct threshold the bloom is a
     *    flat haze that amplifies the persistence buffer's 8-bit residue into
     *    visible scratchy texture.
     */
    b.clearRect(0, 0, bw, bh);
    b.drawImage(this.bloomA, 0, 0);
    b.globalCompositeOperation = 'destination-in';
    b.drawImage(this.bloomA, 0, 0);
    b.globalCompositeOperation = 'source-over';

    if (!this.supportsFilter) return this.bloomB;

    // 3. Blur while it is still small. Blurring at full resolution instead
    //    would cost ~16x more for an identical-looking result, since the
    //    source has already lost that detail.
    a.clearRect(0, 0, bw, bh);
    a.filter = `blur(${this.profile.bloomBlur}px)`;
    a.drawImage(this.bloomB, 0, 0);
    a.filter = 'none';
    return this.bloomA;
  }

  /**
   * Flatten the offscreen buffers onto the visible canvas: starfield, then the
   * scene, then bloom added on top. `lighter` here is the same additive blend a
   * CSS `screen` layer would give, but stays inside one canvas so the browser
   * only has a single layer to composite.
   */
  private composite(state: SandboxState, bloom: HTMLCanvasElement | null): void {
    const v = this.view;
    const stars = state.stars && this.profile.stars;

    // 'copy' replaces the destination outright, folding the clear into the
    // first blit. On integrated graphics every full-screen pass saved is worth
    // having: at the low tier this frame is two passes instead of four.
    v.globalCompositeOperation = 'copy';
    v.drawImage(stars ? this.starBuf : this.trailBuf, 0, 0, this.width, this.height);
    v.globalCompositeOperation = 'source-over';

    if (stars) v.drawImage(this.trailBuf, 0, 0, this.width, this.height);

    if (bloom) {
      v.globalCompositeOperation = 'lighter';
      v.globalAlpha = Math.min(1, state.bloom * 1.6);
      v.drawImage(bloom, 0, 0, this.width, this.height);
      v.globalAlpha = 1;
      v.globalCompositeOperation = 'source-over';
    }
  }

  /* --------------------------------------------------------------- overlay */

  /** Slingshot preview: ghost body, aim line and a launch arrow. */
  drawAim(from: Vec2, to: Vec2, radius: number, color: string): void {
    const ctx = this.view;
    const cam = this.camera;
    const fx = cam.screenX(from.x);
    const fy = cam.screenY(from.y);
    const tx = cam.screenX(to.x);
    const ty = cam.screenY(to.y);

    const dx = tx - fx;
    const dy = ty - fy;
    const len = Math.hypot(dx, dy);
    const r = Math.max(1.5, radius * cam.zoom);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.globalAlpha = 0.55;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ghost of the body about to be spawned.
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.arc(fx, fy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(fx, fy, r, 0, Math.PI * 2);
    ctx.stroke();

    if (len > 12) {
      const ux = dx / len;
      const uy = dy / len;
      const head = Math.min(14, len * 0.3);
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - ux * head - uy * head * 0.45, ty - uy * head + ux * head * 0.45);
      ctx.lineTo(tx - ux * head + uy * head * 0.45, ty - uy * head - ux * head * 0.45);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** The forward-integrated path of a body about to be launched. */
  drawPath(points: Float32Array, count: number, color: string): void {
    if (count < 2) return;
    const ctx = this.view;
    const cam = this.camera;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(cam.screenX(points[0]), cam.screenY(points[1]));
    for (let i = 1; i < count; i++) {
      ctx.lineTo(cam.screenX(points[i * 2]), cam.screenY(points[i * 2 + 1]));
    }
    ctx.stroke();

    // Fade the tail so the near future reads as more certain than the far.
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.restore();
  }

  /** Selection ring plus a marker on the body it is orbiting. */
  drawSelection(body: Body, elements: OrbitElements | null): void {
    const ctx = this.view;
    const cam = this.camera;
    const x = cam.screenX(body.x);
    const y = cam.screenY(body.y);
    const r = Math.max(6, body.radius * cam.zoom + 6);

    ctx.save();
    ctx.strokeStyle = COLORS.select;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (elements) {
      const px = cam.screenX(elements.primary.x);
      const py = cam.screenY(elements.primary.y);
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(px, py);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The osculating Kepler ellipse: the closed orbit the body would follow if
   * only it and its primary existed. The primary sits at a *focus*, so the
   * ellipse centre is offset from it by a*e along the anti-periapsis direction.
   */
  drawOrbit(elements: OrbitElements): void {
    if (!elements.bound || elements.e >= 1) return;
    const ctx = this.view;
    const cam = this.camera;

    const a = elements.a * cam.zoom;
    const b = a * Math.sqrt(Math.max(0, 1 - elements.e * elements.e));
    if (!isFinite(a) || a <= 0 || a > 60000) return;

    const c = a * elements.e;
    const px = cam.screenX(elements.primary.x);
    const py = cam.screenY(elements.primary.y);
    // Centre lies opposite periapsis from the focus.
    const cxp = px - Math.cos(elements.argP) * c;
    const cyp = py - Math.sin(elements.argP) * c;

    ctx.save();
    ctx.strokeStyle = COLORS.orbit;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.ellipse(cxp, cyp, a, b, elements.argP, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Periapsis and apoapsis markers.
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = COLORS.orbit;
    const peri = elements.periapsis * cam.zoom;
    const apo = elements.apoapsis * cam.zoom;
    dot(ctx, px + Math.cos(elements.argP) * peri, py + Math.sin(elements.argP) * peri, 2.5);
    dot(ctx, px - Math.cos(elements.argP) * apo, py - Math.sin(elements.argP) * apo, 2.5);
    ctx.restore();
  }

  /** Small cross at the system barycentre. */
  drawBarycentre(wx: number, wy: number): void {
    const ctx = this.view;
    const x = this.camera.screenX(wx);
    const y = this.camera.screenY(wy);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + 5, y);
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y + 5);
    ctx.stroke();
    ctx.restore();
  }

  /** A scale bar, so zoom level is legible. */
  drawScaleBar(): void {
    const ctx = this.view;
    const zoom = this.camera.zoom;
    // Pick a round world distance that lands near 120 screen px.
    const target = 120 / zoom;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const mult = [1, 2, 5, 10].find((m) => pow * m >= target) ?? 10;
    const world = pow * mult;
    const px = world * zoom;

    const x = this.width - px - 22;
    const y = this.height - 24;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${world.toLocaleString()} u`, x + px, y - 8);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ helpers */

function ctx2d(canvas: HTMLCanvasElement): Ctx {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

function dot(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
