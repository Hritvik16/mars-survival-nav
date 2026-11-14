// src/core/solarAndComms.ts
const MARS_RADIUS_METERS = 3_389_500;
const HAB_MAST_HEIGHT_M = 6.0;
const EVA_ANTENNA_HEIGHT_M = 1.8;

/**
 * Computes binary solar illumination buffer (1 = sunlit charging, 0 = topographic shadow)
 * matching the sun vector in Scene3DHarness.setSolHour(solHour).
 */
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
  const sunY = Math.max(8.0, Math.sin(angle) * 100.0);
  const sunZ = 35.0;

  const horizLen = Math.hypot(sunX, sunZ);
  const dirCol = sunX / horizLen;
  const dirRow = sunZ / horizLen;
  const tanSunElev = sunY / horizLen;

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
 * Computes Habitat UHF Radio Line-of-Sight buffer (1 = active UHF link, 0 = terrain blackout)
 * from (habCol, habRow) at +6.0m mast height to every cell at +1.8m suit transceiver height.
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
  const zHab = elevation[habRow * gridSize + habCol] + HAB_MAST_HEIGHT_M;

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      const dc = c - habCol;
      const dr = r - habRow;
      const steps = Math.max(Math.abs(dc), Math.abs(dr));

      if (steps === 0) {
        commsLos[idx] = 1;
        continue;
      }

      const zEva = elevation[idx] + EVA_ANTENNA_HEIGHT_M;
      const totalDistM = Math.hypot(dc, dr) * cellStep;
      let visible = 1;

      for (let s = 1; s < steps; s++) {
        const frac = s / steps;
        const nc = Math.round(habCol + dc * frac);
        const nr = Math.round(habRow + dr * frac);

        const d1 = frac * totalDistM;
        const d2 = (1.0 - frac) * totalDistM;
        const curvatureDrop = (d1 * d2) / (2.0 * MARS_RADIUS_METERS);
        const beamHeight = (1.0 - frac) * zHab + frac * zEva - curvatureDrop;

        if (elevation[nr * gridSize + nc] > beamHeight) {
          visible = 0;
          break;
        }
      }
      commsLos[idx] = visible;
    }
  }
}
