// tools/build_mars_sectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Trek tiles are resolved relative to this script (tools/..), never the caller's working directory.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SECTOR_SIZE_METERS = 2048;
const VERTICAL_SCALE = 15.5;

const SITES = [
  {
    id: 'mount_sharp',
    name: 'Mount Sharp (Gale Crater Boxwork Ridge)',
    coordsLabel: '4.95°S, 137.40°E (-4,500m MOLA)',
    centerLatLon: [-4.95, 137.4],
    baseDatumMeters: -4500,
    habCol: 20,
    habRow: 64,
    trekFile: 'public/images/trek_mount_sharp.jpg',
  },
  {
    id: 'deuteronilus',
    name: 'Deuteronilus Mensae (Fretted Glacial Dichotomy)',
    coordsLabel: '43.90°N, 22.60°E (-3,800m MOLA)',
    centerLatLon: [43.9, 22.6],
    baseDatumMeters: -3800,
    habCol: 24,
    habRow: 64,
    trekFile: 'public/images/trek_deuteronilus.jpg',
  },
  {
    id: 'arcadia_ap1',
    name: 'Arcadia Planitia (Starship Candidate Site AP-1)',
    coordsLabel: '39.09°N, 189.79°E (-4,200m MOLA)',
    centerLatLon: [39.09, 189.79],
    baseDatumMeters: -4200,
    habCol: 64,
    habRow: 64,
    trekFile: 'public/images/trek_arcadia_ap1.jpg',
  },
  {
    id: 'phlegra_pm1',
    name: 'Phlegra Montes (Lobate Debris Apron PM-1)',
    coordsLabel: '39.80°N, 163.20°E (-3,600m MOLA)',
    centerLatLon: [39.8, 163.2],
    baseDatumMeters: -3600,
    habCol: 18,
    habRow: 100,
    trekFile: 'public/images/trek_phlegra_pm1.jpg',
  },
];

const ELEV_SIZE = 128;
const COARSE_SIZE = 64;

function hash2D(ix, iy) {
  const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise2D(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3.0 - 2.0 * fx);
  const uy = fy * fy * (3.0 - 2.0 * fy);

  const a = hash2D(ix, iy);
  const b = hash2D(ix + 1, iy);
  const c = hash2D(ix, iy + 1);
  const d = hash2D(ix + 1, iy + 1);

  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm2D(x, y, octaves = 4) {
  let val = 0.0;
  let amp = 0.5;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    val += amp * (valueNoise2D(x * freq, y * freq) - 0.5) * 2.0;
    freq *= 2.07;
    amp *= 0.48;
  }
  return val;
}

function smoothTerraces(val, stepHeight, sharpness = 2.4) {
  const scaled = val / stepHeight;
  const base = Math.floor(scaled);
  const frac = scaled - base;
  const smoothFrac = 0.5 + (0.5 * Math.tanh(sharpness * (frac - 0.5))) / Math.tanh(0.5 * sharpness);
  return (base + smoothFrac) * stepHeight;
}

const trekCache = new Map();
function readTrekTile(trekFile) {
  let buf = trekCache.get(trekFile);
  if (!buf) {
    const abs = path.resolve(PROJECT_ROOT, trekFile);
    // Fail loudly: a missing / truncated tile must never silently change the generated terrain.
    if (!fs.existsSync(abs)) throw new Error(`Trek tile not found: ${abs}`);
    buf = fs.readFileSync(abs);
    if (buf.length < 2048) throw new Error(`Trek tile too small (${buf.length} bytes): ${abs}`);
    trekCache.set(trekFile, buf);
  }
  return buf;
}

function computeRegionalTileBias(trekFile, u, v) {
  const buf = readTrekTile(trekFile);
  const offset = 1024 + Math.floor((u * 0.45 + v * 0.45) * (buf.length - 1500));
  const b0 = buf[offset] / 255.0 - 0.5;
  return (u - 0.5) * 1.15 + (0.5 - v) * 0.75 + b0 * 0.05;
}

