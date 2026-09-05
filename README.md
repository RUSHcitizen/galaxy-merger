# Cosmic Gravity Sandbox

A three-dimensional N-body gravity sandbox and puzzle game. Fling planets with
the mouse, orbit the camera around a system, select a body to read its live
Keplerian elements — inclination included — and work through six orbital
mechanics challenges. Vite + vanilla TypeScript, rendered on a plain HTML5
canvas with **no runtime dependencies**.

## Run it

```bash
git clone https://github.com/RUSHcitizen/galaxy-merger.git
cd galaxy-merger
git checkout claude/cosmic-gravity-sandbox-vite-cg102u
npm install
npm run dev
```

Needs Node 18+. Open the **Local** URL it prints (`http://localhost:5173/`).

`dev` is already `vite --host` and `vite.config.ts` sets `server.host = true`,
so the server binds to `0.0.0.0` and Vite prints a **Network** URL too — use
that from another device.

### Over Tailscale

From another machine on your tailnet, open `http://<machine>:5173` using the
host's Tailscale IP (`tailscale ip -4`) or its MagicDNS name
(`http://my-box.tailnet-name.ts.net:5173`). `allowedHosts` already whitelists
`.ts.net`, which Vite would otherwise reject as an unrecognised Host header.

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server on all interfaces (LAN + Tailscale) |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve the built bundle, also on all interfaces |
| `npm run typecheck` | `tsc --noEmit` only |

## Controls

| Input | Action |
| --- | --- |
| **Drag** on empty space | Fling a body; the preview shows where it really goes |
| **Click** a body | Select it — inspector, selection ring, its orbit |
| **Shift-click** | Insert a body on a circular orbit in the plane you are viewing |
| **Right-drag** | Orbit the camera around its target |
| **Shift + right-drag** | Pan the camera target |
| **Wheel** | Move closer or further |

Press `?` for the full key list. It is generated from `src/shortcuts.ts`, the
same registry the key handler dispatches from, so a shortcut cannot end up
documented but unhandled.

`Space` pause · `.` step · `C` clear · `B` black hole · `R` recentre ·
`1` top-down view · `2`–`8` scenes · `F` follow · `G` rotating frame ·
`O` orbit · `V` vectors · `T` prediction · `M` mute · `Del` delete · `Esc`
deselect · `H` panel · `?` shortcuts.

## Challenges

Six missions, scored from the live simulation in orbital-mechanics terms rather
than by anything the game hands you. Progress saves locally.

| Mission | Objective |
| --- | --- |
| **Make Orbit** | Get anything into a closed orbit and hold it 10s |
| **Circularize** | Hold eccentricity under 0.08 for 8s |
| **Thread the Needle** | Park in the lane between two planets, disturbing neither |
| **Gravity Assist** | Escape using the giant — a straight burn does not count |
| **Lagrange Parking** | Hold station at L4 for 12s |
| **Feed the Void** | Push three rocks' worth of mass past an event horizon in 90s |

Conditions that must *hold* accumulate in seconds, so clipping through the right
state for one frame never counts. Each mission is tested two ways: played by a
script to prove it is winnable, and left idle for its full time limit to prove
it cannot complete itself.

## Scenes

| Scene | What it demonstrates |
| --- | --- |
| **Solar system** | Six planets, Hill-stable spacing, small real inclinations |
| **Binary stars** | Two stars about their barycentre, inclined circumbinary planets |
| **Figure eight** | The Chenciner–Montgomery three-body choreography |
| **Lagrange trojans** | Asteroids librating at the stable L4/L5 points |
| **Accretion disc** | A disc with genuine scale height grinding itself down |
| **Galaxy merger** | Two discs on *different* planes, throwing tidal tails out of each |
| **Globular cluster** | A spherical swarm with no preferred plane at all |

## Three dimensions

The simulation is fully three-dimensional — positions, velocities,
accelerations, merges, tides and orbital elements all carry a z component. This
is not a tilted flat world: inclination is a real, measured element, and an
inclined orbit holds its plane to **zero out-of-plane drift over 30,000 steps**.

Rendering is a perspective projection onto the same 2D canvas rather than WebGL.
That is a deliberate choice: the bodies are emissive — stars, glowing debris,
accretion light — so the right primitive is a camera-facing sprite, which is
what a GPU renderer would draw anyway. Staying on the 2D context keeps the whole
tuned pipeline intact (persistence-buffer trails, cached sprites, thresholded
bloom, quality tiers) and keeps the project dependency-free.

