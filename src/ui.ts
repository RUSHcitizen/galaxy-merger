/**
 * ui.ts — DOM controls, keyboard shortcuts, pointer interaction and the
 * selected-body inspector.
 *
 * Pointer grammar:
 *   left drag on empty space   fling a new body along the drag vector
 *   left click on a body       select it (inspector + Kepler ellipse)
 *   shift + click              insert a body on a circular orbit there
 *   right / middle drag        pan the camera
 *   wheel                      zoom about the cursor
 */

import {
  CAMERA,
  COLORS,
  FLING_SCALE,
  PHYSICS,
  PREDICT,
  randomColor,
  state,
} from './config';
import type { Camera } from './camera';
import { makeBody, radiusForMass, World, type Body, type Diagnostics } from './physics';
import {
  circularSpeed,
  dominantAttractor,
  elementsFor,
  predictPath,
  type OrbitElements,
} from './orbits';
import { blackHole, PRESETS, presetById } from './presets';
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

function bindToggle(id: string, get: () => boolean, set: (v: boolean) => void): HTMLInputElement {
  const input = el<HTMLInputElement>(id);
  input.checked = get();
  input.addEventListener('change', () => set(input.checked));
  return input;
}

/** Compact number formatting for the HUD: 12.3k, 4.56M, 0.0031. */
function fmt(n: number, digits = 2): string {
  if (!isFinite(n)) return '∞';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(digits) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(digits) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(digits) + 'k';
  if (abs >= 1) return n.toFixed(digits);
  if (abs === 0) return '0';
  return n.toPrecision(2);
}

/* ---------------------------------------------------------------- interface */

export interface UiHandles {
  /** Body the user has selected, if any (cleared automatically when merged). */
  readonly selected: Body | null;
  /** Elements of the selection about its dominant attractor, recomputed live. */
  readonly elements: OrbitElements | null;
  /** Called by the loop once per frame to draw drag previews and selection. */
  drawOverlay(): void;
  updateHud(fps: number, bodies: number, merges: number, degraded: boolean): void;
  updateDiagnostics(d: Diagnostics): void;
  /** Drop a selection that no longer exists (merged or culled away). */
  validateSelection(): void;
}

