/**
 * renderer.ts — perspective rendering onto a single 2D canvas.
 *
 * There is no WebGL here, deliberately. The bodies are emissive — stars, glowing
 * debris, accretion light — so the right primitive for them is a camera-facing
 * sprite, which is what a GPU renderer would end up drawing anyway. Staying on
 * the 2D context keeps the whole tuned pipeline intact: the persistence-buffer
 * trails, the cached glow sprites, the thresholded bloom and the quality tiers
 * that make this run on weak integrated graphics.
 *
 * What makes it read as three-dimensional:
 *
 *  - a real perspective divide, so size and spacing fall off with distance;
 *  - painter's-algorithm depth sorting, so near bodies occlude far ones;
 *  - shaded sphere sprites for anything big enough to show a lit limb, with the
 *    light coming from the nearest star rather than a fixed screen direction;
 *  - depth cueing, dimming distant bodies the way haze does;
 *  - a reference grid on the z = 0 plane and a starfield fixed to the sky, both
 *    of which give the eye something to judge camera motion against.
 *
 * Buffers, cheapest first:
 *
 *   backBuf   starfield and reference grid, redrawn only when the camera moves
 *   trailBuf  the persistence buffer: trails, glows, bodies, debris
 *   bloomA/B  quarter-resolution downsample and blur of trailBuf
 *
 * All three are flattened into the one visible canvas each frame with
 * `globalCompositeOperation`. Using stacked <canvas> elements and a CSS blend
 * mode measured far more expensive: every extra composited layer costs real
 * time and a blend mode forces the compositor to read the backdrop back.
 */

import { COLORS, RENDER, type SandboxState } from './config';
import type { Camera, Projected } from './camera';
import type { QualityProfile } from './quality';
import { hexToRgb, type Body, type Vec3 } from './physics';
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

/**
 * A body's recent path, kept in *world* space as a ring buffer.
 *
 * The previous version painted trails into a persistence buffer and faded it
 * each frame, which is cheap but only valid while the world-to-screen mapping
 * holds still. Under a perspective camera any orbit or dolly invalidates every
 * pixel already drawn, so the buffer had to be thrown away — which is what made
 * dragging flash and the picture jump. Storing the path as geometry and
 * re-projecting it each frame costs more, but it is correct under any camera
 * motion: the trails simply swing round with everything else.
 */
interface Trail {
  /** x, y, z interleaved. */
  pts: Float32Array;
  count: number;
  /** Next write slot. */
  head: number;
  /** Frame this trail was last touched, so dead bodies can be pruned. */
  seen: number;
}

/** Per-body scratch, reused every frame so the draw loop never allocates. */
interface Item {
  body: Body;
  sx: number;
  sy: number;
  /** Screen radius in CSS px. */
  r: number;
  depth: number;
  /** Screen-space light direction, for sphere shading. */
  lx: number;
  ly: number;
  /** Depth-cue alpha. */
  dim: number;
}

export class Renderer {
  private view: Ctx;

  private trailBuf = document.createElement('canvas');
  private ctx: Ctx;
  private backBuf = document.createElement('canvas');
  private backCtx: Ctx;
  private bloomA = document.createElement('canvas');
  private bloomACtx: Ctx;
  private bloomB = document.createElement('canvas');
  private bloomBCtx: Ctx;

  private sprites = new Map<string, Sprite>();
  private spriteBytes = 0;
  private dpr = 1;
  private spritesThisFrame = 0;
  private supportsFilter: boolean;

  /** Star directions on the unit sphere (x, y, z interleaved), per layer. */
  private starLayers: Array<{ dirs: Float32Array; size: number; alpha: number }> = [];

  private trails = new Map<number, Trail>();
  /** Screen-space scratch for one trail: x, y, visible-flag interleaved. */
  private trailScreen = new Float32Array(RENDER.TRAIL_CAPACITY * 3);
  private frameNo = 0;
  /**
   * Set whenever the backdrop buffer's contents are no longer valid — a resize
   * or a quality change reallocates it, which clears it. Without this the
   * starfield and grid stay blank until the camera happens to move.
   */
  private backdropDirty = true;

