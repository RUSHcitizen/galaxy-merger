# Cosmic Gravity Sandbox

An N-body Newtonian gravity sandbox — fling planets with the mouse, drop a black
hole in the middle and watch everything accrete. Vite + vanilla TypeScript,
rendered on a plain HTML5 canvas with no runtime dependencies.

## Run it

```bash
npm install
npm run dev
```

That is the only command you need — `dev` is already `vite --host`, and
`vite.config.ts` sets `server.host = true`, so the dev server binds to
`0.0.0.0` and Vite prints both a **Local** and a **Network** URL:

```
➜  Local:   http://localhost:5173/
➜  Network: http://192.168.1.24:5173/
```

### Reaching it over Tailscale

From another device on your tailnet, open `http://<machine>:5173` using the
host's Tailscale IP (`tailscale ip -4`) or its MagicDNS name
(`http://my-macbook.tailnet-name.ts.net:5173`). `allowedHosts` in
`vite.config.ts` already whitelists `.ts.net`, which Vite would otherwise
reject as an unrecognised Host header.

Other scripts:

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server on all interfaces (LAN + Tailscale) |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve the built bundle, also on all interfaces |
| `npm run typecheck` | `tsc --noEmit` only |

## Controls

- **Click and drag** anywhere on the void to fling a body. The dashed arrow is
  its launch vector; a plain click drops one at rest.
- **Sliders** — time step, gravity (G), trail length, spawn mass, substeps.
- **Buttons** — pause, clear, spawn a central black hole, load the stable solar
  system preset, load an accretion cluster.
- **Keys** — `Space` pause · `C` clear · `B` black hole · `P` preset ·
  `V` velocity vectors · `H` hide panel.

## Structure

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Physics constants, render constants, palette, mutable UI state |
| `src/physics.ts` | Vector maths, `World`, the force loop, leapfrog integrator, merges |
| `src/renderer.ts` | Canvas rendering: persistence trails, glow sprites, aim overlay |
| `src/ui.ts` | DOM controls, drag-to-fling, keyboard, scene presets |
| `src/main.ts` | Bootstrap and the animation loop |
| `src/style.css` | Dark-mode framing |
| `index.html` | Markup shell |

## How it works

**Gravity.** Every unordered pair is visited once and Newton's third law
supplies the other half, so the cost is n²/2 rather than n²:

```
a_i = Σ G·m_j·(r_j − r_i) / (|r_j − r_i|² + ε²)^(3/2)
```

The ε (Plummer softening, `PHYSICS.SOFTENING`) keeps the force finite when two
bodies pass very close, instead of launching one to infinity.

**Integration.** Kick-drift-kick leapfrog, which is symplectic: circular orbits
stay circular instead of spiralling the way forward Euler does. Acceleration is
carried on the body between steps, so each step needs one force evaluation.
Measured drift over 40,000 steps of a circular orbit is 0.03% of the radius.

**Merging.** Perfectly inelastic and exactly conservative:

```
m = m₁ + m₂        v = (m₁v₁ + m₂v₂) / m        x = (m₁x₁ + m₂x₂) / m
```

Radius follows constant density, r ∝ m^(1/3), so merging two equal discs gives
r = ∛2·r₁ rather than 2·r₁.

## Rendering, and why it is fast

The target was a smooth 60fps on a 2017 MacBook Pro, i.e. a ~16ms frame budget
on an Intel integrated GPU. What that ruled in and out:

- **Trails are a persistence buffer, not geometry.** Instead of clearing, the
  canvas is erased slightly each frame with one `destination-out` rect. Cost is
  a single fill regardless of body count — keeping a point history per body and
  stroking thousands of segments would not fit the budget. The trail-length
  slider sets the erase alpha.
- **No `shadowBlur`.** It is the obvious way to get neon and it is brutally slow
  on integrated GPUs. Glows are pre-rasterised radial-gradient sprites drawn
  with `drawImage` under `'lighter'` blending.
- **The sprite cache is bounded three ways.** Radii are bucketed, colours are
  quantised (merges blend colours, which would otherwise mint a unique gradient
  per body), eviction is LRU rather than a wholesale flush, and at most
  `RENDER.SPRITE_BUDGET` gradients may be rasterised in one frame — anything
  past that falls back to a plain disc. Before these bounds, 600 uniquely
  coloured bodies cost 90ms/frame because the cache flushed and re-rasterised
  every frame; after, 22ms.
- **Motion streaks.** A round-capped line from each body's previous position to
  its current one. Without it a body travelling faster than its own diameter per
  frame paints a dotted line into the persistence buffer. Bodies that barely
  moved are skipped.
- **DPR is capped at 2.** A retina 15" panel at full ratio is ~5M pixels of fill
  per frame.
- **Off-screen bodies are skipped** before touching the rasteriser, and escapees
  are culled from the simulation entirely.
- **Quality degrades automatically.** If smoothed frame time drifts above 21ms
  the renderer shrinks glows and draws tiny bodies as discs, recovering when it
  drops back under 14ms. The HUD shows `high` or `adaptive`.
- **The hot loop never allocates.** No temporary vector objects per pair; the
  aim arrow lives on a separate overlay canvas so transient UI never smears into
  the trail buffer, and that canvas is only touched while dragging.

Measured physics cost per step (one force evaluation, no merging):

| Bodies | Force loop | Collision pass |
| --- | --- | --- |
| 100 | 0.04 ms | 0.05 ms |
| 250 | 0.21 ms | 0.15 ms |
| 500 | 0.82 ms | 0.66 ms |
| 900 | 2.68 ms | 2.14 ms |

At the default 2 substeps, a 250-body scene spends ~0.6ms per frame on physics,
leaving essentially the whole budget for drawing. `PHYSICS.MAX_BODIES` caps the
world at 900; near that ceiling, drop substeps to 1.

## Tuning

Nearly everything worth changing is a named constant in `src/config.ts` —
gravitational constant, softening length, collision overlap, density, body cap,
cull radius, glow size, DPR cap and the adaptive-quality thresholds.
