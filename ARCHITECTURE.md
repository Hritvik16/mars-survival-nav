# Mars Survival Nav: Architecture and Mathematical Reference

This manual documents what the code in this repository does, derived from `tools/build_mars_sectors.mjs`,
`src/core/*`, `src/viewer/*`, `src/main.ts` and the shipped `public/data/*/manifest.json` files. Where the
code differs from a textbook formula, the code's version is the one written here and the difference is
called out. Math uses GitHub-flavoured `$...$` / `$$...$$` LaTeX.

Contents: 1 System dataflow, 2 Binary pack specification, 3 Pack generator, 4 Grid and derived layers,
5 Sun and radio, 6 Cost model and A*, 7 Consumables, 8 Navigation uncertainty, 9 Walkback field,
10 Relay optimiser, 11 Rover rendezvous, 12 Science loop, 13 Hazards, 14 Discovery and ice table,
15 Viewer mappings, 16 Memory budget, 17 Known approximations.

---

## 1. System dataflow

### 1.1 Build time

```
 tools/build_mars_sectors.mjs  (node, run from project root)
 +--------------------------------------------------------------+
 |  SITES[4] : id, lat/lon, base datum, Hab (col,row), trek jpg  |
 |        |                                                      |
 |        v   for each (r,c) of 128x128 and of 64x64             |
 |  evaluateSiteCell(site, u, v)                                 |
 |    u,v in [0,1]  ->  nx,ny = (u-0.5)*4, (v-0.5)*4            |
 |    regionalTilt  (linear tilt + 1 byte of trek_*.jpg)         |
 |    fbm2D value noise                                          |
 |    per-site landform  ->  strata (m/15.5), tiu, unit          |
 |        |                                                      |
 |        +--> elevation  = strata * 15.5            (128x128 f32)|
 |        +--> thermal    = round(max(45, tiu))       ( 64x64 u16)|
 |        +--> geologic   = unit 0..3                 ( 64x64 u8 )|
 +-----------------------+--------------------------------------+
                         v
        public/data/<site>/{elevation.bin, thermal.bin, geologic.bin, manifest.json}
```

### 1.2 Run time

```
 browser                                         src/core (pure TypeScript, no DOM)
 +--------------------------------+   fetch    +----------------------------------------------+
 | main.ts  activateSite(id)      |----------->| sectorGrid.loadSectorFromBinary              |
 +--------------------------------+            |   manifest.json + 3 .bin  (77,824 B)         |
        |                                      |   thermal 64->128 bilinear, geologic nearest |
        |                                      |        |                                     |
        |                                      |        v   derived layers (sectorData.ts)    |
        |                                      |   slope, roughness, sky-view factor          |
        |                                      |   discoveryScore (entropy), iceTableDepth    |
        |                                      |   landmarks (3)                              |
        |                                      |        v   (solarAndComms.ts)                |
        |                                      |   solarShadow(solHour), commsLos(Hab)        |
        |                                      +---------------------+------------------------+
        |                                                            | SectorBuffers
        |  click / Sol slider / loadout / Shift+Click / RELAY        v
        |                                      +----------------------------------------------+
        +------------------------------------->| AnisotropicPathfinder (pathfinder.ts)        |
                                               |   findRoute / findRoverAssistedRoute         |
                                               |   findScienceLoop / findNearestSafeHaven     |
                                               |   computeWalkbackEnvelope -> walkbackO2      |
                                               |   evaluateDirectPath (naive baseline)        |
                                               |   buildTelemetry -> RouteResult              |
                                               +---------------------+------------------------+
                                                                     | RouteResult, fields
        +------------------------------------------------------------v-----------+
        | viewer/scene3D.ts : terrain mesh, heat maps, route tubes, CEP rings,    |
        |   strata curtain, relay / hazard / hotspot markers, visor camera        |
        | viewer/wristHud.ts: gauges (O2 / H2O / Wh), comparison table, SVG        |
        |   elevation + ice profile, loadout, NASA imagery + citations            |
        +-------------------------------------------------------------------------+
```

### 1.3 One interaction (click on terrain)

```
 pointerdown -> raycast terrain mesh -> (col,row) = round(frac*(N-1)), clamped 1..N-2
   -> updateRouteAndHud(col,row)
        smart = rover toggle ? findRoverAssistedRoute : findRoute      (A*, ~ms)
        naive = evaluateDirectPath                                      (straight line)
        spot  = findRouteDiscoveryHotspot(smart.path)
        HUD.updateRouteComparison(smart, naive, spot)
        viewer.renderRoute(path, naive, CEP, rover leg) -> tube, curtain, rings, camera
```

---

## 2. Binary pack specification (`public/data/<site_id>/`)

Four sites: `mount_sharp`, `deuteronilus`, `arcadia_ap1`, `phlegra_pm1`. Each directory holds exactly four files.

### 2.1 Channel files

There is **no header**: each `.bin` file is a raw array, row-major (`index = row * width + col`, row 0 first,
col 0 first within a row), so file size = element count x element size.

