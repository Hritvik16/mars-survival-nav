// src/core/sectorData.ts
/**
 * @file sectorData.ts
 * @module core/sectorData
 *
 * Site catalogue, the per-sector buffer bundle ("SectorBuffers") and the terrain-derived layers that
 * do NOT depend on the time of day or on routing: slope, roughness, sky-view factor, SHARAD-style
 * ice-table depth, Shannon-entropy "discovery" score and the optical-navigation landmark picker.
 *
 * Grid conventions used throughout src/core:
 *   - A sector is a square N x N raster, N = gridSize = 128, stored row-major: idx = row * N + col.
 *   - It spans worldSizeMeters W = 2048 m, so the sample pitch is h = W / (N - 1) = 2048 / 127
 *     = 16.126 m per cell (N - 1 intervals between N posts).
 *   - col increases toward +x (east in the viewer), row toward +z (south in the viewer).
 *   - Elevation is in metres relative to the site datum (MARS_SITES[id].baseDatumMeters, MOLA).
 *   - Cells on the outer border are never written by the finite-difference layers (they stay 0).
 *
 * Dataflow: loadSectorFromBinary() (sectorGrid.ts) or createSyntheticSector() (below) fill
 * elevation / thermalInertia / geologicUnit, then call the recompute* functions here and in
 * solarAndComms.ts to fill every derived layer. Pathfinding (pathfinder.ts) only READS these.
 */
import { recomputeCommsLos, recomputeSolarShadow } from './solarAndComms';

/**
 * Heat-map layers the 3D viewer can paint onto the terrain (see Scene3DHarness.applyHeatmap):
 * mars = hypsometric tint, slope = hazard ramp, sand = thermal-inertia trafficability,
 * roughness = 3x3 elevation RMS, radiation = sky-view exposure, solar = lit/shadow mask,
 * comms = UHF line-of-sight mask, walkback = round-trip O2 field, discovery = entropy score.
 */
export type LayerMode =
  | 'mars'
  | 'slope'
  | 'sand'
  | 'roughness'
  | 'radiation'
  | 'solar'
  | 'comms'
  | 'walkback'
  | 'discovery';

export type SiteId = 'mount_sharp' | 'deuteronilus' | 'arcadia_ap1' | 'phlegra_pm1';

/**
 * A science stop. (col,row) are grid indices (0..127); the HUD, the route solver and the 3D beacons
 * all use the same indices. scienceGoal is display text only.
 */
export interface ScienceWaypoint {
  readonly code: string;
  readonly shortLabel: string;
  readonly title: string;
  readonly col: number;
  readonly row: number;
  readonly scienceGoal: string;
}

/**
 * A high-ground optical navigation landmark used by the GPS-denied CEP model (see
 * findProminenceLandmarks). elevMeters is the rounded site-relative elevation in metres.
 */
export interface HorizonLandmark {
  readonly code: string;
  readonly col: number;
  readonly row: number;
  readonly elevMeters: number;
}

/**
 * Static description of a landing site. baseDatumMeters is the MOLA datum offset added to
 * site-relative elevation to display absolute elevation in the visor. marsTrekTileUrl is a
 * 256x256 JPEG orbital context tile served from /public/images (display only; not sampled by the solvers).
 */
export interface SiteMetadata {
  readonly id: SiteId;
  readonly name: string;
  readonly coordsLabel: string;
  readonly baseDatumMeters: number;
  readonly habCol: number;
  readonly habRow: number;
  readonly marsTrekTileUrl: string;
  readonly waypoints: readonly ScienceWaypoint[];
}

/**
 * The four candidate EVA sectors. habCol/habRow here are defaults; loadSectorFromBinary overrides
 * them with manifest.hab_grid_coords. Waypoint grid coordinates are authored by hand and are the
 * inputs to findScienceLoop (n = 3, 2, 2, 2 waypoints -> 6, 2, 2, 2 visit orders).
 */
