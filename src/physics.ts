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
  /** Where this body came from — the challenge runner scores player spawns. */
  origin: BodyOrigin;
  /**
   * Frames during which this body refuses to merge. Tidal fragments are born
   * overlapping their siblings; without a grace period they would re-merge
   * into the parent on the very next step.
   */
  noMergeFrames: number;
}

/** How a body entered the world. */
export type BodyOrigin = 'preset' | 'player' | 'fragment';

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
  origin?: BodyOrigin;
  noMergeFrames?: number;
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
    origin: spec.origin ?? 'preset',
    noMergeFrames: spec.noMergeFrames ?? 0,
  };
}

/* --------------------------------------------------------------------- world */

/** Emitted when two bodies merge, so the renderer can throw off debris. */
export interface MergeEvent {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  /** Radius of the smaller body — scales the size of the burst. */
  scale: number;
  /** True when the survivor is a black hole, i.e. something was swallowed. */
  intoBlackHole: boolean;
  /** Mass of the absorbed body. */
  mass: number;
}

/** Emitted when a body is torn apart by tides. */
export interface DisruptEvent {
  x: number;
  y: number;
  color: string;
  /** Radius of the body that broke up. */
  scale: number;
}

/** Bulk conservation figures, recomputed on a throttle for the HUD. */
export interface Diagnostics {
  kinetic: number;
  potential: number;
  total: number;
  angularMomentum: number;
  momentum: number;
  barycentreX: number;
  barycentreY: number;
  mass: number;
}

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
  /** Merge sites since the last drain, for the particle system. */
  readonly mergeEvents: MergeEvent[] = [];
  /** Tidal break-up sites since the last drain. */
  readonly disruptEvents: DisruptEvent[] = [];
  /**
   * Mass consumed by black holes, cumulative. Mass rather than a body count:
   * a rock that breaks up at the Roche limit arrives as four fragments, and
   * counting bodies would score it four times over.
   */
  swallowedMass = 0;
  /**
   * Live body cap. Lowered by the quality tier: the force loop is O(n²), so
   * this is the main lever on CPU cost for a weak machine.
   */
  maxBodies: number = PHYSICS.MAX_BODIES;

  add(body: Body): Body | null {
    if (this.bodies.length >= this.maxBodies) return null;
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
    this.mergeEvents.length = 0;
    this.disruptEvents.length = 0;
    this.swallowedMass = 0;
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
        /*
         * The grace period exists so the siblings of one break-up can separate
         * instead of instantly recombining, so it applies only when *both*
         * bodies are in it. Requiring just one would let a fragment fall
         * straight through the primary that shattered it — and a body passing
         * through the centre of a deep potential well picks up an enormous,
         * badly-integrated kick and is flung back out at escape speed.
         */
        if (bi.noMergeFrames > 0 && bj.noMergeFrames > 0) continue;

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

        this.mergeEvents.push({
          x: cx,
          y: cy,
          vx: bi.vx,
          vy: bi.vy,
          color: gone.color,
          scale: Math.min(gone.radius, keep.radius),
          intoBlackHole: bi.kind === 'blackhole',
          mass: gone.mass,
        });

        absorbed[j] = 1;
        merges++;
      }
    }

    for (const e of this.mergeEvents) if (e.intoBlackHole) this.swallowedMass += e.mass;

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

  /**
   * Bulk conservation figures. The potential term is another O(n²) pass, so the
   * caller throttles this — the HUD refreshes it a few times a second, not
   * every frame.
   *
   *   KE = Σ ½mv²        PE = -Σ_{i<j} G·m_i·m_j / r_ij        L = Σ m(x·v_y − y·v_x)
   *
   * Total energy drifts a little as bodies merge (merging is inelastic, so
   * kinetic energy is genuinely lost) but is otherwise near-constant, which is
   * what the symplectic integrator buys.
   */
  diagnostics(G: number): Diagnostics {
    const bodies = this.bodies;
    const n = bodies.length;
    const soft2 = PHYSICS.SOFTENING * PHYSICS.SOFTENING;

    let kinetic = 0;
    let potential = 0;
    let px = 0;
    let py = 0;
    let mass = 0;
    let bx = 0;
    let by = 0;

    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      kinetic += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
      px += b.mass * b.vx;
      py += b.mass * b.vy;
      mass += b.mass;
      bx += b.mass * b.x;
      by += b.mass * b.y;
    }

    for (let i = 0; i < n; i++) {
      const bi = bodies[i];
      for (let j = i + 1; j < n; j++) {
        const bj = bodies[j];
        const dx = bj.x - bi.x;
        const dy = bj.y - bi.y;
        // Softened potential, matching the softened force the integrator uses.
        potential -= (G * bi.mass * bj.mass) / Math.sqrt(dx * dx + dy * dy + soft2);
      }
    }

    const cx = n > 0 ? bx / mass : 0;
    const cy = n > 0 ? by / mass : 0;

    // Angular momentum about the barycentre, so it does not drift with the
    // system's bulk translation.
    let angular = 0;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      angular += b.mass * ((b.x - cx) * b.vy - (b.y - cy) * b.vx);
    }

    return {
      kinetic,
      potential,
      total: kinetic + potential,
      angularMomentum: angular,
      momentum: Math.hypot(px, py),
      barycentreX: cx,
      barycentreY: cy,
      mass,
    };
  }

  /** The heaviest body, used as a default camera target. */
  heaviest(): Body | null {
    let best: Body | null = null;
    for (const b of this.bodies) if (!best || b.mass > best.mass) best = b;
    return best;
  }

  /** Topmost body whose disc contains the given world point. */
  pick(wx: number, wy: number, slack: number): Body | null {
    let best: Body | null = null;
    let bestD2 = Infinity;
    for (const b of this.bodies) {
      const dx = wx - b.x;
      const dy = wy - b.y;
      const d2 = dx * dx + dy * dy;
      const reach = b.radius + slack;
      if (d2 <= reach * reach && d2 < bestD2) {
        bestD2 = d2;
        best = b;
      }
    }
    return best;
  }

  /**
   * Tidal break-up. A satellite closer to its primary than the Roche limit is
   * pulled apart, because the difference in gravitational pull across its own
   * width exceeds the self-gravity holding it together:
   *
   *     d_roche = k · R_primary · (rho_primary / rho_satellite)^(1/3)
   *
   * with k ≈ 1.26 for a rigid body and 2.44 for a fluid one. Every body here is
   * built at one constant density (r ∝ m^(1/3)), so the density ratio is 1 and
   * the limit is just a multiple of the primary's radius.
   *
   * Fragments are laid out along the orbital direction and given a velocity
   * shear — the inner ones orbit faster — which is what actually produces the
   * long debris streams seen in real tidal disruption events. Mass and momentum
   * are conserved exactly: the offsets are symmetric about the parent, so the
   * momentum they add sums to zero.
   */
  resolveTides(): number {
    const bodies = this.bodies;
    const n = bodies.length;
    if (n < 2) return 0;

    let broken = 0;

    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      // A black hole has no structure to pull apart; tiny bodies are already
      // rubble, and stopping there is what guarantees the recursion terminates.
      if (b.kind === 'blackhole') continue;
      if (b.mass < PHYSICS.MIN_DISRUPT_MASS) continue;
      if (b.noMergeFrames > 0) continue;
      // Refuse to shatter if there is no room for the pieces.
      if (this.bodies.length + PHYSICS.DISRUPT_PIECES > this.maxBodies) break;

      let primary: Body | null = null;
      for (let j = 0; j < n; j++) {
        const p = bodies[j];
        if (p === b) continue;
        // Only a much heavier body raises a tide worth the name; two similar
        // masses simply collide.
        if (p.mass < b.mass * PHYSICS.DISRUPT_MASS_RATIO) continue;
        const dx = p.x - b.x;
        const dy = p.y - b.y;
        const roche = PHYSICS.ROCHE_FACTOR * p.radius;
        if (dx * dx + dy * dy < roche * roche) {
          if (!primary || p.mass > primary.mass) primary = p;
        }
      }
      if (!primary) continue;

      this.shatter(i, primary);
      broken++;
      // The parent slot now holds a fragment; leave the rest to later frames.
    }

    return broken;
  }

  /** Replace bodies[index] with a stream of fragments. */
  private shatter(index: number, primary: Body): void {
    const b = this.bodies[index];
    const pieces = PHYSICS.DISRUPT_PIECES;

    this.disruptEvents.push({ x: b.x, y: b.y, color: b.color, scale: b.radius });

    // Along-track unit vector: the direction the body is already moving
    // relative to its primary, which is the axis a tidal stream stretches on.
    let ux = b.vx - primary.vx;
    let uy = b.vy - primary.vy;
    const speed = Math.hypot(ux, uy);
    if (speed > 1e-6) {
      ux /= speed;
      uy /= speed;
    } else {
      ux = 1;
      uy = 0;
    }

    const fragMass = b.mass / pieces;
    const fragRadius = radiusForMass(fragMass);
    // Spread the chain over a few parent radii so the pieces start apart.
    const spacing = Math.max(fragRadius * 2.2, b.radius * 0.9);
    const shear = PHYSICS.DISRUPT_SHEAR;

    const made: Body[] = [];
    for (let k = 0; k < pieces; k++) {
      // Symmetric offsets: ..., -1.5, -0.5, +0.5, +1.5, ... so they sum to zero
      // and the fragments carry exactly the parent's momentum.
      const t = k - (pieces - 1) / 2;
      made.push(
        makeBody({
          x: b.x + ux * t * spacing,
          y: b.y + uy * t * spacing,
          vx: b.vx + ux * t * shear,
          vy: b.vy + uy * t * shear,
          mass: fragMass,
          color: b.color,
          origin: 'fragment',
          noMergeFrames: PHYSICS.DISRUPT_GRACE_FRAMES,
        }),
      );
    }

    // Overwrite the parent in place, append the rest.
    this.bodies[index] = made[0];
    for (let k = 1; k < made.length; k++) this.bodies.push(made[k]);
    this.accelDirty = true;
  }

  /** Tick down per-body merge grace periods. */
  tickCooldowns(dt: number): void {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i].noMergeFrames > 0) bodies[i].noMergeFrames -= dt;
    }
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