export function initUI(world: World, renderer: Renderer, camera: Camera): UiHandles {
  const stage = el<HTMLElement>('stage');
  const pauseBtn = el<HTMLButtonElement>('btn-pause');

  let selected: Body | null = null;
  let elements: OrbitElements | null = null;

  /* ---------------------------------------------------------- controls ---- */

  bindSlider('time-step', (v) => v.toFixed(2) + '×', (v) => (state.timeStep = v));
  bindSlider('gravity', (v) => v.toFixed(2), (v) => (state.gravity = v));
  bindSlider(
    'trail',
    (v) => (v <= 0 ? 'off' : Math.round(v * 100) + '%'),
    (v) => (state.trail = v),
  );
  bindSlider(
    'bloom',
    (v) => (v <= 0 ? 'off' : Math.round(v * 100) + '%'),
    (v) => (state.bloom = v),
  );
  bindSlider('spawn-mass', (v) => fmt(v, 0), (v) => (state.spawnMass = v));
  bindSlider('substeps', (v) => String(Math.round(v)), (v) => (state.substeps = Math.round(v)));

  const zoomSlider = bindSlider(
    'zoom',
    (v) => v.toFixed(2) + '×',
    (v) => {
      if (Math.abs(v - camera.zoom) > 1e-4) camera.setZoom(v);
    },
  );
  const syncZoomSlider = () => {
    zoomSlider.value = String(camera.zoom);
    el('zoom-value').textContent = camera.zoom.toFixed(2) + '×';
  };

  bindToggle('glow', () => state.glow, (v) => {
    state.glow = v;
    renderer.clearAll();
  });
  bindToggle('stars', () => state.stars, (v) => {
    state.stars = v;
    camera.setZoom(camera.zoom); // force a starfield redraw
  });
  bindToggle('show-vectors', () => state.showVectors, (v) => (state.showVectors = v));
  bindToggle('merging', () => state.merging, (v) => (state.merging = v));
  bindToggle('show-orbits', () => state.showOrbits, (v) => (state.showOrbits = v));
  bindToggle('predict', () => state.predict, (v) => (state.predict = v));
  const followBox = bindToggle('follow', () => state.follow, (v) => (state.follow = v));

  /* ----------------------------------------------------------- buttons ---- */

  const setPaused = (paused: boolean) => {
    state.paused = paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('is-active', paused);
    pauseBtn.setAttribute('aria-pressed', String(paused));
    el('btn-step').toggleAttribute('disabled', !paused);
  };

  const select = (body: Body | null) => {
    selected = body;
    elements = null;
    if (!body) {
      state.follow = false;
      followBox.checked = false;
    }
    renderInspector();
  };

  const clearAll = () => {
    world.clear();
    select(null);
    renderer.clearAll();
  };

  const loadPreset = (id: string) => {
    const preset = presetById(id);
    if (!preset) return;
    clearAll();
    camera.reset();
    camera.setZoom(preset.zoom);
    syncZoomSlider();
    world.addAll(preset.build(0, 0, state.gravity));
    el('preset-hint').textContent = preset.hint;
    for (const btn of presetButtons) btn.classList.toggle('is-active', btn.dataset.preset === id);
  };

  // Preset buttons are generated from the registry so adding a scene is a
  // one-line change in presets.ts.
  const presetGrid = el('presets');
  const presetButtons: HTMLButtonElement[] = PRESETS.map((p) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-preset';
    btn.textContent = p.label;
    btn.dataset.preset = p.id;
    btn.title = p.hint;
    btn.addEventListener('click', () => loadPreset(p.id));
    presetGrid.appendChild(btn);
    return btn;
  });

  pauseBtn.addEventListener('click', () => setPaused(!state.paused));
  el('btn-step').addEventListener('click', () => {
    state.stepOnce = true;
  });
  el('btn-clear').addEventListener('click', clearAll);
  el('btn-blackhole').addEventListener('click', () => {
    world.add(blackHole(renderer.centerX, renderer.centerY));
  });
  el('btn-recenter').addEventListener('click', () => {
    const target = selected ?? world.heaviest();
    if (target) camera.centerOn(target.x, target.y);
    else camera.reset();
    syncZoomSlider();
  });
  el('panel-toggle').addEventListener('click', () => {
    document.body.classList.toggle('panel-collapsed');
  });

  /* -------------------------------------------------------- interaction --- */

  type Mode = 'none' | 'fling' | 'pan';
  let mode: Mode = 'none';
  let pointerId = -1;
  let dragged = false;
  /** Drag endpoints in world space. */
  const from = { x: 0, y: 0 };
  const to = { x: 0, y: 0 };
  /** Last pointer position in screen space, for panning. */
  let lastScreenX = 0;
  let lastScreenY = 0;
  let dragColor: string = COLORS.ghost;

  const pathBuffer = new Float32Array(PREDICT.STEPS * 2);
  let pathCount = 0;

  const screenPos = (e: PointerEvent): [number, number] => {
    const rect = stage.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  /**
   * Insert a body on a circular orbit about whatever is pulling hardest at that
   * point — the quickest way to build a stable system by hand.
   */
  const insertOrbiter = (wx: number, wy: number) => {
    const probe = makeBody({ x: wx, y: wy, mass: state.spawnMass, color: randomColor() });
    const primary = dominantAttractor(world.bodies, probe, state.gravity);
    if (!primary) {
      world.add(probe);
      return;
    }
    const dx = wx - primary.x;
    const dy = wy - primary.y;
    const r = Math.hypot(dx, dy);
    if (r < 1e-3) return;

    const v = circularSpeed(state.gravity, primary.mass + probe.mass, r);
    // Perpendicular to the radius, in the same sense as the primary's spin.
    probe.vx = primary.vx - (dy / r) * v;
    probe.vy = primary.vy + (dx / r) * v;
    probe.px = probe.x;
    probe.py = probe.y;
    world.add(probe);
  };

  stage.addEventListener('pointerdown', (e) => {
    const [sx, sy] = screenPos(e);
    lastScreenX = sx;
    lastScreenY = sy;
    dragged = false;
    pointerId = e.pointerId;
    stage.setPointerCapture(pointerId);

    if (e.button === 1 || e.button === 2 || e.altKey) {
      mode = 'pan';
      stage.classList.add('is-panning');
    } else if (e.button === 0) {
      if (e.shiftKey) {
        insertOrbiter(camera.worldX(sx), camera.worldY(sy));
        mode = 'none';
        return;
      }
      mode = 'fling';
      dragColor = randomColor();
      from.x = camera.worldX(sx);
      from.y = camera.worldY(sy);
      to.x = from.x;
      to.y = from.y;
      pathCount = 0;
    }
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId || mode === 'none') return;
    const [sx, sy] = screenPos(e);
    const dx = sx - lastScreenX;
    const dy = sy - lastScreenY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragged = true;

    if (mode === 'pan') {
      camera.panByScreen(dx, dy);
      state.follow = false;
      followBox.checked = false;
    } else {
      to.x = camera.worldX(sx);
      to.y = camera.worldY(sy);
    }
    lastScreenX = sx;
    lastScreenY = sy;
  });

  const endDrag = (e: PointerEvent, commit: boolean) => {
    if (e.pointerId !== pointerId) return;
    if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
    pointerId = -1;
    stage.classList.remove('is-panning');
    const wasMode = mode;
    mode = 'none';
    pathCount = 0;
    if (!commit || wasMode !== 'fling') return;

    if (!dragged) {
      // A click, not a drag: select whatever is under the cursor.
      const [sx, sy] = screenPos(e);
      select(world.pick(camera.worldX(sx), camera.worldY(sy), 8 / camera.zoom));
      return;
    }

    // Drag away from the spawn point to fling in that direction. Dividing by
    // zoom keeps the launch speed tied to world distance, so a drag means the
    // same thing whether you are zoomed in or out.
    world.add(
      makeBody({
        x: from.x,
        y: from.y,
        vx: (to.x - from.x) * FLING_SCALE * camera.zoom,
        vy: (to.y - from.y) * FLING_SCALE * camera.zoom,
        mass: state.spawnMass,
        color: dragColor,
      }),
    );
  };

  stage.addEventListener('pointerup', (e) => endDrag(e, true));
  stage.addEventListener('pointercancel', (e) => endDrag(e, false));
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = e.deltaY < 0 ? CAMERA.ZOOM_STEP : 1 / CAMERA.ZOOM_STEP;
      camera.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
      syncZoomSlider();
    },
    { passive: false },
  );

  /* ---------------------------------------------------------- keyboard ---- */

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    if (e.key >= '1' && e.key <= String(Math.min(9, PRESETS.length))) {
      loadPreset(PRESETS[Number(e.key) - 1].id);
      return;
    }

    switch (e.key.toLowerCase()) {
      case ' ':
        e.preventDefault();
        setPaused(!state.paused);
        break;
      case '.':
        if (state.paused) state.stepOnce = true;
        break;
      case 'c':
        clearAll();
        break;
      case 'b':
        world.add(blackHole(renderer.centerX, renderer.centerY));
        break;
      case 'f':
        if (selected) {
          state.follow = !state.follow;
          followBox.checked = state.follow;
        }
        break;
      case 'o':
        state.showOrbits = !state.showOrbits;
        el<HTMLInputElement>('show-orbits').checked = state.showOrbits;
        break;
      case 'v':
        state.showVectors = !state.showVectors;
        el<HTMLInputElement>('show-vectors').checked = state.showVectors;
        break;
      case 'escape':
        select(null);
        break;
      case 'h':
        document.body.classList.toggle('panel-collapsed');
        break;
    }
  });

  /* --------------------------------------------------------- inspector ---- */

  const inspector = el('inspector');
  const inspectorBody = el('inspector-body');

  function renderInspector(): void {
    if (!selected) {
      inspector.classList.add('is-empty');
      inspectorBody.innerHTML =
        '<p class="muted">Click a body to inspect its orbit.</p>';
      return;
    }
    inspector.classList.remove('is-empty');

    const b = selected;
    const speed = Math.hypot(b.vx, b.vy);
    const rows: Array<[string, string]> = [
      ['Mass', fmt(b.mass, 1)],
      ['Radius', fmt(b.radius, 1)],
      ['Speed', fmt(speed, 2)],
    ];

    if (elements) {
      const o = elements;
      rows.push(['Orbiting', o.primary.kind === 'blackhole' ? 'black hole' : `mass ${fmt(o.primary.mass, 1)}`]);
      rows.push(['Distance', fmt(o.r, 1)]);
      if (o.bound) {
        rows.push(['Semi-major a', fmt(o.a, 1)]);
        rows.push(['Eccentricity', o.e.toFixed(3)]);
        rows.push(['Periapsis', fmt(o.periapsis, 1)]);
        rows.push(['Apoapsis', fmt(o.apoapsis, 1)]);
        rows.push(['Period', fmt(o.period, 0) + ' t']);
      } else {
        rows.push(['Trajectory', o.e >= 1 ? 'hyperbolic — escaping' : 'unbound']);
        rows.push(['Eccentricity', o.e.toFixed(3)]);
      }
    }

    inspectorBody.innerHTML = rows
      .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`)
      .join('');
    const swatch = el('inspector-swatch');
    swatch.style.background = b.color;
  }

  /* --------------------------------------------------------------- HUD ---- */

  const fpsEl = el('hud-fps');
  const bodiesEl = el('hud-bodies');
  const mergesEl = el('hud-merges');
  const qualityEl = el('hud-quality');
  const energyEl = el('hud-energy');
  const angularEl = el('hud-angular');

  loadPreset('solar');
  setPaused(false);
  select(null);

  return {
    get selected() {
      return selected;
    },
    get elements() {
      return elements;
    },

    validateSelection() {
      if (selected && !world.bodies.includes(selected)) select(null);
    },

    drawOverlay() {
      // Live orbital elements for the selection.
      if (selected) {
        const primary = dominantAttractor(world.bodies, selected, state.gravity);
        elements = primary ? elementsFor(selected, primary, state.gravity) : null;
        if (state.showOrbits && elements) renderer.drawOrbit(elements);
        renderer.drawSelection(selected, elements);
      } else {
        elements = null;
      }

      // Drag preview: aim arrow plus the forward-integrated path.
      if (mode === 'fling' && dragged) {
        const vx = (to.x - from.x) * FLING_SCALE * camera.zoom;
        const vy = (to.y - from.y) * FLING_SCALE * camera.zoom;
        if (state.predict) {
          pathCount = predictPath(
            world.bodies, from.x, from.y, vx, vy, state.gravity, pathBuffer,
          );
          renderer.drawPath(pathBuffer, pathCount, COLORS.predict);
        }
        renderer.drawAim(from, to, radiusForMass(state.spawnMass), dragColor);
      }

      renderer.drawScaleBar();
    },

    updateHud(fps, bodies, merges, degraded) {
      fpsEl.textContent = String(Math.round(fps));
      bodiesEl.textContent = `${bodies} / ${PHYSICS.MAX_BODIES}`;
      mergesEl.textContent = String(merges);
      qualityEl.textContent = degraded ? 'adaptive' : 'high';
      qualityEl.classList.toggle('is-warn', degraded);
      syncZoomSlider();
      if (selected) renderInspector();
    },

    updateDiagnostics(d) {
      energyEl.textContent = fmt(d.total, 2);
      angularEl.textContent = fmt(d.angularMomentum, 2);
    },
  };
}