export const MARS_SITES: Record<SiteId, SiteMetadata> = {
  mount_sharp: {
    id: 'mount_sharp',
    name: 'Mount Sharp (Gale Crater Boxwork Ridge)',
    coordsLabel: '4.95°S, 137.40°E (-4,500m MOLA | 2.05km Sector)',
    baseDatumMeters: -4500,
    habCol: 20,
    habRow: 64,
    marsTrekTileUrl: '/images/trek_mount_sharp.jpg',
    waypoints: [
      {
        code: 'WP-1',
        shortLabel: 'WP-1 BOXWORK',
        title: '2025 Boxwork Mineral Ridge (Curiosity Target)',
        col: 108,
        row: 46,
        scienceGoal: 'Sample cemented groundwater fracture networks for ancient microbial biosignatures.',
      },
      {
        code: 'WP-2',
        shortLabel: 'WP-2 SULFATE',
        title: 'Gediz Vallis Sulfate Transition Channel',
        col: 62,
        row: 28,
        scienceGoal: 'Core Hesperian sulfate-to-clay transition strata along the alluvial breach.',
      },
      {
        code: 'WP-3',
        shortLabel: 'WP-3 PEDIMENT',
        title: 'Greenheugh Pediment Basal Bench',
        col: 96,
        row: 102,
        scienceGoal: 'Inspect cross-bedded eolian sandstone unconformity above Bagnold sand sheet.',
      },
    ],
  },
  deuteronilus: {
    id: 'deuteronilus',
    name: 'Deuteronilus Mensae (Fretted Glacial Dichotomy)',
    coordsLabel: '43.90°N, 22.60°E (-3,800m MOLA | 2.05km Sector)',
    baseDatumMeters: -3800,
    habCol: 24,
    habRow: 64,
    marsTrekTileUrl: '/images/trek_deuteronilus.jpg',
    waypoints: [
      {
        code: 'WP-1',
        shortLabel: 'WP-1 GLACIER',
        title: 'SHARAD Subsurface Glacial Ice Exposure',
        col: 104,
        row: 38,
        scienceGoal: 'Drill 1.5m ice core for ISRU Sabatier propellant water stock & paleoclimate isotopes.',
      },
      {
        code: 'WP-2',
        shortLabel: 'WP-2 CLAY ALCOVE',
        title: 'Noachian Clay-Bearing Mesa Alcove',
        col: 72,
        row: 98,
        scienceGoal: 'X-ray fluorescence assay of iron-magnesium phyllosilicates in shielded cliff wall.',
      },
    ],
  },
  arcadia_ap1: {
    id: 'arcadia_ap1',
    name: 'Arcadia Planitia (Starship Candidate Site AP-1)',
    coordsLabel: '39.09°N, 189.79°E (-4,200m MOLA | 2.05km Sector)',
    baseDatumMeters: -4200,
    habCol: 64,
    habRow: 64,
    marsTrekTileUrl: '/images/trek_arcadia_ap1.jpg',
    waypoints: [
      {
        code: 'WP-1',
        shortLabel: 'WP-1 ICE POLYGON',
        title: 'SWIM Polygonal Ice Trench Network',
        col: 22,
        row: 24,
        scienceGoal: 'Ground-penetrating radar survey of shallow (<2m) massive water-ice sheet.',
      },
      {
        code: 'WP-2',
        shortLabel: 'WP-2 EJECTA RIM',
        title: 'Fresh Secondary Crater Ejecta Rim',
        col: 94,
        row: 52,
        scienceGoal: 'Collect excavated Amazonian basaltic lava blocks along crater rim.',
      },
    ],
  },
  phlegra_pm1: {
    id: 'phlegra_pm1',
    name: 'Phlegra Montes (Lobate Debris Apron PM-1)',
    coordsLabel: '39.80°N, 163.20°E (-3,600m MOLA | 2.05km Sector)',
    baseDatumMeters: -3600,
    habCol: 18,
    habRow: 100,
    marsTrekTileUrl: '/images/trek_phlegra_pm1.jpg',
    waypoints: [
      {
        code: 'WP-1',
        shortLabel: 'WP-1 MORAINE ICE',
        title: 'Lobate Debris Apron Glacial Moraine',
        col: 92,
        row: 44,
        scienceGoal: 'Sample >80% pure piedmont glacier ice beneath thin regolith sublimation lag.',
      },
      {
        code: 'WP-2',
        shortLabel: 'WP-2 SCARP SEIS',
        title: 'Piedmont Ridge Tectonic Scarp',
        col: 54,
        row: 24,
        scienceGoal: 'Deploy broadband seismometer array on exposed bedrock bench.',
      },
    ],
  },
};

