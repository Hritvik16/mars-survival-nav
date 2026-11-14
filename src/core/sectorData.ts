// src/core/sectorData.ts
import { recomputeCommsLos, recomputeSolarShadow } from './solarAndComms';

export type LayerMode = 'mars' | 'slope' | 'sand' | 'roughness' | 'radiation' | 'solar' | 'comms';

export type SiteId = 'mount_sharp' | 'deuteronilus' | 'arcadia_ap1' | 'phlegra_pm1';

export interface SiteMetadata {
  readonly id: SiteId;
  readonly name: string;
  readonly coordsLabel: string;
  readonly baseDatumMeters: number;
  readonly habCol: number;
  readonly habRow: number;
}

export const MARS_SITES: Record<SiteId, SiteMetadata> = {
  mount_sharp: {
    id: 'mount_sharp',
    name: 'Mount Sharp (Gale Crater Boxwork Ridge)',
    coordsLabel: '4.95°S, 137.40°E (-4,500m MOLA)',
    baseDatumMeters: -4500,
    habCol: 20,
    habRow: 64,
  },
  deuteronilus: {
    id: 'deuteronilus',
    name: 'Deuteronilus Mensae (Fretted Glacial Dichotomy)',
    coordsLabel: '43.90°N, 22.60°E (-3,800m MOLA)',
    baseDatumMeters: -3800,
    habCol: 24,
    habRow: 64,
  },
  arcadia_ap1: {
    id: 'arcadia_ap1',
    name: 'Arcadia Planitia (Starship Candidate Site AP-1)',
    coordsLabel: '39.09°N, 189.79°E (-4,200m MOLA)',
    baseDatumMeters: -4200,
    habCol: 64,
    habRow: 64,
  },
  phlegra_pm1: {
    id: 'phlegra_pm1',
    name: 'Phlegra Montes (Lobate Debris Apron PM-1)',
    coordsLabel: '39.80°N, 163.20°E (-3,600m MOLA)',
    baseDatumMeters: -3600,
    habCol: 18,
    habRow: 100,
  },
};

export const GEOLOGIC_UNIT_LABELS: readonly string[] = [
  'Eolian Bagnold Sand Sheet (Low Traction)',
  'Hesperian Layered Sulfate Terrace',
  'Amazonian Basaltic Bedrock Mesa',
  'SHARAD Shallow Subsurface Water-Ice Apron',
];

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
  readonly memoryKB: number;
}