| File | dtype | Width x Height | Elements | Bytes | Unit | Range in the shipped packs |
|---|---|---|---|---|---|---|
| `elevation.bin` | `float32` (IEEE 754 binary32) | 128 x 128 | 16,384 | 65,536 | metres, site-relative | -149.7 to +166.0 (Phlegra); -94.2/+107.9 (Mount Sharp); -76.5/+91.7 (Deuteronilus); -70.3/+25.1 (Arcadia) |
| `thermal.bin` | `uint16` | 64 x 64 | 4,096 | 8,192 | TIU (thermal inertia units) | 60 to 378 |
| `geologic.bin` | `uint8` | 64 x 64 | 4,096 | 4,096 | class id | 0..3 |
| `manifest.json` | UTF-8 JSON | n/a | n/a | 777 (Mount Sharp), 784 (Deuteronilus), 787 (Arcadia), 780 (Phlegra) | n/a | n/a |

Total channel payload: **77,824 B = 76.0 KiB** per site (the "Binary Pack" column of `BENCHMARKS.md`).
Total with manifest: 78,601 to 78,611 B.

**Endianness.** The generator writes `Buffer.from(typedArray.buffer)`, i.e. the host byte order, and the loader
views the fetched `ArrayBuffer` with `new Float32Array(buf)` / `new Uint16Array(buf)`, i.e. the host byte order
again. The shipped files were generated on an arm64 machine and are **little-endian**. Check: the first four bytes
of `mount_sharp/elevation.bin` are `9a a8 9d 42`, which as little-endian IEEE-754 is `0x429DA89A` = 78.83 m.
Big-endian hosts would misread the packs; no byte swapping is performed. `uint8` has no byte order.

**Addressing.**

$$\text{byteOffset}_{elev}(r,c)=4\,(128r+c),\qquad \text{byteOffset}_{tiu}(r,c)=2\,(64r+c),\qquad \text{byteOffset}_{geo}(r,c)=64r+c$$

`float32` offsets are 4-byte aligned in the fetched buffer, which `new Float32Array(buf)` requires.

### 2.2 Geologic class ids

| id | Meaning (`GEOLOGIC_UNIT_LABELS`) | Present in |
|---|---|---|
| 0 | Bagnold eolian sand sheet (low-TIU dust trap) | all four |
| 1 | Hesperian layered sulfate and clay terrace | Mount Sharp only (1,103 cells) |
| 2 | Amazonian basaltic bedrock and cemented boxwork | all four |
| 3 | SHARAD shallow subsurface water-ice apron | Deuteronilus, Arcadia, Phlegra (not Mount Sharp) |

Cell counts of the 4,096 coarse cells (class 0/1/2/3): Mount Sharp 386/1103/2607/0, Deuteronilus 179/0/1067/2850,
Arcadia 425/0/457/3214, Phlegra 292/0/1695/2109.

### 2.3 `manifest.json`

```json
{
  "site_id": "mount_sharp",
  "name": "Mount Sharp (Gale Crater Boxwork Ridge)",
  "coords_label": "4.95°S, 137.40°E (-4,500m MOLA)",
  "center_lat_lon": [-4.95, 137.4],
  "base_datum_meters": -4500,
  "sector_size_meters": 2048,
  "hab_grid_coords": [20, 64],
  "channels": [
    { "id": "elevation",       "file": "elevation.bin", "dtype": "float32", "width": 128, "height": 128, "unit": "m"     },
    { "id": "thermal_inertia", "file": "thermal.bin",   "dtype": "uint16",  "width": 64,  "height": 64,  "unit": "TIU"   },
    { "id": "geologic_unit",   "file": "geologic.bin",  "dtype": "uint8",   "width": 64,  "height": 64,  "unit": "class" }
  ]
}
```

| Field | Type | Meaning | Values in the four shipped manifests |
|---|---|---|---|
| `site_id` | string | key into `MARS_SITES` | `mount_sharp`, `deuteronilus`, `arcadia_ap1`, `phlegra_pm1` |
| `name`, `coords_label` | string | display text | n/a |
| `center_lat_lon` | `[lat, lon]` degrees | site centre | [-4.95, 137.4], [43.9, 22.6], [39.09, 189.79], [39.8, 163.2] |
| `base_datum_meters` | number | datum added to elevation to display absolute elevation | -4500, -3800, -4200, -3600 |
| `sector_size_meters` | number | side of the square sector, W | 2048 for all |
| `hab_grid_coords` | `[col, row]` | habitat cell on the 128 x 128 grid | [20,64], [24,64], [64,64], [18,100] |
| `channels[]` | array | `id`, `file`, `dtype`, `width`, `height`, `unit` | as in the example |

The loader requires channels with ids `elevation`, `thermal_inertia`, `geologic_unit`; it takes
`gridSize = channels[elevation].width` and assumes a square raster. The verify script hard-codes 128 / 64.

### 2.4 Loading pipeline (`loadSectorFromBinary`)

