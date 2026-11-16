# Mars Survival Nav

**Hyperlocalized 4D Martian EVA Navigation & Science Operations System**
2026 NASA Space Apps Challenge submission. Vite + TypeScript + three.js, no backend.

A browser-based planning console for a crew member on foot (or riding a companion rover) inside a
2.05 km x 2.05 km sector around a habitat. It plans traverses over the terrain, the sun, the radio
horizon and the suit's three consumables at once, and shows the result as a 3D scene, a wrist HUD
and a first-person visor view. The whole engine runs from **76 KB of binary data per site** and a
few hundred kilobytes of typed arrays.

---

## 1. The problem: regional orbital map vs. hyperlocalized EVA excursion

Orbital data products (the JPL Mars Trek MOLA / HRSC layers, USGS geologic maps) answer
*"where on Mars is interesting?"* at regional scale. An astronaut walking out of a habitat needs
the opposite: *"which 2 km of ground can I actually cross, in which order, at what hour, and
can I still walk home?"*

| | Regional orbital map | Hyperlocalized EVA excursion (this project) |
|---|---|---|
| Extent | Whole regions / planet tiles | One 2048 m x 2048 m sector (`sector_size_meters = 2048`) |
| Grid | Tile imagery, one global colour ramp | 128 x 128 solver grid, 16.126 m post spacing |
| Question | Where is the terrain? | Where can a person *survive and work* on it? |
| Constraints | None | Slope vs. payload, sand traps, roughness, radiation shelter, sun / shadow at the hour of arrival, UHF radio line of sight, O2 / SWME water / battery, GPS-denied navigation error |
| Time | Static | Departure Sol hour (6 to 18 h) changes the shadows and therefore the route and the battery draw |
| Output | A picture | A route, a Point-of-No-Return contour, a relay site, a consumable budget, a visor-eye walkthrough |

Four sites are bundled: Mount Sharp (Gale Crater boxwork ridge), Deuteronilus Mensae (fretted
glacial dichotomy), Arcadia Planitia (Starship candidate site AP-1) and Phlegra Montes (lobate
debris apron PM-1).

> **Data provenance, stated plainly.** The `.bin` elevation / thermal-inertia / geologic packs
> are *procedurally generated stand-ins* (`tools/build_mars_sectors.mjs`): one analytic landform
> model per site (S-curve canyon with terraced benches, flat-topped buttes, three impact craters,
> a diagonal scarp with outwash valleys) plus deterministic fractal noise, scaled by a vertical
> exaggeration of 15.5. They are placed at the real site coordinates and datums, but they are **not
> resampled MOLA / HRSC DEMs**. The bundled Mars Trek tile for each site is shown as orbital context
> and contributes one byte-derived perturbation of at most about +-0.5 m to the generator. The
> navigation, physics and UI layers are real and data-agnostic: they run unchanged on any
> 128 x 128 pack that follows the format in `ARCHITECTURE.md`.

---

## 2. Quantitative benchmarks

Source: `BENCHMARKS.md`, written by `npx tsx tools/verify_benchmarks.mjs` (waypoint 1 of each site,
15.5 kg default science pack, departure at Sol hour 14.0). "KB" in the file means KiB (1024 B).

| Landing Site | Binary Pack | Active RAM | WP-1 Slope (Smart vs Naive) | WP-1 Sand (Smart vs Naive) | GPS-Denied Max CEP | SHARAD Min Ice Depth | A* Time | Full Science Loop Order | Loop Dist | Loop O₂ | Safe Walkback Area | 2-Hop UHF Relay Gain |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Mount Sharp (Gale Crater Boxwork Ridge)** | 76.0 KB | 508.0 KB | **13.5°** vs 45.1° | **0 m** vs 278.1 m | ±3.5 m | -6.2 m | 17.72 ms | `HAB → WP-2 → WP-1 → WP-3 → HAB` | 4.66 km | 139.7 L | 75% | 76% → 88% |
| **Deuteronilus Mensae (Fretted Glacial Dichotomy)** | 76.0 KB | 508.0 KB | **14.5°** vs 18° | **0 m** vs 330.3 m | ±7 m | -1.6 m | 20.78 ms | `HAB → WP-2 → WP-1 → HAB` | 3.89 km | 110.67 L | 85% | 34% → 48% |
| **Arcadia Planitia (Starship Candidate Site AP-1)** | 76.0 KB | 508.0 KB | **4.6°** vs 29.5° | **0 m** vs 387.7 m | ±13.8 m | -1.5 m | 10.03 ms | `HAB → WP-1 → WP-2 → HAB` | 3.55 km | 90.15 L | 96% | 32% → 57% |
| **Phlegra Montes (Lobate Debris Apron PM-1)** | 76.0 KB | 508.0 KB | **19.1°** vs 29° | **0 m** vs 0 m | ±12.7 m | -1.4 m | 13.93 ms | `HAB → WP-1 → WP-2 → HAB` | 4.18 km | 129.36 L | 60% | 41% → 73% |

