/**
 * challenges.ts — the game layer.
 *
 * Each challenge builds its own scene and then watches the live simulation for
 * a win condition expressed in orbital-mechanics terms: eccentricity below a
 * threshold, a body becoming unbound after a close pass, something parked at a
 * Lagrange point. Nothing here alters the physics — a challenge only observes,
 * so a solution has to be a genuine orbital manoeuvre rather than something the
 * scoring code hands you.
 *
 * Conditions that must *hold* are accumulated in seconds rather than tested
 * instantaneously, so clipping through the right state for one frame never
 * counts as a win.
 */

import { COLORS, PHYSICS, randomColor } from './config';
import { makeBody, type Body, type World } from './physics';
import { circularSpeed, dominantAttractor, elementsFor } from './orbits';

export type ChallengeState = 'pending' | 'success' | 'failed';

export interface ChallengeCtx {
  world: World;
  G: number;
  /** Seconds since the challenge started. */
  elapsed: number;
  /** Seconds this frame represents. */
  dt: number;
  /** Bodies the player has spawned since the challenge began. */
  playerBodies: Body[];
  /** Mass swallowed by a black hole since the challenge began. */
  swallowedMass: number;
  /** Per-body accumulators, cleared when a body stops qualifying. */
  timers: Map<number, number>;
  /** Free-form scalar store for a challenge's own bookkeeping. */
  memory: Map<string, number>;
}

export interface Challenge {
  id: string;
  title: string;
  brief: string;
  hint: string;
  /** Seconds before the attempt fails. */
  timeLimit: number;
  /** Camera zoom that frames the scene. */
  zoom: number;
  build(G: number): Body[];
  /** Called once per frame. Returning anything but 'pending' ends the run. */
  check(ctx: ChallengeCtx): ChallengeState;
  /** Progress 0..1 for the banner meter. */
  progress(ctx: ChallengeCtx): number;
}

/* ------------------------------------------------------------------ helpers */

function star(mass: number = PHYSICS.STAR_MASS): Body {
  return makeBody({ x: 0, y: 0, mass, color: COLORS.star, kind: 'star' });
}

/** Circular orbiter about a primary, at radius r and angle a. */
function orbiter(primary: Body, r: number, a: number, mass: number, color: string, G: number): Body {
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const v = circularSpeed(G, primary.mass + mass, r);
  return makeBody({
    x: primary.x + ux * r,
    y: primary.y + uy * r,
    vx: primary.vx - uy * v,
    vy: primary.vy + ux * v,
    mass,
    color,
  });
}

/**
 * Accumulate held time for every player body currently satisfying `ok`, and
 * reset the moment one stops. Returns the longest streak in seconds.
 */
function holdTime(ctx: ChallengeCtx, ok: (b: Body) => boolean): number {
  let best = 0;
  for (const b of ctx.playerBodies) {
    if (ok(b)) {
      const t = (ctx.timers.get(b.id) ?? 0) + ctx.dt;
      ctx.timers.set(b.id, t);
      if (t > best) best = t;
    } else {
      ctx.timers.set(b.id, 0);
    }
  }
  return best;
}

/** Elements of `b` about the heaviest body in the world. */
function aboutPrimary(ctx: ChallengeCtx, b: Body) {
  const primary = dominantAttractor(ctx.world.bodies, b, ctx.G);
  return primary ? elementsFor(b, primary, ctx.G) : null;
}

/* --------------------------------------------------------------- challenges */

const firstOrbit: Challenge = {
  id: 'first-orbit',
  title: 'Make Orbit',
  brief: 'Fling a body into a closed orbit and keep it there for 10 seconds.',
  hint: 'Aim sideways, not at the star. The dashed preview shows where it goes.',
  timeLimit: 120,
  zoom: 1,
  build: () => [star()],
  check(ctx) {
    const held = holdTime(ctx, (b) => {
      const e = aboutPrimary(ctx, b);
      return !!e && e.bound && e.e < 0.9 && e.periapsis > 55;
    });
    if (held >= 10) return 'success';
    return ctx.elapsed > this.timeLimit ? 'failed' : 'pending';
  },
  progress: (ctx) => Math.min(1, Math.max(0, ...[...ctx.timers.values()]) / 10),
};

