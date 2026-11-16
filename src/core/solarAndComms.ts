// src/core/solarAndComms.ts
// Mars mean radius in metres (3,389.5 km); used only for the curvature sag term in hasLineOfSight().
/**
 * @file solarAndComms.ts
 * @module core/solarAndComms
 *
 * Time-of-day and radio physics on the height field: (1) the moving-sun horizon ray-march that
 * produces the sunlit/shadow mask, (2) point-to-point UHF line of sight with planetary-curvature
 * sag, (3) the sector-wide Hab comms mask, and (4) the greedy 2-hop relay placement optimiser.
 *
 * Everything here works in grid cells for indexing and in metres for geometry, with the sample
 * pitch h = worldSizeMeters / (gridSize - 1).
 */
const MARS_RADIUS_METERS = 3_389_500;
// Antenna heights above local terrain, metres: habitat mast 22.0, deployable relay 9.5, EVA suit 2.2.
const HAB_MAST_HEIGHT_M = 22.0;
const RELAY_MAST_HEIGHT_M = 9.5; // Deployable companion rover / tripod UHF relay mast
const EVA_ANTENNA_HEIGHT_M = 2.2;

/**
 * Result of deployOptimalCommsRelay(). beforeCoveragePct / afterCoveragePct are the percentage of
 * ALL N*N cells with UHF LOS (Hab-only vs Hab + relay); computeTimeMs is wall time in ms
 * (2 decimals, from performance.now()). relayCol/relayRow are grid indices.
 */
export interface RelayPlacementResult {
  readonly deployed: boolean;
  readonly relayCol: number;
  readonly relayRow: number;
  readonly beforeCoveragePct: number;
  readonly afterCoveragePct: number;
  readonly computeTimeMs: number;
}

/**
 * Moving-sun horizon ray-march: writes solarShadow[idx] = 1 for lit cells and 0 for cells whose
 * sun ray is blocked by terrain, for local solar hour `solHour` (6 = sunrise, 12 = noon, 18 = sunset).
 *
 * Sun model (a fixed-azimuth-plane toy model, exactly as coded):
 *     a      = (solHour - 6) / 12 * pi
 *     sunX   = 100 cos a,   sunY = max(12, 100 sin a),   sunZ = 35
 *     horiz  = hypot(sunX, sunZ);   (dirCol, dirRow) = (sunX, sunZ) / horiz     unit step in grid space
 *     tanElev = (sunY / horiz) * (W / 132) / 10
 * The factor (W/132)/10 = 1.5515 for W = 2048 is the same relief scale used by the synthetic
 * terrain; it scales the sun slope to the vertical exaggeration of the height field. Examples
 * (W = 2048): solHour 6 or 18 -> tanElev = 0.176 (elev ~10 deg); 14 -> 2.20 (~66 deg); 12 -> 4.43 (~77 deg).
 * The sun therefore always lies toward +row (sunZ is constant), and only its column component
 * swings from +x (morning) through 0 (noon) to -x (evening).
 *
 * Per cell (r, c): step s = 1, 2, ... N-1 along the unit direction, sampling the NEAREST cell
 * (round); at distance d_s = s * h the ray height is z0 + d_s * tanElev. The cell is in shadow
 * if any sampled elevation exceeds that height before the ray leaves the raster:
 *     lit(r, c) = 0  iff  exists s : z[round(r + dirRow*s), round(c + dirCol*s)] > z0 + s * h * tanElev
 * Complexity O(N^3) worst case (128^3 = 2.1 M steps), run once per Sol-slider change.
 *
 * @param elevation       metres
 * @param solarShadow     OUTPUT, 1 = sunlit, 0 = shadow
 * @param gridSize        N
 * @param worldSizeMeters W (m)
 * @param solHour         local solar hour, 6..18 in the UI (NaN/Infinity -> 14.0, outside 6..18 clamped)
 */