/**
 * Display names for geologic class ids 0..3 as stored in geologic.bin (uint8):
 *   0 = unconsolidated eolian sand (low thermal inertia, sinkage risk),
 *   1 = layered sulfate / clay terrace, 2 = basaltic bedrock / cemented boxwork,
 *   3 = shallow water-ice apron. The same ids index UNIT_IMAGE_URLS (scene3D.ts) and
 *   UNIT_SURFACE_POV (wristHud.ts), and select the branches of recomputeIceTableDepth().
 */
export const GEOLOGIC_UNIT_LABELS: readonly string[] = [
  'Bagnold Eolian Sand Sheet (Low-TIU Dust Trap)',
  'Hesperian Layered Sulfate & Clay Terrace',
  'Amazonian Basaltic Bedrock & Cemented Boxwork',
  'SHARAD Shallow Subsurface Water-Ice Apron',
];

/**
 * Everything the solvers and the viewer need for one sector. All arrays are length N*N, row-major.
 *   elevation       Float32  m      site-relative surface height (read from elevation.bin)
 *   slopeDeg        Float32  deg    atan(|grad z|), central differences (border = 0)
 *   thermalInertia  Float32  TIU    bilinear up-sample of the 64x64 uint16 channel (low = sand)
 *   roughness       Float32  m      std-dev of elevation in a 3x3 window (border = 0)
 *   skyViewFactor   Float32  0..1   mean cos^2 of the 8-direction horizon angle (1 = open sky)
 *   solarShadow     Uint8    0/1    1 = sunlit at the current Sol hour (solarAndComms.ts)
 *   commsLos        Uint8    0/1    1 = UHF line of sight to the Hab mast (or to a deployed relay)
 *   geologicUnit    Uint8    0..3   nearest-neighbour up-sample of the 64x64 class channel
 *   walkbackO2      Float32  L      round-trip O2 field (Infinity = unreachable); filled by
 *                                   AnisotropicPathfinder.computeWalkbackEnvelope
 *   discoveryScore  Float32  0..100 Shannon-entropy geological-contact score
 *   iceTableDepthM  Float32  m      heuristic depth to ice / hydrated horizon
 *   inSituBlocked   Uint8    0/1    Shift+Click hazard mask, treated as impassable by every search
 * memoryKB is the byte total of the arrays the loader COUNTS (see sectorGrid.ts) divided by 1024.
 */
export interface SectorBuffers {
  readonly site: SiteMetadata;
  readonly gridSize: number;
  readonly worldSizeMeters: number;
  readonly elevation: Float32Array;
  readonly slopeDeg: Float32Array;
  readonly thermalInertia: Float32Array;
  readonly roughness: Float32Array;
  readonly skyViewFactor: Float32Array;
  readonly solarShadow: Uint8Array;
  readonly commsLos: Uint8Array;
  readonly geologicUnit: Uint8Array;
  readonly walkbackO2: Float32Array;
  readonly discoveryScore: Float32Array;
  readonly iceTableDepthM: Float32Array;
  readonly inSituBlocked: Uint8Array;
  readonly landmarks: readonly HorizonLandmark[];
  readonly memoryKB: number;
}