1. `elevation = new Float32Array(elevBuf)` (no copy).
2. Thermal inertia 64 x 64 to 128 x 128 by **bilinear** interpolation of posts, $u=c/127,\ v=r/127$:

$$x=63u,\quad y=63v,\quad TIU(r,c)=(1-f_y)\big[(1-f_x)T_{00}+f_xT_{10}\big]+f_y\big[(1-f_x)T_{01}+f_xT_{11}\big]$$

3. Geologic class 64 x 64 to 128 x 128 by **nearest neighbour**, $\text{geo}(r,c)=G\big[\text{round}(63\,r/127),\ \text{round}(63\,c/127)\big]$
   (class ids must not be blended).
4. Habitat position from `hab_grid_coords`. 5. Derived layers (sections 4 to 5, 14).

---

## 3. Pack generator (`tools/build_mars_sectors.mjs`)

Constants: `SECTOR_SIZE_METERS = 2048`, `VERTICAL_SCALE = 15.5`, `ELEV_SIZE = 128`, `COARSE_SIZE = 64`.
Elevation is sampled at $u=c/127$; thermal and geologic at $u=c/63$ (both span $[0,1]$ corner to corner).

**Noise.**

$$\text{hash}(i,j)=\operatorname{frac}\big(43758.5453123\,\sin(127.1\,i+311.7\,j)\big)$$

$$\text{vnoise}(x,y)=a+(b-a)u_x+(c-a)u_y+(a-b-c+d)u_xu_y,\qquad u=f^2(3-2f)$$

(a,b,c,d are hashes of the four surrounding lattice points; $f$ the fractional part), and fractal Brownian motion
with 4 octaves, lacunarity 2.07, gain 0.48, base amplitude 0.5:

$$\text{fbm}(x,y)=\sum_{k=0}^{3}0.5\cdot0.48^{k}\cdot2\,\big(\text{vnoise}(2.07^{k}x,\,2.07^{k}y)-0.5\big)$$

**Terraces** (Mount Sharp benches): with step $s$ and sharpness $q$,
$\text{terrace}(v)=s\,\big(\lfloor v/s\rfloor+\tfrac12+\tfrac{\tanh(q(\phi-\frac12))}{2\tanh(q/2)}\big)$, $\phi=v/s-\lfloor v/s\rfloor$.

**Regional tilt.** $\text{tilt}=1.15(u-0.5)+0.75(0.5-v)+0.05\,b_0$, where $b_0=\text{byte}/255-0.5$ is one byte of the site's
`trek_*.jpg` read at offset $1024+\lfloor0.45(u+v)(\text{len}-1500)\rfloor$ (a raw compressed JPEG byte, **not** a decoded pixel; the term
contributes at most 0.025 in tilt units, about 0.5 m after the site multipliers and the 15.5 scale). If the file is unreadable or under 2,048 bytes
the function falls back to $1.15(u-0.5)$ or 0.

**Per-site landforms** ($n_x=4(u-\tfrac12),\ n_y=4(v-\tfrac12)$; elevation = strata $\times 15.5$ m):

| Site | Landform model in `evaluateSiteCell` | tiu / unit rule |
|---|---|---|
| Mount Sharp | S-curve canyon $x_c=0.62\sin(1.35n_y)+0.18\,\text{fbm}$; floor $10.8\tanh(1.85|n_x-x_c|)-5.4$; terraced with step 3.2, sharpness 2.3; two gentle ramps (north/south) blended in; boxwork fbm detail beyond 0.65 from the canyon | canyon core (< 0.35, ramp < 0.45): tiu $60+80d$, unit 0; strata > 1.8: tiu $355+35\,\text{fbm}$, unit 2; else $245+30\,\text{fbm}$, unit 1 |
| Deuteronilus | three flat-topped buttes via $1-\tanh(\cdot)$ with heights 4.2, 3.6, 3.4; valley floor $-3.8+0.6\sin(1.1n_x)+0.85\,\text{fbm}$ | trough (< 0.48 from (0.05,-0.05)): tiu $72+65d$, unit 0; strata > 1.6: $345+30\,\text{fbm}$, unit 2; else $275+25\,\text{fbm}$, unit 3 |
| Arcadia | three bowl craters $-\cos(\tfrac{\pi}{2}\tfrac{d}{R})\cdot$depth (3.8, 4.1, 4.4) with Gaussian rims | inside crater floors: tiu 70, unit 0; else $315+30\,\text{fbm}$; unit 2 on strong rims else 3 |
| Phlegra | diagonal scarp $9.6\tanh(1.95(d+0.2))$ blended with gentle outwash $6\tanh(0.75(d+0.2))$ in two valley Gaussians; moraine ridges $0.65\sin(9d)$ | thin zone at the scarp foot: tiu 78, unit 0; else $330+25\,\text{fbm}$; unit 3 where $d>-0.05$, else 0 or 2 |

Thermal inertia is clamped $\ge 45$ and rounded to `uint16`. Every file is deterministic (no RNG).

---

## 4. Grid and derived terrain layers (`sectorData.ts`)

Sector side $W=2048$ m, $N=128$ posts per side, spacing

