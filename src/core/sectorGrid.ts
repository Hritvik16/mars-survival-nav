// src/core/sectorGrid.ts
import {
  findProminenceLandmarks,
  MARS_SITES,
  recomputeDiscoveryScore,
  recomputeIceTableDepth,
  recomputeSkyViewFactor,
  recomputeSlopeAndRoughness,
  type SectorBuffers,
  type SiteId,
  type SiteMetadata,
} from './sectorData';
import { recomputeCommsLos, recomputeSolarShadow } from './solarAndComms';

export interface ChannelDescriptor {
  readonly id: string;
  readonly file: string;
  readonly dtype: 'float32' | 'uint16' | 'uint8';
  readonly width: number;
  readonly height: number;
  readonly unit: string;
}

export interface SectorManifest {
  readonly site_id: SiteId;
  readonly name: string;
  readonly coords_label: string;
  readonly center_lat_lon: readonly [number, number];
  readonly base_datum_meters: number;
  readonly sector_size_meters: number;
  readonly hab_grid_coords: readonly [number, number];
  readonly channels: readonly ChannelDescriptor[];
}

export function sampleBilinear(
  coarse: ArrayLike<number>,
  coarseW: number,
  coarseH: number,
  u: number,
  v: number
): number {
  const x = Math.max(0, Math.min(coarseW - 1, u * (coarseW - 1)));
  const y = Math.max(0, Math.min(coarseH - 1, v * (coarseH - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, coarseW - 1);
  const y1 = Math.min(y0 + 1, coarseH - 1);
  const fx = x - x0;
  const fy = y - y0;

  const v00 = coarse[y0 * coarseW + x0];
  const v10 = coarse[y0 * coarseW + x1];
  const v01 = coarse[y1 * coarseW + x0];
  const v11 = coarse[y1 * coarseW + x1];

  const top = v00 * (1.0 - fx) + v10 * fx;
  const bot = v01 * (1.0 - fx) + v11 * fx;
  return top * (1.0 - fy) + bot * fy;
}

export async function loadSectorFromBinary(
  siteId: SiteId,
  solHour = 14.0
): Promise<SectorBuffers> {
  const baseUrl = `/data/${siteId}`;
  const manifestRes = await fetch(`${baseUrl}/manifest.json`, { cache: "no-store" });
  if (!manifestRes.ok) {
    throw new Error(`Failed to load manifest for ${siteId}`);
  }
  const manifest = (await manifestRes.json()) as SectorManifest;

  const elevDesc = manifest.channels.find((c) => c.id === 'elevation')!;
  const tiuDesc = manifest.channels.find((c) => c.id === 'thermal_inertia')!;
  const geoDesc = manifest.channels.find((c) => c.id === 'geologic_unit')!;

  const [elevBuf, tiuBuf, geoBuf] = await Promise.all([
    fetch(`${baseUrl}/${elevDesc.file}`, { cache: "no-store" }).then((r) => r.arrayBuffer()),
    fetch(`${baseUrl}/${tiuDesc.file}`, { cache: "no-store" }).then((r) => r.arrayBuffer()),
    fetch(`${baseUrl}/${geoDesc.file}`, { cache: "no-store" }).then((r) => r.arrayBuffer()),
  ]);

  const gridSize = elevDesc.width;
  const worldSizeMeters = manifest.sector_size_meters;
  const count = gridSize * gridSize;

  const elevation = new Float32Array(elevBuf);
  const coarseTiu = new Uint16Array(tiuBuf);
  const coarseGeo = new Uint8Array(geoBuf);

  const thermalInertia = new Float32Array(count);
  const geologicUnit = new Uint8Array(count);
  const slopeDeg = new Float32Array(count);
  const roughness = new Float32Array(count);
  const skyViewFactor = new Float32Array(count);
  const solarShadow = new Uint8Array(count);
  const commsLos = new Uint8Array(count);
  const walkbackO2 = new Float32Array(count);
  const discoveryScore = new Float32Array(count);
  const iceTableDepthM = new Float32Array(count);
  const inSituBlocked = new Uint8Array(count);

  for (let r = 0; r < gridSize; r++) {
    const v = r / (gridSize - 1);
    const geoR = Math.min(geoDesc.height - 1, Math.round(v * (geoDesc.height - 1)));
    for (let c = 0; c < gridSize; c++) {
      const u = c / (gridSize - 1);
      const idx = r * gridSize + c;
      thermalInertia[idx] = sampleBilinear(coarseTiu, tiuDesc.width, tiuDesc.height, u, v);
      const geoC = Math.min(geoDesc.width - 1, Math.round(u * (geoDesc.width - 1)));
      geologicUnit[idx] = coarseGeo[geoR * geoDesc.width + geoC];
    }
  }

  const baseSite = MARS_SITES[manifest.site_id];
  const site: SiteMetadata = {
    ...baseSite,
    habCol: manifest.hab_grid_coords[0],
    habRow: manifest.hab_grid_coords[1],
  };

  recomputeSlopeAndRoughness(elevation, slopeDeg, roughness, gridSize, worldSizeMeters);
  recomputeSkyViewFactor(elevation, skyViewFactor, gridSize, worldSizeMeters);
  recomputeSolarShadow(elevation, solarShadow, gridSize, worldSizeMeters, solHour);
  recomputeCommsLos(elevation, commsLos, gridSize, worldSizeMeters, site.habCol, site.habRow);
  recomputeDiscoveryScore(geologicUnit, thermalInertia, slopeDeg, discoveryScore, gridSize);
  recomputeIceTableDepth(elevation, thermalInertia, geologicUnit, iceTableDepthM, gridSize);
  const landmarks = findProminenceLandmarks(elevation, gridSize);

  const totalBytes =
    elevation.byteLength +
    coarseTiu.byteLength +
    coarseGeo.byteLength +
    slopeDeg.byteLength +
    roughness.byteLength +
    skyViewFactor.byteLength +
    solarShadow.byteLength +
    commsLos.byteLength +
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