/**
 * Picks up to three optical-navigation landmarks for GPS-denied position fixing.
 *
 * Algorithm: sample a stride-4 lattice over the interior [8, N-9] x [8, N-9], sort the samples by
 * elevation (descending) and greedily accept a sample if it lies >= 28 cells (28 * 16.126 m =
 * 451.5 m) from every landmark already accepted. Codes are LM-ALPHA, LM-BETA, LM-GAMMA in order.
 * Note: this ranks by absolute elevation within the sector, not by topographic prominence
 * (there is no saddle / col analysis); the separation rule is what spreads the peaks out.
 *
 * @param elevation  site-relative heights in metres, length gridSize^2
 * @param gridSize   raster width/height N
 * @returns          0..3 landmarks (3 whenever the sector is large enough, which 128x128 always is)
 */
export function findProminenceLandmarks(
  elevation: Float32Array,
  gridSize: number
): HorizonLandmark[] {
  const candidates: { col: number; row: number; z: number }[] = [];
  for (let r = 8; r < gridSize - 8; r += 4) {
    for (let c = 8; c < gridSize - 8; c += 4) {
      const z = elevation[r * gridSize + c];
      candidates.push({ col: c, row: r, z });
    }
  }
  candidates.sort((a, b) => b.z - a.z);

  const selected: HorizonLandmark[] = [];
  const codes = ['LM-ALPHA', 'LM-BETA', 'LM-GAMMA'];
  for (const cand of candidates) {
    if (selected.every((s) => Math.hypot(s.col - cand.col, s.row - cand.row) >= 28)) {
      selected.push({
        code: codes[selected.length],
        col: cand.col,
        row: cand.row,
        elevMeters: Math.round(cand.z),
      });
      if (selected.length === 3) break;
    }
  }
  return selected;
}

/**
 * Heuristic depth (metres below the surface) to the shallowest water-ice / hydrated-mineral
 * horizon, one value per cell. This is a lookup keyed on geologic class - NOT an inversion of
 * SHARAD radargrams - so it is a planning proxy for the "SHARAD ice" read-outs and the 3D curtain.
 *
 *   class 3 (ice apron):      d = max(0.6, 1.8 - 0.004 * (TIU - 250))       [m]
 *   class 1 (sulfate/clay):   d = 6.2  + max(0, 0.05 * z)                   [m], z = elevation in m
 *   class 2 (bedrock):        d = 13.5 + max(0, 0.06 * z)                   [m]
 *   class 0 (dry sand):       d = 24.0                                      [m] (constant)
 *
 * Higher thermal inertia on class 3 makes the ice table shallower (more ice-cemented regolith).
 *
 * @param elevation       site-relative elevation, m
 * @param thermalInertia  TIU (thermal inertia units), full-resolution Float32
 * @param geologicUnit    class ids 0..3
 * @param iceTableDepthM  OUTPUT, metres below surface
 * @param gridSize        raster width N
 */
export function recomputeIceTableDepth(
  elevation: Float32Array,
  thermalInertia: Float32Array,
  geologicUnit: Uint8Array,
  iceTableDepthM: Float32Array,
  gridSize: number
): void {
  for (let i = 0; i < gridSize * gridSize; i++) {
    const u = geologicUnit[i];
    const tiu = thermalInertia[i];
    if (u === 3) {
      // Glacial Lobate Debris Apron / SWIM ice polygon: shallow ice 0.8m - 2.4m deep
      iceTableDepthM[i] = Math.max(0.6, 1.8 - (tiu - 250) * 0.004);
    } else if (u === 1) {
      // Hesperian Sulfate / Clay bench: hydrated phyllosilicate contact 4.5m - 9.5m deep
      iceTableDepthM[i] = 6.2 + Math.max(0, elevation[i] * 0.05);
    } else if (u === 2) {
      // Cemented Boxwork / Basaltic caprock: deeper fracture water table 11m - 19m
      iceTableDepthM[i] = 13.5 + Math.max(0, elevation[i] * 0.06);
    } else {
      // Dry unconsolidated eolian sand
      iceTableDepthM[i] = 24.0;
    }
  }
}