$$h=\frac{W}{N-1}=\frac{2048}{127}\approx16.126\ \text{m}$$

Index $i=rN+c$. Border cells of finite-difference layers remain 0.

**Slope** (central differences, interior cells):

$$z_x=\frac{z_{r,c+1}-z_{r,c-1}}{2h},\quad z_y=\frac{z_{r+1,c}-z_{r-1,c}}{2h},\quad \beta=\frac{180}{\pi}\arctan\sqrt{z_x^2+z_y^2}$$

**Roughness** (3 x 3 population standard deviation, metres): $\sigma=\sqrt{\max\!\big(0,\ \overline{z^2}-\bar z^{\,2}\big)}$.

**Sky-view factor.** For the 8 compass directions $d$ with step length $\ell_d=h\cdot\{1,\sqrt2\}$, march $s=1..14$ cells,
stopping at the raster edge:

$$\theta_d=\max_{s:\ \Delta z_s>0}\ \arctan\frac{\Delta z_s}{s\,\ell_d}\ \ (0\text{ if none}),\qquad \mathrm{SVF}=\frac18\sum_{d=1}^{8}\cos^2\theta_d$$

(note: $\cos^2$ of the horizon elevation angle, a sky-fraction proxy; 14 cells = 226 m orthogonal, 320 m diagonal).
The radiation shield shown in the visor is $100(1-\mathrm{SVF})\%$.

**Optical landmarks.** Stride-4 lattice over $[8,N-9]^2$, sorted by elevation descending, greedy pick of up to three cells with
pairwise $\sqrt{\Delta c^2+\Delta r^2}\ge28$ cells (451.5 m); codes `LM-ALPHA`, `LM-BETA`, `LM-GAMMA`. This is highest-elevation selection
with a separation rule; there is no topographic-prominence (saddle) analysis despite the function name.

---

## 5. Sun and radio (`solarAndComms.ts`)

### 5.1 Moving-sun horizon ray-march

With local solar hour $t_h$ (UI range 6 to 18):

$$\alpha=\frac{t_h-6}{12}\pi,\quad s_x=100\cos\alpha,\quad s_y=\max(12,\,100\sin\alpha),\quad s_z=35$$

$$L=\sqrt{s_x^2+s_z^2},\quad (\hat d_c,\hat d_r)=\frac{(s_x,\,s_z)}{L},\quad \tan\varepsilon=\frac{s_y}{L}\cdot\frac{W/132}{10}$$

For $W=2048$ the relief factor is $(W/132)/10=1.5515$, so $\varepsilon\approx10^\circ$ at $t_h=6$ and 18, $\approx66^\circ$ at 14, $\approx77^\circ$ at 12.
The sun always lies on the $+z$ (row) side because $s_z$ is constant; only its column component sweeps. For each cell the ray
is stepped $k=1,2,\dots,N-1$ at grid positions $(\text{round}(r+\hat d_rk),\ \text{round}(c+\hat d_ck))$ (unit direction, so $kh$ metres of ray length):

$$\text{shadow}(r,c)\iff\exists k:\ z\big(\text{round}(r+\hat d_rk),\text{round}(c+\hat d_ck)\big)>z_{r,c}+k\,h\tan\varepsilon$$

Cost $O(N^3)\approx2.1\times10^6$ steps per Sol-slider tick. The visual `DirectionalLight` uses the same angle but a floor of 8 instead of 12.

### 5.2 UHF line of sight with curvature (`hasLineOfSight`)

Endpoints $A,B$ with antenna heights $h_A,h_B$, $z_A=z(A)+h_A$, $z_B=z(B)+h_B$, ground distance $D=h\sqrt{\Delta c^2+\Delta r^2}$,
$n=\max(|\Delta c|,|\Delta r|)$ samples $f=k/n$, $k=1..n-1$, nearest-cell terrain:

$$\text{beam}(f)=(1-f)\,z_A+f\,z_B-\frac{(fD)\,\big((1-f)D\big)}{2R},\qquad R=3{,}389{,}500\ \text{m}$$

The link is clear iff $z(\text{cell}_f)\le\text{beam}(f)$ for every sample. The sag $D^2/8R$ is 0.15 m over 2.05 km (0.31 m over the 2.9 km diagonal).
Antenna heights: habitat mast 22.0 m, relay mast 9.5 m, EVA suit 2.2 m, observer eye 1.8 m and landmark beacon 2.0 m for optical fixes.
No refraction, Fresnel zone, frequency or link budget is modelled: "2-way UHF radiometric ranging" is the binary event LOS $=1$.

`recomputeCommsLos` evaluates LOS from the habitat (22 m) to every cell (2.2 m): 16,384 tests.

---

## 6. Anisotropic cost model and A* (`runSearch`)

Let payload mass $m$ (kg), load ratio $\rho=m/145$, edge length $d=\{1,\sqrt2\}\,h$, edge slope
$\theta=\arctan(\Delta z/d)\cdot180/\pi$ (signed, along the travel direction).

