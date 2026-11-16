// src/core/pathfinder.ts
/**
 * @file pathfinder.ts
 * @module core/pathfinder
 *
 * Route planning and EVA consumable physics on a SectorBuffers bundle. One class,
 * AnisotropicPathfinder, owns preallocated scratch arrays (gScore, fScore, outboundO2, inboundO2,
 * parent, closed, heap: about 400 KiB for 128x128) so no search allocates per cell.
 *
 * Searches (all 8-connected on the 128x128 grid, interior cells 1..N-2 only, cells with
 * inSituBlocked == 1 are impassable everywhere):
 *   findRoute / findNearestSafeHaven  -> runSearch(): A* (or Dijkstra with h = 0) on a composite
 *                                        terrain cost, then buildTelemetry() on the resulting path
 *   findRoverAssistedRoute            -> rover Dijkstra + rendezvous selection + foot-leg A*
 *   computeWalkbackEnvelope           -> two O2-cost Dijkstra wavefronts from the Hab
 *   findScienceLoop                   -> exhaustive waypoint ordering over runSearch legs
 *
 * "4D" here means (x, y, z, t): z comes from the height field, and t enters through the departure
 * Sol hour (a) via the estimated arrival hour, which triggers a dusk multiplier on shadow cost, and
 * (b) through the solarShadow mask that the caller recomputed for that hour. t is NOT a search-graph
 * dimension (no time-expanded states); the mask is a snapshot at the departure hour.
 *
 * Units: distances m, slopes degrees, mass kg, O2 / water litres, energy Wh, time min or Sol hours.
 */
import type { SectorBuffers } from './sectorData';
import { hasLineOfSight } from './solarAndComms';

/**
 * One selectable science instrument. massKg sums into the payload mass m that drives every cost
 * term through the load ratio rho = m / 145 kg. The default selection (hammer 2.2 + SHERLOC/PIXL 4.8 +
 * core drill 8.5) totals 15.5 kg, which is the default payload everywhere in this file.
 */
export interface EvaInstrument {
  readonly id: string;
  readonly name: string;
  readonly massKg: number;
  readonly heritage: string;
  readonly targetRole: string;
  readonly defaultSelected: boolean;
}

export const EVA_INSTRUMENTS: readonly EvaInstrument[] = [
  {
    id: 'hammer_scoop',
    name: 'Artemis Geology Hammer & Regolith Scoop',
    massKg: 2.2,
    heritage: 'Apollo / Artemis EVA Kit',
    targetRole: 'Chip weathered rind & collect loose eolian/regolith samples',
    defaultSelected: true,
  },
  {
    id: 'sherloc_pixl',
    name: 'Handheld Raman & XRF Spectrometer',
    massKg: 4.8,
    heritage: 'Mars 2020 SHERLOC / PIXL',
    targetRole: 'Non-destructive elemental & organic biosignature assay on boxwork veins',
    defaultSelected: true,
  },
  {
    id: 'core_drill',
    name: 'Rotary-Percussive Core Drill + 6 Ti Tubes',
    massKg: 8.5,
    heritage: 'Perseverance Coring System',
    targetRole: 'Extract intact 5cm rock cores from Hesperian sulfate & clay strata',
    defaultSelected: true,
  },
  {
    id: 'gpr_wand',
    name: 'SHARAD/SWIM Ground-Penetrating Radar Wand',
    massKg: 6.4,
    heritage: 'MRO SHARAD / RIMFAX',
    targetRole: 'Map subsurface water-ice table depth and polygonal fractures',
    defaultSelected: false,
  },
  {
    id: 'cryo_auger',
    name: 'Cryo-Auger 1.5m Subsurface Ice Corer',
    massKg: 11.0,
    heritage: 'Phoenix / Artemis ISRU Drill',
    targetRole: 'Harvest pure glacial ice cores for Sabatier propellant water assay',
    defaultSelected: false,
  },
  {
    id: 'seis_pack',
    name: 'Portable Broadband Seismometer Package',
    massKg: 7.5,
    heritage: 'InSight SEIS',
    targetRole: 'Deploy on exposed bedrock scarps to monitor marsquakes & meteoroid impacts',
    defaultSelected: false,
  },
];

// xEMU PLSS budget model (display ceilings used by the HUD gauges): 180 L O2, 4.2 L SWME cooling
// water, 850 Wh suit battery. SINGLE_SORTIE_WALKBACK_LIMIT_O2 = 95 L is the round-trip O2 ceiling
// that defines the Point-of-No-Return contour for a single sortie (about 53% of the 180 L tank).
export const PLSS_MAX_O2_LITERS = 180.0;
export const PLSS_MAX_COOLING_WATER_L = 4.2;
export const PLSS_MAX_BATTERY_WH = 850.0;
export const SINGLE_SORTIE_WALKBACK_LIMIT_O2 = 95.0;

/**
 * Best high-entropy contact found near the route (see findRouteDiscoveryHotspot). found = false
 * means no cell scored above 45/100.
 */
export interface DiscoveryHotspot {
  readonly found: boolean;
  readonly col: number;
  readonly row: number;
  readonly score: number;
  readonly description: string;
}

/**
 * Telemetry for one planned traverse (units): pathIndices flat cell indices row*N+col;
 * pathCepMeters per-node position uncertainty (m); maxCepMeters worst CEP (m); minIceDepthMeters
 * shallowest ice-table depth under the path (m); distanceMeters path length (m);
 * durationMinutes walk + science stops (min); arrivalSolHour = departure + duration/60 (capped at
 * 24); netElevationGainM sum of positive dz (m); maxSlopeDeg largest |dz|/step slope on the path
 * (deg); safeSlopeLimitDeg = max(22, 32 - 0.15 m); sandTrapMeters length with TIU < 120 (m);
 * estimatedO2Liters (L); coolingWaterLiters SWME sublimator water (L); batteryWh (Wh);
 * sunlitPercent / commsCoveragePercent share of path nodes lit / with UHF LOS; computeTimeMs solver
 * wall time. found = path exists AND maxSlopeDeg <= safeSlopeLimitDeg. roverPathIndices and
 * rendezvousCoord ([col,row]) are set only by findRoverAssistedRoute.
 */
export interface RouteResult {
  readonly found: boolean;
  readonly pathIndices: Int32Array;
  readonly roverPathIndices?: Int32Array;
  readonly rendezvousCoord?: readonly [number, number];
  readonly pathCepMeters: Float32Array;
  readonly maxCepMeters: number;
  readonly minIceDepthMeters: number;
  readonly distanceMeters: number;
  readonly durationMinutes: number;
  readonly arrivalSolHour: number;
  readonly netElevationGainM: number;
  readonly maxSlopeDeg: number;
  readonly safeSlopeLimitDeg: number;
  readonly sandTrapMeters: number;
  readonly payloadMassKg: number;
  readonly estimatedO2Liters: number;
  readonly coolingWaterLiters: number;
  readonly batteryWh: number;
  readonly sunlitPercent: number;
  readonly commsCoveragePercent: number;
  readonly computeTimeMs: number;
  readonly isSafeHavenRoute: boolean;
  readonly isMultiWaypointLoop: boolean;
  readonly waypointOrderLabel: string;
}