const circularize: Challenge = {
  id: 'circularize',
  title: 'Circularize',
  brief: 'Get a body onto a near-circular orbit — eccentricity under 0.08 — and hold it for 8 seconds.',
  hint: 'Shift-click drops a body onto an exactly circular orbit. Doing it by hand is the real challenge.',
  timeLimit: 150,
  zoom: 1,
  build: () => [star()],
  check(ctx) {
    const held = holdTime(ctx, (b) => {
      const e = aboutPrimary(ctx, b);
      return !!e && e.bound && e.e < 0.08;
    });
    if (held >= 8) return 'success';
    return ctx.elapsed > this.timeLimit ? 'failed' : 'pending';
  },
  progress: (ctx) => Math.min(1, Math.max(0, ...[...ctx.timers.values()]) / 8),
};

const threadTheNeedle: Challenge = {
  id: 'thread',
  title: 'Thread the Needle',
  brief: 'Park a body in the gap between the two planets — and leave both planets in one piece.',
  hint: 'The lane is roughly 170 to 310 units out. Keep the whole orbit inside it, not just this moment.',
  timeLimit: 180,
  zoom: 0.95,
  build(G) {
    const s = star();
    return [
      s,
      orbiter(s, 140, 0.6, 60, '#4dd0ff', G),
      orbiter(s, 340, 3.4, 90, '#ff8a3d', G),
    ];
  },
  check(ctx) {
    // Losing a planet fails the run outright: threading means not disturbing.
    const planets = ctx.world.bodies.filter((b) => b.origin === 'preset' && b.kind !== 'star');
    if (planets.length < 2) return 'failed';

    const held = holdTime(ctx, (b) => {
      const e = aboutPrimary(ctx, b);
      if (!e || !e.bound || e.primary.kind !== 'star') return false;
      // The whole orbit must stay inside the lane, not just this instant.
      // A little wider than the visual gap: the two planets perturb anything
      // in here continuously, and a lane with no margin would reset the hold
      // timer on jitter rather than on the player actually losing the orbit.
      return e.periapsis > 165 && e.apoapsis < 315;
    });
    if (held >= 12) return 'success';
    return ctx.elapsed > this.timeLimit ? 'failed' : 'pending';
  },
  progress: (ctx) => Math.min(1, Math.max(0, ...[...ctx.timers.values()]) / 12),
};

const slingshot: Challenge = {
  id: 'slingshot',
  title: 'Gravity Assist',
  brief: 'Escape the system — but only by stealing momentum from the giant. A straight burn out does not count.',
  hint: 'Pass close behind the giant in its direction of travel. It drags you forward.',
  timeLimit: 180,
  zoom: 0.8,
  build(G) {
    const s = star(20000);
    return [s, orbiter(s, 300, 0.4, 2600, '#ffb27a', G)];
  },
  check(ctx) {
    const giant = ctx.world.bodies.find((b) => b.origin === 'preset' && b.kind !== 'star');
    const sun = ctx.world.bodies.find((b) => b.kind === 'star');
    if (!giant || !sun) return 'failed';

    const reach = giant.radius * 6;

    for (const b of ctx.playerBodies) {
      const e = elementsFor(b, sun, ctx.G);
      if (!e) continue;

      /*
       * The assist only counts if the encounter is what freed the probe: it has
       * to arrive at the giant still *bound* to the star and leave unbound.
       * Testing merely for "passed near the giant and is now escaping" would
       * accept a straight burn out through the giant's neighbourhood, which
       * gains nothing from it.
       */
      const d = Math.hypot(b.x - giant.x, b.y - giant.y);
      if (d < reach && e.bound) ctx.memory.set('assist:' + b.id, 1);

      if (!ctx.memory.has('assist:' + b.id)) continue;
      if (!e.bound && e.r > 500) return 'success';
    }
    return ctx.elapsed > this.timeLimit ? 'failed' : 'pending';
  },
  progress(ctx) {
    const sun = ctx.world.bodies.find((b) => b.kind === 'star');
    if (!sun) return 0;
    let best = 0;
    for (const b of ctx.playerBodies) {
      const e = elementsFor(b, sun, ctx.G);
      if (!e) continue;
      // Half for reaching the giant while still bound, half for getting away.
      const staged = ctx.memory.has('assist:' + b.id)
        ? 0.5 + (e.bound ? 0 : Math.min(0.5, e.r / 1000))
        : Math.min(0.4, e.r / 800);
      best = Math.max(best, staged);
    }
    return best;
  },
};

