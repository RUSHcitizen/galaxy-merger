/**
 * main.ts — bootstrap and the animation loop.
 *
 * The loop is frame-rate compensated: simulation time advanced per frame is
 * `timeStep` scaled by (real frame time / 16.67ms) and clamped, so the sandbox
 * runs at the same apparent speed on a 60Hz panel, a 120Hz one, or during a
 * hitch — without ever letting one slow frame explode the integrator.
 */

import './style.css';
import { state } from './config';
import { World } from './physics';
import { Renderer } from './renderer';
import { initUI } from './ui';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;

const renderer = new Renderer(canvas, overlay);
const world = new World();
const ui = initUI(world, renderer);

// Debounced resize: recreating the backing store is expensive.
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderer.resize(), 120);
});

const TARGET_FRAME_MS = 1000 / 60;
let last = performance.now();
let hudTimer = 0;

function frame(now: number): void {
  const elapsed = now - last;
  last = now;

  // Clamp so a background-tab stall or a dropped frame cannot teleport bodies.
  const scale = Math.min(2.5, Math.max(0.2, elapsed / TARGET_FRAME_MS));

  if (!state.paused && world.count > 0) {
    // Remember frame-start positions so the renderer can streak between them.
    world.snapshotPositions();
    const steps = Math.max(1, state.substeps | 0);
    const dt = (state.timeStep * scale) / steps;
    const opts = {
      dt,
      G: state.gravity,
      centerX: renderer.centerX,
      centerY: renderer.centerY,
    };
    for (let i = 0; i < steps; i++) world.step(opts);

    // Once per frame is plenty: merges are a discrete event, not a force.
    world.resolveCollisions();
    world.cull(renderer.centerX, renderer.centerY);
  }

  renderer.render(world.bodies, state);
  renderer.reportFrameTime(elapsed);

  hudTimer += elapsed;
  if (hudTimer > 250) {
    hudTimer = 0;
    ui.updateHud(renderer.fps, world.count, world.mergeCount, renderer.degraded);
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