// 8-neighbourhood: [d_col, d_row, step length in cells]. Orthogonal steps cost 1 cell, diagonals sqrt(2).
const DIRS: readonly [number, number, number][] = [
  [1, 0, 1.0],
  [-1, 0, 1.0],
  [0, 1, 1.0],
  [0, -1, 1.0],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * Anisotropic (direction-dependent) terrain pathfinder. "Anisotropic" because the cost of an edge
 * depends on the SIGNED slope along the direction of travel (uphill is penalised quadratically,
 * steep downhill braking separately, and cell-wise limits apply to the unsigned slope), not on a
 * single scalar cell cost. The binary min-heap stores cell indices keyed by fScore with lazy
 * deletion: a node may be pushed several times and stale pops are skipped via the `closed` mask.
 */
export class AnisotropicPathfinder {
  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly outboundO2: Float32Array;
  private readonly inboundO2: Float32Array;
  private readonly parent: Int32Array;
  private readonly closed: Uint8Array;
  private readonly heap: Int32Array;
  private heapSize = 0;

  constructor(maxCells = 128 * 128) {
    this.gScore = new Float32Array(maxCells);
    this.fScore = new Float32Array(maxCells);
    this.outboundO2 = new Float32Array(maxCells);
    this.inboundO2 = new Float32Array(maxCells);
    this.parent = new Int32Array(maxCells);
    this.closed = new Uint8Array(maxCells);
    this.heap = new Int32Array(maxCells);
  }

  /**
   * Live in-situ hazard editing (Shift+Click). Ignores clicks within 3 cells of the Hab. If any
   * blocked cell exists in the 9x9 window around (col,row) the click CLEARS only the connected
   * (8-neighbour) blocked patch that contains the blocked cell nearest the click (whole patch, any size), so unrelated hazards
   * nearby survive; otherwise it BLOCKS a 5x5 square (radius 2,
   * about 80 m on a side). Only cells with 1 <= index <= N-2 are touched. Because inSituBlocked is read
   * by every search, the caller simply re-runs findRoute / findScienceLoop / computeWalkbackEnvelope
   * to re-route around the obstacle.
   *
   * @returns 'added' if a block was added, 'cleared' if at least one blocked cell was cleared,
   *          'ignored' if nothing changed (click next to the Hab, or no interior cell was affected)
   */
  public toggleInSituHazard(
    sector: SectorBuffers,
    col: number,
    row: number
  ): 'added' | 'cleared' | 'ignored' {
    const { gridSize, inSituBlocked, site } = sector;
    if (Math.hypot(col - site.habCol, row - site.habRow) <= 3) return 'ignored';
    const inside = (r: number, c: number): boolean =>
      r >= 1 && r < gridSize - 1 && c >= 1 && c < gridSize - 1;

    // Seed: the blocked cell nearest the click inside the 9x9 window (one patch, not every patch in reach).
    const stack: number[] = [];
    const seen = new Set<number>();
    let bestD = Infinity;
    let seed = -1;
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const nr = row + dr;
        const nc = col + dc;
        if (inside(nr, nc) && inSituBlocked[nr * gridSize + nc] === 1) {
          const dist = dr * dr + dc * dc;
          if (dist < bestD) {
            bestD = dist;
            seed = nr * gridSize + nc;
          }
        }
      }
    }
    if (seed >= 0) {
      stack.push(seed);
      seen.add(seed);
    }

    if (stack.length > 0) {
      // Clear exactly the connected patch (flood fill over 8-neighbours), nothing else.
      let cleared = 0;
      while (stack.length > 0) {
        const idx = stack.pop() as number;
        inSituBlocked[idx] = 0;
        cleared++;
        const r = Math.floor(idx / gridSize);
        const c = idx % gridSize;
        for (let d = 0; d < 8; d++) {
          const nr = r + DIRS[d][1];
          const nc = c + DIRS[d][0];
          if (!inside(nr, nc)) continue;
          const ni = nr * gridSize + nc;
          if (inSituBlocked[ni] === 1 && !seen.has(ni)) {
            seen.add(ni);
            stack.push(ni);
          }
        }
      }
      return cleared > 0 ? 'cleared' : 'ignored';
    }

    let added = 0;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const nr = row + dr;
        const nc = col + dc;
        if (inside(nr, nc)) {
          inSituBlocked[nr * gridSize + nc] = 1;
          added++;
        }
      }
    }
    return added > 0 ? 'added' : 'ignored';
  }

  /**
   * Removes every in-situ hazard block (fills inSituBlocked with 0).
   */
  public clearAllInSituHazards(sector: SectorBuffers): void {
    sector.inSituBlocked.fill(0);
  }

  /**
   * Optical skyline fix availability: which of the sector landmarks are in line of sight from an
   * observer eye at 1.8 m above (col,row) to a 2.0 m beacon on each landmark (hasLineOfSight, which
   * includes curvature sag). Returns the codes, e.g. ["LM-ALPHA","LM-GAMMA"]. Two or more visible
   * landmarks are what the CEP model needs for a triangulated fix.
   */
  public countVisibleLandmarks(sector: SectorBuffers, col: number, row: number): string[] {
    const cellStep = sector.worldSizeMeters / (sector.gridSize - 1);
    const visible: string[] = [];
    for (const lm of sector.landmarks) {
      if (
        hasLineOfSight(
          sector.elevation,
          sector.gridSize,
          cellStep,
          col,
          row,
          1.8,
          lm.col,
          lm.row,
          2.0
        )
      ) {
        visible.push(lm.code);
      }
    }
    return visible;
  }

  /**
   * Optimal single-leg EVA route (A*) from (startCol,startRow) to (goalCol,goalRow) on the composite
   * cost described at runSearch(), followed by consumable telemetry.
   *
   * @param payloadMassKg  carried mass m in kg (sets rho = m/145, slope limits and walk speed)
   * @param startSolHour   local solar hour at departure (6..18 in the UI)
   */
  public findRoute(
    sector: SectorBuffers,
    startCol: number,
    startRow: number,
    goalCol: number,
    goalRow: number,
    payloadMassKg = 15.5,
    startSolHour = 14.0
  ): RouteResult {
    return this.runSearch(
      sector,
      startCol,
      startRow,
      goalCol,
      goalRow,
      payloadMassKg,
      startSolHour,
      false
    );
  }

  /**
   * Multimodal Steiner Rendezvous Solver (Hab ==Rover==> R* --Foot Scramble--> Target):
   * Wheeled rover hauls heavy payloadMassKg along gentle terrain (<=15.5 deg, TIU >= 130) to an
   * optimal drop-off basecamp R*, and astronaut scrambles R* -> Target carrying only 2.2kg hand tools.
    *
    * Algorithm (exactly as coded):
    *   1. Rover Dijkstra from the Hab over cells with slope <= 15.5 deg, TIU >= 130, roughness <=
    *      the sector's own 75th percentile (sector units; a fixed 0.45 m cut excluded 66-96 % of the
    *      vertically exaggerated map), and per-edge slope atan2(|dz|, d) <= 14.5 deg. Edge cost
    *          c = d * (1 + 0.08 * edgeSlopeDeg)                                  (d = stepDist, m)
    *      gives roverCost[] (a weighted-metre cost, not metres).
    *   2. Rendezvous R*: scan the stride-2 lattice [2, N-3]; among reachable cells minimise
    *          J(R) = |R - Goal|_euclid (m)  +  0.18 * roverCost[R]
    *      i.e. one unit of foot Euclidean distance trades against 1/0.18 = 5.6 units of rover cost.
    *      This is a discrete weighted-sum (Fermat-Weber / Steiner-point style) minimisation over the
    *      two-leg chain Hab -> R -> Goal; it does not solve the foot leg during the scan.
    *   3. Foot leg R* -> Goal by runSearch() with payload 2.2 kg (hand kit only).
    *   4. Combine: roverDistM = 0.65 * roverCost[R*] (empirical conversion of weighted cost to metres),
    *      roverDriveMin = round(roverDistM / 110 m/min), rover-leg O2 = 0.35 L/min * roverDriveMin.
    *      Distance, duration and O2 are the sums of the two legs; the HUD doubles O2 for the return.
    * The result carries the foot leg's telemetry (CEP, slope, sand, water, battery) with
    * roverPathIndices / rendezvousCoord added and pathIndices = rover path + foot path. Because it is
    * the foot leg's telemetry, payloadMassKg and safeSlopeLimitDeg are the foot leg's too (2.2 kg hand
    * kit, limit 31.7 deg), so the two always agree; the haul payload argument only drives the rover
    * leg's assumptions. If the foot leg fails, that failed result is returned with roverPathIndices /
    * rendezvousCoord still attached. If no rover-reachable cell beats the start (rendezvous = start)
    * the result is found = false with a "ROVER UNAVAILABLE" label rather than a foot route in disguise.
   */
  public findRoverAssistedRoute(
    sector: SectorBuffers,
    startCol: number,
    startRow: number,
    goalCol: number,
    goalRow: number,
    payloadMassKg = 15.5,
    startSolHour = 14.0
  ): RouteResult {
    const t0 = performance.now();
    const {
      gridSize,
      worldSizeMeters,
      elevation,
      slopeDeg,
      thermalInertia,
      roughness,
      inSituBlocked,
    } = sector;
    const cellStep = worldSizeMeters / (gridSize - 1);

    // --- Stage 1: rover reachability field (Dijkstra, edge cost d * (1 + 0.08 * slopeDeg)) ---
    const roverCost = new Float32Array(gridSize * gridSize).fill(Infinity);
    const roverParent = new Int32Array(gridSize * gridSize).fill(-1);
    this.fScore.fill(Infinity);
    this.closed.fill(0);
    this.heapSize = 0;

    const startIdx = startRow * gridSize + startCol;
    if (inSituBlocked[startIdx] === 1) {
      return this.buildTelemetry(
        sector,
        new Int32Array(0),
        payloadMassKg,
        startSolHour,
        false,
        false,
        '',
        Math.round((performance.now() - t0) * 100) / 100
      );
    }

    // Roughness gate: sector.roughness is in site units (the generated terrain is scaled by
    // VERTICAL_SCALE), so an absolute 0.45 m cut passes only 4-34 % of cells. Use the sector's own
    // 75th-percentile roughness instead, computed once per call.
    const roughSorted = Float32Array.from(roughness).sort();
    const roughCap = roughSorted[Math.floor(0.75 * (roughSorted.length - 1))];

    roverCost[startIdx] = 0;
    this.fScore[startIdx] = 0;
    this.pushHeap(startIdx);

    while (this.heapSize > 0) {
      const curr = this.popHeap();
      if (this.closed[curr]) continue;
      this.closed[curr] = 1;

      const cr = Math.floor(curr / gridSize);
      const cc = curr % gridSize;
      const zCurr = elevation[curr];

      for (let d = 0; d < 8; d++) {
        const nc = cc + DIRS[d][0];
        const nr = cr + DIRS[d][1];
        if (nc < 1 || nc >= gridSize - 1 || nr < 1 || nr >= gridSize - 1) continue;
        const nextIdx = nr * gridSize + nc;
        if (this.closed[nextIdx] || inSituBlocked[nextIdx] === 1) continue;

        if (
          slopeDeg[nextIdx] > 15.5 ||
          thermalInertia[nextIdx] < 130 ||
          roughness[nextIdx] > roughCap
        ) {
          continue;
        }

        const stepDist = DIRS[d][2] * cellStep;
        const dz = Math.abs(elevation[nextIdx] - zCurr);
        const dirSlope = Math.atan2(dz, stepDist) * (180 / Math.PI);
        if (dirSlope > 14.5) continue;

        const nextG = roverCost[curr] + stepDist * (1.0 + dirSlope * 0.08);
        if (nextG < roverCost[nextIdx]) {
          roverCost[nextIdx] = nextG;
          roverParent[nextIdx] = curr;
          this.fScore[nextIdx] = nextG;
          this.pushHeap(nextIdx);
        }
      }
    }

    // --- Stage 2: pick rendezvous R* minimising |R-Goal| + 0.18 * roverCost[R] over a stride-2 lattice ---
    let bestRIdx = startIdx;
    let bestHeuristic = Infinity;
    for (let r = 2; r < gridSize - 2; r += 2) {
      for (let c = 2; c < gridSize - 2; c += 2) {
        const idx = r * gridSize + c;
        if (!Number.isFinite(roverCost[idx])) continue;
        const remDist = Math.hypot(goalCol - c, goalRow - r) * cellStep;
        const score = remDist + roverCost[idx] * 0.18;
        if (score < bestHeuristic) {
          bestHeuristic = score;
          bestRIdx = idx;
        }
      }
    }

    const rRow = Math.floor(bestRIdx / gridSize);
    const rCol = bestRIdx % gridSize;

    const roverRev: number[] = [];
    let trace = bestRIdx;
    while (trace !== -1) {
      roverRev.push(trace);
      trace = roverParent[trace];
    }
    roverRev.reverse();

    // --- Stage 3: unburdened foot scramble R* -> Goal (payload = 2.2 kg hand tools) ---
    const footLeg = this.runSearch(
      sector,
      rCol,
      rRow,
      goalCol,
      goalRow,
      2.2,
      startSolHour,
      false
    );
    const roverPathIndices = new Int32Array(roverRev);
    const rendezvousCoord: readonly [number, number] = [rCol, rRow];
    // Rover diagnostics survive a failed foot leg so the HUD / caller can still see the rendezvous.
    if (!footLeg.found) return { ...footLeg, roverPathIndices, rendezvousCoord };
    // No rover leg at all (rendezvous = start): this is a plain foot route, never label it as rover-assisted.
    if (bestRIdx === startIdx) {
      return {
        ...footLeg,
        found: false,
        roverPathIndices,
        rendezvousCoord,
        waypointOrderLabel: 'ROVER UNAVAILABLE: rendezvous = start (no rover-reachable basecamp)',
      };
    }

    const combined = new Int32Array(roverRev.length + footLeg.pathIndices.length - 1);
    for (let i = 0; i < roverRev.length; i++) combined[i] = roverRev[i];
    for (let i = 1; i < footLeg.pathIndices.length; i++) {
      combined[roverRev.length + i - 1] = footLeg.pathIndices[i];
    }

    // --- Stage 4: convert rover cost to approximate metres (x0.65), time at 110 m/min, O2 at 0.35 L/min ---
    const roverDistM = roverCost[bestRIdx] * 0.65;
    const roverDriveMin = Math.round(roverDistM / 110.0);
    const roverSedentaryO2 = roverDriveMin * 0.35;

    const computeTimeMs = Math.round((performance.now() - t0) * 100) / 100;
    return {
      ...footLeg,
      pathIndices: combined,
      roverPathIndices,
      rendezvousCoord,
      distanceMeters: Math.round((roverDistM + footLeg.distanceMeters) * 10) / 10,
      durationMinutes: roverDriveMin + footLeg.durationMinutes,
      estimatedO2Liters: Math.round((roverSedentaryO2 + footLeg.estimatedO2Liters) * 100) / 100,
      computeTimeMs,
    };
  }

  /**
   * SPE (solar particle event) shelter search: Dijkstra (h = 0) over the same composite cost until the
   * first popped cell satisfies SVF <= maxSkyViewThreshold (default 0.58, i.e. well-shielded terrain)
   * and slope <= safeCellSlopeLimit. Sets isSafeHavenRoute on the result.
   */
  public findNearestSafeHaven(
    sector: SectorBuffers,
    startCol: number,
    startRow: number,
    maxSkyViewThreshold = 0.58,
    payloadMassKg = 15.5,
    startSolHour = 14.0
  ): RouteResult {
    return this.runSearch(
      sector,
      startCol,
      startRow,
      -1,
      -1,
      payloadMassKg,
      startSolHour,
      true,
      maxSkyViewThreshold
    );
  }

  /**
   * "Naive" baseline: the straight line from start to goal, sampled at n = max(|dc|,|dr|) + 1 cells
   * with rounded linear interpolation, run through the same buildTelemetry() as the optimised
   * route so every metric is directly comparable. No hazard, slope or sand avoidance.
   */
  public evaluateDirectPath(
    sector: SectorBuffers,
    startCol: number,
    startRow: number,
    goalCol: number,
    goalRow: number,
    payloadMassKg = 15.5,
    startSolHour = 14.0
  ): RouteResult {
    const t0 = performance.now();
    const { gridSize } = sector;
    const steps = Math.max(Math.abs(goalCol - startCol), Math.abs(goalRow - startRow));
    if (steps === 0) {
      return this.buildTelemetry(
        sector,
        new Int32Array([startRow * gridSize + startCol]),
        payloadMassKg,
        startSolHour,
        false,
        false,
        'Direct',
        0
      );
    }
    const indices = new Int32Array(steps + 1);
    for (let s = 0; s <= steps; s++) {
      const c = Math.round(startCol + ((goalCol - startCol) * s) / steps);
      const r = Math.round(startRow + ((goalRow - startRow) * s) / steps);
      indices[s] = r * gridSize + c;
    }
    const computeTimeMs = Math.round((performance.now() - t0) * 100) / 100;
    return this.buildTelemetry(
      sector,
      indices,
      payloadMassKg,
      startSolHour,
      false,
      false,
      'Direct',
      computeTimeMs
    );
  }

  /**
   * Finds the highest-entropy contact near a route. Every 2nd path node (excluding the 3 first and
   * last) is the centre of an 11x11 window sampled at stride 2 (+-5 cells ~ +-80 m, hence the
   * "within 80m" text). A candidate must score > 45, lie >= 10 cells from the Hab and from every
   * waypoint, and not be hazard-blocked; the best discoveryScore wins. Requires >= 4 path nodes.
   */
  public findRouteDiscoveryHotspot(
    sector: SectorBuffers,
    pathIndices: Int32Array
  ): DiscoveryHotspot {
    if (pathIndices.length < 4) {
      return { found: false, col: -1, row: -1, score: 0, description: '' };
    }
    const { gridSize, discoveryScore } = sector;
    let bestScore = 45;
    let bestCol = -1;
    let bestRow = -1;

    for (let i = 3; i < pathIndices.length - 3; i += 2) {
      const centerIdx = pathIndices[i];
      const cr = Math.floor(centerIdx / gridSize);
      const cc = centerIdx % gridSize;
      for (let dr = -5; dr <= 5; dr += 2) {
        for (let dc = -5; dc <= 5; dc += 2) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 2 || nr >= gridSize - 2 || nc < 2 || nc >= gridSize - 2) continue;
          const nearHab = Math.hypot(nc - sector.site.habCol, nr - sector.site.habRow) < 10;
          const nearWp = sector.site.waypoints.some((w) => Math.hypot(nc - w.col, nr - w.row) < 10);
          if (nearHab || nearWp || sector.inSituBlocked[nr * gridSize + nc] === 1) continue;
          const sc = discoveryScore[nr * gridSize + nc];
          if (sc > bestScore) {
            bestScore = sc;
            bestCol = nc;
            bestRow = nr;
          }
        }
      }
    }

    if (bestCol === -1) {
      return { found: false, col: -1, row: -1, score: 0, description: '' };
    }

    return {
      found: true,
      col: bestCol,
      row: bestRow,
      score: bestScore,
      description: 'Multi-strata lithologic contact boundary within 80m of route',
    };
  }

  /**
   * Bidirectional anisotropic walkback isochrone field (Point-of-No-Return contour).
   *
   * Two single-source Dijkstra wavefronts are expanded from the Hab on the O2 cost (litres):
   *   outbound[X]  O2 to walk Hab -> X carrying m kg
   *   inbound[X]   O2 to walk X -> Hab carrying (m + 3.0) kg (+3 kg extra load), computed on the
   *                reversed graph (see runO2Wavefront reverseDirection)
   * Round trip with a 15-minute sampling stop at 0.45 L/min (= 6.75 L):
   *     W[X] = outbound[X] + inbound[X] + 15 * 0.45
   * A cell is "safely reachable" when W[X] <= 95 L (SINGLE_SORTIE_WALKBACK_LIMIT_O2). The field is
   * written into sector.walkbackO2 (Infinity where either direction is unreachable) and the white
   * ring in the WALKBACK layer is the |W - 95| <= 2.4 L band.
   *
   * @returns reachablePercent = round(100 * #safe / N^2) and computeTimeMs
   */
  public computeWalkbackEnvelope(
    sector: SectorBuffers,
    payloadMassKg = 15.5
  ): { reachablePercent: number; computeTimeMs: number } {
    const t0 = performance.now();
    const { habCol, habRow } = sector.site;
    const count = sector.gridSize * sector.gridSize;

    this.runO2Wavefront(sector, habCol, habRow, payloadMassKg, false, this.outboundO2);
    this.runO2Wavefront(sector, habCol, habRow, payloadMassKg + 3.0, true, this.inboundO2);

    // Sampling stop at the target: 15 min * 0.45 L/min = 6.75 L of metabolic O2.
    const samplingStopO2 = 15.0 * 0.45;
    let safeReachableCount = 0;

    for (let i = 0; i < count; i++) {
      const out = this.outboundO2[i];
      const ret = this.inboundO2[i];
      if (out < Infinity && ret < Infinity) {
        const roundTrip = out + ret + samplingStopO2;
        sector.walkbackO2[i] = roundTrip;
        if (roundTrip <= SINGLE_SORTIE_WALKBACK_LIMIT_O2) {
          safeReachableCount++;
        }
      } else {
        sector.walkbackO2[i] = Infinity;
      }
    }

    const computeTimeMs = Math.round((performance.now() - t0) * 100) / 100;
    const reachablePercent = Math.round((safeReachableCount / count) * 100);
    return { reachablePercent, computeTimeMs };
  }

  /**
   * Single-source Dijkstra over the metabolic O2 cost, writing litres into `outDist`.
   *
   * Per-edge cost (d = stepDist m, dz = elevation change ALONG THE TRAVEL DIRECTION, rho = m/145):
   *     flatBurn    = d * 0.018 * (1 + 1.35 rho)                          [L]
   *     uphillWork  = dz > 0 ? dz * 0.085 * (1 + 2.1 rho) : 0             [L]
   *     sandDrag    = TIU < 120 ? d * 0.025 * (1 + 2.2 rho) : 0           [L]
   *     shadowOver  = shaded(next) ? d * 0.004 : 0                        [L] (thermal-regulation overhead)
   * Hard limits: cell slope <= max(22, 32 - 0.15 m) deg; |edge slope| <= max(20, 28 - 0.14 m) deg.
   *
   * reverseDirection = true computes cost-to-go to the Hab: the edge is walked from `next` to `curr`,
   * so dz = z[curr] - z[next] and the entered cell is `curr` (TIU[curr] is used for sand drag).
   *
   * @param massKg            carried mass for this wavefront
   * @param reverseDirection  false = Hab -> X, true = X -> Hab
   * @param outDist           OUTPUT litres (Infinity = unreachable)
   */
  private runO2Wavefront(
    sector: SectorBuffers,
    habCol: number,
    habRow: number,
    massKg: number,
    reverseDirection: boolean,
    outDist: Float32Array
  ): void {
    const { gridSize, worldSizeMeters, elevation, slopeDeg, thermalInertia, inSituBlocked } =
      sector;
    const cellStep = worldSizeMeters / (gridSize - 1);
    const loadRatio = massKg / 145.0;
    const safeCellSlopeLimit = Math.max(22.0, 32.0 - 0.15 * massKg);
    const safeDirSlopeLimit = Math.max(20.0, 28.0 - 0.14 * massKg);

    outDist.fill(Infinity);
    this.fScore.fill(Infinity);
    this.closed.fill(0);
    this.heapSize = 0;

    const startIdx = habRow * gridSize + habCol;
    // A hazard-blocked Hab cell yields an all-Infinity field (nothing is walkback-reachable).
    if (inSituBlocked[startIdx] === 1) return;
    outDist[startIdx] = 0;
    this.fScore[startIdx] = 0;
    this.pushHeap(startIdx);

    while (this.heapSize > 0) {
      const curr = this.popHeap();
      if (this.closed[curr]) continue;
      this.closed[curr] = 1;

      const cr = Math.floor(curr / gridSize);
      const cc = curr % gridSize;
      const zCurr = elevation[curr];
      const currO2 = outDist[curr];

      for (let d = 0; d < 8; d++) {
        const nc = cc + DIRS[d][0];
        const nr = cr + DIRS[d][1];
        if (nc < 1 || nc >= gridSize - 1 || nr < 1 || nr >= gridSize - 1) continue;

        const nextIdx = nr * gridSize + nc;
        if (this.closed[nextIdx] || inSituBlocked[nextIdx] === 1) continue;
        if (slopeDeg[nextIdx] > safeCellSlopeLimit) continue;

        const stepDist = DIRS[d][2] * cellStep;
        const dz = reverseDirection ? zCurr - elevation[nextIdx] : elevation[nextIdx] - zCurr;
        const dirSlopeDeg = Math.atan2(dz, stepDist) * (180 / Math.PI);
        if (Math.abs(dirSlopeDeg) > safeDirSlopeLimit) continue;

        const stepTiu = reverseDirection ? thermalInertia[curr] : thermalInertia[nextIdx];
        const flatBurn = stepDist * 0.018 * (1.0 + 1.35 * loadRatio);
        const uphillWork = dz > 0 ? dz * 0.085 * (1.0 + 2.1 * loadRatio) : 0;
        const sandDrag = stepTiu < 120 ? stepDist * 0.025 * (1.0 + 2.2 * loadRatio) : 0;
        const shadowOverhead = sector.solarShadow[nextIdx] === 0 ? stepDist * 0.004 : 0;

        const tentativeO2 = currO2 + flatBurn + uphillWork + sandDrag + shadowOverhead;
        if (tentativeO2 < outDist[nextIdx]) {
          outDist[nextIdx] = tentativeO2;
          this.fScore[nextIdx] = tentativeO2;
          this.pushHeap(nextIdx);
        }
      }
    }
  }

  /**
   * Optimal full science loop HAB -> {all waypoints in the best order} -> HAB.
   *
   * Enumerates every permutation of the site waypoints (n! = 6 for Mount Sharp, 2 for the others),
   * plans each leg with findRoute(), and keeps the order with the least summed leg O2. Leg s carries
   * m + 1.5 s kg (1.5 kg of samples gained per stop) and starts at the previous leg's arrival hour
   * + 0.25 h (15 min stop). The combined path is then re-evaluated once by buildTelemetry() (with the
   * BASE payload and 15 min of science per waypoint) so the reported totals include the stops.
   * Returns a "Loop Blocked" result (found = false) if any leg of every permutation fails.
   * Note the shadow mask stays the snapshot at the slider hour; only the dusk multiplier sees later hours.
   */
  public findScienceLoop(
    sector: SectorBuffers,
    payloadMassKg = 15.5,
    startSolHour = 14.0
  ): RouteResult {
    const t0 = performance.now();
    const wps = sector.site.waypoints;
    const { habCol, habRow } = sector.site;

    const indices = wps.map((_, i) => i);
    const perms = this.permute(indices);

    let bestCombined: number[] | null = null;
    let bestO2 = Infinity;
    let bestOrderLabel = '';

    for (const perm of perms) {
      const stops: { col: number; row: number; code: string }[] = [
        { col: habCol, row: habRow, code: 'HAB' },
        ...perm.map((i) => ({ col: wps[i].col, row: wps[i].row, code: wps[i].code })),
        { col: habCol, row: habRow, code: 'HAB' },
      ];

      let possible = true;
      let totalO2 = 0;
      let legSolHr = startSolHour;
      const combinedPath: number[] = [];

      for (let s = 0; s < stops.length - 1; s++) {
        const legPayload = payloadMassKg + s * 1.5;
        const leg = this.findRoute(
          sector,
          stops[s].col,
          stops[s].row,
          stops[s + 1].col,
          stops[s + 1].row,
          legPayload,
          legSolHr
        );
        if (!leg.found) {
          possible = false;
          break;
        }
        totalO2 += leg.estimatedO2Liters;
        legSolHr = leg.arrivalSolHour + 0.25;
        for (let k = s === 0 ? 0 : 1; k < leg.pathIndices.length; k++) {
          combinedPath.push(leg.pathIndices[k]);
        }
      }

      if (possible && totalO2 < bestO2) {
        bestO2 = totalO2;
        bestCombined = combinedPath;
        bestOrderLabel = stops.map((st) => st.code).join(' → ');
      }
    }

    const computeTimeMs = Math.round((performance.now() - t0) * 100) / 100;
    if (!bestCombined) {
      return this.buildTelemetry(
        sector,
        new Int32Array(0),
        payloadMassKg,
        startSolHour,
        false,
        true,
        'Loop Blocked by Payload / In-Situ Hazard',
        computeTimeMs
      );
    }

    return this.buildTelemetry(
      sector,
      new Int32Array(bestCombined),
      payloadMassKg,
      startSolHour,
      false,
      true,
      bestOrderLabel,
      computeTimeMs
    );
  }

  /**
   * Recursive permutation generator (all n! orderings of `arr`).
   */
  private permute(arr: number[]): number[][] {
    if (arr.length <= 1) return [arr];
    const result: number[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const current = arr[i];
      const remaining = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of this.permute(remaining)) {
        result.push([current, ...p]);
      }
    }
    return result;
  }

  /**
   * Core A* (goal mode) / Dijkstra (safe-haven mode, h = 0) with the anisotropic composite cost.
   *
   * Let rho = m / 145,  d = stepDist (m),  theta = signed edge slope = atan2(dz, d) in degrees,
   *     safeCellSlopeLimit = max(22, 32 - 0.15 m),   safeDirSlopeLimit = max(20, 28 - 0.14 m).
   * Edges into a cell with slope > safeCellSlopeLimit or |theta| > safeDirSlopeLimit are forbidden.
   * Otherwise the edge cost is  c = d * ( S + P_sand + P_rough + P_rad + P_shadow + P_comms ):
   *     S       = 1 + 0.5 rho  +  [theta > 0]  0.04 (1 + 1.8 rho) theta^2
   *                            +  [theta < -6] 0.018 (1 + 1.4 rho) (|theta| - 6)^2
   *     P_sand  = [TIU < 140] ((140 - TIU) / 25)^2 (1 + 2.2 rho)
   *     P_rough = [sigma > 0.2] 3.5 sigma (1 + rho)           (sigma = 3x3 roughness, m)
   *     P_rad   = 0.35 * SVF                                  (sky-view factor, 0..1)
   *     P_shadow= [shaded] 1.6 * D                            (D = 2.4 if arrival hour > 17.2 else 1)
   *     P_comms = [no UHF LOS] 0.85
   * Heuristic h = Euclidean distance to the goal in metres. Every bracket is >= 0 and S >= 1, so each
   * edge costs >= d, hence h is admissible and consistent and the first goal pop is cost-optimal
   * (up to Float32 rounding of gScore).
   *
   * Time axis: the arrival hour used for D is estimated at the expanded node as
   *     t_arr = startSolHour + (|node - start| in metres) / walkSpeedMPerHour,
   *     walkSpeed = 45 / (1 + 0.85 rho) m/min  (2.7 km/h unloaded), using the STRAIGHT-LINE distance from
   * the start, not the path length so far; so t is an approximation, not an exact state variable.
   *
   * @param safeHavenMode  true -> stop at the first cell with SVF <= maxSkyViewThreshold (no goal)
   * @returns RouteResult from buildTelemetry(); found = false with an empty path if unreachable
   */
  private runSearch(
    sector: SectorBuffers,
    startCol: number,
    startRow: number,
    goalCol: number,
    goalRow: number,
    payloadMassKg: number,
    startSolHour: number,
    safeHavenMode: boolean,
    maxSkyViewThreshold = 0.58
  ): RouteResult {
    const t0 = performance.now();
    const {
      gridSize,
      worldSizeMeters,
      elevation,
      slopeDeg,
      thermalInertia,
      roughness,
      skyViewFactor,
      inSituBlocked,
    } = sector;
    const cellStep = worldSizeMeters / (gridSize - 1);

    const loadRatio = payloadMassKg / 145.0;
    const safeCellSlopeLimit = Math.max(22.0, 32.0 - 0.15 * payloadMassKg);
    const safeDirSlopeLimit = Math.max(20.0, 28.0 - 0.14 * payloadMassKg);
    // walk speed = 45 m/min / (1 + 0.85 rho)  ->  metres per hour (x60)
    const walkSpeedMPerHour = (45.0 / (1.0 + 0.85 * loadRatio)) * 60.0;

    this.gScore.fill(Infinity);
    this.fScore.fill(Infinity);
    this.parent.fill(-1);
    this.closed.fill(0);
    this.heapSize = 0;

    const startIdx = startRow * gridSize + startCol;
    const goalIdx = safeHavenMode ? -1 : goalRow * gridSize + goalCol;

    // A blocked start cell is as impassable as a blocked goal: return the empty / not-found telemetry.
    if (inSituBlocked[startIdx] === 1) {
      return this.buildTelemetry(
        sector,
        new Int32Array(0),
        payloadMassKg,
        startSolHour,
        safeHavenMode,
        false,
        '',
        Math.round((performance.now() - t0) * 100) / 100
      );
    }

    this.gScore[startIdx] = 0;
    this.fScore[startIdx] = safeHavenMode
      ? 0
      : Math.hypot(goalCol - startCol, goalRow - startRow) * cellStep;
    this.pushHeap(startIdx);

    let reachedIdx = -1;

    while (this.heapSize > 0) {
      const curr = this.popHeap();
      if (this.closed[curr]) continue;
      this.closed[curr] = 1;

      if (safeHavenMode) {
        if (skyViewFactor[curr] <= maxSkyViewThreshold && slopeDeg[curr] <= safeCellSlopeLimit) {
          reachedIdx = curr;
          break;
        }
      } else if (curr === goalIdx) {
        reachedIdx = curr;
        break;
      }

      const cr = Math.floor(curr / gridSize);
      const cc = curr % gridSize;
      const zA = elevation[curr];

      const approxDistM = Math.hypot(cc - startCol, cr - startRow) * cellStep;
      const arrivalSolHr = startSolHour + approxDistM / walkSpeedMPerHour;
      // Time-dependent term: after Sol hour 17.2 shadow cells cost 2.4x more (night-approach avoidance).
      const duskFactor = arrivalSolHr > 17.2 ? 2.4 : 1.0;

      for (let d = 0; d < 8; d++) {
        const dc = DIRS[d][0];
        const dr = DIRS[d][1];
        const nc = cc + dc;
        const nr = cr + dr;

        if (nc < 1 || nc >= gridSize - 1 || nr < 1 || nr >= gridSize - 1) continue;
        const nextIdx = nr * gridSize + nc;
        if (this.closed[nextIdx] || inSituBlocked[nextIdx] === 1) continue;

        if (slopeDeg[nextIdx] > safeCellSlopeLimit) continue;

        const stepDist = DIRS[d][2] * cellStep;
        const dz = elevation[nextIdx] - zA;
        const dirSlopeDeg = Math.atan2(dz, stepDist) * (180 / Math.PI);
        if (Math.abs(dirSlopeDeg) > safeDirSlopeLimit) continue;

        // S = 1 + 0.5 rho; uphill adds 0.04(1+1.8 rho) theta^2, steep descent (< -6 deg) adds a braking term.
        let slopeFactor = 1.0 + 0.5 * loadRatio;
        if (dirSlopeDeg > 0) {
          slopeFactor += 0.04 * (1.0 + 1.8 * loadRatio) * dirSlopeDeg * dirSlopeDeg;
        } else if (dirSlopeDeg < -6.0) {
          const brakingDeg = Math.abs(dirSlopeDeg) - 6.0;
          slopeFactor += 0.018 * (1.0 + 1.4 * loadRatio) * brakingDeg * brakingDeg;
        }

        const tiu = thermalInertia[nextIdx];
        const sandPenalty =
          tiu < 140.0 ? Math.pow((140.0 - tiu) / 25.0, 2) * (1.0 + 2.2 * loadRatio) : 0.0;

        const roughPenalty =
          roughness[nextIdx] > 0.2 ? roughness[nextIdx] * 3.5 * (1.0 + loadRatio) : 0.0;

        const radPenalty = skyViewFactor[nextIdx] * 0.35;
        const shadowPenalty = (sector.solarShadow[nextIdx] === 0 ? 1.6 : 0.0) * duskFactor;
        const commsPenalty = sector.commsLos[nextIdx] === 0 ? 0.85 : 0.0;

        // c = d * (S + P_sand + P_rough + P_rad + P_shadow + P_comms), accumulated in gScore (Float32).
        const stepCost =
          stepDist *
          (slopeFactor + sandPenalty + roughPenalty + radPenalty + shadowPenalty + commsPenalty);
        const tentativeG = this.gScore[curr] + stepCost;

        if (tentativeG < this.gScore[nextIdx]) {
          this.parent[nextIdx] = curr;
          this.gScore[nextIdx] = tentativeG;
          // f = g + h with h = straight-line metres to the goal (admissible: every step costs >= its length in m).
          const h = safeHavenMode ? 0 : Math.hypot(goalCol - nc, goalRow - nr) * cellStep;
          this.fScore[nextIdx] = tentativeG + h;
          this.pushHeap(nextIdx);
        }
      }
    }

    const computeTimeMs = Math.round((performance.now() - t0) * 100) / 100;

    if (reachedIdx === -1) {
      return this.buildTelemetry(
        sector,
        new Int32Array(0),
        payloadMassKg,
        startSolHour,
        safeHavenMode,
        false,
        '',
        computeTimeMs
      );
    }

    const revPath: number[] = [];
    let trace = reachedIdx;
    while (trace !== -1) {
      revPath.push(trace);
      trace = this.parent[trace];
    }
    revPath.reverse();

    return this.buildTelemetry(
      sector,
      new Int32Array(revPath),
      payloadMassKg,
      startSolHour,
      safeHavenMode,
      false,
      'HAB → TARGET',
      computeTimeMs
    );
  }

  /**
   * Converts a cell path into the RouteResult read-outs: geometry, the three coupled xEMU PLSS
   * consumables, navigation uncertainty and exposure percentages. For each segment i-1 -> i with
   * length d (m), dz (m), rho = m/145 and a walk speed v = 45 / (1 + 0.85 rho) m/min:
   *
   * 1) Metabolic O2 (L):   flatBurn = d * 0.018 * (1 + 1.35 rho)
   *                        uphill   = [dz > 0] dz * 0.085 * (1 + 2.1 rho)
   *                        sand     = [TIU < 120] d * 0.025 * (1 + 2.2 rho)
   *                        dO2 = flatBurn + uphill + sand           (runO2Wavefront adds a further d * 0.004 L in
   *                        shadow; that term is deliberately NOT included here, so the benchmarked
   *                        route O2 stays as documented)
   * 2) SWME sublimator water (L): proportional to metabolic heat, hotter in sun
   *                        dH2O = dO2 * 0.019 * (lit ? 1.25 : 0.78)
   * 3) Suit battery (Wh):  dt_h = d / v / 60;   P = lit ? (65 - 25) : (65 + 135) W
   *                        (65 W baseline; -25 W solar assist when lit; +135 W heater in shadow)
   *                        dE = dt_h * P
   * Science stops (loops only): 15 min per waypoint add 0.45 L/min O2, 0.008 L/min water, 60 W.
   * Duration = round(distance / v + stops); arrival hour = min(24, start + duration/60), 0.1 h rounding.
   *
   * GPS-denied navigation uncertainty (CEP, metres; starts at 0.8 m):
   *     UHF LOS at the node                       -> CEP := 0.8            (radiometric ranging lock)
   *     no LOS, >= 2 landmarks visible AND lit    -> CEP := min(CEP + 0.010 d, 2.4)   (skyline triangulation)
   *     no LOS, exactly 1 landmark visible AND lit-> CEP := min(CEP + 0.016 d, 6.8)
   *     otherwise                                 -> CEP += 0.028 d        (IMU dead-reckoning drift, 2.8 % of distance)
   * Note the min(.) caps also act as a re-acquisition: a fix pulls an already larger CEP down to the cap.
   *
   * found = (maxSlopeDeg <= safeSlopeLimitDeg). Empty paths return a zeroed result with found = false.
   * minIceDepth falls back to 12.0 m when no path node exists. Rounding: distance/slope/ice 0.1,
   * O2/water 0.01, battery 1 Wh, CEP 0.1 m.
   */
  private buildTelemetry(
    sector: SectorBuffers,
    pathIndices: Int32Array,
    payloadMassKg: number,
    startSolHour: number,
    safeHavenMode: boolean,
    isMultiWaypointLoop: boolean,
    waypointOrderLabel: string,
    computeTimeMs: number
  ): RouteResult {
    const { gridSize, worldSizeMeters, elevation, thermalInertia, iceTableDepthM } = sector;
    const cellStep = worldSizeMeters / (gridSize - 1);
    const loadRatio = payloadMassKg / 145.0;
    const safeSlopeLimitDeg = Math.round(Math.max(22.0, 32.0 - 0.15 * payloadMassKg) * 10) / 10;

    if (pathIndices.length === 0) {
      return {
        found: false,
        pathIndices,
        pathCepMeters: new Float32Array(0),
        maxCepMeters: 0,
        minIceDepthMeters: 0,
        distanceMeters: 0,
        durationMinutes: 0,
        arrivalSolHour: startSolHour,
        netElevationGainM: 0,
        maxSlopeDeg: 0,
        safeSlopeLimitDeg,
        sandTrapMeters: 0,
        payloadMassKg: Math.round(payloadMassKg * 10) / 10,
        estimatedO2Liters: 0,
        coolingWaterLiters: 0,
        batteryWh: 0,
        sunlitPercent: 0,
        commsCoveragePercent: 0,
        computeTimeMs,
        isSafeHavenRoute: safeHavenMode,
        isMultiWaypointLoop,
        waypointOrderLabel,
      };
    }

    let distanceMeters = 0;
    let netElevationGainM = 0;
    let maxSlopeDeg = 0;
    let sandTrapMeters = 0;
    let estimatedO2Liters = 0;
    let coolingWaterLiters = 0;
    let batteryWh = 0;
    let sunlitCount = 0;
    let commsCount = 0;
    let minIceDepthMeters = Infinity;
    let maxCepMeters = 0.8;
    let currentCep = 0.8;

    const pathCepMeters = new Float32Array(pathIndices.length);
    const walkSpeedMPerMin = 45.0 / (1.0 + 0.85 * loadRatio);

    for (let i = 0; i < pathIndices.length; i++) {
      const idx = pathIndices[i];
      const r1 = Math.floor(idx / gridSize);
      const c1 = idx % gridSize;
      const isLit = sector.solarShadow[idx] === 1;
      const hasUhf = sector.commsLos[idx] === 1;

      if (isLit) sunlitCount++;
      if (hasUhf) commsCount++;
      if (iceTableDepthM[idx] < minIceDepthMeters) {
        minIceDepthMeters = iceTableDepthM[idx];
      }

      if (i === 0) {
        pathCepMeters[0] = 0.8;
        continue;
      }

      const i0 = pathIndices[i - 1];
      const r0 = Math.floor(i0 / gridSize);
      const c0 = i0 % gridSize;
      const d = Math.hypot(c1 - c0, r1 - r0) * cellStep;
      const dz = elevation[idx] - elevation[i0];
      const sDeg = Math.abs(Math.atan2(dz, d) * (180 / Math.PI));

      if (hasUhf) {
        currentCep = 0.8;
      } else {
        const visLandmarks = this.countVisibleLandmarks(sector, c1, r1);
        if (visLandmarks.length >= 2 && isLit) {
          currentCep = Math.min(currentCep + d * 0.01, 2.4);
        } else if (visLandmarks.length === 1 && isLit) {
          currentCep = Math.min(currentCep + d * 0.016, 6.8);
        } else {
          currentCep += d * 0.028;
        }
      }
      pathCepMeters[i] = Math.round(currentCep * 10) / 10;
      if (currentCep > maxCepMeters) maxCepMeters = currentCep;

      distanceMeters += d;
      if (dz > 0) netElevationGainM += dz;
      if (sDeg > maxSlopeDeg) maxSlopeDeg = sDeg;
      if (thermalInertia[idx] < 120) sandTrapMeters += d;

      const flatBurn = d * 0.018 * (1.0 + 1.35 * loadRatio);
      const uphillWork = dz > 0 ? dz * 0.085 * (1.0 + 2.1 * loadRatio) : 0;
      const sandDrag = thermalInertia[idx] < 120 ? d * 0.025 * (1.0 + 2.2 * loadRatio) : 0;
      const stepO2 = flatBurn + uphillWork + sandDrag;
      estimatedO2Liters += stepO2;

      const solarHeatFactor = isLit ? 1.25 : 0.78;
      coolingWaterLiters += stepO2 * 0.019 * solarHeatFactor;

      const stepHours = d / walkSpeedMPerMin / 60.0;
      const netPowerWatts = isLit ? 65.0 - 25.0 : 65.0 + 135.0;
      batteryWh += stepHours * netPowerWatts;
    }

    const scienceStopMinutes = isMultiWaypointLoop ? sector.site.waypoints.length * 15 : 0;
    const durationMinutes = Math.round(distanceMeters / walkSpeedMPerMin + scienceStopMinutes);
    const arrivalSolHour =
      Math.round(Math.min(24.0, startSolHour + durationMinutes / 60.0) * 10) / 10;

    estimatedO2Liters += scienceStopMinutes * 0.45;
    coolingWaterLiters += scienceStopMinutes * 0.008;
    batteryWh += (scienceStopMinutes / 60.0) * 60.0;

    return {
      found: maxSlopeDeg <= safeSlopeLimitDeg,
      pathIndices,
      pathCepMeters,
      maxCepMeters: Math.round(maxCepMeters * 10) / 10,
      minIceDepthMeters:
        Math.round((Number.isFinite(minIceDepthMeters) ? minIceDepthMeters : 12.0) * 10) / 10,
      distanceMeters: Math.round(distanceMeters * 10) / 10,
      durationMinutes,
      arrivalSolHour,
      netElevationGainM: Math.round(netElevationGainM * 10) / 10,
      maxSlopeDeg: Math.round(maxSlopeDeg * 10) / 10,
      safeSlopeLimitDeg,
      sandTrapMeters: Math.round(sandTrapMeters * 10) / 10,
      payloadMassKg: Math.round(payloadMassKg * 10) / 10,
      estimatedO2Liters: Math.round(estimatedO2Liters * 100) / 100,
      coolingWaterLiters: Math.round(coolingWaterLiters * 100) / 100,
      batteryWh: Math.round(batteryWh),
      sunlitPercent: Math.round((sunlitCount / Math.max(1, pathIndices.length)) * 100),
      commsCoveragePercent: Math.round((commsCount / Math.max(1, pathIndices.length)) * 100),
      computeTimeMs,
      isSafeHavenRoute: safeHavenMode,
      isMultiWaypointLoop,
      waypointOrderLabel,
    };
  }

  /**
   * Binary min-heap insert keyed by fScore[nodeIdx]; sift-up with parent (i-1)>>1. Duplicates are
   * allowed (lazy deletion); there is no decrease-key.
   */
  private pushHeap(nodeIdx: number): void {
    let i = this.heapSize++;
    this.heap[i] = nodeIdx;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.fScore[this.heap[i]] >= this.fScore[this.heap[p]]) break;
      const tmp = this.heap[i];
      this.heap[i] = this.heap[p];
      this.heap[p] = tmp;
      i = p;
    }
  }

  /**
   * Binary min-heap extract-min: moves the last element to the root and sifts down using children
   * (2i+1, 2i+2). Callers must check `closed` for stale duplicates.
   */
  private popHeap(): number {
    const top = this.heap[0];
    const last = this.heap[--this.heapSize];
    if (this.heapSize > 0) {
      this.heap[0] = last;
      let i = 0;
      while (true) {
        const left = (i << 1) + 1;
        const right = left + 1;
        let smallest = i;
        if (
          left < this.heapSize &&
          this.fScore[this.heap[left]] < this.fScore[this.heap[smallest]]
        ) {
          smallest = left;
        }
        if (
          right < this.heapSize &&
          this.fScore[this.heap[right]] < this.fScore[this.heap[smallest]]
        ) {
          smallest = right;
        }
        if (smallest === i) break;
        const tmp = this.heap[i];
        this.heap[i] = this.heap[smallest];
        this.heap[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}