function evaluateSiteCell(site, u, v) {
  const siteId = site.id;
  const nx = (u - 0.5) * 4.0;
  const ny = (v - 0.5) * 4.0;
  const regionalTilt = computeRegionalTileBias(site.trekFile, u, v);
  const naturalDetail = fbm2D(nx * 2.4 + 7.1, ny * 2.4 + 3.3, 4);

  let strata = 0;
  let tiu = 280;
  let unit = 1;

  if (siteId === 'mount_sharp') {
    // 1. MOUNT SHARP: S-Curve Gediz Vallis Canyon + Stepped Sulfate Benches + Boxwork Ridge
    const canyonWarp = fbm2D(nx * 0.8, ny * 0.8, 2) * 0.18;
    const canyonPath = Math.sin(ny * 1.35) * 0.62 + canyonWarp;
    const canyonDist = Math.abs(nx - canyonPath);
    const canyonFloor = Math.tanh(canyonDist * 1.85) * 10.8 - 5.4;
    const rawMesa = canyonFloor + regionalTilt * 1.2 + naturalDetail * 1.15;
    const steppedStrata = smoothTerraces(rawMesa, 3.2, 2.3);

    const rampNorth = Math.exp(-Math.pow((ny + 0.85) / 0.45, 2));
    const rampSouth = Math.exp(-Math.pow((ny - 0.75) / 0.45, 2));
    const rampBlend = Math.min(1.0, rampNorth + rampSouth);
    const gentleCanyon = (Math.tanh(canyonDist * 1.1) * 6.0 - 3.0) * 0.55 + naturalDetail * 0.35;
    strata = steppedStrata * (1.0 - rampBlend) + gentleCanyon * rampBlend;

    const boxworkDetail =
      canyonDist > 0.65 ? fbm2D(nx * 7.5, ny * 7.5, 3) * 0.42 * (1.0 - rampBlend) : 0.0;
    strata += boxworkDetail;

    if (canyonDist < 0.35 && rampBlend < 0.45) {
      tiu = 60 + canyonDist * 80;
      unit = 0;
    } else if (strata > 1.8) {
      tiu = 355 + naturalDetail * 35;
      unit = 2;
    } else {
      tiu = 245 + naturalDetail * 30;
      unit = 1;
    }
  } else if (siteId === 'deuteronilus') {
    // 2. DEUTERONILUS MENSAE: Fretted Dichotomy Isolated Flat-Topped Buttes/Mesas + Glacial Troughs
    const warpX = nx + fbm2D(nx * 1.2, ny * 1.2, 2) * 0.25;
    const warpY = ny + fbm2D(nx * 1.2 + 4.0, ny * 1.2 + 4.0, 2) * 0.25;

    const butteNE = Math.hypot((warpX - 0.85) * 0.9, (warpY + 0.65) * 1.1);
    const butteSE = Math.hypot((warpX - 0.35) * 1.0, (warpY - 0.85) * 0.95);
    const butteNW = Math.hypot((warpX + 0.95) * 1.1, (warpY + 0.85) * 1.1);

    const mesa1 = (1.0 - Math.tanh((butteNE - 0.92) * 3.2)) * 4.2;
    const mesa2 = (1.0 - Math.tanh((butteSE - 0.78) * 3.0)) * 3.6;
    const mesa3 = (1.0 - Math.tanh((butteNW - 0.72) * 3.2)) * 3.4;

    // Central glacial valley floor with eolian drift pocket in the deep trough
    const valleyFloor = -3.8 + Math.sin(nx * 1.1) * 0.6 + naturalDetail * 0.85;
    strata = valleyFloor + mesa1 + mesa2 + mesa3;

    const troughDist = Math.hypot(nx - 0.05, ny + 0.05);
    if (troughDist < 0.48) {
      tiu = 72 + troughDist * 65;
      unit = 0;
    } else if (strata > 1.6) {
      tiu = 345 + naturalDetail * 30;
      unit = 2;
    } else {
      tiu = 275 + naturalDetail * 25;
      unit = 3; // SHARAD Subsurface Glacial Ice Apron
    }
  } else if (siteId === 'arcadia_ap1') {
    // 3. ARCADIA PLANITIA: 3 Terraced Impact Craters on Volcanic Plains (clear of Hab & WP-2)
    const craterNW = Math.hypot(nx + 0.68, ny + 0.62);
    const craterSW = Math.hypot(nx + 0.78, ny - 0.82);
    const craterSE = Math.hypot(nx - 0.65, ny - 0.78);

    const bowlNW = craterNW < 0.56 ? -Math.cos((craterNW / 0.56) * (Math.PI / 2)) * 3.8 : 0;
    const bowlSW = craterSW < 0.58 ? -Math.cos((craterSW / 0.58) * (Math.PI / 2)) * 4.1 : 0;
    const bowlSE = craterSE < 0.62 ? -Math.cos((craterSE / 0.62) * (Math.PI / 2)) * 4.4 : 0;

    const rimNW = Math.exp(-Math.pow((craterNW - 0.56) / 0.14, 2)) * 1.15;
    const rimSW = Math.exp(-Math.pow((craterSW - 0.58) / 0.14, 2)) * 1.25;
    const rimSE = Math.exp(-Math.pow((craterSE - 0.62) / 0.15, 2)) * 1.35;

    strata = bowlNW + bowlSW + bowlSE + rimNW + rimSW + rimSE + regionalTilt * 0.45 + naturalDetail * 0.55;
    tiu = craterNW < 0.42 || craterSW < 0.42 || craterSE < 0.44 ? 70 : 315 + naturalDetail * 30;
    unit = tiu < 110 ? 0 : rimNW > 0.6 || rimSE > 0.6 ? 2 : 3;
  } else {
    // 4. PHLEGRA MONTES: Diagonal Tectonic Mountain Scarp + Braided Glacial Outwash Valleys
    const diagCoord = nx * 0.82 - ny * 0.57;
    const crossCoord = nx * 0.57 + ny * 0.82;

    const valleyNorth = Math.exp(-Math.pow((crossCoord + 0.62) / 0.46, 2));
    const valleySouth = Math.exp(-Math.pow((crossCoord - 0.52) / 0.46, 2));
    const valleyBlend = Math.min(1.0, valleyNorth + valleySouth);

    const steepScarp = Math.tanh((diagCoord + 0.2) * 1.95) * 9.6;
    const gentleOutwash = Math.tanh((diagCoord + 0.2) * 0.75) * 6.0;
    const apronSlope = steepScarp * (1.0 - valleyBlend * 0.75) + gentleOutwash * (valleyBlend * 0.75);

    const moraineRidges =
      diagCoord > -0.2
        ? Math.sin(diagCoord * 9.0) * 0.65 * (1.0 - valleyBlend * 0.5) +
          fbm2D(nx * 3.2, ny * 2.2, 3) * 0.9
        : 0;
    strata = apronSlope + moraineRidges + regionalTilt * 0.5 + naturalDetail * 0.55;
    tiu = Math.abs(diagCoord + 0.2) < 0.26 && valleyBlend < 0.35 ? 78 : 330 + naturalDetail * 25;
    unit = diagCoord > -0.05 ? 3 : tiu < 110 ? 0 : 2;
  }

  return { strata: strata * VERTICAL_SCALE, tiu: Math.max(45, tiu), unit };
}

