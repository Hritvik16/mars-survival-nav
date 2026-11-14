// src/core/sectorData.ts
export type LayerMode = 'mars' | 'slope' | 'sand';

export interface SectorBuffers {
  readonly gridSize: number;
  readonly worldSizeMeters: number;
  readonly elevation: Float32Array;
  readonly slopeDeg: Float32Array;
  readonly thermalInertia: Float32Array;
}

export function createSyntheticSector(gridSize = 128, worldSizeMeters = 100): SectorBuffers {
  const count = gridSize * gridSize;
  const elevation = new Float32Array(count);
  const slopeDeg = new Float32Array(count);
  const thermalInertia = new Float32Array(count);

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      const nx = (c / gridSize - 0.5) * 4.0;
      const ny = (r / gridSize - 0.5) * 4.0;
      const dist = Math.hypot(nx, ny);

      // Multi-tiered Martian mesa + winding canyon + terrace steps (Deuteronilus / Mount Sharp style)
      const canyonPath = Math.sin(ny * 1.4) * 0.65;
      const canyonDist = Math.abs(nx - canyonPath);
      const canyonFloor = Math.tanh(canyonDist * 3.2) * 14.0 - 7.0;
      const rawMesa = canyonFloor + Math.sin(nx * 3.5) * Math.cos(ny * 3.5) * 2.5;
      // Quantize into stepped geological strata with smooth cliff faces
      const strata = Math.floor(rawMesa / 3.5) * 3.5 + Math.tanh((rawMesa % 3.5) * 2.0);
      elevation[idx] = strata;

      // Fine eolian sand traps (<100 TIU) collect at the bottom of the canyon trough
      thermalInertia[idx] = canyonDist < 0.35 ? 60 + canyonDist * 80 : 290 + Math.cos(nx * 6) * 50;
    }
  }

  recomputeSlope(elevation, slopeDeg, gridSize, worldSizeMeters);

  return { gridSize, worldSizeMeters, elevation, slopeDeg, thermalInertia };
}

export function recomputeSlope(
  elevation: Float32Array,
  slopeDeg: Float32Array,
  gridSize: number,
  worldSizeMeters: number
): void {
  const cellStep = worldSizeMeters / (gridSize - 1);
  for (let r = 1; r < gridSize - 1; r++) {
    for (let c = 1; c < gridSize - 1; c++) {
      const idx = r * gridSize + c;
      const dzdx = (elevation[idx + 1] - elevation[idx - 1]) / (2.0 * cellStep);
      const dzdy = (elevation[idx + gridSize] - elevation[idx - gridSize]) / (2.0 * cellStep);
      slopeDeg[idx] = Math.atan(Math.hypot(dzdx, dzdy)) * (180 / Math.PI);
    }
  }
}