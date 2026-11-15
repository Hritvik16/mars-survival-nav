// tools/build_mars_sectors.mjs
import fs from 'node:fs';
import path from 'node:path';

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

function computeRegionalTileBias(trekFile, u, v) {
  try {
    const buf = fs.readFileSync(trekFile);
    if (buf.length < 2048) return 0;
    const offset = 1024 + Math.floor((u * 0.45 + v * 0.45) * (buf.length - 1500));
    const b0 = buf[offset] / 255.0 - 0.5;
    return (u - 0.5) * 1.15 + (0.5 - v) * 0.75 + b0 * 0.05;
  } catch {
    return (u - 0.5) * 1.15;
  }
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

  if (siteId === 'mount_sharp' || siteId === 'deuteronilus') {
    const canyonFreq = siteId === 'mount_sharp' ? 1.35 : 1.0;
    const stepHeight = siteId === 'mount_sharp' ? 3.2 : 4.0;
    const canyonWarp = fbm2D(nx * 0.8, ny * 0.8, 2) * 0.18;
    const canyonPath = Math.sin(ny * canyonFreq) * 0.62 + canyonWarp;
    const canyonDist = Math.abs(nx - canyonPath);
    const canyonFloor = Math.tanh(canyonDist * 1.85) * 10.8 - 5.4;
    const rawMesa = canyonFloor + regionalTilt * 1.2 + naturalDetail * 1.15;

    const steppedStrata = smoothTerraces(rawMesa, stepHeight, 2.3);

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
      unit = siteId === 'deuteronilus' ? 3 : 1;
    }
  } else if (siteId === 'arcadia_ap1') {
    const crater1 = Math.hypot(nx - 0.7, ny + 0.35);
    const crater2 = Math.hypot(nx + 0.68, ny + 0.62);
    const bowl1 = crater1 < 0.72 ? -Math.cos((crater1 / 0.72) * (Math.PI / 2)) * 5.2 : 0;
    const bowl2 = crater2 < 0.65 ? -Math.cos((crater2 / 0.65) * (Math.PI / 2)) * 4.8 : 0;
    const rim1 = Math.exp(-Math.pow((crater1 - 0.72) / 0.14, 2)) * 1.1;
    const rim2 = Math.exp(-Math.pow((crater2 - 0.65) / 0.13, 2)) * 1.0;
    strata = bowl1 + bowl2 + rim1 + rim2 + regionalTilt * 0.6 + naturalDetail * 0.75;
    tiu = crater1 < 0.48 || crater2 < 0.46 ? 72 : 315 + naturalDetail * 30;
    unit = tiu < 110 ? 0 : 3;
  } else {
    // Phlegra Montes Lobate Debris Apron with steep main scarp + 2 traversable glacial outwash valleys
    const valleyNorth = Math.exp(-Math.pow((ny + 0.65) / 0.48, 2));
    const valleySouth = Math.exp(-Math.pow((ny - 0.55) / 0.48, 2));
    const valleyBlend = Math.min(1.0, valleyNorth + valleySouth);

    const steepScarp = Math.tanh((nx + 0.25) * 1.85) * 9.2;
    const gentleOutwash = Math.tanh((nx + 0.25) * 0.75) * 6.2;
    const apronSlope = steepScarp * (1.0 - valleyBlend * 0.75) + gentleOutwash * (valleyBlend * 0.75);

    const moraineRidges =
      nx > -0.25 ? fbm2D(nx * 3.2, ny * 2.2, 3) * 1.1 * (1.0 - valleyBlend * 0.5) : 0;
    strata = apronSlope + moraineRidges + regionalTilt * 0.6 + naturalDetail * 0.55;
    tiu = Math.abs(nx + 0.25) < 0.28 && valleyBlend < 0.35 ? 78 : 330 + naturalDetail * 25;
    unit = nx > -0.1 ? 3 : tiu < 110 ? 0 : 2;
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
console.log('Fixed Phlegra Montes glacial outwash valleys & updated binary packs.');