const trojanParking: Challenge = {
  id: 'trojan',
  title: 'Lagrange Parking',
  brief: 'Park a body at L4 — 60° ahead of the planet on its own orbit — and keep it there for 12 seconds.',
  hint: 'L4 is marked. It only holds still in the rotating frame: press G once something is selected.',
  timeLimit: 210,
  zoom: 0.85,
  build(G) {
    const s = star(40000);
    return [s, orbiter(s, 320, 0, 420, '#ffb27a', G)];
  },
  check(ctx) {
    const l4 = lagrangeL4(ctx.world);
    if (!l4) return 'failed';
    const held = holdTime(ctx, (b) => Math.hypot(b.x - l4.x, b.y - l4.y) < 60);
    if (held >= 12) return 'success';
    return ctx.elapsed > this.timeLimit ? 'failed' : 'pending';
  },
  progress: (ctx) => Math.min(1, Math.max(0, ...[...ctx.timers.values()]) / 12),
};

/** Mass of one rock in the black-hole challenge. */
const ROCK_MASS = 25;

const feedTheHole: Challenge = {
  id: 'feed',
  title: 'Feed the Void',
  brief: 'Feed the void three rocks\u2019 worth of mass before the clock runs out.',
  hint: 'Fling something heavy into a rock to rob it of speed — slow it enough and its orbit drops inside the horizon.',
  timeLimit: 90,
  zoom: 0.55,
  build(G) {
    const hole = makeBody({
      x: 0, y: 0, mass: PHYSICS.BLACK_HOLE_MASS,
      color: COLORS.blackHole, kind: 'blackhole',
    });
    const bodies = [hole];

    /*
     * Nested circular orbits, not a standing start and not crossing ellipses.
     *
     * Dropped from rest the rocks would simply fall in and the challenge would
     * complete itself. Put on eccentric orbits at a common radius they instead
     * collide with *each other*, and each merge robs angular momentum until
     * something drops inside the horizon on its own — which also completes the
     * challenge without the player. Circular orbits at well-separated radii
     * never approach each other, so nothing moves inward unless it is pushed.
     */
    // Geometric spacing, not linear. Circular orbits still destabilise each
    // other if they sit closer than ~2*sqrt(3) mutual Hill radii; evenly spaced
    // rings fail that test at the inner end and grind themselves down to fewer
    // rocks than the objective needs. These sit at 4.3 mutual Hill radii, the
    // same margin the solar-system preset uses.
    const radii = [230, 294, 376, 481, 615, 787];
    for (let i = 0; i < radii.length; i++) {
      const r = radii[i];
      const a = (i * 2.4) % (Math.PI * 2);
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const v = circularSpeed(G, PHYSICS.BLACK_HOLE_MASS, r);
      bodies.push(
        makeBody({
          x: ux * r, y: uy * r,
          vx: -uy * v, vy: ux * v,
          mass: ROCK_MASS, color: randomColor(),
        }),
      );
    }
    return bodies;
  },
  check(ctx) {
    // Scored by mass, so a rock that shatters on the way in still counts once.
    if (ctx.swallowedMass >= ROCK_MASS * 3) return 'success';
    return ctx.elapsed > this.timeLimit ? 'failed' : 'pending';
  },
  progress: (ctx) => Math.min(1, ctx.swallowedMass / (ROCK_MASS * 3)),
};