How to read the figures, and what they do and do not include:

* **Binary Pack, 76.0 KB.** Exactly `65,536 + 8,192 + 4,096 = 77,824 B` per site: a 128 x 128 `float32`
  elevation raster, a 64 x 64 `uint16` thermal-inertia raster and a 64 x 64 `uint8` geologic-class
  raster. The ~0.8 KB `manifest.json` is not counted.
* **Active RAM, 508.0 KB.** The sum the loader reports (`memoryKB`) over twelve arrays. It counts the
  *coarse* 64 x 64 thermal and geologic arrays (12 KB) that are read from disk, but not the
  128 x 128 `Float32` thermal-inertia (64 KB) and `Uint8` geologic (16 KB) expansions the solvers
  actually read. The live typed-array footprint of a sector bundle is therefore **576.0 KB**, plus
  about 400 KB of reusable pathfinder scratch (`gScore`, `fScore`, two O2 fields, `parent`,
  `closed`, `heap`). Both are well under 1 MB.
* **Gzipped engine, 24.5 KB.** `npm run build` reports `dist/assets/index-*.js` at
  **75.59 kB raw / 24.50 kB gzip**. That chunk is the *entire application* (core engine + 3D viewer +
  wrist HUD + `main.ts`); three.js is split into a separate `three-vendor` chunk
  (581.61 kB / 143.84 kB gzip). Bundling only `src/core/*` with rolldown, minified, gives
  **21.80 kB raw / 8.94 kB gzip** (`gzip -9`). So "24.5 KB" is correct for the app code excluding
  three.js, and the pure solver core is about 8.9 KB.
* **A* Time** is wall-clock time of one `findRoute` call and varies by machine and run. The values
  above are those stored in `BENCHMARKS.md`; a fresh run of the verify script on the authoring
  machine (warm JIT) printed 2.61 to 4.21 ms for the same four routes. Every other column is
  deterministic and reproduced exactly on re-run.
* **Smart vs Naive** compares the optimised route against a straight line from the habitat to
  waypoint 1 through the same telemetry code.

---

## 3. The seven core mathematical innovations

Full derivations with the exact constants are in [`ARCHITECTURE.md`](ARCHITECTURE.md). Source files
carry matching TSDoc.

### (a) 4D spatio-temporal anisotropic A* with moving-sun horizon ray-marching
`src/core/pathfinder.ts` (`runSearch`) and `src/core/solarAndComms.ts` (`recomputeSolarShadow`).

For every grid cell a ray is marched toward the sun at the chosen Sol hour; if terrain rises above
the ray, the cell is in shadow. A* then searches the 8-connected grid with an *anisotropic* edge
cost: it depends on the **signed** slope of the step (uphill grows as $\theta^2$, steep downhill
braking is charged separately), the payload ($\rho = m/145$), sand ($\text{TIU} < 140$), roughness,
radiation exposure (sky-view factor), shadow, and radio blackout:

$$c = d\,\big(S + P_{sand} + P_{rough} + P_{rad} + P_{shadow} + P_{comms}\big)$$

with $S \ge 1$ and all other terms $\ge 0$, so the straight-line heuristic is admissible and the
first goal pop is optimal. Time enters through the departure hour: the arrival hour at each expanded
node triggers a 2.4x shadow penalty after Sol hour 17.2, and the shadow mask is recomputed for the
slider hour. *Honest scope:* time is not a time-expanded search dimension; the mask is a snapshot at
the departure hour and the arrival hour is estimated from straight-line distance.

### (b) Coupled 3-consumable xEMU PLSS physics
`buildTelemetry`. One pass along the path yields three coupled quantities per segment of length
$d$, rise $dz$, load ratio $\rho$:

* Metabolic O2: $dO_2 = 0.018\,d\,(1+1.35\rho) + [dz>0]\,0.085\,dz\,(1+2.1\rho) + [\text{TIU}<120]\,0.025\,d\,(1+2.2\rho)$ litres
* SWME sublimator water, tied to metabolic heat and sun: $dH_2O = 0.019\;dO_2\;(1.25 \text{ lit} \,/\, 0.78 \text{ shaded})$ litres
* Suit battery: $dE = \frac{d}{60\,v}\,(65-25 \text{ lit} \,/\, 65+135 \text{ shaded})$ Wh, $v = 45/(1+0.85\rho)$ m/min

Gauges are scaled against 180 L O2, 4.2 L water and 850 Wh; the single-sortie return ceiling is 95 L.

