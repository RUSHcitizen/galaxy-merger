/**
 * quality.ts — rendering quality tiers.
 *
 * The sandbox has to run on a 2017 MacBook Pro *and* on a low-end Chromebook
 * with DDR3 memory and integrated graphics. Those differ by roughly an order of
 * magnitude in fill rate, and the dominant cost here is full-screen pixel
 * traffic, so the knobs that matter most are device pixel ratio (quadratic in
 * cost) and how many full-screen passes each frame makes.
 *
 * Tiers can be pinned by the user or driven automatically from measured frame
 * time. Auto-stepping is deliberately sluggish: changing the pixel ratio
 * reallocates every buffer and drops the trail history, so it must not happen
 * on a transient hitch.
 */

export type QualityTier = 'low' | 'medium' | 'high';
export type QualityMode = 'auto' | QualityTier;

export interface QualityProfile {
  /** Device-pixel-ratio ceiling. The single biggest lever: cost is ~dpr². */
  dprCap: number;
  /** Whether the bloom post-process may run at all. */
  bloom: boolean;
  /**
   * Bloom buffer size as a fraction of the viewport, and the blur radius
   * applied in that reduced space. Bloom measured at ~60% of the whole frame
   * cost, so this — not the starfield or the glow sprites — is the knob worth
   * tiering.
   */
  bloomScale: number;
  bloomBlur: number;
  /** Whether the parallax starfield may run at all. */
  stars: boolean;
  /** Multiplier on drawn glow sprite size. */
  glowScale: number;
  /**
   * Bodies smaller than this (screen px) are drawn as plain discs instead of
   * glow sprites. Measured, a disc is 40-200x cheaper than blitting a glow —
   * a glow covers (3.6r)², about 52x the body's own area — so this is the
   * strongest lever available at a fixed pixel ratio, and below ~3px the halo
   * is barely perceptible anyway.
   */
  discBelow: number;
  /** Hard cap on live bodies — the force loop is O(n²). */
  maxBodies: number;
  /** Stars generated per parallax layer. */
  starsPerLayer: number;
  /** Ceiling on physics substeps per frame. */
  maxSubsteps: number;
  /** Budget for the glow sprite cache, in bytes of backing store. */
  spriteBudgetBytes: number;
  label: string;
}

export const PROFILES: Record<QualityTier, QualityProfile> = {
  high: {
    dprCap: 2,
    bloom: true,
    bloomScale: 0.25,
    bloomBlur: 3.5,
    stars: true,
    glowScale: 1,
    discBelow: 0,
    maxBodies: 900,
    starsPerLayer: 130,
    maxSubsteps: 6,
    spriteBudgetBytes: 48 << 20,
    label: 'High',
  },
  medium: {
    dprCap: 1.5,
    bloom: true,
    bloomScale: 0.14,
    bloomBlur: 2,
    stars: true,
    glowScale: 0.85,
    discBelow: 3,
    maxBodies: 500,
    starsPerLayer: 90,
    maxSubsteps: 4,
    spriteBudgetBytes: 24 << 20,
    label: 'Balanced',
  },
  low: {
    // dpr 1 and no bloom/starfield takes the frame from four full-screen
    // passes down to two, which is what makes weak integrated graphics viable.
    dprCap: 1,
    bloom: false,
    bloomScale: 0.12,
    bloomBlur: 1.5,
    stars: false,
    glowScale: 0.7,
    discBelow: 4.5,
    maxBodies: 260,
    starsPerLayer: 45,
    maxSubsteps: 2,
    spriteBudgetBytes: 10 << 20,
    label: 'Low',
  },
};

const ORDER: QualityTier[] = ['low', 'medium', 'high'];

/**
 * Opening guess from what the browser will tell us. `deviceMemory` is coarse
 * (and absent on Safari/Firefox) and core count says nothing about the GPU, so
 * this only picks a starting point — measured frame time does the real work.
 */
export function detectTier(): QualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency || 4;

  if (mem <= 4 || cores <= 2) return 'low';
  // An 8GB, 4-core Chromebook lands here: usable settings without guessing
  // wrong in the expensive direction. Auto-stepping climbs if it can.
  if (mem <= 8 && cores <= 4) return 'medium';
  return 'high';
}

/** Frame-time thresholds for stepping between tiers. */
const DEGRADE_MS = 23;
const RECOVER_MS = 12.5;
/** How long the average must stay past a threshold before the tier moves. */
const DEGRADE_HOLD_MS = 1200;
const RECOVER_HOLD_MS = 5000;
/** Quiet period after any change — a tier switch reallocates every buffer. */
const COOLDOWN_MS = 2500;

export class QualityController {
  mode: QualityMode = 'auto';
  tier: QualityTier;
  /** Exponential moving average of frame time, ms. */
  private avg = 16;
  private overMs = 0;
  private underMs = 0;
  private cooldown = 0;
  /** Auto never climbs back above what the device was detected as capable of. */
  private ceiling: QualityTier;

  constructor() {
    this.tier = detectTier();
    this.ceiling = 'high';
  }

  get profile(): QualityProfile {
    return PROFILES[this.tier];
  }

  /** Pin a tier, or hand control back to the frame-time watcher. */
  setMode(mode: QualityMode): boolean {
    this.mode = mode;
    if (mode === 'auto') {
      this.overMs = 0;
      this.underMs = 0;
      this.cooldown = COOLDOWN_MS;
      return false;
    }
    const changed = this.tier !== mode;
    this.tier = mode;
    return changed;
  }

  /**
   * Feed one frame. Returns true when the tier changed, which the caller must
   * treat as "reallocate the buffers".
   */
  update(frameMs: number): boolean {
    this.avg += (frameMs - this.avg) * 0.06;
    if (this.mode !== 'auto') return false;

    if (this.cooldown > 0) {
      this.cooldown -= frameMs;
      return false;
    }

    const i = ORDER.indexOf(this.tier);

    if (this.avg > DEGRADE_MS) {
      this.underMs = 0;
      this.overMs += frameMs;
      if (this.overMs > DEGRADE_HOLD_MS && i > 0) {
        this.tier = ORDER[i - 1];
        this.overMs = 0;
        this.cooldown = COOLDOWN_MS;
        return true;
      }
    } else if (this.avg < RECOVER_MS) {
      this.overMs = 0;
      this.underMs += frameMs;
      if (this.underMs > RECOVER_HOLD_MS && i < ORDER.indexOf(this.ceiling)) {
        this.tier = ORDER[i + 1];
        this.underMs = 0;
        this.cooldown = COOLDOWN_MS;
        return true;
      }
    } else {
      this.overMs = 0;
      this.underMs = 0;
    }
    return false;
  }

  get fps(): number {
    return this.avg > 0 ? 1000 / this.avg : 0;
  }
}
