/**
 * ui.ts — DOM controls, keyboard shortcuts, click-and-drag vector flinging and
 * the scene presets. Nothing in here runs per-frame except `updateHud`, which
 * is throttled.
 */

import {
  COLORS,
  FLING_SCALE,
  PHYSICS,
  randomColor,
  state,
} from './config';
import { makeBody, orbitalSpeed, radiusForMass, World, type Body, type Vec2 } from './physics';
import type { Renderer } from './renderer';

/* ------------------------------------------------------------------ helpers */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

/** Wire a range input to a state field, mirroring the value into its readout. */
function bindSlider(
  id: string,
  format: (v: number) => string,
  apply: (v: number) => void,
): HTMLInputElement {
  const input = el<HTMLInputElement>(id);
  const readout = el<HTMLElement>(`${id}-value`);
  const sync = () => {
    const v = parseFloat(input.value);
    readout.textContent = format(v);
    apply(v);
  };
  input.addEventListener('input', sync);
  sync();
  return input;
}

/* ------------------------------------------------------------------ presets */

/**
 * A deliberately stable system: one heavy star plus planets on circular orbits,
 * v = √(GM/r) perpendicular to the radius. Orbits are spaced widely enough that
 * planet-planet perturbation stays negligible, so it stays put for minutes.
 */
export function solarSystem(cx: number, cy: number, G: number): Body[] {
  const star = makeBody({
    x: cx,
    y: cy,
    mass: PHYSICS.STAR_MASS,
    color: COLORS.star,
    kind: 'star',
  });

  const planets: Array<{ r: number; mass: number; color: string; moon?: number }> = [
    { r: 78, mass: 30, color: '#ff8a3d' },
    { r: 124, mass: 90, color: '#4dd0ff' },
    { r: 178, mass: 70, color: '#3ef2b5', moon: 16 },
    { r: 246, mass: 45, color: '#ff4d9d' },
    { r: 330, mass: 260, color: '#ffd166' },
    { r: 420, mass: 150, color: '#7c5cff' },
  ];

  const bodies: Body[] = [star];
  let phase = Math.random() * Math.PI * 2;

  for (const p of planets) {
    // Spread the planets around the star rather than lining them up, which
    // would make their mutual pull resonate.
    phase += 1.9 + Math.random() * 0.8;
    const ux = Math.cos(phase);
    const uy = Math.sin(phase);
    const v = orbitalSpeed(G, PHYSICS.STAR_MASS, p.r);

    const planet = makeBody({
      x: cx + ux * p.r,
      y: cy + uy * p.r,
      // Velocity is perpendicular to the radius: (-uy, ux) * v.
      vx: -uy * v,
      vy: ux * v,
      mass: p.mass,
      color: p.color,
    });
    bodies.push(planet);

    if (p.moon) {
      const mv = orbitalSpeed(G, p.mass, p.moon);
      bodies.push(
        makeBody({
          x: planet.x + ux * p.moon,
          y: planet.y + uy * p.moon,
          vx: planet.vx - uy * mv,
          vy: planet.vy + ux * mv,
          mass: 1.5,
          color: '#cfe9ff',
        }),
      );
    }
  }

  return bodies;
}