### (c) Bidirectional anisotropic Dijkstra walkback isochrone field
`computeWalkbackEnvelope` / `runO2Wavefront`. Two Dijkstra wavefronts from the habitat, both in litres
of O2: one outbound at pack mass $m$, one on the *reversed* graph (cost to walk **back**, with
$m + 3$ kg and the signed slope flipped). The round-trip field

$$W(X) = O_{out}(X) + O_{in}(X) + 15\ \text{min}\times 0.45\ \text{L/min}$$

is painted on the terrain; the `WALKBACK` layer draws the **95 L Point-of-No-Return** as a white
ring (the $|W-95|\le 2.4$ L band). The reachable-area percentages in the table are
$100\cdot\#\{W\le 95\}/128^2$. Changing the pack, the Sol hour or dropping a hazard recomputes it live.

### (d) GPS-denied navigation uncertainty (CEP) and optical skyline triangulation vs. UHF ranging
Each path node updates a circular-error-probable $\sigma$ (m), starting at 0.8 m:
UHF line of sight to the habitat mast resets $\sigma = 0.8$ (2-way radiometric ranging);
otherwise two or more lit landmarks give $\sigma \leftarrow \min(\sigma + 0.010d,\,2.4)$ (skyline
triangulation), exactly one gives $\min(\sigma + 0.016d,\,6.8)$, and none gives IMU drift
$\sigma \leftarrow \sigma + 0.028d$. Landmarks are the three highest cells on a stride-4 lattice at
least 28 cells (451.5 m) apart; visibility is a curvature-corrected line-of-sight test. Radio
"ranging" is modelled as binary geometric LOS (no link budget). Rings in the 3D view and the visor
mode label (`UHF RANGING LOCK` / `SKYLINE TRIANGULATION` / `IMU DEAD RECKONING DRIFT`) expose it.

### (e) Autonomous 2-hop UHF relay viewshed optimiser (`DEPLOY RELAY`)
`deployOptimalCommsRelay`. Candidate sites (stride-3 lattice) must already see the habitat mast,
have slope $\le 22^\circ$ and TIU $\ge 130$. Each is scored by the number of currently dark cells it
can see from a 9.5 m mast:

$$\text{score} = 0.15\,z + 25\cdot\#\{\text{dark route cells in view}\} + 2\cdot\#\{\text{dark sector samples in view}\}$$

The best site wins and the comms mask is upgraded in place. Table column "2-Hop UHF Relay Gain"
(e.g. Phlegra 41% to 73%) is the sector-wide LOS coverage before and after.

### (f) 3D volumetric subsurface strata + SHARAD ice curtain (`3D STRATA`) and Shannon-entropy unconformity detector (`DISCOVERY`)
The curtain is a translucent ribbon hung 155 m deep under the active route, coloured by a
classification (ice / hydrated lens, regolith, Hesperian sulfate, Noachian clay). The ice-table depth
is a **heuristic lookup by geologic class** (shallow ice 0.6 to 1.8 m on the ice apron, 6.2 m + 0.05z on
sulfate, 13.5 m + 0.06z on bedrock, 24 m on sand), not a radar inversion. The discovery score is the
Shannon entropy of the geologic-class histogram in a 5 x 5 window,
$H = -\sum_k p_k\log_2 p_k$, weighted by the thermal-inertia gradient and an outcrop-slope window and
clamped to 0 to 100; a route-side hotspot (> 45) is offered as a one-click detour.

