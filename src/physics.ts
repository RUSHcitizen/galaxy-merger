/**
 * physics.ts — Newtonian N-body gravity in three dimensions, vector helpers and
 * momentum-conserving merge collisions.
 *
 * The pairwise force loop is the hot path, so it works on scalars pulled out of
 * the body objects and never allocates. Vec3 helpers exist for UI-side maths
 * (drag vectors, preset construction) where clarity beats raw speed.
 */

import { PHYSICS, type BodyKind } from './config';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/* ------------------------------------------------------------------ vectors */

export const V = {
  add: (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  dot: (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a: Vec3, b: Vec3): Vec3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  lenSq: (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z,
  len: (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
  distSq: (a: Vec3, b: Vec3): number => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  },
  dist: (a: Vec3, b: Vec3): number => Math.sqrt(V.distSq(a, b)),
  norm: (a: Vec3): Vec3 => {
    const l = V.len(a);
    return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
  },
  /**
   * Any unit vector perpendicular to `a`. Used to build an orbit basis: pick
   * whichever axis is least aligned with `a` so the cross product stays well
   * conditioned.
   */
  anyPerp: (a: Vec3): Vec3 => {
    const ax = Math.abs(a.x);
    const ay = Math.abs(a.y);
    const az = Math.abs(a.z);
    const axis: Vec3 =
      ax <= ay && ax <= az ? { x: 1, y: 0, z: 0 }
      : ay <= az ? { x: 0, y: 1, z: 0 }
      : { x: 0, y: 0, z: 1 };
    return V.norm(V.cross(a, axis));
  },
};

/* -------------------------------------------------------------------- bodies */

export interface Body {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Acceleration carried between steps so leapfrog needs one force pass. */
  ax: number;
  ay: number;
  az: number;
  /** Position at the start of the current frame; the renderer streaks from it. */
  px: number;
  py: number;
  pz: number;
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
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
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
    z: spec.z ?? 0,
    vx: spec.vx ?? 0,
    vy: spec.vy ?? 0,
    vz: spec.vz ?? 0,
    ax: 0,
    ay: 0,
    az: 0,
    px: spec.x,
    py: spec.y,
    pz: spec.z ?? 0,
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
  z: number;
  vx: number;
  vy: number;
  vz: number;
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
  z: number;
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
  barycentreZ: number;
  mass: number;
}

export interface StepOptions {
  /** Simulation time to advance. */
  dt: number;
  /** Gravitational constant. */
  G: number;
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
      b.pz = b.z;
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
      bodies[i].az = 0;
    }

    for (let i = 0; i < n; i++) {
      const bi = bodies[i];
      const xi = bi.x;
      const yi = bi.y;
      const zi = bi.z;
      const mi = bi.mass;
      let axi = bi.ax;
      let ayi = bi.ay;
      let azi = bi.az;

      for (let j = i + 1; j < n; j++) {
        const bj = bodies[j];
        const dx = bj.x - xi;
        const dy = bj.y - yi;
        const dz = bj.z - zi;
        const d2 = dx * dx + dy * dy + dz * dz + soft2;
        // 1/r³ — one sqrt, two multiplies, no Math.pow.
        const invD = 1 / Math.sqrt(d2);
        const invD3 = invD * invD * invD;
        const f = G * invD3;

        const fj = f * bj.mass;
        axi += dx * fj;
        ayi += dy * fj;
        azi += dz * fj;

        const fi = f * mi;
        bj.ax -= dx * fi;
        bj.ay -= dy * fi;
        bj.az -= dz * fi;
      }

      bi.ax = axi;
      bi.ay = ayi;
      bi.az = azi;
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
      b.vz += b.az * half;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
    }

    this.computeAccelerations(G);

    // kick (half)
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      b.vx += b.ax * half;
      b.vy += b.ay * half;
      b.vz += b.az * half;

      const s2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
      if (s2 > maxSpeed * maxSpeed) {
        const k = maxSpeed / Math.sqrt(s2);
        b.vx *= k;
        b.vy *= k;
        b.vz *= k;
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
        const dz = bj.z - bi.z;
        // A black hole swallows anything that touches its horizon.
        const touch =
          bi.kind === 'blackhole' || bj.kind === 'blackhole'
            ? bi.radius + bj.radius
            : (bi.radius + bj.radius) * overlap;

        if (dx * dx + dy * dy + dz * dz > touch * touch) continue;

        // Merge j into i, keeping the heavier body's identity.
        const [keep, gone] = bi.mass >= bj.mass ? [bi, bj] : [bj, bi];
        const m = bi.mass + bj.mass;
        const invM = 1 / m;

        const px = bi.mass * bi.vx + bj.mass * bj.vx;
        const py = bi.mass * bi.vy + bj.mass * bj.vy;
        const pz = bi.mass * bi.vz + bj.mass * bj.vz;
        const cx = (bi.mass * bi.x + bj.mass * bj.x) * invM;
        const cy = (bi.mass * bi.y + bj.mass * bj.y) * invM;
        const cz = (bi.mass * bi.z + bj.mass * bj.z) * invM;

        bi.x = cx;
        bi.y = cy;
        bi.z = cz;
        bi.vx = px * invM;
        bi.vy = py * invM;
        bi.vz = pz * invM;
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
          z: cz,
          vx: bi.vx,
          vy: bi.vy,
          vz: bi.vz,
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
    let pz = 0;
    let mass = 0;
    let bx = 0;
    let by = 0;
    let bz = 0;

    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      kinetic += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
      px += b.mass * b.vx;
      py += b.mass * b.vy;
      pz += b.mass * b.vz;
      mass += b.mass;
      bx += b.mass * b.x;
      by += b.mass * b.y;
      bz += b.mass * b.z;
    }

    for (let i = 0; i < n; i++) {
      const bi = bodies[i];
      for (let j = i + 1; j < n; j++) {
        const bj = bodies[j];
        const dx = bj.x - bi.x;
        const dy = bj.y - bi.y;
        const dz = bj.z - bi.z;
        // Softened potential, matching the softened force the integrator uses.
        potential -=
          (G * bi.mass * bj.mass) / Math.sqrt(dx * dx + dy * dy + dz * dz + soft2);
      }
    }

    const cx = n > 0 ? bx / mass : 0;
    const cy = n > 0 ? by / mass : 0;
    const cz = n > 0 ? bz / mass : 0;

    // Angular momentum about the barycentre, so it does not drift with the
    // system's bulk translation. In 3D this is a vector, L = Σ m (r × v); the
    // HUD shows its magnitude.
    let lx = 0;
    let ly = 0;
    let lz = 0;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      const rx = b.x - cx;
      const ry = b.y - cy;
      const rz = b.z - cz;
      lx += b.mass * (ry * b.vz - rz * b.vy);
      ly += b.mass * (rz * b.vx - rx * b.vz);
      lz += b.mass * (rx * b.vy - ry * b.vx);
    }

    return {
      kinetic,
      potential,
      total: kinetic + potential,
      angularMomentum: Math.sqrt(lx * lx + ly * ly + lz * lz),
      momentum: Math.sqrt(px * px + py * py + pz * pz),
      barycentreX: cx,
      barycentreY: cy,
      barycentreZ: cz,
      mass,
    };
  }

  /** The heaviest body, used as a default camera target. */
  heaviest(): Body | null {
    let best: Body | null = null;
    for (const b of this.bodies) if (!best || b.mass > best.mass) best = b;
    return best;
  }

  /**
   * Nearest body along a ray, for 3D picking. The renderer turns a cursor
   * position into a world-space ray; a body is a hit when the ray passes within
   * its radius (plus a little slack, so small bodies stay clickable), and of
   * those the one closest to the camera wins.
   */
  pickRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, slack: number): Body | null {
    let best: Body | null = null;
    let bestT = Infinity;

    for (const b of this.bodies) {
      const rx = b.x - ox;
      const ry = b.y - oy;
      const rz = b.z - oz;
      // Distance along the ray to the point of closest approach.
      const t = rx * dx + ry * dy + rz * dz;
      if (t <= 0) continue; // behind the camera

      const cxp = rx - dx * t;
      const cyp = ry - dy * t;
      const czp = rz - dz * t;
      const miss2 = cxp * cxp + cyp * cyp + czp * czp;
      // Slack scales with distance so a far-off body stays as clickable as its
      // on-screen size suggests.
      const reach = b.radius + slack * t;
      if (miss2 > reach * reach) continue;

      if (t < bestT) {
        bestT = t;
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
        const dz = p.z - b.z;
        const roche = PHYSICS.ROCHE_FACTOR * p.radius;
        if (dx * dx + dy * dy + dz * dz < roche * roche) {
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

    this.disruptEvents.push({ x: b.x, y: b.y, z: b.z, color: b.color, scale: b.radius });

    // Along-track unit vector: the direction the body is already moving
    // relative to its primary, which is the axis a tidal stream stretches on.
    let ux = b.vx - primary.vx;
    let uy = b.vy - primary.vy;
    let uz = b.vz - primary.vz;
    const speed = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (speed > 1e-6) {
      ux /= speed;
      uy /= speed;
      uz /= speed;
    } else {
      ux = 1;
      uy = 0;
      uz = 0;
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
          z: b.z + uz * t * spacing,
          vx: b.vx + ux * t * shear,
          vy: b.vy + uy * t * shear,
          vz: b.vz + uz * t * shear,
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
  cull(centerX: number, centerY: number, centerZ: number): void {
    const bodies = this.bodies;
    const limit = PHYSICS.CULL_RADIUS * PHYSICS.CULL_RADIUS;
    let w = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const dx = b.x - centerX;
      const dy = b.y - centerY;
      const dz = b.z - centerZ;
      if (dx * dx + dy * dy + dz * dz < limit) bodies[w++] = b;
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
