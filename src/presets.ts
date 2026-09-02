/**
 * presets.ts — ready-made scenes.
 *
 * Each preset is built at a world-space centre and uses the *current* G, so a
 * scene stays correct whatever the gravity slider is set to: every initial
 * velocity here is derived from G rather than hard-coded.
 */

import { COLORS, PHYSICS, randomColor, starColor } from './config';
import { makeBody, type Body } from './physics';
import { circularSpeed } from './orbits';

export interface Preset {
  id: string;
  label: string;
  hint: string;
  build(cx: number, cy: number, G: number): Body[];
  /** Suggested zoom so the scene frames nicely. */
  zoom: number;
}

/** Put a satellite on a circular orbit of radius r about a primary. */
function orbiter(
  primary: Body,
  r: number,
  angle: number,
  mass: number,
  color: string,
  G: number,
  direction = 1,
): Body {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  // Speed for a circular orbit, applied perpendicular to the radius.
  const v = circularSpeed(G, primary.mass + mass, r) * direction;
  return makeBody({
    x: primary.x + ux * r,
    y: primary.y + uy * r,
    vx: primary.vx - uy * v,
    vy: primary.vy + ux * v,
    mass,
    color,
  });
}

/** Remove any net drift so a scene stays in frame. */
function zeroMomentum(bodies: Body[]): Body[] {
  let px = 0;
  let py = 0;
  let m = 0;
  for (const b of bodies) {
    px += b.mass * b.vx;
    py += b.mass * b.vy;
    m += b.mass;
  }
  const vx = px / m;
  const vy = py / m;
  for (const b of bodies) {
    b.vx -= vx;
    b.vy -= vy;
  }
  return bodies;
}

/* ------------------------------------------------------------ solar system */

const solarSystem: Preset = {
  id: 'solar',
  label: 'Solar system',
  hint: 'A star and six planets, spaced for long-term stability. One has a moon.',
  zoom: 0.8,
  build(cx, cy, G) {
    const star = makeBody({
      x: cx,
      y: cy,
      mass: PHYSICS.STAR_MASS,
      color: COLORS.star,
      kind: 'star',
    });

    /*
     * Spacing here is not decorative. Two neighbouring planets are Hill-stable
     * only if their separation exceeds ~2*sqrt(3) mutual Hill radii, where
     *
     *   R_H = ((m1 + m2) / 3M)^(1/3) * (a1 + a2) / 2
     *
     * Below that they scatter each other onto crossing orbits and collide
     * within a few dozen revolutions. Every adjacent pair below sits at 4.3
     * mutual Hill radii or more — comfortably stable, and in the same range as
     * real compact systems like TRAPPIST-1.
     */
    const planets: Array<{ r: number; mass: number; color: string; moon?: number }> = [
      { r: 70, mass: 6, color: '#ff8a3d' },
      { r: 108, mass: 14, color: '#4dd0ff' },
      { r: 165, mass: 10, color: '#3ef2b5' },
      { r: 250, mass: 20, color: '#ff4d9d' },
      { r: 370, mass: 30, color: '#ffd166' },
      // The moon's host is the outermost planet: its Hill sphere is ~65px
      // there, so a satellite at 22px sits at a third of it and stays put.
      { r: 620, mass: 90, color: '#b388ff', moon: 22 },
    ];

    const bodies: Body[] = [star];
    let phase = Math.random() * Math.PI * 2;

    for (const p of planets) {
      // Spread the planets around the star rather than lining them up, which
      // would make their mutual pull resonate.
      phase += 1.9 + Math.random() * 0.8;
      const planet = orbiter(star, p.r, phase, p.mass, p.color, G);
      bodies.push(planet);

      if (p.moon) {
        bodies.push(orbiter(planet, p.moon, phase + 1.4, 0.8, '#cfe9ff', G));
      }
    }
    return zeroMomentum(bodies);
  },
};

/* -------------------------------------------------------------- binary star */