**Hard limits** (an edge into a cell is skipped if any holds): the cell is hazard-blocked; $\beta_{cell}>\beta_{max}=\max(22,\ 32-0.15m)$;
$|\theta|>\theta_{max}=\max(20,\ 28-0.14m)$; the target is on the raster rim (search is restricted to indices $1..N-2$).

**Edge cost**

$$c=d\,\big(S+P_{sand}+P_{rough}+P_{rad}+P_{shadow}+P_{comms}\big)$$

$$S=1+0.5\rho+\begin{cases}0.04(1+1.8\rho)\,\theta^2&\theta>0\\[2pt]0.018(1+1.4\rho)(|\theta|-6)^2&\theta<-6\\[2pt]0&\text{otherwise}\end{cases}$$

$$P_{sand}=\begin{cases}\left(\dfrac{140-\mathrm{TIU}}{25}\right)^2(1+2.2\rho)&\mathrm{TIU}<140\\0&\text{else}\end{cases},\qquad
P_{rough}=\begin{cases}3.5\,\sigma\,(1+\rho)&\sigma>0.2\ \text{m}\\0&\text{else}\end{cases}$$

$$P_{rad}=0.35\,\mathrm{SVF},\qquad P_{shadow}=1.6\,D_t\,[\text{shaded}],\qquad P_{comms}=0.85\,[\text{no UHF LOS}]$$

(all terms evaluated at the destination cell). The "4D" (time) term:

$$v=\frac{45}{1+0.85\rho}\ \text{m/min},\qquad t_{arr}=t_0+\frac{h\,\lVert(c,r)-(c_s,r_s)\rVert}{60\,v}\ \text{h},\qquad D_t=\begin{cases}2.4&t_{arr}>17.2\\1&\text{else}\end{cases}$$

where $t_0$ is the departure Sol hour and the distance is the **straight-line distance from the start** to the node being expanded (not the
path length so far). The shaded flag comes from `solarShadow`, a snapshot for the slider hour, not for $t_{arr}$.

**Search.** Priority $f=g+h_{goal}$, $h_{goal}=h\lVert G-n\rVert$ (metres). Because $S\ge1$ and every other term is $\ge0$, each step
costs at least its length, so $h_{goal}$ is admissible and consistent and the first pop of the goal is optimal (to `Float32` rounding).
Data structures: preallocated `Float32Array` g/f scores, `Int32Array` parents and a binary min-heap of cell indices with lazy deletion
(`closed` mask; duplicates allowed; no decrease-key). *Shelter mode* sets $h=0$ and stops at the first cell with $\mathrm{SVF}\le0.58$ and
slope $\le\beta_{max}$.

**Naive baseline** (`evaluateDirectPath`): $n=\max(|\Delta c|,|\Delta r|)$, nodes $\text{round}(c_0+\Delta c\,k/n)$, no constraints, same telemetry.

---

## 7. Coupled xEMU PLSS consumables (`buildTelemetry`)

For each path segment of length $d$ (m), rise $\Delta z$, destination cell lit or shaded, and $\rho=m/145$:

**Metabolic O2 (litres)**

$$dO_2=\underbrace{0.018\,d\,(1+1.35\rho)}_{\text{flat}}+\underbrace{[\Delta z>0]\,0.085\,\Delta z\,(1+2.1\rho)}_{\text{climb}}+\underbrace{[\mathrm{TIU}<120]\,0.025\,d\,(1+2.2\rho)}_{\text{sand drag}}$$

(The walkback wavefront of section 9 adds a further $[\text{shaded}]\,0.004\,d$; the route telemetry here deliberately omits it so the benchmarked route O2 stays unchanged.)

**SWME sublimator cooling water (litres)** proportional to metabolic heat, hotter when in sun:

$$dH_2O=0.019\,dO_2\cdot\begin{cases}1.25&\text{lit}\\0.78&\text{shaded}\end{cases}$$

**Suit battery (Wh)**, with $\Delta t=\dfrac{d}{v\cdot60}$ h:

$$dE=\Delta t\cdot P,\qquad P=\begin{cases}65-25=40\ \text{W}&\text{lit (solar assist)}\\65+135=200\ \text{W}&\text{shaded (heater)}\end{cases}$$

**Science stops** (loops only; $n_{wp}$ waypoints, 15 min each): $+0.45\,\text{L/min}\cdot15n_{wp}$ O2, $+0.008\cdot15n_{wp}$ L water, $+60\ \text{W}\cdot\frac{15n_{wp}}{60}$ h.

**Totals.** Duration $=\text{round}(\sum d/v+15n_{wp})$ min; arrival hour $=\min(24,\ t_0+\text{duration}/60)$. Gauge ceilings
(`pathfinder.ts`): O2 180 L, water 4.2 L, battery 850 Wh; single-sortie walkback ceiling 95 L. In the HUD, single-target O2 is the target
cell's round-trip $W$ (section 9) if finite, else $2\times$ the route O2; water and battery are doubled for out-and-back routes; loops and the
rover case use the route values (rover O2 doubled).