export function createSyntheticSector(
  gridSize = 128,
  worldSizeMeters = 100,
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

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      const nx = (c / gridSize - 0.5) * 4.0;
      const ny = (r / gridSize - 0.5) * 4.0;

      // Site-specific analytical geomorphology (zero domain warping)
      let strata = 0;
      let tiu = 280;
      let unit = 1;

      if (siteId === 'mount_sharp' || siteId === 'deuteronilus') {
        const canyonFreq = siteId === 'mount_sharp' ? 1.4 : 1.0;
        const stepHeight = siteId === 'mount_sharp' ? 3.5 : 4.2;
        const canyonPath = Math.sin(ny * canyonFreq) * 0.65;
        const canyonDist = Math.abs(nx - canyonPath);
        const canyonFloor = Math.tanh(canyonDist * 1.85) * 11.0 - 5.5;
        const rawMesa = canyonFloor + Math.sin(nx * 3.5) * Math.cos(ny * 3.5) * 1.6;
        const rem = ((rawMesa % stepHeight) + stepHeight) % stepHeight;
        const steppedStrata = Math.floor(rawMesa / stepHeight) * stepHeight + Math.tanh(rem * 1.8);

        // Natural alluvial erosion breaches (Gediz Vallis style <18° canyon crossings)
        const rampNorth = Math.exp(-Math.pow((ny + 0.85) / 0.45, 2));
        const rampSouth = Math.exp(-Math.pow((ny - 0.75) / 0.45, 2));
        const rampBlend = Math.min(1.0, rampNorth + rampSouth);
        const gentleCanyon = (Math.tanh(canyonDist * 1.1) * 6.0 - 3.0) * 0.55;
        strata = steppedStrata * (1.0 - rampBlend) + gentleCanyon * rampBlend;

        // High-frequency boxwork/boulder micro-relief on upper ridges (smoothed inside ramps)
        const microBoulders =
          canyonDist > 0.7 ? Math.sin(c * 1.7) * Math.cos(r * 1.9) * 0.32 * (1.0 - rampBlend) : 0.0;
        strata += microBoulders;

        if (canyonDist < 0.35) {
          tiu = 60 + canyonDist * 80; // Fine eolian dust trap (<100 TIU)
          unit = 0;
        } else if (strata > 3.0) {
          tiu = 360 + Math.cos(nx * 6) * 40; // Exposed bedrock mesa
          unit = 2;
        } else {
          tiu = 240 + Math.sin(ny * 5) * 35; // Sulfate/glacial terrace
          unit = siteId === 'deuteronilus' ? 3 : 1;
        }
      } else if (siteId === 'arcadia_ap1') {
        // Flat volcanic plains with secondary crater bowls and shallow ice polygons
        const crater1 = Math.hypot(nx - 0.7, ny + 0.5);
        const crater2 = Math.hypot(nx + 0.8, ny - 0.6);
        const bowl1 = crater1 < 0.75 ? -Math.cos((crater1 / 0.75) * (Math.PI / 2)) * 5.5 : 0;
        const bowl2 = crater2 < 0.55 ? -Math.cos((crater2 / 0.55) * (Math.PI / 2)) * 4.0 : 0;
        const ejecta = Math.abs(crater1 - 0.75) < 0.2 ? Math.sin(c * 2.1) * Math.cos(r * 2.1) * 0.6 : 0;
        strata = bowl1 + bowl2 + ejecta + Math.sin(nx * 1.5) * Math.cos(ny * 1.5) * 0.8;
        tiu = crater1 < 0.45 || crater2 < 0.35 ? 75 : 310 + Math.cos(nx * 4) * 30;
        unit = tiu < 110 ? 0 : 3;
      } else {
        // Phlegra Montes: steep Lobate Debris Apron glacial front rising from flat plain
        const apronSlope = Math.tanh((nx + 0.3) * 1.8) * 11.0;
        const moraineRidges = nx > -0.3 ? Math.sin(nx * 8.0) * Math.cos(ny * 3.0) * 1.2 : 0;
        strata = apronSlope + moraineRidges;
        tiu = Math.abs(nx + 0.3) < 0.25 ? 85 : 330;
        unit = nx > -0.1 ? 3 : tiu < 110 ? 0 : 2;
      }

      elevation[idx] = strata;
      thermalInertia[idx] = tiu;
      geologicUnit[idx] = unit;
    }
  }

  recomputeSlopeAndRoughness(elevation, slopeDeg, roughness, gridSize, worldSizeMeters);
  recomputeSkyViewFactor(elevation, skyViewFactor, gridSize, worldSizeMeters);
  recomputeSolarShadow(elevation, solarShadow, gridSize, worldSizeMeters, 14.0);
  recomputeCommsLos(elevation, commsLos, gridSize, worldSizeMeters, site.habCol, site.habRow);

  const totalBytes =
    elevation.byteLength +
    slopeDeg.byteLength +
    thermalInertia.byteLength +
    roughness.byteLength +
    skyViewFactor.byteLength +
    solarShadow.byteLength +
    commsLos.byteLength +
    geologicUnit.byteLength;

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
    memoryKB: Math.round((totalBytes / 1024) * 10) / 10,
  };
}

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
      // 1. Central-difference gradient -> slope angle in degrees
      const dzdx = (elevation[idx + 1] - elevation[idx - 1]) / (2.0 * cellStep);
      const dzdy = (elevation[idx + gridSize] - elevation[idx - gridSize]) / (2.0 * cellStep);
      slopeDeg[idx] = Math.atan(Math.hypot(dzdx, dzdy)) * (180 / Math.PI);

      // 2. 3x3 neighborhood elevation standard deviation -> surface roughness (m)
      let sum = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          sum += elevation[(r + dr) * gridSize + (c + dc)];
        }
      }
      const mean = sum / 9.0;
      let sqDiffSum = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const diff = elevation[(r + dr) * gridSize + (c + dc)] - mean;
          sqDiffSum += diff * diff;
        }
      }
      roughness[idx] = Math.sqrt(sqDiffSum / 9.0);
    }
  }
}

export function recomputeSkyViewFactor(
  elevation: Float32Array,
  skyViewFactor: Float32Array,
  gridSize: number,
  worldSizeMeters: number
): void {
  const cellStep = worldSizeMeters / (gridSize - 1);
  const dirs = [
    [-1, 0], [-1, 1], [0, 1], [1, 1],
    [1, 0], [1, -1], [0, -1], [-1, -1],
  ] as const;
  const maxSteps = 16;

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      const z0 = elevation[idx];
      let openSkySum = 0;

      for (let d = 0; d < 8; d++) {
        const dr = dirs[d][0];
        const dc = dirs[d][1];
        const stepDist = Math.hypot(dr, dc) * cellStep;
        let maxHorizonAngle = 0;

        for (let s = 1; s <= maxSteps; s++) {
          const nr = r + dr * s;
          const nc = c + dc * s;
          if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize) break;
          const dz = elevation[nr * gridSize + nc] - z0;
          if (dz > 0) {
            const angle = Math.atan2(dz, s * stepDist);
            if (angle > maxHorizonAngle) maxHorizonAngle = angle;
          }
        }
        const cosA = Math.cos(maxHorizonAngle);
        openSkySum += cosA * cosA;
      }
      skyViewFactor[idx] = openSkySum / 8.0;
    }
  }
}