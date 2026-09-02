/**
 * physics.ts — Newtonian N-body gravity, vector helpers and momentum-conserving
 * merge collisions.
 *
 * The pairwise force loop is the hot path, so it works on scalars pulled out of
 * the body objects and never allocates. Vec2 helpers exist for UI-side maths
 * (drag vectors, preset construction) where clarity beats raw speed.
 */

import { PHYSICS, type BodyKind } from './config';

export interface Vec2 {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ vectors */

export const V = {
  add: (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s }),
  dot: (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y,
  lenSq: (a: Vec2): number => a.x * a.x + a.y * a.y,
  len: (a: Vec2): number => Math.hypot(a.x, a.y),
  distSq: (a: Vec2, b: Vec2): number => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  },
  dist: (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y),
  norm: (a: Vec2): Vec2 => {
    const l = Math.hypot(a.x, a.y);
    return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
  },
  /** Rotate 90 degrees counter-clockwise — handy for circular orbits. */
  perp: (a: Vec2): Vec2 => ({ x: -a.y, y: a.x }),
};

/* -------------------------------------------------------------------- bodies */

export interface Body {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Acceleration carried between steps so leapfrog needs one force pass. */
  ax: number;
  ay: number;
  /** Position at the start of the current frame; the renderer streaks from it. */
  px: number;
  py: number;
  mass: number;
  radius: number;
  color: string;
  kind: BodyKind;
}

let nextId = 1;

/** radius from mass, assuming constant density (r ∝ m^(1/3)). */
export function radiusForMass(mass: number): number {
  return Math.max(PHYSICS.MIN_RADIUS, PHYSICS.RADIUS_SCALE * Math.cbrt(mass));
}

export interface BodySpec {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  mass: number;
  color: string;
  kind?: BodyKind;
}

export function makeBody(spec: BodySpec): Body {
  return {
    id: nextId++,
    x: spec.x,
    y: spec.y,
    vx: spec.vx ?? 0,
    vy: spec.vy ?? 0,
    ax: 0,
    ay: 0,
    px: spec.x,
    py: spec.y,
    mass: spec.mass,
    radius: radiusForMass(spec.mass),
    color: spec.color,
    kind: spec.kind ?? 'body',
  };
}

/* --------------------------------------------------------------------- world */

export interface StepOptions {
  /** Simulation time to advance. */
  dt: number;
  /** Gravitational constant. */
  G: number;
  /** Viewport centre, used for culling escapees. */
  centerX: number;
  centerY: number;
}

export class World {
  bodies: Body[] = [];
  /** Set whenever the body list changes so accelerations are refreshed. */
  private accelDirty = true;
  /** Merges since the last read — the UI uses it for the collision counter. */
  mergeCount = 0;

  add(body: Body): Body | null {
    if (this.bodies.length >= PHYSICS.MAX_BODIES) return null;
    this.bodies.push(body);
    this.accelDirty = true;
    return body;
  }

  addAll(bodies: Body[]): void {
    for (const b of bodies) this.add(b);
  }

  clear(): void {
    this.bodies.length = 0;
    this.accelDirty = true;
    this.mergeCount = 0;
  }

  get count(): number {
    return this.bodies.length;
  }

  /** Magnitude of total momentum — the HUD shows it as a conservation check. */
  totalMomentum(): number {
    let px = 0;
    let py = 0;
    for (const b of this.bodies) {
      px += b.mass * b.vx;
      py += b.mass * b.vy;
    }
    return Math.hypot(px, py);
  }

  markDirty(): void {
    this.accelDirty = true;
  }

