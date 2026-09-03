# Cosmic Gravity Sandbox

An N-body Newtonian gravity sandbox. Fling planets with the mouse, select one to
read its live Keplerian orbital elements, drop a black hole in the middle and
watch a galaxy merger throw off tidal tails. Vite + vanilla TypeScript, rendered
on a plain HTML5 canvas with **no runtime dependencies**.

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

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server on all interfaces (LAN + Tailscale) |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve the built bundle, also on all interfaces |
| `npm run typecheck` | `tsc --noEmit` only |

## Controls

| Input | Action |
| --- | --- |
| **Drag** on empty space | Fling a new body along the drag vector; the preview shows where it will actually go |
| **Click** a body | Select it — inspector, selection ring and its Kepler ellipse |
| **Shift-click** | Insert a body on a circular orbit about whatever dominates there |
| **Right / middle drag** | Pan the camera |
| **Wheel** | Zoom about the cursor |

Press `?` in the app for the full keyboard list. It is generated from
`src/shortcuts.ts`, the same registry the key handler dispatches from, so a
shortcut cannot end up documented but unhandled (or the reverse).

`Space` pause · `.` single step · `C` clear · `B` black hole · `R` recentre ·
`F` follow · `O` orbit ellipse · `V` velocity vectors · `T` trajectory preview ·
`M` mute · `G` rotating frame · `Del` delete selected · `1`–`6` scenes ·
`Esc` deselect · `H` hide panel · `?` shortcuts.

## Sound

Effects are synthesized with the Web Audio API — oscillators and one shared
noise buffer — so the project still ships zero audio assets and works offline.
Collisions thud with a pitch set by the mass involved, flings sweep, black holes
drop a sub-bass swell, and the UI ticks.

Two constraints shape the implementation. Browsers refuse to start an
`AudioContext` before a user gesture, so it is created lazily on the first real
interaction rather than at load. And merges are not rare — an accretion disc can
produce dozens in a single frame — so every sound passes a voice cap and a
per-kind minimum interval, and the loop aggregates a frame's merges into one
call. Measured under a heavy merge storm that holds voice creation to ~10/s.
Mute state and volume persist in `localStorage`.

## Challenges

Six missions, each scored from the live simulation in orbital-mechanics terms
rather than by anything the game hands you. Progress is saved locally.

| Mission | Objective |
| --- | --- |
| **Make Orbit** | Get anything into a closed orbit and hold it 10s |
| **Circularize** | Hold eccentricity under 0.08 for 8s |
| **Thread the Needle** | Park in the lane between two planets, without disturbing either |
| **Gravity Assist** | Escape the system using the giant — a straight burn out does not count |
| **Lagrange Parking** | Hold station at L4 for 12s |
| **Feed the Void** | Push three rocks' worth of mass past an event horizon in 90s |

Conditions that must *hold* accumulate in seconds, so clipping through the right
state for a single frame never counts. Each mission was tested two ways: played
by a script to confirm it is winnable, and left completely idle for its full
time limit to confirm it cannot complete itself. Both checks caught real
problems — see below.

## Scenes

| Scene | What it demonstrates |
| --- | --- |
| **Solar system** | Six planets spaced for genuine Hill stability, one with a moon |
| **Binary stars** | Two stars about their barycentre with circumbinary planets |
| **Figure eight** | The Chenciner–Montgomery three-body choreography |
| **Lagrange trojans** | Asteroids librating at the stable L4/L5 points |
| **Accretion disc** | A dense disc grinding itself down into a few large bodies |
| **Galaxy merger** | Two counter-rotating discs on a grazing pass, throwing tidal tails |

## Structure

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Physics/render constants, palette, mutable UI state |
| `src/physics.ts` | Vector maths, `World`, force loop, leapfrog, merges, diagnostics |
| `src/orbits.ts` | Keplerian elements, primary selection, trajectory prediction |
| `src/camera.ts` | World↔screen transform, pan, zoom, follow |
| `src/renderer.ts` | Persistence trails, glow sprites, bloom, starfield, overlays |
| `src/particles.ts` | Merge debris sparks |
| `src/presets.ts` | The six scenes |
| `src/audio.ts` | Synthesized sound effects, voice capping, rate limiting |
| `src/quality.ts` | Quality tiers and the frame-time watcher |
| `src/shortcuts.ts` | The keyboard registry both the handler and overlay read |
| `src/challenges.ts` | The six missions and the run/scoring state machine |
| `src/share.ts` | World serialization to and from a URL fragment |
| `src/ui.ts` | Controls, pointer grammar, inspector, help overlay |
| `src/main.ts` | Bootstrap and the animation loop |

