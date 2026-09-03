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
import type { AudioEngine } from './audio';
import type { QualityController, QualityMode } from './quality';
import { matchShortcut, POINTER_HELP, SHORTCUTS, type ShortcutId } from './shortcuts';
import { CHALLENGES, ChallengeRunner, lagrangeL4, type Challenge } from './challenges';
import { encodeWorld } from './share';

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
  updateHud(fps: number, bodies: number, merges: number): void;
  updateDiagnostics(d: Diagnostics): void;
  /** Drop a selection that no longer exists (merged or culled away). */
  validateSelection(): void;
  /** Re-sync controls after the auto-quality watcher changes tier. */
  onQualityChange(): void;
  /** Redraw the challenge banner (timer, progress). */
  refreshChallenge(): void;
  /** A challenge just finished; refresh the list and play a cue. */
  challengeEnded(win: boolean): void;
  /** The world was replaced wholesale (e.g. by a shared link). */
  onWorldReplaced(): void;
}

export function initUI(
  world: World,
  renderer: Renderer,
  camera: Camera,
  audio: AudioEngine,
  quality: QualityController,
  runner: ChallengeRunner,
): UiHandles {
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
  bindToggle('tides', () => state.tides, (v) => (state.tides = v));
  bindToggle('rotating', () => state.rotatingFrame, (v) => setRotatingFrame(v));

  /* ------------------------------------------------------------ audio ---- */

  bindToggle('sound', () => audio.enabled, (v) => {
    audio.setEnabled(v);
    if (v) audio.ui();
  });
  bindSlider('volume', (v) => (v <= 0 ? 'off' : Math.round(v * 100) + '%'), (v) => {
    audio.setVolume(v);
  });
  // Reflect whatever was restored from localStorage.
  el<HTMLInputElement>('volume').value = String(audio.volume);
  el('volume-value').textContent =
    audio.volume <= 0 ? 'off' : Math.round(audio.volume * 100) + '%';

  /* ---------------------------------------------------------- quality ---- */

  const qualitySelect = el<HTMLSelectElement>('quality');
  qualitySelect.value = quality.mode;
  qualitySelect.addEventListener('change', () => {
    if (quality.setMode(qualitySelect.value as QualityMode)) renderer.setProfile(quality.profile);
    world.maxBodies = quality.profile.maxBodies;
    clampSubsteps();
    audio.ui();
  });

  /** Keep the substeps slider inside what the current tier allows. */
  const substepsInput = el<HTMLInputElement>('substeps');
  const clampSubsteps = () => {
    const max = quality.profile.maxSubsteps;
    substepsInput.max = String(max);
    if (state.substeps > max) {
      state.substeps = max;
      substepsInput.value = String(max);
      el('substeps-value').textContent = String(max);
    }
  };

  /* ----------------------------------------------------------- buttons ---- */

  const setPaused = (paused: boolean) => {
    state.paused = paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('is-active', paused);
    pauseBtn.setAttribute('aria-pressed', String(paused));
    el('btn-step').toggleAttribute('disabled', !paused);
  };

  const select = (body: Body | null) => {
    if (body && body !== selected) audio.select();
    selected = body;
    elements = null;
    if (!body) {
      state.follow = false;
      followBox.checked = false;
      // The rotating frame is defined by the selection; without one there is
      // nothing to co-rotate with.
      if (state.rotatingFrame) setRotatingFrame(false);
    }
    renderInspector();
  };

  const clearAll = () => {
    audio.ui();
    world.clear();
    select(null);
    renderer.clearAll();
  };

  const loadPreset = (id: string) => {
    const preset = presetById(id);
    if (!preset) return;
    audio.scene();
    runner.stop();
    updateBanner();
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

  const spawnBlackHole = () => {
    if (world.add(blackHole(renderer.centerX, renderer.centerY))) audio.blackhole();
  };

  /**
   * Entering or leaving the rotating frame changes the world->screen mapping
   * discontinuously, so the trail buffer — which holds history drawn under the
   * old mapping — has to go.
   */
  const setRotatingFrame = (on: boolean) => {
    state.rotatingFrame = on && !!selected;
    el<HTMLInputElement>('rotating').checked = state.rotatingFrame;
    if (!state.rotatingFrame) camera.setRotation(0);
    renderer.clearAll();
  };

  const recentre = () => {
    const target = selected ?? world.heaviest();
    if (target) camera.centerOn(target.x, target.y);
    else camera.reset();
    syncZoomSlider();
  };

  pauseBtn.addEventListener('click', () => {
    audio.ui();
    setPaused(!state.paused);
  });
  el('btn-step').addEventListener('click', () => {
    state.stepOnce = true;
  });
  el('btn-clear').addEventListener('click', clearAll);
  const deleteSelected = () => {
    if (!selected) return;
    const i = world.bodies.indexOf(selected);
    if (i >= 0) {
      world.bodies.splice(i, 1);
      world.markDirty();
    }
    select(null);
    audio.ui();
  };

  const shareLink = async () => {
    const hash = encodeWorld(world, camera.zoom);
    const url = `${location.origin}${location.pathname}#w=${hash}`;
    history.replaceState(null, '', `#w=${hash}`);
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // Clipboard needs a secure context and permission; the URL bar now holds
      // the link either way, so say so rather than failing silently.
    }
    const btn = el('btn-share');
    btn.textContent = ok ? 'Link copied' : 'Link in address bar';
    setTimeout(() => (btn.textContent = 'Share system'), 1800);
    audio.ui();
  };

  el('btn-share').addEventListener('click', shareLink);
  el('btn-delete').addEventListener('click', deleteSelected);
  el('btn-blackhole').addEventListener('click', spawnBlackHole);
  el('btn-recenter').addEventListener('click', recentre);
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
    const probe = makeBody({
      x: wx, y: wy, mass: state.spawnMass, color: randomColor(), origin: 'player',
    });
    const primary = dominantAttractor(world.bodies, probe, state.gravity);
    if (!primary) {
      if (world.add(probe)) runner.notePlayerBody(probe);
      return;
    }
    const dx = wx - primary.x;
    const dy = wy - primary.y;
    const r = Math.hypot(dx, dy);
    if (r < 1e-3) return;

    audio.launch(2);
    const v = circularSpeed(state.gravity, primary.mass + probe.mass, r);
    // Perpendicular to the radius, in the same sense as the primary's spin.
    probe.vx = primary.vx - (dy / r) * v;
    probe.vy = primary.vy + (dx / r) * v;
    probe.px = probe.x;
    probe.py = probe.y;
    if (world.add(probe)) runner.notePlayerBody(probe);
  };

  stage.addEventListener('pointerdown', (e) => {
    // Browsers only allow an AudioContext to start from a user gesture.
    audio.unlock();
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
        insertOrbiter(camera.worldX(sx, sy), camera.worldY(sx, sy));
        mode = 'none';
        return;
      }
      mode = 'fling';
      dragColor = randomColor();
      from.x = camera.worldX(sx, sy);
      from.y = camera.worldY(sx, sy);
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
      to.x = camera.worldX(sx, sy);
      to.y = camera.worldY(sx, sy);
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
      select(world.pick(camera.worldX(sx, sy), camera.worldY(sx, sy), 8 / camera.zoom));
      return;
    }

    // Drag away from the spawn point to fling in that direction. Dividing by
    // zoom keeps the launch speed tied to world distance, so a drag means the
    // same thing whether you are zoomed in or out.
    const vx = (to.x - from.x) * FLING_SCALE * camera.zoom;
    const vy = (to.y - from.y) * FLING_SCALE * camera.zoom;
    const added = world.add(
      makeBody({
        x: from.x,
        y: from.y,
        vx,
        vy,
        mass: state.spawnMass,
        color: dragColor,
        origin: 'player',
      }),
    );
    if (added) {
      runner.notePlayerBody(added);
      audio.launch(Math.hypot(vx, vy));
    }
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

  /* --------------------------------------------------------- challenges --- */

  const banner = el('banner');
  const challengeList = el('challenge-list');

  const renderChallengeList = () => {
    challengeList.innerHTML = '';
    for (const c of CHALLENGES) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-challenge';
      btn.classList.toggle('is-done', runner.completed.has(c.id));
      btn.innerHTML =
        `<span>${c.title}</span>` +
        (runner.completed.has(c.id) ? '<i class="tick" aria-label="completed">✓</i>' : '');
      btn.title = c.brief;
      btn.addEventListener('click', () => startChallenge(c));
      challengeList.appendChild(btn);
    }
    el('challenge-score').textContent = `${runner.completed.size} / ${CHALLENGES.length}`;
  };

  const startChallenge = (c: Challenge) => {
    audio.scene();
    select(null);
    camera.reset();
    camera.setZoom(c.zoom);
    syncZoomSlider();
    runner.start(c, world, state.gravity);
    renderer.clearAll();
    setPaused(false);
    for (const btn of presetButtons) btn.classList.remove('is-active');
    el('preset-hint').textContent = '';
    updateBanner();
  };

  const endChallenge = () => {
    runner.stop();
    renderChallengeList();
    updateBanner();
  };

  function updateBanner(): void {
    const c = runner.active;
    if (!c) {
      banner.className = 'banner';
      banner.innerHTML = '';
      return;
    }
    const done = runner.state !== 'pending';
    banner.className = 'banner is-open' + (done ? ` is-${runner.state}` : '');

    const pct = Math.round(runner.progress * 100);
    const time = Math.ceil(runner.remaining);
    const status = done
      ? runner.state === 'success'
        ? 'Complete'
        : 'Out of time'
      : `${Math.floor(time / 60)}:${String(time % 60).padStart(2, '0')}`;

    banner.innerHTML =
      `<div class="banner-head"><b>${c.title}</b><span class="banner-time">${status}</span>` +
      `<button class="icon-btn" data-close aria-label="End challenge">×</button></div>` +
      `<p>${done && runner.state === 'failed' ? c.hint : c.brief}</p>` +
      `<div class="meter"><i style="width:${pct}%"></i></div>`;

    const close = banner.querySelector('[data-close]');
    close?.addEventListener('click', endChallenge);
  }

  el('btn-challenge-reset').addEventListener('click', () => {
    runner.completed.clear();
    try {
      localStorage.removeItem('cgs.challenges');
    } catch {
      /* ignore */
    }
    renderChallengeList();
    audio.ui();
  });

  renderChallengeList();

  /* ------------------------------------------------------- help overlay --- */

  const help = el('help');
  const helpClose = el('btn-help-close');

  /** Render the overlay from the shortcut registry, so it cannot drift. */
  function buildHelp(): void {
    const groups = new Map<string, string[]>();
    for (const sc of SHORTCUTS) {
      const row = `<div><span>${sc.label}</span><kbd>${sc.keys.join('</kbd><kbd>')}</kbd></div>`;
      const list = groups.get(sc.group);
      if (list) list.push(row);
      else groups.set(sc.group, [row]);
    }
    const pointer = POINTER_HELP.map(
      (p) => `<div><span>${p.label}</span><kbd>${p.keys.join('</kbd><kbd>')}</kbd></div>`,
    ).join('');

    el('help-grid').innerHTML =
      `<section><h3>Mouse</h3>${pointer}</section>` +
      [...groups]
        .map(([name, rows]) => `<section><h3>${name}</h3>${rows.join('')}</section>`)
        .join('');
  }

  const setHelp = (open: boolean) => {
    help.classList.toggle('is-open', open);
    help.setAttribute('aria-hidden', String(!open));
    if (open) helpClose.focus();
  };
  const helpOpen = () => help.classList.contains('is-open');

  buildHelp();
  helpClose.addEventListener('click', () => setHelp(false));
  el('btn-help').addEventListener('click', () => {
    audio.ui();
    setHelp(!helpOpen());
  });
  help.addEventListener('click', (e) => {
    // Click the backdrop (but not the dialog) to dismiss.
    if (e.target === help) setHelp(false);
  });

  /* ---------------------------------------------------------- keyboard ---- */

  /** One action per shortcut id — the registry decides which keys reach here. */
  const actions: Record<ShortcutId, (e: KeyboardEvent) => void> = {
    pause: () => setPaused(!state.paused),
    step: () => {
      if (state.paused) state.stepOnce = true;
    },
    clear: () => clearAll(),
    blackhole: () => spawnBlackHole(),
    scene: (e) => {
      const i = Number(e.key) - 1;
      if (i < PRESETS.length) loadPreset(PRESETS[i].id);
    },
    recentre: () => recentre(),
    orbits: () => setToggleState('show-orbits', (state.showOrbits = !state.showOrbits)),
    vectors: () => setToggleState('show-vectors', (state.showVectors = !state.showVectors)),
    predict: () => setToggleState('predict', (state.predict = !state.predict)),
    follow: () => {
      if (!selected) return;
      state.follow = !state.follow;
      setToggleState('follow', state.follow);
    },
    deselect: () => {
      if (helpOpen()) setHelp(false);
      else select(null);
    },
    mute: () => {
      audio.setEnabled(!audio.enabled);
      setToggleState('sound', audio.enabled);
      audio.ui();
    },
    rotframe: () => setRotatingFrame(!state.rotatingFrame),
    delete: () => deleteSelected(),
    panel: () => document.body.classList.toggle('panel-collapsed'),
    help: () => setHelp(!helpOpen()),
  };

  const setToggleState = (id: string, on: boolean) => {
    el<HTMLInputElement>(id).checked = on;
  };

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    const id = matchShortcut(e);
    if (!id) return;

    // While the help overlay is up only Escape and ? do anything, so the list
    // cannot be read and acted on at the same time by accident.
    if (helpOpen() && id !== 'deselect' && id !== 'help') return;

    if (e.key === ' ' || e.key === '/') e.preventDefault();
    audio.unlock();
    actions[id](e);
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
  const memEl = el('hud-mem');
  const energyEl = el('hud-energy');
  const angularEl = el('hud-angular');

  world.maxBodies = quality.profile.maxBodies;
  clampSubsteps();
  loadPreset('solar');
  setPaused(false);
  select(null);

  return {
    refreshChallenge: updateBanner,
    onWorldReplaced() {
      select(null);
      runner.stop();
      updateBanner();
      for (const btn of presetButtons) btn.classList.remove('is-active');
      el('preset-hint').textContent = '';
      syncZoomSlider();
    },

    challengeEnded(win: boolean) {
      renderChallengeList();
      updateBanner();
      if (win) audio.scene();
      else audio.ui();
    },

    get selected() {
      return selected;
    },
    get elements() {
      return elements;
    },

    validateSelection() {
      if (selected && !world.bodies.includes(selected)) select(null);
    },

    onQualityChange() {
      clampSubsteps();
      qualitySelect.value = quality.mode;
    },

    drawOverlay() {
      // Co-rotate with the selection's orbit. The angle is the negative of the
      // body's current bearing from its primary, which pins it to a fixed
      // direction on screen and freezes the Lagrange points with it.
      if (state.rotatingFrame && selected) {
        const primary = dominantAttractor(world.bodies, selected, state.gravity);
        if (primary) {
          camera.setRotation(-Math.atan2(selected.y - primary.y, selected.x - primary.x));
          camera.centerOn(primary.x, primary.y);
        }
      }

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

      // Mark L4 while its challenge is running, so the target is visible.
      if (runner.active?.id === 'trojan') {
        const l4 = lagrangeL4(world);
        if (l4) renderer.drawTarget(l4.x, l4.y, 60, COLORS.lagrange, 'L4');
      }

      renderer.drawScaleBar();
    },

    updateHud(fps, bodies, merges) {
      fpsEl.textContent = String(Math.round(fps));
      bodiesEl.textContent = `${bodies} / ${quality.profile.maxBodies}`;
      mergesEl.textContent = String(merges);
      qualityEl.textContent =
        quality.profile.label + (quality.mode === 'auto' ? ' (auto)' : '');
      qualityEl.classList.toggle('is-warn', quality.tier !== 'high');
      memEl.textContent = renderer.spriteMB.toFixed(1) + ' MB';
      syncZoomSlider();
      if (selected) renderInspector();
    },

    updateDiagnostics(d) {
      energyEl.textContent = fmt(d.total, 2);
      angularEl.textContent = fmt(d.angularMomentum, 2);
    },
  };
}
