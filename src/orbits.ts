/**
 * orbits.ts — three-dimensional Keplerian orbital elements and trajectory
 * prediction.
 *
 * The simulation itself is a full N-body integration; nothing here feeds back
 * into it. These are read-only analyses used to *describe* what an orbit is
 * doing — the osculating ellipse a body is on right now, and where a body being
 * flung would go — which is exactly how orbital elements are used in practice.
 */

import { PHYSICS, PREDICT } from './config';
import { V, type Body, type Vec3 } from './physics';

export interface OrbitElements {
  /** The body this orbit is measured against. */
  primary: Body;
  /** Semi-major axis. Negative for hyperbolic paths. */
  a: number;
  /** Eccentricity: 0 circular, <1 elliptical, >=1 escaping. */
  e: number;
  /** Orbital period in sim-ticks; Infinity when unbound. */
  period: number;
  /** Closest and furthest approach distances. */
  periapsis: number;
  apoapsis: number;
  /** Inclination of the orbit plane to the reference (z = 0) plane, radians. */
  inclination: number;
  /** Longitude of the ascending node, radians. */
  node: number;
  /** Argument of periapsis measured in the orbit plane, radians. */
  argP: number;
  /** Current separation and speed. */
  r: number;
  speed: number;
  /** Specific orbital energy; negative means bound. */
  energy: number;
  bound: boolean;
  /**
   * Orthonormal basis of the orbit plane. `u` points at periapsis, `w` is the
   * orbit normal, `v = w × u`. The renderer sweeps the ellipse with these
   * rather than re-deriving angles, so the drawn curve is exactly the one the
   * elements describe.
   */
  u: Vec3;
  v: Vec3;
  w: Vec3;
}

/**
 * The body `b` should be considered to be orbiting.
 *
 * Picking the body that pulls hardest (max m/r²) is the obvious rule and it is
 * wrong: the Sun pulls on our Moon about twice as hard as the Earth does, yet
 * the Moon plainly orbits the Earth. What actually decides the hierarchy is
 * which primary the body is most tightly *bound* to.
 *
 * So: among candidates heavier than `b` that it is gravitationally bound to
 * (negative two-body energy), take the one giving the smallest semi-major axis
 * — the most local, tightest binding. The mass test is what breaks the
 * symmetry of binding, which is otherwise mutual: without it a planet would
 * report its own moon as its primary. If nothing qualifies (a lone body, or one
 * escaping everything) fall back to the strongest attractor so the inspector
 * still has something to measure against.
 */
export function dominantAttractor(bodies: Body[], b: Body, G: number): Body | null {
  let bound: Body | null = null;
  let boundA = Infinity;
  let strongest: Body | null = null;
  let strongestPull = 0;
  const soft2 = PHYSICS.SOFTENING * PHYSICS.SOFTENING;

  for (let i = 0; i < bodies.length; i++) {
    const o = bodies[i];
    if (o === b) continue;

    const dx = o.x - b.x;
    const dy = o.y - b.y;
    const dz = o.z - b.z;
    const d2 = dx * dx + dy * dy + dz * dz;

    const pull = o.mass / (d2 + soft2);
    if (pull > strongestPull) {
      strongestPull = pull;
      strongest = o;
    }

    if (o.mass <= b.mass) continue;

    const r = Math.sqrt(d2);
    if (r < 1e-9) continue;
    const dvx = b.vx - o.vx;
    const dvy = b.vy - o.vy;
    const dvz = b.vz - o.vz;
    const mu = G * (o.mass + b.mass);
    const energy = 0.5 * (dvx * dvx + dvy * dvy + dvz * dvz) - mu / r;
    if (energy >= 0) continue; // not bound to this one

    const a = -mu / (2 * energy);
    if (a < boundA) {
      boundA = a;
      bound = o;
    }
  }

  return bound ?? strongest;
}

