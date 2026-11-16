// src/core/sectorGrid.ts
/**
 * @file sectorGrid.ts
 * @module core/sectorGrid
 *
 * Loader for the binary sector packs written by tools/build_mars_sectors.mjs, plus the bilinear
 * sampler used to up-sample the 64x64 thermal channel onto the 128x128 solver grid.
 *
 * Wire format (all files little-endian, row-major, no header; the host is assumed little-endian,
 * as every WebGL-capable browser platform is, because the typed-array constructors below view
 * the fetched ArrayBuffer in native byte order):
 *   elevation.bin  Float32  128 x 128  = 65,536 B   metres, site-relative
 *   thermal.bin    Uint16    64 x  64  =  8,192 B   thermal inertia (TIU)
 *   geologic.bin   Uint8     64 x  64  =  4,096 B   class id 0..3
 *   manifest.json  names the files, dtypes, widths/heights, hab_grid_coords and sector_size_meters.
 * Total payload per site: 77,824 B = 76.0 KiB (manifest excluded).
 */
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

/**
 * One entry of manifest.json "channels": which file holds the channel, its element type
 * and raster size. The loader trusts width/height (elevation width becomes gridSize).
 */
export interface ChannelDescriptor {
  readonly id: string;
  readonly file: string;
  readonly dtype: 'float32' | 'uint16' | 'uint8';
  readonly width: number;
  readonly height: number;
  readonly unit: string;
}

/**
 * Shape of public/data/<site>/manifest.json. hab_grid_coords = [col, row] of the habitat on the
 * 128x128 grid; sector_size_meters = 2048 (the 2.05 km square); center_lat_lon in degrees.
 */
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

/**
 * Bilinear interpolation of a coarse raster at normalised coordinates (u, v) in [0, 1].
 *
 *     x = clamp(u * (W - 1), 0, W - 1),  y = clamp(v * (H - 1), 0, H - 1)
 *     x0 = floor(x), x1 = min(x0 + 1, W - 1), fx = x - x0   (same for y)
 *     value = (1-fy) * [ (1-fx)*v00 + fx*v10 ]  +  fy * [ (1-fx)*v01 + fx*v11 ]
 *
 * Because u = 0 and u = 1 map exactly to the first and last coarse posts, the coarse and fine
 * grids share corner alignment (posts, not pixel centres).
 *
 * @param coarse  source samples, row-major, length coarseW * coarseH
 * @param coarseW source width;  @param coarseH source height
 * @param u,v     normalised position, 0..1 (clamped)
 * @returns       interpolated value in the units of `coarse`
 */
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

/**
 * Fetches /data/<siteId>/manifest.json and the three .bin channels (cache: "no-store") and
 * assembles a SectorBuffers bundle.
 *
 * Steps: (1) view elevation.bin as Float32Array (no copy); (2) up-sample thermal 64x64 -> 128x128
 * with sampleBilinear (TIU is continuous); (3) up-sample geologic 64x64 -> 128x128 with nearest
 * neighbour, idx = round(u * 63) (classes are categorical, so no blending); (4) override the Hab
 * cell with manifest.hab_grid_coords; (5) run the derived-layer pipeline: slope+roughness, sky-view,
 * solar shadow at `solHour`, comms LOS from the Hab, discovery score, ice-table depth, landmarks.
 *
 * memoryKB accounting: the byte total sums the COARSE thermal (8,192 B) and geologic (4,096 B)
 * arrays that were read from disk plus elevation, slope, roughness, sky-view, shadow, comms,
 * walkbackO2, discovery, ice and blocked arrays = 508.0 KiB. It does not include the 128x128
 * Float32 thermalInertia (64 KiB) and Uint8 geologicUnit (16 KiB) expansions that the solvers
 * actually read, so the live typed-array footprint of the returned bundle is 576.0 KiB.
 *
 * @param siteId   one of the four SiteId values
 * @param solHour  local solar hour used for the initial shadow mask (default 14.0)
 * @returns        Promise<SectorBuffers>; rejects if the manifest or any .bin request fails (non-OK
 *                 status) or a .bin's byteLength != width * height * bytesPerElement from the manifest
 */
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

  if (!elevDesc || !tiuDesc || !geoDesc) {
    throw new Error(`Manifest for ${siteId} is missing an elevation / thermal_inertia / geologic_unit channel`);
  }

  const fetchChannel = async (
    desc: { file: string; width: number; height: number; dtype: string },
    bytesPerElement: number
  ): Promise<ArrayBuffer> => {
    const res = await fetch(`${baseUrl}/${desc.file}`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Failed to load ${siteId}/${desc.file}: HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    const expected = desc.width * desc.height * bytesPerElement;
    if (buf.byteLength !== expected) {
      throw new Error(
        `${siteId}/${desc.file} is ${buf.byteLength} bytes, expected ${expected} ` +
          `(${desc.width}x${desc.height} ${desc.dtype})`
      );
    }
    return buf;
  };

  const [elevBuf, tiuBuf, geoBuf] = await Promise.all([
    fetchChannel(elevDesc, 4),
    fetchChannel(tiuDesc, 2),
    fetchChannel(geoDesc, 1),
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