/**
 * Shannon-entropy geological-contact ("unconformity") detector.
 *
 * For every interior cell (border of 2 skipped) that is traversable - slope <= 27.5 deg AND
 * thermal inertia >= 115 TIU, otherwise score = 0 - take the 5x5 neighbourhood (25 cells),
 * build the class histogram n_k (k = 0..3, class = geologicUnit & 3) and compute
 *
 *     p_k = n_k / 25,        H = - sum_k p_k * log2(p_k)      [bits]
 *
 * H is 0 inside a single unit and grows where several units meet. It is modulated by
 *   tiuFactor     = min(1, |grad TIU| / 90),  |grad TIU| = hypot(TIU[c+1]-TIU[c-1], TIU[r+1]-TIU[r-1])
 *                   (a 2-cell difference in TIU units, NOT divided by distance)
 *   outcropFactor = 1.25 if 4 deg <= slope <= 24 deg (exposed, climbable outcrop) else 0.75
 *
 *     score = min(100, round( (H / 1.58) * (0.55 + 0.45 * tiuFactor) * outcropFactor * 100 ))
 *
 * 1.58 ~ log2(3): the entropy of a 3-way even split. With four classes H can reach 2 bits, so
 * the factor can exceed 1 and the min(...,100) clamp matters for 4-unit corners.
 *
 * @param geologicUnit    class ids 0..3
 * @param thermalInertia  TIU, full-resolution
 * @param slopeDeg        degrees (from recomputeSlopeAndRoughness)
 * @param discoveryScore  OUTPUT, 0..100
 * @param gridSize        raster width N
 */
export function recomputeDiscoveryScore(
  geologicUnit: Uint8Array,
  thermalInertia: Float32Array,
  slopeDeg: Float32Array,
  discoveryScore: Float32Array,
  gridSize: number
): void {
  const counts = new Int32Array(4);
  for (let r = 2; r < gridSize - 2; r++) {
    for (let c = 2; c < gridSize - 2; c++) {
      const idx = r * gridSize + c;
      if (slopeDeg[idx] > 27.5 || thermalInertia[idx] < 115) {
        discoveryScore[idx] = 0;
        continue;
      }
      counts.fill(0);
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const u = geologicUnit[(r + dr) * gridSize + (c + dc)] ?? 0;
          counts[u & 3]++;
        }
      }
      let entropy = 0;
      for (let k = 0; k < 4; k++) {
        if (counts[k] > 0) {
          const p = counts[k] / 25.0;
          entropy -= p * Math.log2(p);
        }
      }
      const dTiu = Math.hypot(
        thermalInertia[idx + 1] - thermalInertia[idx - 1],
        thermalInertia[idx + gridSize] - thermalInertia[idx - gridSize]
      );
      const tiuFactor = Math.min(1.0, dTiu / 90.0);
      const outcropFactor = slopeDeg[idx] >= 4.0 && slopeDeg[idx] <= 24.0 ? 1.25 : 0.75;
      discoveryScore[idx] = Math.min(
        100,
        Math.round((entropy / 1.58) * (0.55 + 0.45 * tiuFactor) * outcropFactor * 100)
      );
    }
  }
}

/**
 * Builds a self-contained procedural sector (Mount Sharp style S-curve canyon) without any
 * network access. main.ts uses it for the very first frame and as a fallback when
 * loadSectorFromBinary() throws. It is NOT the same terrain as the .bin packs.
 *
 *   nx = (c / N - 0.5) * 4,  ny = (r / N - 0.5) * 4          (note: divides by N, the packs use N-1)
 *   canyon centre line  x_c(ny) = 0.62 * sin(1.35 * ny)
 *   strata              s = 6 * tanh(1.5 * |nx - x_c|) - 3
 *   elevation           z = s * (W / 132)  metres
 *   thermal inertia     80 TIU inside |nx - x_c| < 0.3 (sand), else 290 TIU
 *   geologic unit       0 in the canyon, else 2 if s > 1.5, else 1
 *
 * It then runs the full derived-layer pipeline at Sol hour 14.0 and reports memoryKB over all 12
 * allocated arrays (here that includes the full-resolution thermalInertia and geologicUnit).
 *
 * @param gridSize        N (default 128)
 * @param worldSizeMeters W in metres (default 2048)
 * @param siteId          selects MARS_SITES metadata (hab position, waypoints)
 */
