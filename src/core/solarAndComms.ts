// src/core/solarAndComms.ts
const MARS_RADIUS_METERS = 3_389_500;
const HAB_MAST_HEIGHT_M = 22.0;
const RELAY_MAST_HEIGHT_M = 9.5; // Deployable companion rover / tripod UHF relay mast
const EVA_ANTENNA_HEIGHT_M = 2.2;

export interface RelayPlacementResult {
  readonly deployed: boolean;
  readonly relayCol: number;
  readonly relayRow: number;
  readonly beforeCoveragePct: number;
  readonly afterCoveragePct: number;
  readonly computeTimeMs: number;
}

export function recomputeSolarShadow(
  elevation: Float32Array,
  solarShadow: Uint8Array,
  gridSize: number,
  worldSizeMeters: number,
  solHour: number
): void {
  const cellStep = worldSizeMeters / (gridSize - 1);
  const angle = ((solHour - 6.0) / 12.0) * Math.PI;
  const sunX = Math.cos(angle) * 100.0;
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

/** Tests point-to-point UHF radio line of sight between two grid cells including planetary curvature */
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
  let bestScore = -1;

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