/**
 * Osculating orbital elements of `body` about `primary`, from the relative
 * state vector. Standard two-body results:
 *
 *   mu   = G(M + m)                      gravitational parameter
 *   eps  = v²/2 - mu/r                   specific orbital energy
 *   a    = -mu / 2*eps                   semi-major axis  (vis-viva)
 *   h⃗   = r⃗ × v⃗                        specific angular momentum, normal to
 *                                        the orbit plane
 *   e⃗   = (v⃗ × h⃗)/mu - r̂               eccentricity vector, pointing at
 *                                        periapsis
 *   i    = acos(h_z / |h|)               inclination to the reference plane
 *   T    = 2π sqrt(a³ / mu)              period (bound orbits only)
 *
 * In three dimensions the orbit plane is set by h⃗, which is what makes
 * inclination a real, measurable element rather than a decoration.
 */
export function elementsFor(body: Body, primary: Body, G: number): OrbitElements | null {
  const rx = body.x - primary.x;
  const ry = body.y - primary.y;
  const rz = body.z - primary.z;
  const vx = body.vx - primary.vx;
  const vy = body.vy - primary.vy;
  const vz = body.vz - primary.vz;

  const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (r < 1e-6) return null;

  const mu = G * (primary.mass + body.mass);
  if (mu <= 0) return null;

  const v2 = vx * vx + vy * vy + vz * vz;
  const energy = v2 * 0.5 - mu / r;

  // Specific angular momentum: normal to the orbit plane.
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (h < 1e-9) return null; // radial plunge: no orbit plane to speak of

  // Eccentricity vector, e⃗ = (v⃗ × h⃗)/mu - r̂.
  const ex = (vy * hz - vz * hy) / mu - rx / r;
  const ey = (vz * hx - vx * hz) / mu - ry / r;
  const ez = (vx * hy - vy * hx) / mu - rz / r;
  const e = Math.sqrt(ex * ex + ey * ey + ez * ez);

  const bound = energy < 0;
  // vis-viva: a = -mu/2eps. Positive for bound orbits, negative for hyperbolic.
  const a = -mu / (2 * energy);
  const period = bound ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;

  const w: Vec3 = { x: hx / h, y: hy / h, z: hz / h };
  const inclination = Math.acos(Math.max(-1, Math.min(1, w.z)));

  // Ascending node: where the orbit crosses the reference plane going up. It is
  // the direction ẑ × ĥ; for an equatorial orbit that is degenerate, so fall
  // back to any perpendicular of the normal.
  let nx = -w.y;
  let ny = w.x;
  const nLen = Math.hypot(nx, ny);
  let node = 0;
  if (nLen > 1e-9) {
    nx /= nLen;
    ny /= nLen;
    node = Math.atan2(ny, nx);
  } else {
    nx = 1;
    ny = 0;
  }

  // Periapsis direction. For a circular orbit the eccentricity vector vanishes,
  // so use the node line to keep the basis well defined.
  const u: Vec3 =
    e > 1e-8
      ? { x: ex / e, y: ey / e, z: ez / e }
      : { x: nx, y: ny, z: 0 };
  const vAxis = V.cross(w, u);

  // Argument of periapsis: angle from the node line to periapsis, in-plane.
  const argP = Math.atan2(u.z / Math.max(1e-12, Math.sin(inclination)), u.x * nx + u.y * ny);

  return {
    primary,
    a,
    e,
    period,
    periapsis: Math.abs(a) * Math.abs(1 - e),
    apoapsis: bound ? a * (1 + e) : Infinity,
    inclination,
    node,
    argP: isFinite(argP) ? argP : 0,
    r,
    speed: Math.sqrt(v2),
    energy,
    bound,
    u,
    v: vAxis,
    w,
  };
}

