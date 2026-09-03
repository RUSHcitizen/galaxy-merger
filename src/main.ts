/**
 * main.ts — bootstrap and the animation loop.
 *
 * The loop is frame-rate compensated: simulation time advanced per frame is
 * `timeStep` scaled by (real frame time / 16.67ms) and clamped, so the sandbox
 * runs at the same apparent speed on a 60Hz panel, a 120Hz one, or during a
 * hitch — without ever letting one slow frame explode the integrator.
 */

import './style.css';
import { AudioEngine } from './audio';
import { Camera } from './camera';
import { state } from './config';
import { Sparks } from './particles';
import { World } from './physics';
import { QualityController } from './quality';
import { Renderer } from './renderer';
import { initUI } from './ui';

const view = document.getElementById('view') as HTMLCanvasElement;

const quality = new QualityController();
const camera = new Camera();
const renderer = new Renderer(view, camera, quality.profile);
const world = new World();
const sparks = new Sparks();
const audio = new AudioEngine();
const ui = initUI(world, renderer, camera, audio, quality);

// Debounced resize: recreating the backing stores is expensive.
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderer.resize(), 120);
});

// A user gesture is required before audio can start; keyboard counts too.
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

const TARGET_FRAME_MS = 1000 / 60;
/** Diagnostics are an O(n²) pass, so they run a few times a second at most. */
const DIAG_INTERVAL_MS = 400;

let last = performance.now();
let hudTimer = 0;
let diagTimer = DIAG_INTERVAL_MS;

function frame(now: number): void {
  const elapsed = now - last;
  last = now;

  // Clamp so a background-tab stall or a dropped frame cannot teleport bodies.
  const scale = Math.min(2.5, Math.max(0.2, elapsed / TARGET_FRAME_MS));
  const advancing = (!state.paused || state.stepOnce) && world.count > 0;

  camera.update(state.follow ? ui.selected : null);

  if (advancing) {
    // Remember frame-start positions so the renderer can streak between them.
    world.snapshotPositions();

    const steps = Math.max(1, Math.min(quality.profile.maxSubsteps, state.substeps | 0));
    const dt = (state.timeStep * (state.stepOnce ? 1 : scale)) / steps;
    const opts = {
      dt,
      G: state.gravity,
      centerX: renderer.centerX,
      centerY: renderer.centerY,
    };
    for (let i = 0; i < steps; i++) world.step(opts);

    // Once per frame is plenty: merges are a discrete event, not a force.
    if (state.merging) {
      world.resolveCollisions();
      drainMergeEvents();
    }
    world.cull(renderer.centerX, renderer.centerY);
    ui.validateSelection();
    state.stepOnce = false;
  }

  sparks.update(advancing ? scale : 0);
  renderer.render(world.bodies, state, sparks);
  ui.drawOverlay();

  // Quality is driven by measured frame time. A tier change reallocates every
  // buffer, so the controller applies plenty of hysteresis before switching.
  if (quality.update(elapsed)) {
    renderer.setProfile(quality.profile);
    world.maxBodies = quality.profile.maxBodies;
    ui.onQualityChange();
  }

  hudTimer += elapsed;
  if (hudTimer > 250) {
    hudTimer = 0;
    ui.updateHud(quality.fps, world.count, world.mergeCount);
  }

  diagTimer += elapsed;
  if (diagTimer > DIAG_INTERVAL_MS) {
    diagTimer = 0;
    ui.updateDiagnostics(world.diagnostics(state.gravity));
  }

  requestAnimationFrame(frame);
}

/**
 * Turn merges into debris bursts and one aggregated sound. A busy accretion
 * disc can merge dozens of bodies in a single frame; firing a voice per
 * collision would be both inaudible mush and a lot of wasted audio nodes.
 */
function drainMergeEvents(): void {
  const events = world.mergeEvents;
  if (events.length === 0) return;

  let loudest = 0;
  for (let i = 0; i < events.length; i++) {
    const m = events[i];
    const n = Math.min(18, 5 + Math.round(m.scale));
    sparks.emit(m.x, m.y, m.vx, m.vy, m.color, n, 0.6 + m.scale * 0.12);
    if (m.scale > loudest) loudest = m.scale;
  }
  // Scale by the biggest body involved, nudged up when many merged at once.
  audio.merge(Math.min(1, loudest / 14 + (events.length - 1) * 0.05));
  events.length = 0;
}

requestAnimationFrame(frame);