What makes it read as three-dimensional:

- **A real perspective divide.** `Camera.project` returns a screen position and
  a scale factor, and every size — sprite, line width, streak — is multiplied by
  it, so near things are bigger and spacing falls off correctly. Measured: a
  body 5× closer projects exactly 5× larger.
- **Painter's-algorithm depth sorting**, so near bodies occlude far ones.
- **Lit spheres.** Anything large enough to show a limb is drawn shaded, with
  the light coming from the brightest star in the scene rather than a fixed
  screen direction. Measured across a disc: 221 luminance on the lit limb, 167
  at centre, 58 on the dark limb, with the terminator inside the body.
- **Depth cueing**, dimming distant bodies the way haze does.
- **A reference grid** on the z = 0 plane and a **starfield fixed to the sky**,
  which give the eye something to judge camera motion against.
- **Ray picking.** Clicking names a line through the scene; the nearest body it
  passes through wins.

The camera is spherical — target, distance, yaw, pitch — which is the natural
scheme for inspecting an orbital system. Spawning raycasts onto the reference
plane, falling back to a view-facing plane through the target when the camera
gets too close to edge-on for that intersection to be usable.

## The physics

**Gravity.** Every unordered pair is visited once and Newton's third law
supplies the other half, so the cost is n²/2 rather than n²:

```
a_i = Σ G·m_j·(r_j − r_i) / (|r_j − r_i|² + ε²)^(3/2)
```

The ε (Plummer softening) keeps the force finite when two bodies pass very close
instead of launching one to infinity.

**Integration.** Kick-drift-kick leapfrog, which is symplectic: circular orbits
stay circular instead of spiralling the way forward Euler does. Acceleration is
carried on the body between steps, so each step needs one force evaluation.

**Merging.** Perfectly inelastic and exactly conservative — measured error on
mass and momentum is zero, in 3D as in 2D.

**Orbital elements.** Selecting a body computes its osculating elements from the
relative state vector: semi-major axis via vis-viva, the eccentricity vector,
period, apoapsis, periapsis, and — in three dimensions — inclination and the
ascending node, from the specific angular momentum `h = r × v` that defines the
orbit plane. The drawn ellipse is swept directly in the orbit's own basis, so
the curve is exactly the orbit the numbers describe, at its true inclination.

Verified against the simulation: predicted period within 0.2% of the period
actually observed, apoapsis and periapsis within 0.5% of the extremes actually
reached, and inclination recovered exactly (a preset built at 0.07 rad reads
back as 4.0°).

Three details here are easy to get wrong, and all three were:

- **Circular-orbit speed is not √(GM/r).** The force is Plummer-softened, so it
  is `sqrt(GM·r²/(r²+ε²)^(3/2))`. The textbook formula over-speeds close-in
  satellites ~10% and they escape within seconds.
- **The primary is not the body pulling hardest.** The Sun pulls on our Moon
  about twice as hard as the Earth does, yet the Moon orbits the Earth. What
  decides the hierarchy is which primary a body is most tightly *bound* to.
- **Planet spacing is a stability constraint.** Two neighbours are Hill-stable
  only beyond ~2√3 mutual Hill radii; below that they scatter each other onto
  crossing orbits within a few dozen revolutions.

## Tidal disruption

A body inside the Roche limit is pulled apart, because the difference in
gravitational pull across its own width exceeds its self-gravity:

```
d_roche = k · R_primary · (rho_primary / rho_satellite)^(1/3)
```

with k ≈ 1.26 rigid, 2.44 fluid. Fragments are laid out along the orbital
direction with a velocity shear — inner pieces orbit faster — which is what
produces long debris streams in real disruption events. Mass and momentum are
conserved exactly.

## Rotating reference frame

Press `G` with a body selected to co-rotate with its orbit. Its primary and the
body go still, and the Lagrange points — fixed only in this frame — stop moving,
so the trojan clouds visibly librate around L4 and L5. The rotation is about the
*orbit normal*, not the world vertical, so it works for inclined orbits too.

The trail buffer is deliberately not discarded when the frame angle changes:
each trail pixel was drawn under the mapping in force at the time, which is
exactly the trajectory in that frame.

## Sharing a system

**Share system** encodes every body — including z and vz — into the URL fragment
and copies the link. Position, velocity, mass, colour and kind round-trip with
zero error; a malformed fragment is ignored. The handler also runs on
`hashchange`, because pasting a link into an already-open tab is a fragment-only
navigation that does not reload the document.