### (g) Multimodal Steiner-point rendezvous (companion rover haul + unburdened foot scramble) and live Shift+Click re-routing
`findRoverAssistedRoute`. A rover Dijkstra (slope $\le 14.5^\circ$ per edge, $\le 15.5^\circ$ per cell, TIU $\ge 130$,
roughness at or below the sector's own 75th percentile; a fixed metre cut excluded most of the vertically exaggerated map) reaches a field of drop-off points; the rendezvous $R^*$ minimises
$|R-G|_{euclid} + 0.18\,C_{rover}(R)$ over a stride-2 lattice (a discrete weighted-sum, Steiner-style
point). The astronaut then scrambles $R^*\to G$ with only the 2.2 kg hand kit. Mid-EVA, **Shift + Click**
drops a 5 x 5 in-situ hazard block (or removes the connected patch nearest the click) that every solver treats as impassable, and the
route, the loop and the walkback field re-solve immediately.

---

## 4. NASA data & heritage citations

What is actually in this repository, checked against the code:

| Item | Where | How it is used |
|---|---|---|
| **JPL Mars Trek WMTS** (MGS MOLA / HRSC blended colour-shaded elevation tiles) | `public/images/trek_*.jpg` (four 256 x 256 JPEGs); link `https://trek.nasa.gov/mars/` | Orbital context card with click-to-enlarge. `tools/build_mars_sectors.mjs` reads one byte from each file for a bias of at most about +-0.5 m; it does **not** decode or sample the DEM. |
| **MSL Curiosity, PIA20168** (Bagnold Dunes ripples, as labelled in the HUD) | `public/images/PIA20168.jpg` | Class 0 boot-surface card and terrain-detail texture. |
| **MSL Curiosity, PIA19912** (cross-bedded sulfate sandstone strata, as labelled) | `public/images/PIA19912.jpg` | Class 1 card and texture. |
| **MSL Curiosity, boxwork veins** | HUD labels it **PIA19307**, but the file shipped is `public/images/PIA19077.jpg` | Class 2 card and texture. The label and the file name differ; treat `PIA19077` as the file of record. |
| **Phoenix SSI, water-ice table** | HUD labels it **PIA10907**, but the file shipped is `public/images/PIA10940.jpg` (its JPEG metadata reads "Phoenix's Workplace Map") | Class 3 card and texture. The label and the file name differ. |
| **USGS Astrogeology planetary geologic mapping** | Link only: `https://astrogeology-usgs.hub.arcgis.com/pages/interactive-maps-mars` | Cited in the HUD; geologic classes in the packs are authored, not imported from USGS units. |
| **MRO SHARAD / SWIM** | Names only (instrument `gpr_wand` heritage, "SHARAD ice" read-outs, SWIM ice polygon waypoint) | Concept heritage for the heuristic ice-table depth. No SHARAD or SWIM data are ingested. |
| **Mars 2020 SHERLOC / PIXL** | Instrument entry `sherloc_pixl` (4.8 kg); link `https://mars.nasa.gov/mars2020/multimedia/raw-images/` | Payload-mass catalogue entry and HUD link. |
| Other heritage named in the instrument list | Artemis geology kit, Perseverance coring, RIMFAX, Phoenix, Artemis ISRU drill, InSight SEIS | Payload masses (2.2 to 11.0 kg) are display data authored in `EVA_INSTRUMENTS`. |
| Curiosity route | Link only: `https://science.nasa.gov/resource/curiositys-proposed-path-up-mount-sharp/` | Cited in the HUD. |

Planetary constant used in the radio model: Mars radius 3,389,500 m.

---

## 5. Quickstart and verification

```bash
npm install                              # three, vite, typescript
npm run dev                              # Vite dev server, http://localhost:5173
npm run build                            # tsc type-check + vite production build into dist/
npx tsx tools/verify_benchmarks.mjs      # runs all four sites headless; prints the table and rewrites BENCHMARKS.md
node tools/build_mars_sectors.mjs        # optional: regenerate public/data/*/ (run from the project root)
```

Notes: `tsx` is not a declared dependency; `npx` fetches it on first use. The verify script reads
`public/data/<site>/` through relative paths, so run it from the project root. It overwrites
`BENCHMARKS.md`, and its `A* Time` column changes from run to run.

### Using the console
| Control | Action |
|---|---|
| Site dropdown | Load one of the four packs |
| Click terrain | Plot optimised route (cyan) against the naive straight line (red) |
| **Shift + Click** | Drop or clear an in-situ hazard block; routes re-solve |
| Layer buttons | `MARS`, `SLOPE`, `SAND`, `ROUGHNESS`, `RADIATION`, `SOLAR`, `COMMS`, `WALKBACK`, `DISCOVERY` |
| `3D STRATA` | Translucent subsurface curtain under the active route |
| `RELAY` | Solve and deploy the 2-hop UHF relay |
| `SHELTER` | Nearest radiation shelter (sky-view factor <= 0.58) from the last clicked cell |
| `VISOR POV` / scrub slider | First-person astronaut walk with live telemetry |
| Sol slider (6 to 18) | Moves the sun, recomputes shadows, walkback and the active route |
| Wrist panel | Waypoint pills, `FULL LOOP`, instrument loadout (mass), `Companion Utility Rover Haul` toggle |

### Layout
```
src/core/sectorData.ts     site catalogue, derived terrain layers, landmarks, discovery, ice table
src/core/sectorGrid.ts     binary pack loader, bilinear sampler
src/core/solarAndComms.ts  sun ray-march, curvature-aware LOS, relay optimiser
src/core/pathfinder.ts     A*, rover solver, walkback wavefronts, loop planner, telemetry
src/viewer/scene3D.ts      three.js scene, route tubes, strata curtain, visor camera
src/viewer/wristHud.ts     HTML HUD, gauges, loadout, citations
src/main.ts                wiring and controls
tools/                     pack generator and headless benchmark verifier
public/data/<site>/        manifest.json + elevation.bin + thermal.bin + geologic.bin
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for dataflow diagrams, the binary specification and every equation.