## Tidal disruption

A body closer to its primary than the Roche limit is pulled apart, because the
difference in gravitational pull across its own width exceeds the self-gravity
holding it together:

```
d_roche = k · R_primary · (rho_primary / rho_satellite)^(1/3)
```

with k ≈ 1.26 rigid and 2.44 fluid. Every body shares one density here, so the
limit is a constant times the primary's radius. Fragments are laid out along the
orbital direction with a velocity shear — inner pieces orbit faster — which is
what produces the long debris streams seen in real disruption events. Mass and
momentum are conserved exactly (measured error: zero), because the offsets are
symmetric about the parent.

Fragments get a brief grace period during which they refuse to merge, or they
would recombine into the parent on the next step. That grace applies only when
*both* bodies are in it — an earlier version required just one, which let a
fragment fall straight *through* the black hole that shredded it, pick up an
enormous badly-integrated kick from the centre of the potential well, and get
flung back out at escape speed. That single rule made one mission unwinnable.

## Rotating reference frame

Press `G` with a body selected to co-rotate with its orbit. Its primary and the
body itself go still, and the Lagrange points — which are fixed points only in
this frame — stop moving, so the trojan clouds visibly librate around L4 and L5
instead of sweeping around the star. Verified numerically: a body on a circular
orbit, viewed co-rotating, stays within 0.02px on screen over 600 steps.

The trail buffer is deliberately *not* reprojected when the frame angle changes.
Each trail pixel was drawn under the mapping in force at the time, which is
exactly the trajectory in that frame; only pan and zoom invalidate it.

## The physics

**Gravity.** Every unordered pair is visited once and Newton's third law supplies
the other half, so the cost is n²/2 rather than n²:

```
a_i = Σ G·m_j·(r_j − r_i) / (|r_j − r_i|² + ε²)^(3/2)
```

The ε (Plummer softening, `PHYSICS.SOFTENING`) keeps the force finite when two
bodies pass very close instead of launching one to infinity.

**Integration.** Kick-drift-kick leapfrog, which is symplectic: circular orbits
stay circular instead of spiralling the way forward Euler does. Acceleration is
carried on the body between steps, so each step needs one force evaluation.
Measured drift over 40,000 steps of a circular orbit is 0.03% of the radius.

**Merging.** Perfectly inelastic and exactly conservative — measured error on
both mass and momentum is zero:

```
m = m₁ + m₂        v = (m₁v₁ + m₂v₂) / m        x = (m₁x₁ + m₂x₂) / m
```

Radius follows constant density, r ∝ m^(1/3).

**Orbital elements.** Selecting a body computes its osculating elements from the
relative state vector — semi-major axis via vis-viva, the eccentricity vector,
period, apoapsis and periapsis — and draws the resulting ellipse with the
primary at a focus. Verified against the simulation itself: predicted period is
within 0.2% of the period actually observed, and predicted apoapsis/periapsis
within 0.5% of the extremes actually reached.

Three details here are easy to get wrong, and all three were:

- **Circular-orbit speed is not √(GM/r).** The simulation uses a *softened*
  force, so the true circular speed is `sqrt(GM·r² / (r² + ε²)^(3/2))`. Using
  the textbook formula over-speeds anything orbiting close in — a moon at
  r ≈ 2.7ε is launched ~10% too fast and escapes within seconds.
- **The primary is not the body pulling hardest.** The Sun pulls on our Moon
  about twice as hard as the Earth does, yet the Moon plainly orbits the Earth.
  What decides the hierarchy is which primary a body is most tightly *bound* to,
  so `dominantAttractor` takes the smallest semi-major axis among heavier bodies
  it is bound to. Picking by force reports every moon as orbiting the star.