/**
 * Speed for a circular orbit of radius r about mass M.
 *
 * The textbook answer is √(GM/r), but the simulation does not use a bare 1/r²
 * force — it uses a Plummer-softened one, so the true centripetal acceleration
 * at radius r is GM·r / (r² + ε²)^(3/2). Setting that equal to v²/r gives
 *
 *     v = sqrt( GM·r² / (r² + ε²)^(3/2) )
 *
 * which tends to √(GM/r) once r >> ε. Using the unsoftened formula instead
 * over-speeds anything orbiting close in — a moon at r ≈ 2.7ε is launched about
 * 10% too fast, spirals outward and escapes its planet within seconds.
 */
export function circularSpeed(G: number, centralMass: number, r: number): number {
  const rr = Math.max(r, 1e-6);
  const soft2 = PHYSICS.SOFTENING * PHYSICS.SOFTENING;
  return Math.sqrt((G * centralMass * rr * rr) / Math.pow(rr * rr + soft2, 1.5));
}

/** Angular rate of that circular orbit, ω = v / r. */
export function circularOmega(G: number, centralMass: number, r: number): number {
  return circularSpeed(G, centralMass, r) / Math.max(r, 1e-6);
}

/* -------------------------------------------------------- path prediction */

/** Indices of the K heaviest bodies, reused between calls. */
const attractorIdx: number[] = [];

/**
 * Forward-integrate a massless test particle through the current field and
 * write world-space points into `out` (x, y, z interleaved). Returns the number
 * of points written.
 *
 * Only the heaviest `PREDICT.ATTRACTORS` bodies act on it: gravity is dominated
 * by the big masses, so this keeps the cost O(K) per step instead of O(n) and
 * lets the preview run every frame while the user is still dragging. The field
 * is frozen — attractors do not move during the prediction — so the path is an
 * approximation that is exact for a single dominant primary and degrades
 * gracefully as the system gets more chaotic.
 */
export function predictPath(
  bodies: Body[],
  x0: number,
  y0: number,
  z0: number,
  vx0: number,
  vy0: number,
  vz0: number,
  G: number,
  out: Float32Array,
): number {
  const n = bodies.length;
  if (n === 0) return 0;

  attractorIdx.length = 0;
  for (let i = 0; i < n; i++) attractorIdx.push(i);
  if (n > PREDICT.ATTRACTORS) {
    attractorIdx.sort((a, b) => bodies[b].mass - bodies[a].mass);
    attractorIdx.length = PREDICT.ATTRACTORS;
  }

  const soft2 = PHYSICS.SOFTENING * PHYSICS.SOFTENING;
  const dt = PREDICT.DT;
  const half = dt * 0.5;
  const maxPoints = Math.floor(out.length / 3);
  const steps = Math.min(PREDICT.STEPS, maxPoints);

  let x = x0;
  let y = y0;
  let z = z0;
  let vx = vx0;
  let vy = vy0;
  let vz = vz0;

  // Same leapfrog the simulation uses, so the preview matches what will
  // actually happen rather than drifting off on a cheaper integrator.
  let ax = 0;
  let ay = 0;
  let az = 0;
  const accel = (px: number, py: number, pz: number) => {
    ax = 0;
    ay = 0;
    az = 0;
    for (let k = 0; k < attractorIdx.length; k++) {
      const b = bodies[attractorIdx[k]];
      const dx = b.x - px;
      const dy = b.y - py;
      const dz = b.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz + soft2;
      const invD = 1 / Math.sqrt(d2);
      const f = G * b.mass * invD * invD * invD;
      ax += dx * f;
      ay += dy * f;
      az += dz * f;
    }
  };

  accel(x, y, z);
  let written = 0;
  for (let s = 0; s < steps; s++) {
    vx += ax * half;
    vy += ay * half;
    vz += az * half;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    accel(x, y, z);
    vx += ax * half;
    vy += ay * half;
    vz += az * half;

    out[written * 3] = x;
    out[written * 3 + 1] = y;
    out[written * 3 + 2] = z;
    written++;

    // Stop once the particle has clearly escaped the interesting region.
    const dx = x - x0;
    const dy = y - y0;
    const dz = z - z0;
    if (dx * dx + dy * dy + dz * dz > 9e8) break;
  }
  return written;
}