  /**
   * Record where every body starts this frame. The renderer draws a streak from
   * there to the post-step position, so a body moving 8px per frame leaves a
   * continuous track rather than a dotted one.
   */
  snapshotPositions(): void {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.px = b.x;
      b.py = b.y;
    }
  }

  /**
   * Pairwise gravitational accelerations, a_i = Σ G*m_j*(r_j - r_i)/|r|³.
   *
   * Newton's third law lets us touch each unordered pair once, halving the
   * work: the ~n²/2 inner iterations are what keeps a few hundred bodies at
   * 60fps on modest hardware.
   */
  computeAccelerations(G: number): void {
    const bodies = this.bodies;
    const n = bodies.length;
    const soft2 = PHYSICS.SOFTENING * PHYSICS.SOFTENING;

    for (let i = 0; i < n; i++) {
      bodies[i].ax = 0;
      bodies[i].ay = 0;
    }

    for (let i = 0; i < n; i++) {
      const bi = bodies[i];
      const xi = bi.x;
      const yi = bi.y;
      const mi = bi.mass;
      let axi = bi.ax;
      let ayi = bi.ay;

      for (let j = i + 1; j < n; j++) {
        const bj = bodies[j];
        const dx = bj.x - xi;
        const dy = bj.y - yi;
        const d2 = dx * dx + dy * dy + soft2;
        // 1/r³ — one sqrt, two multiplies, no Math.pow.
        const invD = 1 / Math.sqrt(d2);
        const invD3 = invD * invD * invD;
        const f = G * invD3;

        const fj = f * bj.mass;
        axi += dx * fj;
        ayi += dy * fj;

        const fi = f * mi;
        bj.ax -= dx * fi;
        bj.ay -= dy * fi;
      }

      bi.ax = axi;
      bi.ay = ayi;
    }

    this.accelDirty = false;
  }

  /**
   * One kick-drift-kick (leapfrog) step. Symplectic, so closed orbits stay
   * closed instead of spiralling the way forward Euler does, and it needs only
   * a single force evaluation per step because `a` is carried on the body.
   */
  step(opts: StepOptions): void {
    const { dt, G } = opts;
    const bodies = this.bodies;
    const n = bodies.length;
    if (n === 0) return;

    if (this.accelDirty) this.computeAccelerations(G);

    const half = dt * 0.5;
    const maxSpeed = PHYSICS.MAX_SPEED;

    // kick (half) + drift (full)
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      b.vx += b.ax * half;
      b.vy += b.ay * half;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }

    this.computeAccelerations(G);

    // kick (half)
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      b.vx += b.ax * half;
      b.vy += b.ay * half;

      const s2 = b.vx * b.vx + b.vy * b.vy;
      if (s2 > maxSpeed * maxSpeed) {
        const k = maxSpeed / Math.sqrt(s2);
        b.vx *= k;
        b.vy *= k;
      }
    }
  }

  /**
   * Perfectly inelastic merges. Mass and momentum are conserved exactly:
   *
   *   m = m1 + m2
   *   v = (m1*v1 + m2*v2) / m
   *   x = (m1*x1 + m2*x2) / m     (centre of mass)
   *
   * Radius follows from the combined "volume", i.e. r = cbrt(r1³ + r2³), which
   * `radiusForMass` reproduces for free since r ∝ m^(1/3).
   */
  resolveCollisions(): number {
    const bodies = this.bodies;
    const n = bodies.length;
    if (n < 2) return 0;

    const overlap = PHYSICS.COLLISION_OVERLAP;
    const absorbed = new Uint8Array(n);
    let merges = 0;

    for (let i = 0; i < n; i++) {
      if (absorbed[i]) continue;
      const bi = bodies[i];

      for (let j = i + 1; j < n; j++) {
        if (absorbed[j]) continue;
        const bj = bodies[j];

        const dx = bj.x - bi.x;
        const dy = bj.y - bi.y;
        // A black hole swallows anything that touches its horizon.
        const touch =
          bi.kind === 'blackhole' || bj.kind === 'blackhole'
            ? bi.radius + bj.radius
            : (bi.radius + bj.radius) * overlap;

        if (dx * dx + dy * dy > touch * touch) continue;

        // Merge j into i, keeping the heavier body's identity.
        const [keep, gone] = bi.mass >= bj.mass ? [bi, bj] : [bj, bi];
        const m = bi.mass + bj.mass;
        const invM = 1 / m;

        const px = bi.mass * bi.vx + bj.mass * bj.vx;
        const py = bi.mass * bi.vy + bj.mass * bj.vy;
        const cx = (bi.mass * bi.x + bj.mass * bj.x) * invM;
        const cy = (bi.mass * bi.y + bj.mass * bj.y) * invM;

        bi.x = cx;
        bi.y = cy;
        bi.vx = px * invM;
        bi.vy = py * invM;
        bi.mass = m;
        bi.radius = radiusForMass(m);
        bi.kind =
          bi.kind === 'blackhole' || bj.kind === 'blackhole'
            ? 'blackhole'
            : keep.kind;
        bi.color = bi.kind === 'blackhole' ? keep.color : mixColors(keep.color, gone.color, 0.75);

        absorbed[j] = 1;
        merges++;
      }
    }

    if (merges > 0) {
      // Single compaction pass — cheaper than repeated splice() calls.
      let w = 0;
      for (let i = 0; i < n; i++) {
        if (!absorbed[i]) bodies[w++] = bodies[i];
      }
      bodies.length = w;
      this.mergeCount += merges;
      this.accelDirty = true;
    }

    return merges;
  }

  /** Drop bodies that have escaped far past the viewport. */
  cull(centerX: number, centerY: number): void {
    const bodies = this.bodies;
    const limit = PHYSICS.CULL_RADIUS * PHYSICS.CULL_RADIUS;
    let w = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const dx = b.x - centerX;
      const dy = b.y - centerY;
      if (dx * dx + dy * dy < limit) bodies[w++] = b;
    }
    if (w !== bodies.length) {
      bodies.length = w;
      this.accelDirty = true;
    }
  }
}

/* ------------------------------------------------------------------- helpers */

/** Circular-orbit speed for a satellite at distance r around mass M: √(GM/r). */
export function orbitalSpeed(G: number, centralMass: number, r: number): number {
  return Math.sqrt((G * centralMass) / Math.max(r, 1e-6));
}

const hexCache = new Map<string, [number, number, number]>();

/** '#rrggbb' -> [r, g, b], memoised. */
export function hexToRgb(hex: string): [number, number, number] {
  const cached = hexCache.get(hex);
  if (cached) return cached;
  const v = parseInt(hex.slice(1), 16);
  const rgb: [number, number, number] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  hexCache.set(hex, rgb);
  return rgb;
}

/** Blend two hex colours; t = 1 keeps `a` entirely. */
export function mixColors(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar * t + br * (1 - t));
  const g = Math.round(ag * t + bg * (1 - t));
  const bl = Math.round(ab * t + bb * (1 - t));
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}