**Validity.** `found` $=\left(\max\text{ segment slope}\le\beta_{max}\right)$ for the path's own payload.

---

## 8. GPS-denied navigation uncertainty (CEP)

Per-node state $\sigma_i$ (metres), $\sigma_0=0.8$, segment length $d$:

$$\sigma_i=\begin{cases}0.8&\text{UHF LOS at node }i\ \ (\text{2-way radiometric ranging lock})\\[2pt]
\min(\sigma_{i-1}+0.010\,d,\ 2.4)&\text{no LOS, }\ge2\text{ landmarks visible and node lit}\ \ (\text{skyline triangulation})\\[2pt]
\min(\sigma_{i-1}+0.016\,d,\ 6.8)&\text{no LOS, exactly 1 landmark visible and node lit}\\[2pt]
\sigma_{i-1}+0.028\,d&\text{otherwise}\ \ (\text{IMU dead reckoning, 2.8 \% of distance})\end{cases}$$

Visible landmarks are those with `hasLineOfSight` from 1.8 m eye height to a 2.0 m beacon. The `min(.)` caps double as fix re-acquisition:
a fix pulls a larger drifted $\sigma$ down to the cap. $\sigma_{max}=\max_i\sigma_i$ is the "GPS-Denied Max CEP" of the benchmark table.
Viewer: rings at every 12th node from index 8 where $\sigma>1$, radius $\text{clamp}(0.18\,\sigma,\,0.65,\,3.2)$ scene units (exaggerated, not to scale with metres), red above 5 m.
Visor label: `UHF RANGING LOCK` if LOS; else `SKYLINE TRIANGULATION [n PEAKS]` if $\ge2$ peaks visible (the visor label does not test sunlight); else `IMU DEAD RECKONING DRIFT`.

---

## 9. Bidirectional anisotropic walkback isochrone field (`computeWalkbackEnvelope`)

Two single-source Dijkstra runs from the habitat on the O2 edge cost (litres), $\rho_{out}=m/145$ and $\rho_{in}=(m+3)/145$:

$$c_{O_2}=0.018\,d(1+1.35\rho)+[\Delta z>0]\,0.085\,\Delta z\,(1+2.1\rho)+[\mathrm{TIU}<120]\,0.025\,d\,(1+2.2\rho)+[\text{shaded}]\,0.004\,d$$

with limits $\beta_{cell}\le\max(22,32-0.15m)$ and $|\theta|\le\max(20,28-0.14m)$. The **outbound** field $O_{out}(X)$ expands the edge $u\to v$ with
$\Delta z=z_v-z_u$ and entered cell $v$. The **inbound** field is Dijkstra on the *reversed* graph: expanding $u\to v$ it charges the cost of
walking $v\to u$, i.e. $\Delta z=z_u-z_v$ and sand drag from the entered cell $u$, so $O_{in}(X)$ is the cost to walk from $X$ home. Then

$$W(X)=O_{out}(X)+O_{in}(X)+\underbrace{15\cdot0.45}_{6.75\ \text{L sampling stop}},\qquad \text{safe}(X)\iff W(X)\le95\ \text{L}$$

$W=\infty$ when either field is unreachable. "Safe Walkback Area" $=100\cdot\#\text{safe}/N^2$ (rounded). `WALKBACK` colours: $|W-95|\le2.4$ white
(Point of No Return), $|W-47.5|\le1.5$ cyan (half budget), $W<95$ green to red by $W/95$, beyond that dark red, unreachable near black.
(In the code the two wavefronts are two independent Dijkstra runs and are combined cell by cell; they are not a meet-in-the-middle bidirectional search.)

---

## 10. Autonomous 2-hop UHF relay (`deployOptimalCommsRelay`)

1. Reset `commsLos` to first-hop (habitat) coverage; $C_0=\#\{\text{LOS}=1\}/N^2$.
2. $\mathcal R$ = route cells with LOS 0 (if a route is active), $\mathcal S$ = LOS-0 cells on the stride-4 lattice $[4,N-5]^2$.
3. Candidate $k$ on the stride-3 lattice $[6,N-7]^2$ with LOS 1 from the habitat, slope $\le22^\circ$, TIU $\ge130$:

$$\text{score}(k)=0.15\,z_k+25\sum_{j\in\mathcal R}\text{LOS}(k_{9.5\text{m}}\!\to\! j_{2.2\text{m}})+2\sum_{j\in\mathcal S}\text{LOS}(k_{9.5\text{m}}\!\to\! j_{2.2\text{m}})$$

4. Best score wins (fallback: the habitat cell if no candidate qualifies). Every LOS-0 cell visible from the relay is set to 1 (the second hop) **in place**; $C_1=\#\{\text{LOS}=1\}/N^2$.
   The habitat-to-relay link is tested with the habitat mast to a 2.2 m antenna at the relay cell (conservative for a 9.5 m mast).
Reported: `beforeCoveragePct` $=\text{round}(100C_0)$, `afterCoveragePct` $=\text{round}(100C_1)$.

---