/** A rotating disc of small bodies — the merge/perf playground. */
export function cluster(cx: number, cy: number, G: number, count = 220): Body[] {
  const bodies: Body[] = [];
  const coreMass = 6000;
  bodies.push(
    makeBody({ x: cx, y: cy, mass: coreMass, color: COLORS.star, kind: 'star' }),
  );

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    // sqrt keeps the disc evenly dense instead of clumping at the centre.
    const r = 130 + Math.sqrt(Math.random()) * 330;
    // A narrow spread around the circular speed: enough eccentricity for orbits
    // to cross and accrete over ~30s, not so much that the disc collapses at
    // once and there is nothing left to watch.
    const v = orbitalSpeed(G, coreMass, r) * (0.97 + Math.random() * 0.07);
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

/* ----------------------------------------------------------------- controls */

export interface UiHandles {
  updateHud(fps: number, bodies: number, merges: number, degraded: boolean): void;
}

export function initUI(world: World, renderer: Renderer): UiHandles {
  const stage = el<HTMLElement>('stage');
  const pauseBtn = el<HTMLButtonElement>('btn-pause');

  /* ---- sliders ---- */
  bindSlider('time-step', (v) => v.toFixed(2) + '×', (v) => (state.timeStep = v));
  bindSlider('gravity', (v) => v.toFixed(2), (v) => (state.gravity = v));
  bindSlider(
    'trail',
    (v) => (v <= 0 ? 'off' : Math.round(v * 100) + '%'),
    (v) => (state.trail = v),
  );
  bindSlider('spawn-mass', (v) => String(Math.round(v)), (v) => (state.spawnMass = v));
  bindSlider('substeps', (v) => String(Math.round(v)), (v) => (state.substeps = Math.round(v)));

  /* ---- toggles ---- */
  const vectorsBox = el<HTMLInputElement>('show-vectors');
  vectorsBox.checked = state.showVectors;
  vectorsBox.addEventListener('change', () => (state.showVectors = vectorsBox.checked));

  const glowBox = el<HTMLInputElement>('glow');
  glowBox.checked = state.glow;
  glowBox.addEventListener('change', () => {
    state.glow = glowBox.checked;
    renderer.clearAll();
  });

  /* ---- buttons ---- */
  const setPaused = (paused: boolean) => {
    state.paused = paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('is-active', paused);
    pauseBtn.setAttribute('aria-pressed', String(paused));
  };

  const clearAll = () => {
    world.clear();
    renderer.clearAll();
  };

  const loadSolarSystem = () => {
    clearAll();
    world.addAll(solarSystem(renderer.centerX, renderer.centerY, state.gravity));
  };

  pauseBtn.addEventListener('click', () => setPaused(!state.paused));
  el('btn-clear').addEventListener('click', clearAll);
  el('btn-blackhole').addEventListener('click', () => {
    world.add(blackHole(renderer.centerX, renderer.centerY));
  });
  el('btn-solar').addEventListener('click', loadSolarSystem);
  el('btn-cluster').addEventListener('click', () => {
    clearAll();
    world.addAll(cluster(renderer.centerX, renderer.centerY, state.gravity));
  });

  el('panel-toggle').addEventListener('click', () => {
    document.body.classList.toggle('panel-collapsed');
  });

  /* ---- click-and-drag vector flinging ---- */

  let dragging = false;
  let pointerId = -1;
  const from: Vec2 = { x: 0, y: 0 };
  const to: Vec2 = { x: 0, y: 0 };
  let dragColor: string = COLORS.ghost;

  const localPoint = (e: PointerEvent, out: Vec2) => {
    const rect = stage.getBoundingClientRect();
    out.x = e.clientX - rect.left;
    out.y = e.clientY - rect.top;
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    pointerId = e.pointerId;
    dragColor = randomColor();
    localPoint(e, from);
    to.x = from.x;
    to.y = from.y;
    stage.setPointerCapture(pointerId);
    renderer.drawAim(from, to, radiusForMass(state.spawnMass), dragColor);
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    localPoint(e, to);
    renderer.drawAim(from, to, radiusForMass(state.spawnMass), dragColor);
  });

  const endDrag = (e: PointerEvent, launch: boolean) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
    pointerId = -1;
    renderer.clearOverlay();
    if (!launch) return;

    localPoint(e, to);
    // Drag away from the spawn point to fling in that direction; a bare click
    // (no drag) drops a body at rest.
    world.add(
      makeBody({
        x: from.x,
        y: from.y,
        vx: (to.x - from.x) * FLING_SCALE,
        vy: (to.y - from.y) * FLING_SCALE,
        mass: state.spawnMass,
        color: dragColor,
      }),
    );
  };

  stage.addEventListener('pointerup', (e) => endDrag(e, true));
  stage.addEventListener('pointercancel', (e) => endDrag(e, false));
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---- keyboard ---- */
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    switch (e.key.toLowerCase()) {
      case ' ':
        e.preventDefault();
        setPaused(!state.paused);
        break;
      case 'c':
        clearAll();
        break;
      case 'b':
        world.add(blackHole(renderer.centerX, renderer.centerY));
        break;
      case 'p':
        loadSolarSystem();
        break;
      case 'v':
        vectorsBox.checked = !vectorsBox.checked;
        vectorsBox.dispatchEvent(new Event('change'));
        break;
      case 'h':
        document.body.classList.toggle('panel-collapsed');
        break;
    }
  });

  /* ---- HUD ---- */
  const fpsEl = el('hud-fps');
  const bodiesEl = el('hud-bodies');
  const mergesEl = el('hud-merges');
  const qualityEl = el('hud-quality');

  // Start with something on screen.
  loadSolarSystem();

  return {
    updateHud(fps, bodies, merges, degraded) {
      fpsEl.textContent = String(Math.round(fps));
      bodiesEl.textContent = String(bodies);
      mergesEl.textContent = String(merges);
      qualityEl.textContent = degraded ? 'adaptive' : 'high';
      qualityEl.classList.toggle('is-warn', degraded);
    },
  };
}