const binary: Preset = {
  id: 'binary',
  label: 'Binary stars',
  hint: 'Two stars about their barycentre, with a circumbinary planet.',
  zoom: 0.9,
  build(cx, cy, G) {
    const m1 = 16000;
    const m2 = 11000;
    const sep = 210;
    const total = m1 + m2;

    // Each star orbits the common centre of mass at its own radius; the
    // relative orbit is circular with speed sqrt(G*(m1+m2)/sep).
    const r1 = (sep * m2) / total;
    const r2 = (sep * m1) / total;
    const vRel = Math.sqrt((G * total) / sep);
    const v1 = (vRel * m2) / total;
    const v2 = (vRel * m1) / total;

    const a = makeBody({
      x: cx - r1, y: cy, vx: 0, vy: v1,
      mass: m1, color: starColor(0.75), kind: 'star',
    });
    const b = makeBody({
      x: cx + r2, y: cy, vx: 0, vy: -v2,
      mass: m2, color: starColor(0.35), kind: 'star',
    });

    const bodies = [a, b];

    // Circumbinary planets must sit well outside the pair or the alternating
    // pull ejects them; ~3x the separation is the usual rule of thumb.
    const barycentre = makeBody({ x: cx, y: cy, mass: total, color: '#000000' });
    for (let i = 0; i < 3; i++) {
      const r = sep * (3 + i * 0.85);
      bodies.push(orbiter(barycentre, r, i * 2.3, 40 + i * 30, randomColor(), G));
    }
    return zeroMomentum(bodies);
  },
};

/* ------------------------------------------------------- figure-eight orbit */

/**
 * The Chenciner–Montgomery figure-eight: three equal masses chasing each other
 * around a single closed loop. Discovered numerically in 1993 and proved in
 * 2000, it is one of the very few known stable three-body choreographies.
 *
 * The published initial conditions are for G = m = 1. They are rescaled here:
 * with lengths multiplied by L and masses by M, the orbit is unchanged if
 * velocities are multiplied by sqrt(G*M/L) — which follows from a ∝ GM/L² and
 * v²/L ∝ GM/L².
 */
const figureEight: Preset = {
  id: 'eight',
  label: 'Figure eight',
  hint: 'Three equal masses on one shared closed loop — a real choreography.',
  zoom: 1.1,
  build(cx, cy, G) {
    const L = 210;
    const M = 5200;
    const vs = Math.sqrt((G * M) / L);

    const px = 0.97000436;
    const py = -0.24308753;
    const vx3 = -0.93240737;
    const vy3 = -0.86473146;

    const spec: Array<[number, number, number, number]> = [
      [px, py, -vx3 / 2, -vy3 / 2],
      [-px, -py, -vx3 / 2, -vy3 / 2],
      [0, 0, vx3, vy3],
    ];
    const colors = ['#4dd0ff', '#ff4d9d', '#ffd166'];

    return spec.map(([x, y, vx, vy], i) =>
      makeBody({
        x: cx + x * L,
        y: cy + y * L,
        vx: vx * vs,
        vy: vy * vs,
        mass: M,
        color: colors[i],
        kind: 'star',
      }),
    );
  },
};

/* ------------------------------------------------------------ Lagrange L4/L5 */

/**
 * Trojans: small bodies sitting 60° ahead of and behind a secondary on its
 * orbit. L4 and L5 are the two *stable* Lagrange points — the equilateral
 * configuration is a genuine equilibrium in the rotating frame, so the trojans
 * librate around those points instead of drifting away. Jupiter holds thousands
 * of real asteroids this way.
 */
const trojans: Preset = {
  id: 'trojans',
  label: 'Lagrange trojans',
  hint: 'Asteroids librating at the stable L4 and L5 points, 60° off Jupiter.',
  zoom: 0.85,
  build(cx, cy, G) {
    const star = makeBody({
      x: cx, y: cy, mass: 40000, color: COLORS.star, kind: 'star',
    });
    const r = 330;
    const jupiter = orbiter(star, r, 0, 420, '#ffb27a', G);
    const bodies = [star, jupiter];

    for (const lead of [1, -1]) {
      for (let i = 0; i < 6; i++) {
        /*
         * A trojan must share Jupiter's orbit, so it gets the circular speed at
         * its own radius and only a whisker of radial offset. Giving it the
         * reference orbit's angular rate at a different radius instead puts it
         * on an eccentric path that crosses Jupiter's — which ejects it.
         *
         * The angular scatter around the exact 60 degree point is what makes
         * the libration visible: trojans do not sit at L4/L5, they trace slow
         * tadpole loops around them.
         */
        const angle = lead * (Math.PI / 3) + (i - 2.5) * 0.075 + (Math.random() - 0.5) * 0.015;
        const rr = r * (1 + (Math.random() - 0.5) * 0.01);
        const v = circularSpeed(G, star.mass + jupiter.mass, rr);
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        bodies.push(
          makeBody({
            x: cx + ux * rr,
            y: cy + uy * rr,
            vx: -uy * v,
            vy: ux * v,
            mass: 0.9,
            color: lead > 0 ? '#5cff9d' : '#7c5cff',
          }),
        );
      }
    }
    return zeroMomentum(bodies);
    return bodies;
  },
};

