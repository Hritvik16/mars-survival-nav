// src/core/pathfinder.ts
import type { SectorBuffers } from './sectorData';

export interface RouteResult {
  readonly found: boolean;
  readonly pathIndices: Int32Array;
  readonly distanceMeters: number;
  readonly netElevationGainM: number;
  readonly maxSlopeDeg: number;
  readonly estimatedO2Liters: number;
  readonly sunlitPercent: number;
  readonly commsCoveragePercent: number;
  readonly computeTimeMs: number;
  readonly isSafeHavenRoute: boolean;
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
  private readonly parent: Int32Array;
  private readonly closed: Uint8Array;
  private readonly heap: Int32Array;
  private heapSize = 0;

  constructor(maxCells = 128 * 128) {
    this.gScore = new Float32Array(maxCells);
    this.fScore = new Float32Array(maxCells);
    this.parent = new Int32Array(maxCells);
    this.closed = new Uint8Array(maxCells);
    this.heap = new Int32Array(maxCells);
  }

  /** Computes optimal anisotropic EVA route from (startCol, startRow) to (goalCol, goalRow) */
  public findRoute(
    sector: SectorBuffers,
    startCol: number,
    startRow: number,
    goalCol: number,
    goalRow: number
  ): RouteResult {
    return this.runSearch(sector, startCol, startRow, goalCol, goalRow, false);
  }

  /** Emergency Solar Particle Event (SPE) router: finds fastest sprint to a radiation-shielded alcove */
  public findNearestSafeHaven(
    sector: SectorBuffers,
    startCol: number,
    startRow: number,
    maxSkyViewThreshold = 0.58
  ): RouteResult {
    return this.runSearch(sector, startCol, startRow, -1, -1, true, maxSkyViewThreshold);
  }

