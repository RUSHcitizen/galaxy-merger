/**
 * config.ts — physics constants, tuning knobs and the shared mutable UI state.
 *
 * Everything the simulation reads at runtime lives in `state`; everything that
 * is a hard property of the model lives in `PHYSICS` / `RENDER`.
 */

/** Immutable physical / numerical constants. */
export const PHYSICS = {
  /** Default gravitational constant. Units are arbitrary: px, mass-units, ticks. */
  G_DEFAULT: 1,
  /**
   * Plummer softening length (px). Gravity is evaluated as
   * F = G*m1*m2 / (r^2 + eps^2), which keeps the integrator finite when two
   * bodies pass very close instead of launching one to infinity.
   */
  SOFTENING: 6,
  /** Bodies merge when their centre distance drops below this * (r1 + r2). */
  COLLISION_OVERLAP: 0.72,
  /** radius = RADIUS_SCALE * cbrt(mass) — constant density discs. */
  RADIUS_SCALE: 1.35,
  MIN_RADIUS: 1.4,
  /** Hard cap on live bodies; spawns beyond this are ignored. */
  MAX_BODIES: 900,
  /** Bodies further than this (world px) from the camera are culled. */
  CULL_RADIUS: 24000,
  /** Speed cap (px per sim-tick) — a last-resort guard against blow-ups. */
  MAX_SPEED: 220,
  /** Mass of the black hole spawned by the "Black hole" button. */
  BLACK_HOLE_MASS: 90000,
  /** Mass of the star used by the solar-system preset. */
  STAR_MASS: 26000,
  /**
   * Roche limit as a multiple of the primary's radius. Every body shares one
   * density, so the density ratio in the Roche formula is 1 and the limit
   * collapses to this constant times R_primary. 1.26 is the rigid-body value
   * and 2.44 the fluid one; 1.35 sits just above rigid, which keeps every
   * preset's innermost orbit safely outside its star's limit.
   */
  ROCHE_FACTOR: 1.35,
  /** A tide only tears a body apart if the primary is this much heavier. */
  DISRUPT_MASS_RATIO: 25,
  /** Below this mass a body is already rubble and will not break up further. */
  MIN_DISRUPT_MASS: 12,
  /** Fragments produced per break-up. */
  DISRUPT_PIECES: 4,
  /** Velocity shear between adjacent fragments — what stretches the stream. */
  DISRUPT_SHEAR: 0.22,
  /** Frames a fresh fragment refuses to merge, so siblings can separate. */
  DISRUPT_GRACE_FRAMES: 50,
} as const;

/** Rendering constants. */
export const RENDER = {
  /** Glow sprite radius as a multiple of the body radius. */
  GLOW_MULT: 3.6,
  /**
   * Longest motion streak drawn between two frames (px). Beyond this the jump
   * is a merge relocating a body to the centre of mass, not real travel.
   */
  MAX_STREAK: 90,
  /** Device-pixel-ratio cap. 2017 retina MacBooks are much happier at <= 2. */
  MAX_DPR: 2,
  /** Largest glow sprite we will rasterise (px, CSS units). */
  MAX_SPRITE_RADIUS: 340,
  /** Sprite cache entries retained (LRU beyond this). */
  SPRITE_CACHE_LIMIT: 384,
  /** Max gradients rasterised in a single frame; the rest fall back to discs. */
  SPRITE_BUDGET: 12,
  /** Frame-time (ms) above which the renderer drops to low quality. */
  DEGRADE_MS: 21,
  /** Frame-time (ms) below which it climbs back to high quality. */
  RECOVER_MS: 14,
  /** Stars generated per depth layer (directions on the sky sphere). */
  STARS_PER_LAYER: 420,
  /** Screen radius at which a body starts being drawn as a lit sphere. */
  SPHERE_MIN_RADIUS: 3,
  /** Segments in a swept orbit ellipse. */
  ORBIT_SEGMENTS: 128,
  /** Depth-cue span, as a multiple of camera distance. */
  DEPTH_FADE_SPAN: 3.5,
} as const;