export function recomputeSolarShadow(
  elevation: Float32Array,
  solarShadow: Uint8Array,
  gridSize: number,
  worldSizeMeters: number,
  solHour: number
): void {
  const cellStep = worldSizeMeters / (gridSize - 1);
  // Guard: a non-finite hour falls back to the UI default 14.0; hours outside daylight are clamped to
  // 6..18 (the sun stays on the sunrise / sunset horizon). Hours inside 6..18 are unaffected.
  const hour = Number.isFinite(solHour) ? Math.min(18.0, Math.max(6.0, solHour)) : 14.0;
  const angle = ((hour - 6.0) / 12.0) * Math.PI;
  const sunX = Math.cos(angle) * 100.0;
  // Sun height is floored at 12 so that the sun never sits on the horizon (avoids infinite shadows at the extremes).
  const sunY = Math.max(12.0, Math.sin(angle) * 100.0);
  const sunZ = 35.0;

  const horizLen = Math.hypot(sunX, sunZ);
  const dirCol = sunX / horizLen;
  const dirRow = sunZ / horizLen;
  const verticalReliefScale = worldSizeMeters / 132.0;
  const tanSunElev = (sunY / horizLen) * (verticalReliefScale / 10.0);

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      const z0 = elevation[idx];
      let lit = 1;

      for (let step = 1; step < gridSize; step++) {
        const nc = Math.round(c + dirCol * step);
        const nr = Math.round(r + dirRow * step);
        if (nc < 0 || nc >= gridSize || nr < 0 || nr >= gridSize) break;

        const distMeters = step * cellStep;
        const rayHeight = z0 + distMeters * tanSunElev;
        if (elevation[nr * gridSize + nc] > rayHeight) {
          lit = 0;
          break;
        }
      }
      solarShadow[idx] = lit;
    }
  }
}

/**
 * Point-to-point UHF line of sight between two grid cells over a 2.5-D height field, including the
 * curvature sag of a spherical planet (no atmospheric refraction, no Fresnel-zone clearance).
 *
 * Let the endpoints be A = (c0, r0) and B = (c1, r1) with antenna heights h0, h1 (m above terrain):
 *     zA = z(A) + h0,  zB = z(B) + h1,  D = hypot(c1-c0, r1-r0) * cellStep   [m]
 * The beam is sampled at n = max(|dc|, |dr|) - 1 interior points, f = s / n, with nearest-cell
 * terrain lookup, and the straight-line chord height minus the sag of a circle of radius R is
 *     d1 = f D,   d2 = (1 - f) D
 *     sag(f)  = d1 * d2 / (2 R)                 (parabolic approximation of the sagitta, R = 3,389,500 m)
 *     beam(f) = (1 - f) zA + f zB - sag(f)
 * The link is blocked iff z(sample) > beam(f) at any interior sample. Over this 2 km sector the
 * maximum sag is D^2 / (8 R): ~0.15 m over 2.05 km (~0.31 m over the 2.9 km diagonal), i.e.
 * curvature is physically negligible here but is kept for correctness at larger ranges.
 *
 * @param elevation  metres;  @param gridSize N;  @param cellStep sample pitch in metres
 * @param c0,r0,h0   transmitter cell and antenna height (m)
 * @param c1,r1,h1   receiver cell and antenna height (m)
 * @returns          true when unobstructed (also true for identical cells)
 */
