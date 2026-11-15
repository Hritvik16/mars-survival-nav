// tools/verify_benchmarks.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  findProminenceLandmarks,
  MARS_SITES,
  recomputeDiscoveryScore,
  recomputeIceTableDepth,
  recomputeSkyViewFactor,
  recomputeSlopeAndRoughness,
} from '../src/core/sectorData.ts';
import { sampleBilinear } from '../src/core/sectorGrid.ts';
import { deployOptimalCommsRelay, recomputeCommsLos, recomputeSolarShadow } from '../src/core/solarAndComms.ts';
import { AnisotropicPathfinder } from '../src/core/pathfinder.ts';

const SITE_IDS = ['mount_sharp', 'deuteronilus', 'arcadia_ap1', 'phlegra_pm1'];
const pathfinder = new AnisotropicPathfinder(128 * 128);

function loadSectorDisk(siteId) {
  const dir = path.join('public', 'data', siteId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const elevBuf = fs.readFileSync(path.join(dir, 'elevation.bin'));
  const tiuBuf = fs.readFileSync(path.join(dir, 'thermal.bin'));
  const geoBuf = fs.readFileSync(path.join(dir, 'geologic.bin'));

  const gridSize = 128;
  const worldSizeMeters = manifest.sector_size_meters;
  const count = gridSize * gridSize;

  const elevation = new Float32Array(elevBuf.buffer, elevBuf.byteOffset, count);
  const coarseTiu = new Uint16Array(tiuBuf.buffer, tiuBuf.byteOffset, 64 * 64);
  const coarseGeo = new Uint8Array(geoBuf.buffer, geoBuf.byteOffset, 64 * 64);

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
    const geoR = Math.min(63, Math.round(v * 63));
    for (let c = 0; c < gridSize; c++) {
      const u = c / (gridSize - 1);
      const idx = r * gridSize + c;
      thermalInertia[idx] = sampleBilinear(coarseTiu, 64, 64, u, v);
      const geoC = Math.min(63, Math.round(u * 63));
      geologicUnit[idx] = coarseGeo[geoR * 64 + geoC];
    }
  }

  const site = {
    ...MARS_SITES[siteId],
    habCol: manifest.hab_grid_coords[0],
    habRow: manifest.hab_grid_coords[1],
  };

  recomputeSlopeAndRoughness(elevation, slopeDeg, roughness, gridSize, worldSizeMeters);
  recomputeSkyViewFactor(elevation, skyViewFactor, gridSize, worldSizeMeters);
  recomputeSolarShadow(elevation, solarShadow, gridSize, worldSizeMeters, 14.0);
  recomputeCommsLos(elevation, commsLos, gridSize, worldSizeMeters, site.habCol, site.habRow);
  recomputeDiscoveryScore(geologicUnit, thermalInertia, slopeDeg, discoveryScore, gridSize);
  recomputeIceTableDepth(elevation, thermalInertia, geologicUnit, iceTableDepthM, gridSize);
  const landmarks = findProminenceLandmarks(elevation, gridSize);

  const diskBytes = elevBuf.byteLength + tiuBuf.byteLength + geoBuf.byteLength;
  const ramBytes =
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
    diskKB: (diskBytes / 1024).toFixed(1),
    memoryKB: (ramBytes / 1024).toFixed(1),
  };
}

const rows = [];
console.log('=== MARS SURVIVAL NAV: AUTOMATED PHYSICS & BENCHMARK SUITE ===\n');

{
  const warm = loadSectorDisk('mount_sharp');
  pathfinder.findRoute(warm, 20, 64, 108, 46, 15.5, 14.0);
}

for (const id of SITE_IDS) {
  const sector = loadSectorDisk(id);
  const wp1 = sector.site.waypoints[0];

  const smart = pathfinder.findRoute(
    sector,
    sector.site.habCol,
    sector.site.habRow,
    wp1.col,
    wp1.row,
    15.5,
    14.0
  );
  const naive = pathfinder.evaluateDirectPath(
    sector,
    sector.site.habCol,
    sector.site.habRow,
    wp1.col,
    wp1.row,
    15.5,
    14.0
  );
  const walkback = pathfinder.computeWalkbackEnvelope(sector, 15.5);
  const loop = pathfinder.findScienceLoop(sector, 15.5, 14.0);
  const relay = deployOptimalCommsRelay(
    sector.elevation,
    sector.slopeDeg,
    sector.thermalInertia,
    sector.commsLos,
    sector.gridSize,
    sector.worldSizeMeters,
    sector.site.habCol,
    sector.site.habRow,
    loop.pathIndices
  );

  rows.push({
    site: sector.site.name,
    diskKB: `${sector.diskKB} KB`,
    ramKB: `${sector.memoryKB} KB`,
    smartSlope: `${smart.maxSlopeDeg}°`,
    naiveSlope: `${naive.maxSlopeDeg}°`,
    smartSand: `${smart.sandTrapMeters} m`,
    naiveSand: `${naive.sandTrapMeters} m`,
    maxCep: `±${smart.maxCepMeters} m`,
    minIce: `-${loop.minIceDepthMeters} m`,
    aStarMs: `${smart.computeTimeMs} ms`,
    loopOrder: loop.waypointOrderLabel,
    loopDist: `${(loop.distanceMeters / 1000).toFixed(2)} km`,
    loopO2: `${loop.estimatedO2Liters} L`,
    walkbackPct: `${walkback.reachablePercent}%`,
    relayGain: `${relay.beforeCoveragePct}% → ${relay.afterCoveragePct}%`,
  });
}

console.table(rows);

let md = `# Quantitative Engineering & Physics Benchmark Report\n\n`;
md += `| Landing Site | Binary Pack | Active RAM | WP-1 Slope (Smart vs Naive) | WP-1 Sand (Smart vs Naive) | GPS-Denied Max CEP | SHARAD Min Ice Depth | A* Time | Full Science Loop Order | Loop Dist | Loop O₂ | Safe Walkback Area | 2-Hop UHF Relay Gain |\n`;
md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
for (const r of rows) {
  md += `| **${r.site}** | ${r.diskKB} | ${r.ramKB} | **${r.smartSlope}** vs ${r.naiveSlope} | **${r.smartSand}** vs ${r.naiveSand} | ${r.maxCep} | ${r.minIce} | ${r.aStarMs} | \`${r.loopOrder}\` | ${r.loopDist} | ${r.loopO2} | ${r.walkbackPct} | ${r.relayGain} |\n`;
}
fs.writeFileSync('BENCHMARKS.md', md);
console.log('\nSaved formatted benchmark table to BENCHMARKS.md');