for (const site of SITES) {
  const dir = path.join('public', 'data', site.id);
  fs.mkdirSync(dir, { recursive: true });

  const elevation = new Float32Array(ELEV_SIZE * ELEV_SIZE);
  for (let r = 0; r < ELEV_SIZE; r++) {
    for (let c = 0; c < ELEV_SIZE; c++) {
      const { strata } = evaluateSiteCell(site, c / (ELEV_SIZE - 1), r / (ELEV_SIZE - 1));
      elevation[r * ELEV_SIZE + c] = strata;
    }
  }

  const thermal = new Uint16Array(COARSE_SIZE * COARSE_SIZE);
  const geologic = new Uint8Array(COARSE_SIZE * COARSE_SIZE);
  for (let r = 0; r < COARSE_SIZE; r++) {
    for (let c = 0; c < COARSE_SIZE; c++) {
      const { tiu, unit } = evaluateSiteCell(site, c / (COARSE_SIZE - 1), r / (COARSE_SIZE - 1));
      thermal[r * COARSE_SIZE + c] = Math.round(tiu);
      geologic[r * COARSE_SIZE + c] = unit;
    }
  }

  fs.writeFileSync(path.join(dir, 'elevation.bin'), Buffer.from(elevation.buffer));
  fs.writeFileSync(path.join(dir, 'thermal.bin'), Buffer.from(thermal.buffer));
  fs.writeFileSync(path.join(dir, 'geologic.bin'), Buffer.from(geologic.buffer));

  const manifest = {
    site_id: site.id,
    name: site.name,
    coords_label: site.coordsLabel,
    center_lat_lon: site.centerLatLon,
    base_datum_meters: site.baseDatumMeters,
    sector_size_meters: SECTOR_SIZE_METERS,
    hab_grid_coords: [site.habCol, site.habRow],
    channels: [
      { id: 'elevation', file: 'elevation.bin', dtype: 'float32', width: ELEV_SIZE, height: ELEV_SIZE, unit: 'm' },
      { id: 'thermal_inertia', file: 'thermal.bin', dtype: 'uint16', width: COARSE_SIZE, height: COARSE_SIZE, unit: 'TIU' },
      { id: 'geologic_unit', file: 'geologic.bin', dtype: 'uint8', width: COARSE_SIZE, height: COARSE_SIZE, unit: 'class' },
    ],
  };

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
console.log('Rebuilt all 4 Mars binary packs with distinct site geomorphologies.');