## 11. Multimodal Steiner-point rendezvous (`findRoverAssistedRoute`)

Rover phase: Dijkstra from the habitat over cells with slope $\le15.5^\circ$, TIU $\ge130$, roughness $\le$ the sector's 75th-percentile roughness (computed once per call; the generated terrain is vertically exaggerated, so an absolute metre limit passes only 4-34 % of cells) and edge slope $\le14.5^\circ$,
edge cost $d\,(1+0.08\,|\theta|)$ giving $C_{rover}(X)$ (weighted-metre units). Rendezvous over the stride-2 lattice $[2,N-3]^2$ of reachable cells:

$$R^*=\arg\min_R\ \Big(\underbrace{h\,\lVert R-G\rVert}_{\text{foot, Euclidean m}}+0.18\,C_{rover}(R)\Big)$$

a discrete weighted-sum minimisation over the two-leg chain $H\xrightarrow{rover}R\xrightarrow{foot}G$ (the Steiner / Fermat-Weber idea with weights 1 and 0.18;
the foot leg is not solved during the scan). Then the foot leg is solved by `runSearch` from $R^*$ to $G$ with $m=2.2$ kg. Combined values:

$$D_{rover}=0.65\,C_{rover}(R^*),\quad T_{rover}=\text{round}(D_{rover}/110)\ \text{min},\quad O_{2,rover}=0.35\,T_{rover}$$

Distance and duration add; O2 $=O_{2,rover}+O_{2,foot}$ (the HUD doubles it for the return). Water, battery, CEP, slope and sand come from the foot leg.
$0.65$ and $110$ m/min are empirical constants in the code. Because the result carries the foot leg's telemetry, `payloadMassKg` is 2.2 and `safeSlopeLimitDeg` 31.7 (the foot leg's, so the two agree). If the foot leg fails, that failed result is returned with `roverPathIndices` / `rendezvousCoord` attached. If the rendezvous equals the start (no rover leg), the result is `found = false` labelled "ROVER UNAVAILABLE" instead of a foot route posing as rover-assisted.

---

## 12. Science loop (`findScienceLoop`)

Waypoints $w_1..w_n$ ($n=3$ at Mount Sharp, else 2). For each of the $n!$ permutations, legs $H\to w_{\pi(1)}\to\dots\to H$ are planned with
`findRoute`; leg $s$ (from 0) carries $m+1.5s$ kg and departs at $t_{s}=t_{arr,s-1}+0.25$ h. The permutation with the smallest $\sum O_{2,leg}$ wins
(ties keep the first). The concatenated path is re-evaluated once by `buildTelemetry` at the base payload with $15n$ minutes of science stops, which
is the reported "Loop O2", "Loop Dist". `found = false` with label "Loop Blocked by Payload / In-Situ Hazard" if no permutation is feasible.
The reported order strings in `BENCHMARKS.md` (e.g. `HAB → WP-2 → WP-1 → WP-3 → HAB`) are these winners.

---

## 13. Live in-situ hazards (`toggleInSituHazard`)

Shift+Click at $(c,r)$ (ignored within 3 cells of the habitat): if any blocked cell exists in the $9\times9$ window the click **clears** the whole 8-connected patch containing the blocked cell nearest the click (other patches survive), else it **blocks** a $5\times5$ square (about 80 m), restricted to indices $1..N-2$. The call returns `added` / `cleared` / `ignored` and the status line reports exactly that. A blocked start cell makes every search (and the walkback wavefronts) return not-found / unreachable. `inSituBlocked` is read by `runSearch`, the rover Dijkstra,
both walkback wavefronts and the discovery search, so the caller re-solves route, loop and walkback and the path bends around the block. The viewer
draws one red cone per patch.

---

## 14. Discovery score and ice table (`sectorData.ts`)

**Shannon-entropy geological-contact detector.** For interior cells (margin 2) with $\beta\le27.5^\circ$ and TIU $\ge115$ (else 0), over the 5 x 5 window,
$p_k=n_k/25$ for classes $k=0..3$:

$$H=-\sum_kp_k\log_2p_k\ \ [\text{bits}],\quad \tau=\min\!\Big(1,\frac{\lVert\nabla\mathrm{TIU}\rVert}{90}\Big),\quad \lVert\nabla\mathrm{TIU}\rVert=\sqrt{(\mathrm{TIU}_{c+1}-\mathrm{TIU}_{c-1})^2+(\mathrm{TIU}_{r+1}-\mathrm{TIU}_{r-1})^2}$$

$$\text{score}=\min\Big(100,\ \text{round}\Big(100\cdot\frac{H}{1.58}\,(0.55+0.45\tau)\,\kappa\Big)\Big),\qquad\kappa=\begin{cases}1.25&4^\circ\le\beta\le24^\circ\\0.75&\text{else}\end{cases}$$

$1.58\approx\log_23$; four-class mixes can reach $H=2$ so the clamp matters. The route detour candidate (`findRouteDiscoveryHotspot`) takes the best cell with
score $>45$ in $11\times11$ windows (stride 2) around every second route node, excluding cells within 10 cells of the habitat or any waypoint.