## Running on low-end hardware

The sandbox targets a 2017 MacBook Pro *and* a low-end Chromebook with DDR3
memory and integrated graphics. Three quality tiers cover that range, selectable
or left on **Auto**, which starts from what the browser reports and then follows
measured frame time with hysteresis and a cooldown — a tier change reallocates
every buffer, so it must not fire on a hitch.

| | High | Balanced | Low |
| --- | --- | --- | --- |
| Pixel ratio cap | 2 | 1.5 | 1 |
| Bloom | full | cheap | off |
| Starfield / grid | on | on | off |
| Body cap | 900 | 500 | 260 |
| Substep ceiling | 6 | 4 | 2 |
| Sprite cache budget | 48 MB | 24 MB | 10 MB |

Measured on a simulated Chromebook panel (1366×768 at DPR 1, dense 400-body
scene), Low renders in **9.2ms against High's 25.1ms — 2.7× faster**. Going 3D
cost about 45% over the 2D renderer; Low still fits inside a 16.7ms budget.
Handed a deliberately overloaded window, Auto steps High → Balanced → Low on its
own and settles without oscillating.

What actually costs what, measured rather than assumed:

- **Bloom is the largest single item** — around 60% of the frame at DPR 1.
  Shrinking its buffer barely helps because the cost is the full-screen additive
  upscale, not the blur, so Low turns it off outright.
- **Pixel ratio is quadratic** but does nothing on a 1×-DPR Chromebook panel,
  which is why the tiers need levers that are not the pixel ratio.
- **A plain disc is 40–200× cheaper than a glow sprite**, because a glow covers
  (3.6r)² — about 52× the body's own area.

Memory is bounded by **bytes**, not just entry count: one sprite for a large
body can be several megabytes of backing store, so a count-only limit could hold
hundreds of megabytes. Evicted canvases are shrunk to 0×0 to release their
backing store immediately. Live usage shows in the HUD.

## Structure

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Physics/render constants, palette, mutable UI state |
| `src/physics.ts` | Vec3, `World`, the force loop, leapfrog, merges, tides |
| `src/orbits.ts` | 3D Keplerian elements, primary selection, prediction |
| `src/camera.ts` | Perspective camera, projection, ray unprojection |
| `src/renderer.ts` | Depth sorting, sprites, lit spheres, bloom, backdrop |
| `src/particles.ts` | Merge and break-up debris |
| `src/presets.ts` | The seven scenes |
| `src/challenges.ts` | The six missions and the scoring state machine |
| `src/audio.ts` | Synthesized sound, voice capping, rate limiting |
| `src/quality.ts` | Quality tiers and the frame-time watcher |
| `src/shortcuts.ts` | The keyboard registry handler and overlay share |
| `src/share.ts` | World serialization to and from a URL fragment |
| `src/ui.ts` | Controls, pointer grammar, inspector, help overlay |
| `src/main.ts` | Bootstrap and the animation loop |

## Sound

Synthesized with the Web Audio API — oscillators and one shared noise buffer —
so the project ships zero audio assets and works offline. The `AudioContext` is
created lazily on the first interaction, because browsers refuse to start one
before a user gesture. Merges are not rare (an accretion disc makes dozens per
frame), so every sound passes a voice cap and a per-kind minimum interval, and
the loop aggregates a frame's merges into one call.

## Known trade-offs

- **Trails are dropped when the camera moves.** A perspective change is not an
  affine transform of the existing pixels, so unlike the 2D version there is
  nothing to salvage. Orbiting the camera clears the trail buffer; it rebuilds
  within a second.
- **The Kepler elements assume an unsoftened force.** For orbits well outside
  the softening length they are accurate to a fraction of a percent. For a
  satellite only two or three ε from its primary, the reported eccentricity
  drifts from zero.
- **The persistence buffer never quite reaches zero.** 8-bit alpha rounding
  leaves a residue around 1/255 where trails have been, visible as very faint
  banding in long-lived scenes. The bloom threshold keeps it from being
  amplified.

## Tuning

Nearly everything worth changing is a named constant in `src/config.ts` —
gravitational constant, softening length, Roche factor, collision overlap,
density, body cap, camera field of view and limits, glow size, sphere threshold,
bloom scale, DPR cap, prediction depth and the adaptive-quality thresholds.