export function hasLineOfSight(
  elevation: Float32Array,
  gridSize: number,
  cellStep: number,
  c0: number,
  r0: number,
  h0: number,
  c1: number,
  r1: number,
  h1: number
): boolean {
  const dc = c1 - c0;
  const dr = r1 - r0;
  const steps = Math.max(Math.abs(dc), Math.abs(dr));
  if (steps === 0) return true;

  const zStart = elevation[r0 * gridSize + c0] + h0;
  const zEnd = elevation[r1 * gridSize + c1] + h1;
  const totalDistM = Math.hypot(dc, dr) * cellStep;

  for (let s = 1; s < steps; s++) {
    const frac = s / steps;
    const nc = Math.round(c0 + dc * frac);
    const nr = Math.round(r0 + dr * frac);
    const d1 = frac * totalDistM;
    const d2 = (1.0 - frac) * totalDistM;
    const curvatureDrop = (d1 * d2) / (2.0 * MARS_RADIUS_METERS);
    const beamHeight = (1.0 - frac) * zStart + frac * zEnd - curvatureDrop;

    if (elevation[nr * gridSize + nc] > beamHeight) {
      return false;
    }
  }
  return true;
}

/**
 * Sector-wide first-hop UHF coverage: commsLos[idx] = 1 when the Hab mast (22.0 m) has line of sight
 * to an EVA antenna (2.2 m) at that cell, via hasLineOfSight(). O(N^2 * N) = about 2 M LOS samples.
 * This is a binary geometric model of 2-way radiometric ranging: LOS present -> the suit is treated
 * as ranging against the Hab and the navigation error is reset (see pathfinder.ts buildTelemetry).
 *
 * @param commsLos OUTPUT, 1 = link available;  @param habCol,habRow habitat cell
 */
export function recomputeCommsLos(
  elevation: Float32Array,
  commsLos: Uint8Array,
  gridSize: number,
  worldSizeMeters: number,
  habCol: number,
  habRow: number
): void {
  const cellStep = worldSizeMeters / (gridSize - 1);
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      commsLos[r * gridSize + c] = hasLineOfSight(
        elevation,
        gridSize,
        cellStep,
        habCol,
        habRow,
        HAB_MAST_HEIGHT_M,
        c,
        r,
        EVA_ANTENNA_HEIGHT_M
      )
        ? 1
        : 0;
    }
  }
}

/**
 * Autonomous 2-Hop UHF Relay Placement Optimizer:
 * Finds the single traversable ridge crest with direct LOS to the Habitat that maximizes
 * 2-hop UHF coverage across occluded route cells and sector blackout zones.
  *
  * Scoring (per candidate cell, as coded):
  *     score = 0.15 * z  +  25 * (#occluded EVA-route cells the relay can see)
  *                       +  2 * (#occluded sector sample cells it can see)
  * Candidates: stride-3 interior lattice [6, N-7]; must already have first-hop LOS from the Hab
  * (commsLos == 1), slope <= 22 deg and thermal inertia >= 130 TIU (safe to park a rover/tripod).
  * Relay-to-target LOS uses a 9.5 m relay mast and a 2.2 m EVA antenna. "Occluded sector sample"
  * cells are the commsLos == 0 cells on a stride-4 lattice [4, N-5]. The best score wins; if no
  * candidate qualifies the relay falls back to the Hab cell. Note the Hab-to-relay link is tested as
  * Hab mast (22 m) to a 2.2 m antenna at the relay cell, not to the 9.5 m relay mast (conservative).
  *
  * Side effects: the function first RESETS commsLos to the Hab-only baseline, then sets
  * commsLos[idx] = 1 for every previously dark cell the chosen relay can see (second hop), mutating
  * the caller's buffer in place. coverage percentages are over all N*N cells.
  *
  * @param elevation,slopeDeg,thermalInertia  sector layers (m, deg, TIU)
  * @param commsLos            IN/OUT UHF mask
  * @param activeRouteIndices  optional flat indices (row*N+col) of the active EVA route
  * @returns RelayPlacementResult  (deployed is always true)
 */