export const CHALLENGES: Challenge[] = [
  firstOrbit,
  circularize,
  threadTheNeedle,
  slingshot,
  trojanParking,
  feedTheHole,
];

/**
 * The L4 point of the heaviest satellite: 60° ahead of it, on its own orbit,
 * measured from the primary. Exported so the renderer can mark it.
 */
export function lagrangeL4(world: World): { x: number; y: number } | null {
  const primary = world.bodies.find((b) => b.kind === 'star');
  if (!primary) return null;
  let secondary: Body | null = null;
  for (const b of world.bodies) {
    if (b === primary || b.origin !== 'preset') continue;
    if (!secondary || b.mass > secondary.mass) secondary = b;
  }
  if (!secondary) return null;

  const dx = secondary.x - primary.x;
  const dy = secondary.y - primary.y;
  const a = Math.atan2(dy, dx) + Math.PI / 3;
  const r = Math.hypot(dx, dy);
  return { x: primary.x + Math.cos(a) * r, y: primary.y + Math.sin(a) * r };
}

/* ------------------------------------------------------------------ runner */

const STORAGE_KEY = 'cgs.challenges';

export class ChallengeRunner {
  active: Challenge | null = null;
  state: ChallengeState = 'pending';
  elapsed = 0;
  progress = 0;
  /** Ids the player has completed, persisted between visits. */
  completed = new Set<string>();

  private timers = new Map<number, number>();
  private memory = new Map<string, number>();
  private playerIds = new Set<number>();
  private swallowedAtStart = 0;

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) for (const id of JSON.parse(raw) as string[]) this.completed.add(id);
    } catch {
      /* storage may be unavailable; an empty record is fine */
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.completed]));
    } catch {
      /* ignore */
    }
  }

  start(challenge: Challenge, world: World, G: number): void {
    this.active = challenge;
    this.state = 'pending';
    this.elapsed = 0;
    this.progress = 0;
    this.timers.clear();
    this.memory.clear();
    this.playerIds.clear();

    world.clear();
    world.addAll(challenge.build(G));
    this.swallowedAtStart = world.swallowedMass;
  }

  stop(): void {
    this.active = null;
    this.state = 'pending';
    this.timers.clear();
    this.memory.clear();
    this.playerIds.clear();
  }

  /** Called by the UI whenever the player spawns something. */
  notePlayerBody(body: Body): void {
    if (this.active) this.playerIds.add(body.id);
  }

  get running(): boolean {
    return this.active !== null && this.state === 'pending';
  }

  /** Advance the active challenge by `dt` seconds of wall clock. */
  update(world: World, G: number, dt: number): ChallengeState | null {
    const c = this.active;
    if (!c || this.state !== 'pending') return null;

    this.elapsed += dt;

    // Fragments inherit the challenge's interest in their parent, so a body
    // torn apart still counts toward "something you put there".
    const playerBodies = world.bodies.filter(
      (b) => this.playerIds.has(b.id) || (b.origin === 'fragment' && this.playerIds.has(b.id)),
    );

    const ctx: ChallengeCtx = {
      world,
      G,
      elapsed: this.elapsed,
      dt,
      playerBodies,
      swallowedMass: world.swallowedMass - this.swallowedAtStart,
      timers: this.timers,
      memory: this.memory,
    };

    const next = c.check(ctx);
    this.progress = Math.max(0, Math.min(1, c.progress(ctx)));

    if (next !== 'pending') {
      this.state = next;
      if (next === 'success') {
        this.completed.add(c.id);
        this.persist();
      }
      return next;
    }
    return null;
  }

  get remaining(): number {
    return this.active ? Math.max(0, this.active.timeLimit - this.elapsed) : 0;
  }
}