  private runSearch(
    sector: SectorBuffers,
    startCol: number,
    startRow: number,
    goalCol: number,
    goalRow: number,
    safeHavenMode: boolean,
    maxSkyViewThreshold = 0.58
  ): RouteResult {
    const t0 = performance.now();
    const { gridSize, worldSizeMeters, elevation, slopeDeg, thermalInertia, roughness, skyViewFactor } = sector;
    const cellStep = worldSizeMeters / (gridSize - 1);

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
        if (skyViewFactor[curr] <= maxSkyViewThreshold && slopeDeg[curr] <= 26.0) {
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

      for (let d = 0; d < 8; d++) {
        const dc = DIRS[d][0];
        const dr = DIRS[d][1];
        const nc = cc + dc;
        const nr = cr + dr;

        if (nc < 1 || nc >= gridSize - 1 || nr < 1 || nr >= gridSize - 1) continue;
        const nextIdx = nr * gridSize + nc;
        if (this.closed[nextIdx]) continue;

        // Hard cliff cutoff: reject cells or transitions exceeding safe EVA/rover slope limits
        if (slopeDeg[nextIdx] > 32.0) continue;

        const stepDist = DIRS[d][2] * cellStep;
        const dz = elevation[nextIdx] - zA;
        const dirSlopeDeg = Math.atan2(dz, stepDist) * (180 / Math.PI);
        if (Math.abs(dirSlopeDeg) > 28.0) continue;

        // 1. Anisotropic directional slope factor (asymmetric uphill vs downhill)
        let slopeFactor = 1.0;
        if (dirSlopeDeg > 0) {
          slopeFactor += 0.04 * dirSlopeDeg * dirSlopeDeg;
        } else if (dirSlopeDeg < -6.0) {
          const brakingDeg = Math.abs(dirSlopeDeg) - 6.0;
          slopeFactor += 0.018 * brakingDeg * brakingDeg;
        }

        // 2. Thermal inertia sand-trap sinkage penalty (<140 TIU = loose eolian dust)
        const tiu = thermalInertia[nextIdx];
        const sandPenalty = tiu < 140.0 ? Math.pow((140.0 - tiu) / 25.0, 2) : 0.0;

        // 3. Surface roughness boulder/boxwork penalty
        const roughPenalty = roughness[nextIdx] > 0.2 ? roughness[nextIdx] * 3.5 : 0.0;

        // 4. Radiation exposure, solar shadow battery drain, & UHF comms blackout bias
        const radPenalty = skyViewFactor[nextIdx] * 0.35;
        const shadowPenalty = sector.solarShadow[nextIdx] === 0 ? 1.6 : 0.0;
        const commsPenalty = sector.commsLos[nextIdx] === 0 ? 0.85 : 0.0;

        const stepCost =
          stepDist * (slopeFactor + sandPenalty + roughPenalty + radPenalty + shadowPenalty + commsPenalty);
        const tentativeG = this.gScore[curr] + stepCost;

        if (tentativeG < this.gScore[nextIdx]) {
          this.parent[nextIdx] = curr;
          this.gScore[nextIdx] = tentativeG;
          const h = safeHavenMode
            ? 0
            : Math.hypot(goalCol - nc, goalRow - nr) * cellStep;
          this.fScore[nextIdx] = tentativeG + h;
          this.pushHeap(nextIdx);
        }
      }
    }

    const computeTimeMs = Math.round((performance.now() - t0) * 100) / 100;

    if (reachedIdx === -1) {
      return {
        found: false,
        pathIndices: new Int32Array(0),
        distanceMeters: 0,
        netElevationGainM: 0,
        maxSlopeDeg: 0,
        estimatedO2Liters: 0,
        sunlitPercent: 0,
        commsCoveragePercent: 0,
        computeTimeMs,
        isSafeHavenRoute: safeHavenMode,
      };
    }

    // Reconstruct path and integrate physical EVA telemetry
    const revPath: number[] = [];
    let trace = reachedIdx;
    while (trace !== -1) {
      revPath.push(trace);
      trace = this.parent[trace];
    }
    revPath.reverse();

    const pathIndices = new Int32Array(revPath);
    let distanceMeters = 0;
    let netElevationGainM = 0;
    let maxSlopeDeg = 0;
    let estimatedO2Liters = 0;
    let sunlitCount = 0;
    let commsCount = 0;

    for (let i = 0; i < pathIndices.length; i++) {
      const idx = pathIndices[i];
      if (sector.solarShadow[idx] === 1) sunlitCount++;
      if (sector.commsLos[idx] === 1) commsCount++;
      if (i === 0) continue;

      const i0 = pathIndices[i - 1];
      const i1 = idx;
      const r0 = Math.floor(i0 / gridSize), c0 = i0 % gridSize;
      const r1 = Math.floor(i1 / gridSize), c1 = i1 % gridSize;
      const d = Math.hypot(c1 - c0, r1 - r0) * cellStep;
      const dz = elevation[i1] - elevation[i0];
      const sDeg = Math.abs(Math.atan2(dz, d) * (180 / Math.PI));

      distanceMeters += d;
      if (dz > 0) netElevationGainM += dz;
      if (sDeg > maxSlopeDeg) maxSlopeDeg = sDeg;

      const uphillWork = dz > 0 ? dz * 0.085 : 0;
      const sandDrag = thermalInertia[i1] < 120 ? d * 0.025 : 0;
      estimatedO2Liters += d * 0.018 + uphillWork + sandDrag;
    }

    return {
      found: true,
      pathIndices,
      distanceMeters: Math.round(distanceMeters * 10) / 10,
      netElevationGainM: Math.round(netElevationGainM * 10) / 10,
      maxSlopeDeg: Math.round(maxSlopeDeg * 10) / 10,
      estimatedO2Liters: Math.round(estimatedO2Liters * 100) / 100,
      sunlitPercent: Math.round((sunlitCount / pathIndices.length) * 100),
      commsCoveragePercent: Math.round((commsCount / pathIndices.length) * 100),
      computeTimeMs,
      isSafeHavenRoute: safeHavenMode,
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
        if (left < this.heapSize && this.fScore[this.heap[left]] < this.fScore[this.heap[smallest]]) {
          smallest = left;
        }
        if (right < this.heapSize && this.fScore[this.heap[right]] < this.fScore[this.heap[smallest]]) {
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