/** Camera limits. */
export const CAMERA = {
  /** Vertical field of view, radians. */
  FOV: 0.85,
  /** Anything closer than this to the eye is clipped. */
  NEAR: 1,
  MIN_DISTANCE: 90,
  MAX_DISTANCE: 30000,
  /** Wheel notch -> distance multiplier. */
  ZOOM_STEP: 1.12,
  /** Radians of camera swing per pixel dragged. */
  ORBIT_SENSITIVITY: 0.006,
  /**
   * Smallest |ray.z| that still counts as hitting the reference plane. Below
   * this the camera is so close to edge-on that the intersection runs away to
   * the horizon and spawning there would be unusable.
   */
  MIN_GRAZE: 0.12,
  /** Exponential smoothing per frame for follow-panning. */
  SMOOTHING: 0.22,
} as const;

/** Trajectory prediction. */
export const PREDICT = {
  /** Integration steps drawn ahead. */
  STEPS: 320,
  /** Sim-time per prediction step. */
  DT: 0.9,
  /**
   * Only the K heaviest bodies act on the test particle. Gravity is dominated
   * by the big masses, and this keeps prediction O(K) per step rather than O(n)
   * so it can run every frame while dragging.
   */
  ATTRACTORS: 12,
} as const;

/** Neon palette used for spawned bodies. */
export const PALETTE = [
  '#4dd0ff',
  '#7c5cff',
  '#ff4d9d',
  '#ffd166',
  '#3ef2b5',
  '#ff8a3d',
  '#b388ff',
  '#5cff9d',
] as const;

export const COLORS = {
  star: '#ffd98a',
  blackHole: '#a06bff',
  ghost: '#8fd8ff',
  predict: '#7fe9ff',
  lagrange: '#5cff9d',
  orbit: '#ffd166',
  select: '#ffffff',
  grid: '#7c9cff',
} as const;

export type BodyKind = 'body' | 'star' | 'blackhole';

/** Live, mutable UI state. The control panel writes it, the loop reads it. */
export interface SandboxState {
  /** Simulation time advanced per rendered frame (before substepping). */
  timeStep: number;
  /** Gravitational constant, live-adjustable. */
  gravity: number;
  /** 0 = no trails (hard clear), 1 = very long trails. */
  trail: number;
  /** Mass given to bodies spawned by click-drag. */
  spawnMass: number;
  /** Physics substeps per frame. More = more accurate, more expensive. */
  substeps: number;
  /** Bloom intensity, 0 = off. */
  bloom: number;
  paused: boolean;
  /** Advance exactly one frame while paused, then clear itself. */
  stepOnce: boolean;
  /** Draw velocity vectors on every body. */
  showVectors: boolean;
  /** Additive glow pass on/off (the single biggest render cost). */
  glow: boolean;
  /** Starfield behind the simulation. */
  stars: boolean;
  /** Reference grid on the z = 0 plane. */
  grid: boolean;
  /** Draw large bodies as lit spheres rather than flat glows. */
  shading: boolean;
  /** Merge bodies on contact. Off = they pass through each other. */
  merging: boolean;
  /** Draw the Kepler ellipse and elements for the selected body. */
  showOrbits: boolean;
  /** Forward-integrate and draw the path of a body being flung. */
  predict: boolean;
  /** Keep the camera centred on the selected body. */
  follow: boolean;
  /** Tear bodies apart inside the Roche limit. */
  tides: boolean;
  /** View from a frame co-rotating with the selection's orbit. */
  rotatingFrame: boolean;
}

export const state: SandboxState = {
  timeStep: 0.6,
  gravity: PHYSICS.G_DEFAULT,
  trail: 0.55,
  spawnMass: 220,
  substeps: 2,
  bloom: 0.55,
  paused: false,
  stepOnce: false,
  showVectors: false,
  glow: true,
  stars: true,
  grid: true,
  shading: true,
  merging: true,
  showOrbits: true,
  predict: true,
  follow: false,
  tides: true,
  rotatingFrame: false,
};

/** Drag pixels -> launch velocity (before the camera zoom is divided out). */
export const FLING_SCALE = 0.045;

/** Random neon colour from the palette. */
export function randomColor(): string {
  return PALETTE[(Math.random() * PALETTE.length) | 0];
}

/**
 * Blackbody-ish colour ramp for stars, cool (red) to hot (blue-white).
 * `t` is 0..1. Used so heavier stars read as hotter.
 */
export function starColor(t: number): string {
  const stops: Array<[number, number, number]> = [
    [255, 137, 74],
    [255, 190, 120],
    [255, 231, 186],
    [222, 233, 255],
    [178, 210, 255],
  ];
  const u = Math.min(0.999, Math.max(0, t)) * (stops.length - 1);
  const i = u | 0;
  const f = u - i;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}