  /** Reusable projection scratch, so the draw loop never allocates. */
  private pr: Projected = { x: 0, y: 0, depth: 0, scale: 0, visible: false };
  private starScratch: Projected = { x: 0, y: 0, depth: 0, scale: 0, visible: false };
  private items: Item[] = [];
  private order: number[] = [];

  width = 0;
  height = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private profile: QualityProfile,
  ) {
    this.view = ctx2d(canvas);
    this.ctx = ctx2d(this.trailBuf);
    this.backCtx = ctx2d(this.backBuf);
    this.bloomACtx = ctx2d(this.bloomA);
    this.bloomBCtx = ctx2d(this.bloomB);

    this.supportsFilter = typeof this.bloomACtx.filter === 'string';
    this.buildStars();
    this.resize();
  }

  setProfile(profile: QualityProfile): void {
    this.profile = profile;
    this.dpr = -1; // defeat the early-out so buffers are rebuilt
    this.resize();
    this.backdropDirty = true;
  }

  /* ------------------------------------------------------------- viewport */

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

    for (const c of [this.canvas, this.trailBuf, this.backBuf]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const bw = Math.max(1, Math.round(w * dpr * this.profile.bloomScale));
    const bh = Math.max(1, Math.round(h * dpr * this.profile.bloomScale));
    this.bloomA.width = bw;
    this.bloomA.height = bh;
    this.bloomB.width = bw;
    this.bloomB.height = bh;

    for (const c of [this.view, this.ctx, this.backCtx]) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.bloomACtx.setTransform(1, 0, 0, 1, 0, 0);
    this.bloomBCtx.setTransform(1, 0, 0, 1, 0, 0);

    this.dropSprites();
    this.backdropDirty = true;
  }

  private dropSprites(): void {
    for (const s of this.sprites.values()) {
      s.canvas.width = 0;
      s.canvas.height = 0;
    }
    this.sprites.clear();
    this.spriteBytes = 0;
  }

  /** World point at the centre of the view — where new things are spawned. */
  get centerX(): number {
    return this.camera.target.x;
  }
  get centerY(): number {
    return this.camera.target.y;
  }
  get centerZ(): number {
    return this.camera.target.z;
  }

  /** Force the starfield and grid to be redrawn on the next frame. */
  invalidateBackdrop(): void {
    this.backdropDirty = true;
  }

  clearAll(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.view.clearRect(0, 0, this.width, this.height);
    this.trails.clear();
  }

  get spriteMB(): number {
    return this.spriteBytes / (1 << 20);
  }

  /* ------------------------------------------------------------ backdrop */

  /**
   * Generate the starfield once, from a fixed seed.
   *
   * Two things follow from that. The sky is identical on every load and every
   * quality tier, so it never changes identity underneath you; and lowering the
   * tier draws a *prefix* of the same list rather than a fresh random set, so
   * stars only ever appear or disappear, never jump to new places.
   */
  private buildStars(): void {
    if (this.starLayers.length > 0) return; // already generated; never re-roll

    const rand = mulberry32(0x5eed1e);
    const mk = (n: number, size: number, alpha: number) => {
      const dirs = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        // Uniform on the sphere: z uniform in [-1,1], angle uniform in [0,2π).
        const z = rand() * 2 - 1;
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(1 - z * z);
        dirs[i * 3] = Math.cos(a) * r;
        dirs[i * 3 + 1] = Math.sin(a) * r;
        dirs[i * 3 + 2] = z;
      }
      return { dirs, size, alpha };
    };
    // Built at the largest tier's budget; smaller tiers draw fewer of these.
    const n = RENDER.STARS_PER_LAYER;
    this.starLayers = [
      mk(n * 3, 1.0, 0.3),
      mk(Math.round(n * 1.6), 1.4, 0.42),
      mk(Math.round(n * 0.6), 2.0, 0.6),
    ];
  }

  /**
   * Starfield and reference grid. Stars are fixed directions on the sky, so
   * they respond to camera *rotation* but not position — which is exactly how
   * an infinitely distant background behaves, and gives the eye a stable frame
   * to judge the tumble against. The grid marks the z = 0 plane, so there is
   * something for depth to be measured against when the camera tilts.
   */
  private drawBackdrop(state: SandboxState): void {
    const ctx = this.backCtx;
    const cam = this.camera;
    ctx.clearRect(0, 0, this.width, this.height);

    if (state.stars && this.profile.stars) {
      const p = this.pr;
      const eye = cam.eyePos;
      ctx.fillStyle = '#ffffff';
      for (const layer of this.starLayers) {
        ctx.globalAlpha = layer.alpha;
        const s = layer.size;
        const d = layer.dirs;
        // Draw a prefix scaled to the tier, so the pattern is a subset of the
        // same sky rather than a different one.
        const share = this.profile.starsPerLayer / RENDER.STARS_PER_LAYER;
        const limit = Math.min(d.length, Math.round((d.length / 3) * share) * 3);
        for (let i = 0; i < limit; i += 3) {
          // Project a point very far away in this direction.
          const FAR = 1e6;
          cam.project(eye.x + d[i] * FAR, eye.y + d[i + 1] * FAR, eye.z + d[i + 2] * FAR, p);
          if (!p.visible) continue;
          if (p.x < 0 || p.y < 0 || p.x > this.width || p.y > this.height) continue;
          ctx.fillRect(p.x, p.y, s, s);
        }
      }
      ctx.globalAlpha = 1;
    }

    if (state.grid && this.profile.stars) this.drawGrid();
  }

  /** Concentric rings and spokes on the reference plane. */
  private drawGrid(): void {
    const ctx = this.backCtx;
    const cam = this.camera;
    const p = this.pr;

    // Ring spacing follows the camera distance, so the grid stays informative
    // at every zoom instead of turning into either one ring or a solid mat.
    const step = Math.pow(10, Math.round(Math.log10(cam.distance / 5)));
    const rings = 6;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;

    const SEG = 72;
    for (let k = 1; k <= rings; k++) {
      const r = step * k;
      ctx.globalAlpha = 0.11 * (1 - (k - 1) / rings);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        cam.project(Math.cos(a) * r, Math.sin(a) * r, 0, p);
        if (!p.visible) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
      ctx.stroke();
    }

    ctx.globalAlpha = 0.06;
    ctx.beginPath();
    const outer = step * rings;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      cam.project(0, 0, 0, p);
      if (!p.visible) continue;
      ctx.moveTo(p.x, p.y);
      cam.project(Math.cos(a) * outer, Math.sin(a) * outer, 0, p);
      if (!p.visible) continue;
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- trails */

  /** Append the current position of every body to its trail. */
  private sampleTrails(bodies: Body[]): void {
    const cap = RENDER.TRAIL_CAPACITY;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      let t = this.trails.get(b.id);
      if (!t) {
        t = { pts: new Float32Array(cap * 3), count: 0, head: 0, seen: this.frameNo };
        this.trails.set(b.id, t);
      }
      const h = t.head;
      t.pts[h * 3] = b.x;
      t.pts[h * 3 + 1] = b.y;
      t.pts[h * 3 + 2] = b.z;
      t.head = (h + 1) % cap;
      if (t.count < cap) t.count++;
      t.seen = this.frameNo;
    }
  }

  /** Forget trails belonging to bodies that no longer exist. */
  private pruneTrails(): void {
    for (const [id, t] of this.trails) {
      if (this.frameNo - t.seen > RENDER.TRAIL_SAMPLE * 4) this.trails.delete(id);
    }
  }

  /**
   * Draw each visible body's path, oldest to newest.
   *
   * The fade is done in two passes rather than per-segment: stroking every
   * segment separately so each could carry its own alpha would mean thousands
   * of one-line paths per frame. Instead the whole path is stroked faintly and
   * the recent third again more brightly, which reads as a fade for two strokes
   * per body.
   */
  private drawTrails(items: Item[], order: number[], state: SandboxState): void {
    const want = Math.round(state.trail * this.profile.trailPoints);
    if (want < 2) return;

    const ctx = this.ctx;
    const cam = this.camera;
    const p = this.pr;
    const cap = RENDER.TRAIL_CAPACITY;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let k = 0; k < order.length; k++) {
      const it = items[order[k]];
      const t = this.trails.get(it.body.id);
      if (!t || t.count < 2) continue;

      const n = Math.min(want, t.count);
      const recent = Math.max(2, Math.round(n * 0.34));

      ctx.strokeStyle = it.body.color;
      // Tapered to the body's own size, with a floor so distant trails survive.
      const w = Math.max(1.2, Math.min(7, it.r * 1.25));

      /*
       * Project once into a scratch buffer, then stroke it twice. Both fade
       * passes walk the same points, so re-projecting per pass would double the
       * per-point cost for nothing.
       */
      const scr = this.trailScreen;
      let m = 0;
      for (let i = n; i >= 1; i--) {
        // Walk backwards from the newest sample.
        const idx = (t.head - i + cap * 2) % cap;
        cam.project(t.pts[idx * 3], t.pts[idx * 3 + 1], t.pts[idx * 3 + 2], p);
        scr[m * 3] = p.x;
        scr[m * 3 + 1] = p.y;
        // A break marker, so a point behind the camera splits the polyline
        // rather than drawing a stray chord across the screen.
        scr[m * 3 + 2] = p.visible ? 1 : 0;
        m++;
      }

      for (let pass = 0; pass < 2; pass++) {
        const start = pass === 0 ? 0 : m - recent;
        ctx.globalAlpha = (pass === 0 ? 0.3 : 0.72) * it.dim;
        ctx.lineWidth = pass === 0 ? w * 0.75 : w;
        ctx.beginPath();
        let started = false;
        for (let i = Math.max(0, start); i < m; i++) {
          if (scr[i * 3 + 2] === 0) {
            started = false;
            continue;
          }
          if (!started) {
            ctx.moveTo(scr[i * 3], scr[i * 3 + 1]);
            started = true;
          } else {
            ctx.lineTo(scr[i * 3], scr[i * 3 + 1]);
          }
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* --------------------------------------------------------------- sprites */

  /**
   * Pre-rendered sprite, or null when this frame's rasterisation budget is
   * spent. `light` is a quantised screen-space light direction: -1 asks for a
   * plain emissive glow, 0..7 for a sphere lit from that octant.
   *
   * The cache is bounded three ways — bucketed radii, quantised colours, and
   * LRU eviction on *bytes* as well as count, because one sprite for a large
   * body can be several megabytes of backing store.
   */
  private sprite(color: string, radius: number, light: number): Sprite | null {
    const bucket = radius < 8 ? Math.max(1, Math.round(radius)) : Math.round(radius / 4) * 4;
    const key = `${quantizeColor(color)}|${bucket}|${light}`;

    const hit = this.sprites.get(key);
    if (hit) {
      this.sprites.delete(key);
      this.sprites.set(key, hit);
      return hit;
    }
    if (this.spritesThisFrame >= RENDER.SPRITE_BUDGET) return null;
    this.spritesThisFrame++;
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

    if (light >= 0) {
      // Lit sphere: a soft halo, then a disc whose bright side faces the light.
      const halo = g.createRadialGradient(half, half, r * 0.9, half, half, glow);
      halo.addColorStop(0, `rgba(${cr},${cg},${cb},0.18)`);
      halo.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = halo;
      g.fillRect(0, 0, size, size);

      const a = (light / 8) * Math.PI * 2;
      const lx = Math.cos(a);
      const ly = Math.sin(a);
      /*
       * Sphere shading. The gradient runs from a highlight offset toward the
       * light out to a circle that is concentric with the disc and exactly its
       * radius, so t = 1 falls on the limb and the terminator lands inside the
       * body where it belongs.
       *
       * An outer circle much larger than the disc — the obvious first try —
       * makes the falloff so gentle that the lit and dark sides differ by only
       * a few percent, and the result reads as a flat glowing coin.
       */
      const hx = half + lx * r * 0.55;
      const hy = half + ly * r * 0.55;
      const lit = g.createRadialGradient(hx, hy, r * 0.03, half, half, r);
      lit.addColorStop(0, `rgb(${mixTo(cr, 255, 0.72)},${mixTo(cg, 255, 0.72)},${mixTo(cb, 255, 0.72)})`);
      lit.addColorStop(0.28, `rgb(${cr},${cg},${cb})`);
      lit.addColorStop(0.62, `rgb(${mixTo(cr, 0, 0.5)},${mixTo(cg, 0, 0.5)},${mixTo(cb, 0, 0.5)})`);
      lit.addColorStop(0.86, `rgb(${mixTo(cr, 0, 0.82)},${mixTo(cg, 0, 0.82)},${mixTo(cb, 0, 0.82)})`);
      lit.addColorStop(1, `rgb(${mixTo(cr, 0, 0.9)},${mixTo(cg, 0, 0.9)},${mixTo(cb, 0, 0.9)})`);
      g.fillStyle = lit;
      g.beginPath();
      g.arc(half, half, r, 0, Math.PI * 2);
      g.fill();
    } else {
      const grad = g.createRadialGradient(half, half, 0, half, half, glow);
      const core = Math.min(0.5, r / glow);
      // Deliberately restrained: these are drawn additively, so overlapping
      // glows stack. A hot white core and a strong halo make a busy scene
      // saturate to white and lose all its colour.
      grad.addColorStop(0, 'rgba(255,255,255,0.42)');
      grad.addColorStop(core * 0.42, `rgba(${cr},${cg},${cb},0.72)`);
      grad.addColorStop(core, `rgba(${cr},${cg},${cb},0.34)`);
      grad.addColorStop(Math.min(0.98, core + 0.3), `rgba(${cr},${cg},${cb},0.07)`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
    }

    const bytes = c.width * c.height * 4;
    const sprite: Sprite = { canvas: c, half, bytes };
    this.sprites.set(key, sprite);
    this.spriteBytes += bytes;
    this.evict(bytes);
    return sprite;
  }

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
      if (this.sprites.size === 1 && victim.bytes === keepBytes) break;
      this.sprites.delete(oldestKey);
      this.spriteBytes -= victim.bytes;
      victim.canvas.width = 0;
      victim.canvas.height = 0;
    }
  }

  /* ----------------------------------------------------------------- scene */

  render(bodies: Body[], state: SandboxState, sparks: Sparks): void {
    const ctx = this.ctx;
    const cam = this.camera;

    if (cam.moved || this.backdropDirty) {
      this.drawBackdrop(state);
      this.backdropDirty = false;
      cam.clearMoved();
    }

    this.spritesThisFrame = 0;
    this.frameNo++;
    // Trails are geometry now, so the scene buffer is simply cleared each
    // frame. Nothing survives between frames that a camera move could
    // invalidate, which is what removes the flashing while dragging.
    ctx.clearRect(0, 0, this.width, this.height);
    if (!state.paused && this.frameNo % RENDER.TRAIL_SAMPLE === 0) this.sampleTrails(bodies);
    if (this.frameNo % 120 === 0) this.pruneTrails();

    // --- project, depth-cue and sort ---
    const items = this.items;
    const order = this.order;
    items.length = 0;
    order.length = 0;

    const p = this.pr;
    const star = brightestStar(bodies);
    const far = cam.distance * RENDER.DEPTH_FADE_SPAN;

    // Project the light source once, outside the per-body loop.
    const starPos = this.starScratch;
    let starOnScreen = false;
    if (star) {
      cam.project(star.x, star.y, star.z, starPos);
      starOnScreen = starPos.visible;
    }

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      cam.project(b.x, b.y, b.z, p);
      if (!p.visible) continue;

      const r = b.radius * p.scale;
      const pad = r * RENDER.GLOW_MULT + 4;
      if (p.x < -pad || p.y < -pad || p.x > this.width + pad || p.y > this.height + pad) continue;

      // Depth cue: things far behind the focus dim, the way haze works.
      const dim = Math.max(0.25, Math.min(1, 1 - (p.depth - cam.distance) / far));

      let lx = 0;
      let ly = 0;
      if (starOnScreen && star !== b) {
        // Light direction in screen space: from the body toward the star. The
        // star's own projection is computed once per frame, not once per body.
        lx = starPos.x - p.x;
        ly = starPos.y - p.y;
        const l = Math.hypot(lx, ly);
        if (l > 1e-6) {
          lx /= l;
          ly /= l;
        }
      }

      items.push({ body: b, sx: p.x, sy: p.y, r: Math.max(0.6, r), depth: p.depth, lx, ly, dim });
      order.push(items.length - 1);
    }

    // Painter's algorithm: far to near, so near bodies occlude far ones.
    order.sort((a, c) => items[c].depth - items[a].depth);

    ctx.globalCompositeOperation = state.glow ? 'lighter' : 'source-over';
    this.drawTrails(items, order, state);

    for (let k = 0; k < order.length; k++) {
      const it = items[order[k]];
      const b = it.body;
      if (b.kind === 'blackhole') continue; // drawn opaquely, after the bloom

      // Big, non-emissive bodies get a lit sphere; everything else is a glow.
      // Below a few pixels a shaded limb is invisible anyway and a plain glow
      // is both cheaper and a better match for a distant point of light.
      const wantSphere =
        state.shading && b.kind !== 'star' && it.r >= RENDER.SPHERE_MIN_RADIUS;

      if (wantSphere) {
        const octant = ((Math.round((Math.atan2(it.ly, it.lx) / (Math.PI * 2)) * 8) % 8) + 8) % 8;
        // Spheres are lit, not emissive: they must not add to what is behind.
        ctx.globalCompositeOperation = 'source-over';
        const s = this.sprite(b.color, it.r, octant);
        ctx.globalAlpha = it.dim;
        if (s) {
          const size = s.half * 2;
          ctx.drawImage(s.canvas, it.sx - s.half, it.sy - s.half, size, size);
        } else {
          ctx.fillStyle = b.color;
          ctx.beginPath();
          ctx.arc(it.sx, it.sy, it.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = state.glow ? 'lighter' : 'source-over';
        continue;
      }

      const s = state.glow && it.r >= this.profile.discBelow ? this.sprite(b.color, it.r, -1) : null;
      ctx.globalAlpha = it.dim;
      if (s) {
        const scale = this.profile.glowScale;
        const size = s.half * 2 * scale;
        ctx.drawImage(s.canvas, it.sx - s.half * scale, it.sy - s.half * scale, size, size);
      } else {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(it.sx, it.sy, it.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    if (sparks.count > 0) sparks.draw(ctx, cam);

    ctx.globalCompositeOperation = 'source-over';
    if (state.showVectors) this.drawVectors(items);

    this.composite(state, this.buildBloom(state));

    // Event horizons go on *after* the bloom composite. Drawn into the trail
    // buffer instead they get washed out: a black hole that has been eating
    // leaves the surrounding pixels saturated and the blurred bloom bleeds
    // straight over the disc.
    this.drawHorizons(items, order);
  }

  private drawHorizons(items: Item[], order: number[]): void {
    const ctx = this.view;
    for (let k = 0; k < order.length; k++) {
      const it = items[order[k]];
      if (it.body.kind !== 'blackhole') continue;
      const r = Math.max(1.5, it.r);
      ctx.beginPath();
      ctx.arc(it.sx, it.sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#05050b';
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.09);
      ctx.strokeStyle = it.body.color;
      ctx.stroke();
    }
  }

  private drawVectors(items: Item[]): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const p = this.pr;
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const it of items) {
      const b = it.body;
      cam.project(b.x + b.vx * 6, b.y + b.vy * 6, b.z + b.vz * 6, p);
      if (!p.visible) continue;
      ctx.moveTo(it.sx, it.sy);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  /* ----------------------------------------------------------------- bloom */

  private buildBloom(state: SandboxState): HTMLCanvasElement | null {
    if (state.bloom <= 0.001 || !this.profile.bloom) return null;

    const bw = this.bloomA.width;
    const bh = this.bloomA.height;
    const a = this.bloomACtx;
    const b = this.bloomBCtx;

    a.clearRect(0, 0, bw, bh);
    a.drawImage(this.trailBuf, 0, 0, bw, bh);

    /*
     * Threshold, so only genuinely bright things bloom. In this buffer
     * brightness lives mostly in the alpha channel — fading a trail lowers its
     * alpha and leaves its colour alone — so the threshold has to act on alpha.
     * 'destination-in' multiplies destination alpha by source alpha, squaring
     * it. 'multiply' is the tempting operator and is wrong: it squares colour
     * but *unions* alpha, brightening faint residue instead of removing it.
     */
    b.clearRect(0, 0, bw, bh);
    b.drawImage(this.bloomA, 0, 0);
    b.globalCompositeOperation = 'destination-in';
    b.drawImage(this.bloomA, 0, 0);
    b.globalCompositeOperation = 'source-over';

    if (!this.supportsFilter) return this.bloomB;

    a.clearRect(0, 0, bw, bh);
    a.filter = `blur(${this.profile.bloomBlur}px)`;
    a.drawImage(this.bloomB, 0, 0);
    a.filter = 'none';
    return this.bloomA;
  }

  private composite(state: SandboxState, bloom: HTMLCanvasElement | null): void {
    const v = this.view;
    const back = (state.stars && this.profile.stars) || state.grid;

    // 'copy' replaces the destination outright, folding the clear into the
    // first blit. On integrated graphics every full-screen pass saved counts.
    v.globalCompositeOperation = 'copy';
    v.drawImage(back ? this.backBuf : this.trailBuf, 0, 0, this.width, this.height);
    v.globalCompositeOperation = 'source-over';
    if (back) v.drawImage(this.trailBuf, 0, 0, this.width, this.height);

    if (bloom) {
      v.globalCompositeOperation = 'lighter';
      v.globalAlpha = Math.min(1, state.bloom);
      v.drawImage(bloom, 0, 0, this.width, this.height);
      v.globalAlpha = 1;
      v.globalCompositeOperation = 'source-over';
    }
  }

  /* --------------------------------------------------------------- overlay */

  /** Project a world point for the UI layer. */
  projectPoint(x: number, y: number, z: number): Projected {
    return this.camera.project(x, y, z, { x: 0, y: 0, depth: 0, scale: 0, visible: false });
  }

  /** Slingshot preview: ghost body, aim line and a launch arrow. */
  drawAim(from: Vec3, to: Vec3, radius: number, color: string): void {
    const ctx = this.view;
    const f = this.projectPoint(from.x, from.y, from.z);
    const t = this.projectPoint(to.x, to.y, to.z);
    if (!f.visible || !t.visible) return;

    const dx = t.x - f.x;
    const dy = t.y - f.y;
    const len = Math.hypot(dx, dy);
    const r = Math.max(1.5, radius * f.scale);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.globalAlpha = 0.55;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
    ctx.stroke();

    if (len > 12) {
      const ux = dx / len;
      const uy = dy / len;
      const head = Math.min(14, len * 0.3);
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x - ux * head - uy * head * 0.45, t.y - uy * head + ux * head * 0.45);
      ctx.lineTo(t.x - ux * head + uy * head * 0.45, t.y - uy * head - ux * head * 0.45);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * A world-space polyline (x, y, z interleaved), broken wherever it passes
   * behind the camera so a clipped point never draws a stray chord.
   */
  private strokePath3(pts: Float32Array, count: number): void {
    const ctx = this.view;
    const p = this.pr;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < count; i++) {
      this.camera.project(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], p);
      if (!p.visible) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
  }

  drawPath(points: Float32Array, count: number, color: string): void {
    if (count < 2) return;
    const ctx = this.view;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.75;
    this.strokePath3(points, count);
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 3.5;
    this.strokePath3(points, count);
    ctx.restore();
  }

  drawSelection(body: Body, elements: OrbitElements | null): void {
    const ctx = this.view;
    const b = this.projectPoint(body.x, body.y, body.z);
    if (!b.visible) return;
    const r = Math.max(6, body.radius * b.scale + 6);

    ctx.save();
    ctx.strokeStyle = COLORS.select;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (elements) {
      const pp = this.projectPoint(elements.primary.x, elements.primary.y, elements.primary.z);
      if (pp.visible) {
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(pp.x, pp.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Scratch for the swept orbit ellipse, so drawing it never allocates. */
  private orbitPts = new Float32Array(RENDER.ORBIT_SEGMENTS * 3 + 3);

  /**
   * The osculating Kepler ellipse, swept in three dimensions.
   *
   * Rather than rotating angles into place, the curve is generated directly in
   * the orbit's own basis: with the primary at a focus,
   *
   *     r(θ) = centre + a·cos(θ)·û + b·sin(θ)·v̂
   *
   * where û points at periapsis, v̂ = ŵ × û completes the plane, and the centre
   * sits a·e back along −û from the focus. Because û and v̂ come straight out
   * of the element solve, the drawn curve is exactly the orbit the numbers
   * describe — including its inclination.
   */
  drawOrbit(el: OrbitElements): void {
    if (!el.bound || el.e >= 1) return;
    const a = el.a;
    const b = a * Math.sqrt(Math.max(0, 1 - el.e * el.e));
    if (!isFinite(a) || a <= 0 || a > 5e5) return;

    const c = a * el.e;
    const cx = el.primary.x - el.u.x * c;
    const cy = el.primary.y - el.u.y * c;
    const cz = el.primary.z - el.u.z * c;

    const N = RENDER.ORBIT_SEGMENTS;
    const pts = this.orbitPts;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2;
      const ca = Math.cos(th) * a;
      const sb = Math.sin(th) * b;
      pts[i * 3] = cx + el.u.x * ca + el.v.x * sb;
      pts[i * 3 + 1] = cy + el.u.y * ca + el.v.y * sb;
      pts[i * 3 + 2] = cz + el.u.z * ca + el.v.z * sb;
    }

    const ctx = this.view;
    ctx.save();
    ctx.strokeStyle = COLORS.orbit;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.1;
    ctx.setLineDash([6, 6]);
    this.strokePath3(pts, N + 1);
    ctx.setLineDash([]);

    // Periapsis and apoapsis markers.
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = COLORS.orbit;
    const peri = this.projectPoint(
      el.primary.x + el.u.x * el.periapsis,
      el.primary.y + el.u.y * el.periapsis,
      el.primary.z + el.u.z * el.periapsis,
    );
    if (peri.visible) dot(ctx, peri.x, peri.y, 2.5);
    if (isFinite(el.apoapsis)) {
      const apo = this.projectPoint(
        el.primary.x - el.u.x * el.apoapsis,
        el.primary.y - el.u.y * el.apoapsis,
        el.primary.z - el.u.z * el.apoapsis,
      );
      if (apo.visible) dot(ctx, apo.x, apo.y, 2.5);
    }
    ctx.restore();
  }

  /** A labelled target ring lying in the reference plane. */
  drawTarget(wx: number, wy: number, wz: number, worldRadius: number, color: string, label: string): void {
    const ctx = this.view;
    const c = this.projectPoint(wx, wy, wz);
    if (!c.visible) return;
    const r = Math.max(6, worldRadius * c.scale);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    dot(ctx, c.x, c.y, 2);
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, c.x, c.y - r - 6);
    ctx.restore();
  }

  /** Scale bar plus the current camera attitude, so orientation is readable. */
  drawScaleBar(): void {
    const ctx = this.view;
    const cam = this.camera;
    // Pixels per world unit at the focal plane.
    const pxPerUnit = this.projectPoint(cam.target.x, cam.target.y, cam.target.z).scale;
    if (!(pxPerUnit > 0)) return;

    const target = 120 / pxPerUnit;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const mult = [1, 2, 5, 10].find((m) => pow * m >= target) ?? 10;
    const world = pow * mult;
    const px = world * pxPerUnit;

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
    ctx.fillText(
      `yaw ${Math.round((cam.yaw * 180) / Math.PI)}°  pitch ${Math.round((cam.pitch * 180) / Math.PI)}°`,
      x + px,
      y + 12,
    );
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

/** Small deterministic PRNG, so the sky is the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mixTo(channel: number, toward: number, t: number): number {
  return Math.round(channel + (toward - channel) * t);
}

/** Heaviest star-like body, used as the light source for sphere shading. */
function brightestStar(bodies: Body[]): Body | null {
  let best: Body | null = null;
  for (const b of bodies) {
    if (b.kind !== 'star') continue;
    if (!best || b.mass > best.mass) best = b;
  }
  // No star in the scene: fall back to the heaviest body so planets still have
  // a consistent, physically motivated light direction.
  if (best) return best;
  for (const b of bodies) if (!best || b.mass > best.mass) best = b;
  return best;
}