**SHARAD-style ice / hydrated-horizon depth (heuristic, by class)** with TIU in thermal inertia units and $z$ in metres:

$$d_{ice}=\begin{cases}\max(0.6,\ 1.8-0.004(\mathrm{TIU}-250))&\text{class 3}\\6.2+\max(0,0.05z)&\text{class 1}\\13.5+\max(0,0.06z)&\text{class 2}\\24&\text{class 0}\end{cases}$$

This is a lookup, not a radar inversion. It explains the benchmark's "SHARAD Min Ice Depth" of -6.2 m at Mount Sharp (class 1 at $z\le0$)
and -1.4 to -1.6 m at the ice-apron sites.

---

## 15. Viewer mappings (`scene3D.ts`, `wristHud.ts`)

* **Scene scale.** `sceneSpan = 100` units for 2048 m: $x,z=(\text{idx}/(N-1)-0.5)\cdot100$, $y=z_m\cdot100/2048+\text{offset}$ (same factor horizontally and vertically).
* **Subsurface curtain.** Per route node, 8 vertices at depths $k/7\cdot155$ m, $k=0..7$. Colour rule (first match): $|{\rm depth}-3.2\,d_{ice}|<14$ cyan (ice lens, 3.2 is a display exaggeration);
  depth < 28 regolith / caprock; $z_{surf}-\text{depth}>-35$ Hesperian sulfate; else Noachian clay. Terrain opacity drops to 0.44 when on.
* **Detail texture.** 1024 x 1024; luminance $L=0.299R+0.587G+0.114B$ of the class's NASA photo, $v=255\,(b+(L-0.5)\,k)$ with $(b,k)=(0.84,0.32)$ off-route and $(0.74,0.58)$ within $\pm2$ cells of the route.
* **Elevation SVG** (HUD): surface and a dashed ice horizon at $z-2.5\,d_{ice}$ (2.5x exaggeration).
* **Visor.** Progress rate 0.045 per second, heading $=(\text{round}(\text{atan2}(dx,-dz)\cdot180/\pi)+360)\bmod360$, absolute elevation = datum + $z$.

---

## 16. Memory budget (per sector)

| Array | dtype | Elements | KiB | Counted in `memoryKB` (508.0) |
|---|---|---|---|---|
| elevation | f32 | 16,384 | 64 | yes |
| thermal (coarse, from disk) | u16 | 4,096 | 8 | yes |
| geologic (coarse, from disk) | u8 | 4,096 | 4 | yes |
| slopeDeg, roughness, skyViewFactor | f32 | 16,384 each | 64 x 3 | yes |
| walkbackO2, discoveryScore, iceTableDepthM | f32 | 16,384 each | 64 x 3 | yes |
| solarShadow, commsLos, inSituBlocked | u8 | 16,384 each | 16 x 3 | yes |
| thermalInertia (expanded, used by solvers) | f32 | 16,384 | 64 | **no** |
| geologicUnit (expanded, used by solvers) | u8 | 16,384 | 16 | **no** |

Counted: $64+8+4+192+192+48=508.0$ KiB (the reported "Active RAM"). Live typed arrays in the returned bundle: $508-12+64+16=576.0$ KiB.
Pathfinder scratch (`new AnisotropicPathfinder(128*128)`): gScore, fScore, outboundO2, inboundO2 (4 x 64 KiB) + parent (64) + heap (64) + closed (16) = 400 KiB.
Disk per site 76.0 KiB. Built JavaScript: application chunk 75.59 kB (24.50 kB gzip); `src/core` alone minified 21.80 kB (8.94 kB gzip); three.js chunk 581.61 kB (143.84 kB gzip).

---

## 17. Known approximations (read before quoting a number)

* Terrain packs are procedural, not measured DEMs (section 3). Absolute slopes, sand and shadows are therefore properties of the synthetic landforms.
* "4D": time is a departure-hour parameter plus a dusk multiplier from an estimated arrival hour; the shadow mask is a single snapshot, not time-expanded.
* The sun model is a fixed-plane toy model (constant $s_z=35$, elevation floor 12, relief scale $(W/132)/10$), not an ephemeris.
* Radio is binary LOS with a parabolic curvature term; there is no link budget, multipath or terrain diffraction.
* Ice-table depth, strata colours and the radar curtain are class-based heuristics; no SHARAD, SWIM, SHERLOC or PIXL data are ingested.
* Consumable coefficients (0.018, 0.085, 0.025 L; 0.019, 1.25 / 0.78; 65 / -25 / +135 W; 145 kg; 45 m/min) are model constants chosen in the code, not mission-certified xEMU values.
* The binary heap has no decrease-key: a node's `fScore` can be lowered while an older heap entry for it exists, so heap order can be locally perturbed; a duplicate entry is also pushed and stale pops are skipped by `closed`. Routes stay valid; strict optimality is not guaranteed in rare ties.
* Active RAM undercounts the expanded thermal / geologic arrays by 80 KiB (section 16).