export function createSyntheticSector(
  gridSize = 128,
  worldSizeMeters = 2048,
  siteId: SiteId = 'mount_sharp'
): SectorBuffers {
  const site = MARS_SITES[siteId];
  const count = gridSize * gridSize;
  const elevation = new Float32Array(count);
  const slopeDeg = new Float32Array(count);
  const thermalInertia = new Float32Array(count);
  const roughness = new Float32Array(count);
  const skyViewFactor = new Float32Array(count);
  const solarShadow = new Uint8Array(count);
  const commsLos = new Uint8Array(count);
  const geologicUnit = new Uint8Array(count);
  const walkbackO2 = new Float32Array(count);
  const discoveryScore = new Float32Array(count);
  const iceTableDepthM = new Float32Array(count);
  const inSituBlocked = new Uint8Array(count);

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      const nx = (c / gridSize - 0.5) * 4.0;
      const ny = (r / gridSize - 0.5) * 4.0;
      const canyonPath = Math.sin(ny * 1.35) * 0.62;
      const canyonDist = Math.abs(nx - canyonPath);
      const strata = Math.tanh(canyonDist * 1.5) * 6.0 - 3.0;
      elevation[idx] = strata * (worldSizeMeters / 132.0);
      thermalInertia[idx] = canyonDist < 0.3 ? 80 : 290;
      geologicUnit[idx] = canyonDist < 0.3 ? 0 : strata > 1.5 ? 2 : 1;
    }
  }

  recomputeSlopeAndRoughness(elevation, slopeDeg, roughness, gridSize, worldSizeMeters);
  recomputeSkyViewFactor(elevation, skyViewFactor, gridSize, worldSizeMeters);
  recomputeSolarShadow(elevation, solarShadow, gridSize, worldSizeMeters, 14.0);
  recomputeCommsLos(elevation, commsLos, gridSize, worldSizeMeters, site.habCol, site.habRow);
  recomputeDiscoveryScore(geologicUnit, thermalInertia, slopeDeg, discoveryScore, gridSize);
  recomputeIceTableDepth(elevation, thermalInertia, geologicUnit, iceTableDepthM, gridSize);
  const landmarks = findProminenceLandmarks(elevation, gridSize);

  const totalBytes =
    elevation.byteLength +
    slopeDeg.byteLength +
    thermalInertia.byteLength +
    roughness.byteLength +
    skyViewFactor.byteLength +
    solarShadow.byteLength +
    commsLos.byteLength +
    geologicUnit.byteLength +
    walkbackO2.byteLength +
    discoveryScore.byteLength +
    iceTableDepthM.byteLength +
    inSituBlocked.byteLength;

  return {
    site,
    gridSize,
    worldSizeMeters,
    elevation,
    slopeDeg,
    thermalInertia,
    roughness,
    skyViewFactor,
    solarShadow,
    commsLos,
    geologicUnit,
    walkbackO2,
    discoveryScore,
    iceTableDepthM,
    inSituBlocked,
    landmarks,
    memoryKB: Math.round((totalBytes / 1024) * 10) / 10,
  };
}