- **Planet spacing is a stability constraint, not decoration.** Two neighbouring
  planets are Hill-stable only beyond ~2√3 mutual Hill radii; below that they
  scatter each other onto crossing orbits and collide within a few dozen
  revolutions. An earlier solar-system preset sat at 1.4 and lost half its
  planets in 30 seconds. Every adjacent pair now sits at 4.3 or more.

## Rendering, and why it is fast

The target was a smooth 60fps on a 2017 MacBook Pro — a ~16ms budget on Intel
integrated graphics.

- **One canvas, not four.** An earlier version stacked separate `<canvas>`
  layers for starfield, scene, bloom and overlay, getting the additive bloom
  free via CSS `mix-blend-mode: screen`. Measured, that was the most expensive
  thing on the page: each extra full-screen composited layer costs real time and
  a blend mode forces the compositor to read the backdrop back. Flattening
  everything into one canvas with `globalCompositeOperation` cut the frame cost
  by **2.5×** (63.5ms → 25.5ms in the test environment).
- **Trails are a persistence buffer, not geometry.** Instead of clearing, the
  buffer is erased slightly each frame with one `destination-out` rect — one
  fill regardless of body count. Panning *translates* that buffer rather than
  discarding it; only zoom forces a clear.
- **No `shadowBlur`.** The obvious way to get neon, and brutally slow on
  integrated GPUs. Glows are pre-rasterised radial-gradient sprites drawn under
  `'lighter'`.
- **The sprite cache is bounded three ways.** Radii bucketed, colours quantised
  (merges blend colours, which would otherwise mint a unique gradient per body),
  LRU eviction, and a per-frame rasterisation budget past which bodies fall back
  to plain discs. Before these bounds, 600 uniquely coloured bodies cost
  90ms/frame because the cache flushed and re-rasterised every frame; after,
  22ms.
- **Bloom is quarter-resolution and thresholded.** Downsample, threshold, blur
  while small, stretch back. The threshold uses `destination-in` — which
  multiplies alpha, squaring it — because in this buffer brightness lives mostly
  in the alpha channel. `multiply` is the tempting operator and is wrong: it
  squares colour but *unions* alpha, brightening faint residue instead of
  removing it.
- **Motion streaks.** A round-capped line from each body's previous position to
  its current one; without it a body travelling faster than its own diameter per
  frame paints a dotted line into the buffer.
- **DPR capped at 2**, off-screen bodies skipped before the rasteriser,
  escapees culled, and quality degrades automatically (smaller glows, no bloom)
  above 21ms smoothed frame time, recovering below 14ms.
- **Trajectory prediction is O(K), not O(n).** The preview integrates a test
  particle against only the heaviest `PREDICT.ATTRACTORS` bodies using the same
  leapfrog the simulation uses, so it can run every frame while you drag. Against
  a single dominant primary it is exact — measured worst deviation over 320
  predicted points is 0px.

Measured physics cost per step (one force evaluation, no merging):

| Bodies | Force loop | Collision pass |
| --- | --- | --- |
| 100 | 0.06 ms | 0.07 ms |
| 250 | 0.29 ms | 0.19 ms |
| 500 | 1.16 ms | 0.76 ms |
| 900 | 3.81 ms | 2.41 ms |

At the default 2 substeps a 250-body scene spends well under 1ms per frame on
physics, leaving essentially the whole budget for drawing. `PHYSICS.MAX_BODIES`
caps the world at 900; near that ceiling, drop substeps to 1.

## Sharing a system

**Share system** encodes every body into the URL fragment and copies the link.
Loading one restores the exact state — position, velocity, mass, colour and kind
round-trip with zero error, and a malformed fragment is ignored rather than
breaking the page. The handler runs on `hashchange` as well as at load, because
pasting a link into the address bar of an already-open tab is a fragment-only
navigation that does not reload the document.

## Running on low-end hardware

The sandbox targets a 2017 MacBook Pro *and* a low-end Chromebook with DDR3
memory and integrated graphics — roughly an order of magnitude apart in fill
rate. Three quality tiers cover that range, selectable in the panel or left on
**Auto**, which starts from what the browser reports (`deviceMemory`,
`hardwareConcurrency`) and then follows measured frame time.

