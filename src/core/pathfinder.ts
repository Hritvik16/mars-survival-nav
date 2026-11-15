// src/core/pathfinder.ts
import type { SectorBuffers } from './sectorData';
import { hasLineOfSight } from './solarAndComms';

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

export const PLSS_MAX_O2_LITERS = 180.0;
export const PLSS_MAX_COOLING_WATER_L = 4.2;
export const PLSS_MAX_BATTERY_WH = 850.0;
export const SINGLE_SORTIE_WALKBACK_LIMIT_O2 = 95.0;

export interface DiscoveryHotspot {
  readonly found: boolean;
  readonly col: number;
  readonly row: number;
  readonly score: number;
  readonly description: string;
}

export interface RouteResult {
  readonly found: boolean;
  readonly pathIndices: Int32Array;
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

  /** Marks or clears a 5x5 cell In-Situ Hazard Block discovered by the astronaut mid-EVA */
  public toggleInSituHazard(sector: SectorBuffers, col: number, row: number): boolean {
    const { gridSize, inSituBlocked, site } = sector;
    if (Math.hypot(col - site.habCol, row - site.habRow) <= 3) return false;

    // If any cell within 4 cells is already blocked, clear the entire nearby hazard patch
    let hasNearby = false;
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 1 && nr < gridSize - 1 && nc >= 1 && nc < gridSize - 1) {
          if (inSituBlocked[nr * gridSize + nc] === 1) hasNearby = true;
        }
      }
    }

    const radius = hasNearby ? 5 : 2;
    const nextVal = hasNearby ? 0 : 1;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 1 && nr < gridSize - 1 && nc >= 1 && nc < gridSize - 1) {
          inSituBlocked[nr * gridSize + nc] = nextVal;
        }
      }
    }
    return nextVal === 1;
  }

  public clearAllInSituHazards(sector: SectorBuffers): void {
    sector.inSituBlocked.fill(0);
  }

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

  public computeWalkbackEnvelope(
    sector: SectorBuffers,
    payloadMassKg = 15.5
  ): { reachablePercent: number; computeTimeMs: number } {
    const t0 = performance.now();
    const { habCol, habRow } = sector.site;
    const count = sector.gridSize * sector.gridSize;

    this.runO2Wavefront(sector, habCol, habRow, payloadMassKg, false, this.outboundO2);
    this.runO2Wavefront(sector, habCol, habRow, payloadMassKg + 3.0, true, this.inboundO2);

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
    const walkSpeedMPerHour = (45.0 / (1.0 + 0.85 * loadRatio)) * 60.0;

    this.gScore.fill(Infinity);
    this.fScore.fill(Infinity);
    this.parent.fill(-1);
    this.closed.fill(0);
    this.heapSize = 0;

    const startIdx = startRow * gridSize + startCol;
    const goalIdx = safeHavenMode ? -1 : goalRow * gridSize + goalCol;

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

        const stepCost =
          stepDist *
          (slopeFactor + sandPenalty + roughPenalty + radPenalty + shadowPenalty + commsPenalty);
        const tentativeG = this.gScore[curr] + stepCost;

        if (tentativeG < this.gScore[nextIdx]) {
          this.parent[nextIdx] = curr;
          this.gScore[nextIdx] = tentativeG;
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

      // GPS-Denied Navigation CEP update:
      // 1) Active UHF link -> 2-Way Radiometric Ranging lock (±0.8m)
      // 2) Occluded UHF -> Check Optical Skyline Triangulation to >=2 Prominence Landmarks (±2.4m)
      // 3) Canyon Blind Spot -> Foot-Mounted IMU Dead Reckoning drift (+2.8% of distance walked)
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
      minIceDepthMeters: Math.round((Number.isFinite(minIceDepthMeters) ? minIceDepthMeters : 12.0) * 10) / 10,
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