/**
 * Fills slopeDeg and roughness for all interior cells (row, col in 1..N-2); the border stays 0.
 *
 * Slope - central differences with pitch h = W / (N - 1):
 *     dz/dx = (z[r, c+1] - z[r, c-1]) / (2h),   dz/dy = (z[r+1, c] - z[r-1, c]) / (2h)
 *     slope = atan( sqrt( (dz/dx)^2 + (dz/dy)^2 ) ) * 180 / pi            [degrees]
 *
 * Roughness - population standard deviation of the 3x3 elevation window:
 *     sigma = sqrt( max(0, E[z^2] - E[z]^2) )                              [metres]
 * (the max(0, .) guards against tiny negative values from cancellation in Float64 arithmetic).
 *
 * @param elevation       metres
 * @param slopeDeg        OUTPUT, degrees
 * @param roughness       OUTPUT, metres
 * @param gridSize        N
 * @param worldSizeMeters W (m)
 */
export function recomputeSlopeAndRoughness(
  elevation: Float32Array,
  slopeDeg: Float32Array,
  roughness: Float32Array,
  gridSize: number,
  worldSizeMeters: number
): void {
  const cellStep = worldSizeMeters / (gridSize - 1);
  for (let r = 1; r < gridSize - 1; r++) {
    for (let c = 1; c < gridSize - 1; c++) {
      const idx = r * gridSize + c;
      const dzdx = (elevation[idx + 1] - elevation[idx - 1]) / (2 * cellStep);
      const dzdy = (elevation[idx + gridSize] - elevation[idx - gridSize]) / (2 * cellStep);
      slopeDeg[idx] = Math.atan(Math.hypot(dzdx, dzdy)) * (180 / Math.PI);

      let sum = 0;
      let sumSq = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const z = elevation[(r + dr) * gridSize + (c + dc)];
          sum += z;
          sumSq += z * z;
        }
      }
      const mean = sum / 9.0;
      roughness[idx] = Math.sqrt(Math.max(0, sumSq / 9.0 - mean * mean));
    }
  }
}

/**
 * Sky-view factor (SVF), the radiation-shelter / SPE-shelter proxy.
 *
 * For each cell, march outward in 8 compass directions (stride 1 cell, up to 14 cells = 226 m
 * orthogonally, 320 m diagonally; the march stops at the raster edge). In direction d the horizon
 * elevation angle is
 *     theta_d = max over steps s with dz_s > 0 of atan2( dz_s, s * stepDist ),   0 if no rise
 *     stepDist = hypot(dc, dr) * h,   dz_s = z(cell + s*d) - z(cell)
 * and the factor is the mean squared cosine over the 8 directions:
 *     SVF = (1/8) * sum_d cos^2(theta_d)
 * SVF = 1 on open flat ground and falls toward 0 inside deep canyons. Used by the A* radiation
 * penalty (0.35 * SVF per metre), the SHELTER search (SVF <= 0.58) and the "radiation" heat map.
 * RAD SHIELD in the visor is displayed as 100 - SVF*100 percent.
 *
 * @param elevation       metres
 * @param skyViewFactor   OUTPUT, 0..1
 * @param gridSize        N
 * @param worldSizeMeters W (m)
 */
export function recomputeSkyViewFactor(
  elevation: Float32Array,
  skyViewFactor: Float32Array,
  gridSize: number,
  worldSizeMeters: number
): void {
  const cellStep = worldSizeMeters / (gridSize - 1);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  const maxSteps = 14;

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      const z0 = elevation[idx];
      let cosSum = 0;

      for (let d = 0; d < 8; d++) {
        const dc = dirs[d][0];
        const dr = dirs[d][1];
        const stepDist = Math.hypot(dc, dr) * cellStep;
        let maxHorizonAngle = 0;

        for (let s = 1; s <= maxSteps; s++) {
          const nc = c + dc * s;
          const nr = r + dr * s;
          if (nc < 0 || nc >= gridSize || nr < 0 || nr >= gridSize) break;
          const dz = elevation[nr * gridSize + nc] - z0;
          if (dz > 0) {
            const angle = Math.atan2(dz, s * stepDist);
            if (angle > maxHorizonAngle) maxHorizonAngle = angle;
          }
        }
        cosSum += Math.cos(maxHorizonAngle) * Math.cos(maxHorizonAngle);
      }
      skyViewFactor[idx] = cosSum / 8.0;
    }
  }
}