/* -------------------------------------------------------- accretion cluster */

const cluster: Preset = {
  id: 'cluster',
  label: 'Accretion disc',
  hint: 'A dense disc that grinds itself down into a few large bodies.',
  zoom: 0.85,
  build(cx, cy, G) {
    const count = 220;
    const coreMass = 6000;
    const core = makeBody({ x: cx, y: cy, mass: coreMass, color: COLORS.star, kind: 'star' });
    const bodies: Body[] = [core];

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      // sqrt keeps the disc evenly dense instead of clumping at the centre.
      const r = 130 + Math.sqrt(Math.random()) * 330;
      // A narrow spread around the circular speed: enough eccentricity for
      // orbits to cross and accrete over ~30s, not so much that the disc
      // collapses at once and there is nothing left to watch.
      const v = circularSpeed(G, coreMass, r) * (0.97 + Math.random() * 0.07);
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      bodies.push(
        makeBody({
          x: cx + ux * r,
          y: cy + uy * r,
          vx: -uy * v,
          vy: ux * v,
          mass: 3 + Math.random() * 15,
          color: randomColor(),
        }),
      );
    }
    return bodies;
  },
};

/* --------------------------------------------------------- galaxy collision */

const collision: Preset = {
  id: 'collision',
  label: 'Galaxy merger',
  hint: 'Two rotating discs on a collision course. Watch the tidal tails.',
  zoom: 0.55,
  build(cx, cy, G) {
    const bodies: Body[] = [];

    // Each disc gets its own saturated hue family rather than a realistic
    // blackbody white: under additive blending everything pale saturates to
    // the same white, and the whole point of watching a merger is being able
    // to tell which tidal tail came from which galaxy.
    const warm = ['#ff8a3d', '#ffb03d', '#ffd166', '#ff6b5c', '#ffa06b'];
    const cool = ['#4dd0ff', '#7c5cff', '#3ef2b5', '#5ce1ff', '#a06bff'];

    const disc = (
      ox: number,
      oy: number,
      vx: number,
      vy: number,
      spin: number,
      coreMass: number,
      n: number,
      ramp: string[],
      coreColor: string,
    ) => {
      const core = makeBody({
        x: ox, y: oy, vx, vy,
        mass: coreMass, color: coreColor, kind: 'star',
      });
      bodies.push(core);
      for (let i = 0; i < n; i++) {
        const angle = Math.random() * Math.PI * 2;
        const r = 55 + Math.sqrt(Math.random()) * 235;
        const v = circularSpeed(G, coreMass, r) * spin;
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        bodies.push(
          makeBody({
            x: ox + ux * r,
            y: oy + uy * r,
            // Disc rotation on top of the galaxy's bulk motion.
            vx: vx - uy * v,
            vy: vy + ux * v,
            mass: 2 + Math.random() * 7,
            color: ramp[(Math.random() * ramp.length) | 0],
          }),
        );
      }
    };

    // Offset in both axes so they meet on a grazing pass — a head-on hit just
    // makes a blob, while a glancing encounter throws off tidal tails.
    disc(cx - 470, cy - 150, 1.35, 0.5, 1, 9000, 130, warm, '#ffcf8a');
    disc(cx + 470, cy + 150, -1.35, -0.5, -1, 7000, 110, cool, '#9fd8ff');
    return zeroMomentum(bodies);
  },
};

/* ------------------------------------------------------------------ exports */

export const PRESETS: Preset[] = [
  solarSystem,
  binary,
  figureEight,
  trojans,
  cluster,
  collision,
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function blackHole(cx: number, cy: number): Body {
  return makeBody({
    x: cx,
    y: cy,
    mass: PHYSICS.BLACK_HOLE_MASS,
    color: COLORS.blackHole,
    kind: 'blackhole',
  });
}