export function deployOptimalCommsRelay(
  elevation: Float32Array,
  slopeDeg: Float32Array,
  thermalInertia: Float32Array,
  commsLos: Uint8Array,
  gridSize: number,
  worldSizeMeters: number,
  habCol: number,
  habRow: number,
  activeRouteIndices?: Int32Array
): RelayPlacementResult {
  const t0 = performance.now();
  const cellStep = worldSizeMeters / (gridSize - 1);
  const count = gridSize * gridSize;

  // Reset to baseline 1-hop Hab LOS first
  recomputeCommsLos(elevation, commsLos, gridSize, worldSizeMeters, habCol, habRow);

  let baseSectorCovered = 0;
  for (let i = 0; i < count; i++) {
    if (commsLos[i] === 1) baseSectorCovered++;
  }
  const beforeCoveragePct = Math.round((baseSectorCovered / count) * 100);

  // Collect occluded route cells (high priority) and sampled occluded sector cells
  const occludedRoute: number[] = [];
  if (activeRouteIndices && activeRouteIndices.length > 0) {
    for (let i = 0; i < activeRouteIndices.length; i++) {
      const idx = activeRouteIndices[i];
      if (commsLos[idx] === 0) occludedRoute.push(idx);
    }
  }

  const occludedSectorSample: number[] = [];
  for (let r = 4; r < gridSize - 4; r += 4) {
    for (let c = 4; c < gridSize - 4; c += 4) {
      const idx = r * gridSize + c;
      if (commsLos[idx] === 0) occludedSectorSample.push(idx);
    }
  }

  let bestCol = habCol;
  let bestRow = habRow;
  let bestScore = -Infinity;

  // Search candidate ridge cells (stride 3) that have direct LOS to the Habitat
  for (let r = 6; r < gridSize - 6; r += 3) {
    for (let c = 6; c < gridSize - 6; c += 3) {
      const idx = r * gridSize + c;
      if (commsLos[idx] === 0) continue; // Must have 1st-hop link to Hab
      if (slopeDeg[idx] > 22.0 || thermalInertia[idx] < 130) continue; // Must be safe for rover/tripod

      let score = elevation[idx] * 0.15;

      // High weight on fixing active EVA route blackout cells
      for (let k = 0; k < occludedRoute.length; k++) {
        const targetIdx = occludedRoute[k];
        const tr = Math.floor(targetIdx / gridSize);
        const tc = targetIdx % gridSize;
        if (
          hasLineOfSight(
            elevation,
            gridSize,
            cellStep,
            c,
            r,
            RELAY_MAST_HEIGHT_M,
            tc,
            tr,
            EVA_ANTENNA_HEIGHT_M
          )
        ) {
          score += 25.0;
        }
      }

      // Secondary weight on illuminating broader sector blackout zones
      for (let k = 0; k < occludedSectorSample.length; k++) {
        const targetIdx = occludedSectorSample[k];
        const tr = Math.floor(targetIdx / gridSize);
        const tc = targetIdx % gridSize;
        if (
          hasLineOfSight(
            elevation,
            gridSize,
            cellStep,
            c,
            r,
            RELAY_MAST_HEIGHT_M,
            tc,
            tr,
            EVA_ANTENNA_HEIGHT_M
          )
        ) {
          score += 2.0;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCol = c;
        bestRow = r;
      }
    }
  }

  // Upgrade commsLos buffer with 2nd-hop coverage from the optimal relay
  let afterSectorCovered = 0;
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      if (commsLos[idx] === 0) {
        if (
          hasLineOfSight(
            elevation,
            gridSize,
            cellStep,
            bestCol,
            bestRow,
            RELAY_MAST_HEIGHT_M,
            c,
            r,
            EVA_ANTENNA_HEIGHT_M
          )
        ) {
          commsLos[idx] = 1;
        }
      }
      if (commsLos[idx] === 1) afterSectorCovered++;
    }
  }

  const computeTimeMs = Math.round((performance.now() - t0) * 100) / 100;
  return {
    deployed: true,
    relayCol: bestCol,
    relayRow: bestRow,
    beforeCoveragePct,
    afterCoveragePct: Math.round((afterSectorCovered / count) * 100),
    computeTimeMs,
  };
}