| | High | Balanced | Low |
| --- | --- | --- | --- |
| Pixel ratio cap | 2 | 1.5 | 1 |
| Bloom | full | cheap | off |
| Starfield | on | on | off |
| Body cap | 900 | 500 | 260 |
| Substep ceiling | 6 | 4 | 2 |
| Sprite cache budget | 48 MB | 24 MB | 10 MB |

Measured on a simulated Chromebook panel (1366×768 at DPR 1, dense 400-body
scene), the Low tier renders in **5.2ms against High's 17.8ms — 3.4× faster**.
Handed a deliberately overloaded window, Auto stepped High → Balanced → Low on
its own and took the frame rate from 12fps to 38fps, then settled without
oscillating.

What actually costs what, measured rather than assumed:

- **Bloom is ~60% of the frame** (10ms of 16.5ms at DPR 1). The starfield is
  0.4ms and glow sprites 1.2ms. Shrinking the bloom buffer barely helps because
  the cost is dominated by the full-screen additive upscale, not the blur — so
  the Low tier turns bloom off outright rather than pretending to make it cheap.
- **Pixel ratio is quadratic.** It does nothing on a 1×-DPR Chromebook panel,
  which is exactly why the tiers need levers that are not the pixel ratio.
- **A plain disc is 40–200× cheaper than a glow sprite**, because a glow covers
  (3.6r)² — about 52× the body's own area. Below ~3px the halo is barely
  perceptible, so the lower tiers draw small bodies as discs.

Memory is bounded rather than merely bounded-by-count. The glow sprite cache
evicts on a **byte** budget as well as an entry count: one sprite for a large
merged body can be several megabytes of backing store, so a count-only limit
would happily hold hundreds of megabytes. Evicted canvases are shrunk to 0×0 to
release their backing store immediately. The pan scratch buffer — another
full-screen surface — is not allocated until the camera actually moves. Live
sprite usage is shown in the HUD.

## What testing caught

Every feature here was checked against the simulation rather than assumed, and
that repeatedly found real bugs:

- **Feed the Void completed itself.** First version dropped rocks from rest, so
  they simply fell in. Put on eccentric orbits at a common radius they instead
  collided with *each other*, and each merge robbed angular momentum until
  something fell in unaided — still self-completing. Circular orbits at evenly
  spaced radii then ground themselves down to fewer rocks than the objective
  needed, because at 38px apart they sat at 2.0 mutual Hill radii, under the
  2*sqrt(3) stability threshold. They are now geometrically spaced at 4.3.
- **Scoring by body count was wrong.** A rock shatters into four fragments at
  the Roche limit, so feeding one scored four. Scoring by consumed *mass* makes
  a shattered rock count exactly once.
- **Gravity Assist accepted a straight burn.** Testing for "passed near the
  giant and is now escaping" would pass a probe that was already unbound. It now
  requires the probe to arrive at the giant still bound and leave unbound, so
  the encounter has to be what freed it. A scripted cheat attempt fails; 52 of
  234 sampled honest launches succeed.
- **The event horizon rendered white.** Drawn into the trail buffer, a black
  hole that had been eating left its surroundings saturated and the blurred
  bloom bled straight over the disc. Horizons are now drawn after the bloom
  composite; the centre pixel measures #05050b as it should.
- **Shared links silently did nothing** when pasted into an already-open tab.
  The first test could not detect this because the body count happened to match
  either way.

### Known trade-offs

The orbital elements in the inspector are *Kepler* elements, which assume an
unsoftened 1/r² force. For orbits well outside the softening length (ε = 6px,
so essentially everything on screen) they are accurate to a fraction of a
percent, as measured above. For a very tight orbit — a satellite only two or
three ε from its primary — the softened force the simulation actually applies
diverges from Newtonian, and the reported eccentricity drifts from zero
accordingly.

The persistence buffer never quite reaches zero: 8-bit alpha rounding leaves a
residue around 1/255 where trails have been, which shows as very faint banding
in long-lived scenes. Clearing it would mean either a visible periodic flash or
per-body point history, which costs far more than it is worth. The bloom
threshold keeps it from being amplified.

## Tuning

Nearly everything worth changing is a named constant in `src/config.ts` —
gravitational constant, softening length, collision overlap, density, body cap,
cull radius, glow size, bloom scale and blur, DPR cap, camera limits, prediction
depth and the adaptive-quality thresholds.
