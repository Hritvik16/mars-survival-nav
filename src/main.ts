import {
  createSyntheticSector,
  GEOLOGIC_UNIT_LABELS,
  MARS_SITES,
  type LayerMode,
  type SiteId,
} from './core/sectorData';
import { AnisotropicPathfinder } from './core/pathfinder';
import { recomputeSolarShadow } from './core/solarAndComms';
import { Scene3DHarness } from './viewer/scene3D';

document.body.style.margin = '0';

// 1. Initialize pure TypeScript sector buffers & pre-allocated A* router (src/core)
let sector = createSyntheticSector(128, 100, 'mount_sharp');
const pathfinder = new AnisotropicPathfinder(128 * 128);
let lastClickedCol = sector.site.habCol;
let lastClickedRow = sector.site.habRow;

// 2. Initialize Three.js 3D Harness (src/viewer)
const appEl = document.querySelector<HTMLDivElement>('#app')!;
const viewer = new Scene3DHarness(appEl, sector);

// 3. Top Control Bar + Bottom Telemetry Bar
const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:12px;left:12px;right:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-family:monospace;font-size:12px;background:rgba(13,9,7,0.88);padding:8px 12px;border:1px solid #ff9d5c;color:#ff9d5c;';

// Landing site selector
const siteSelect = document.createElement('select');
siteSelect.style.cssText =
  'padding:6px 8px;background:#1e1e1e;color:#00f0ff;border:1px solid #00f0ff;font-family:monospace;cursor:pointer;';
(Object.keys(MARS_SITES) as SiteId[]).forEach((id) => {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = MARS_SITES[id].name;
  siteSelect.appendChild(opt);
});
siteSelect.onchange = () => {
  sector = createSyntheticSector(128, 100, siteSelect.value as SiteId);
  lastClickedCol = sector.site.habCol;
  lastClickedRow = sector.site.habRow;
  viewer.setSector(sector);
  telemetry.textContent = `Loaded ${sector.site.name} [${sector.site.coordsLabel}] | Click terrain to plot EVA route from Cyan Hab`;
};
hud.appendChild(siteSelect);

// Layer switcher buttons
(['mars', 'slope', 'sand', 'roughness', 'radiation', 'solar', 'comms'] as const).forEach((mode: LayerMode) => {
  const btn = document.createElement('button');
  btn.textContent = `Layer: ${mode.toUpperCase()}`;
  btn.style.cssText =
    'padding:6px 10px;background:#1e1e1e;color:#ff9d5c;border:1px solid #ff9d5c;font-family:monospace;cursor:pointer;';
  btn.onclick = () => viewer.applyHeatmap(mode);
  hud.appendChild(btn);
});

// Emergency Solar Storm Safe-Haven button
const flareBtn = document.createElement('button');
flareBtn.textContent = '⚡ SOLAR FLARE SAFE HAVEN';
flareBtn.style.cssText =
  'padding:6px 10px;background:#3a1010;color:#00ff88;border:1px solid #00ff88;font-family:monospace;font-weight:bold;cursor:pointer;';
flareBtn.onclick = () => {
  viewer.applyHeatmap('radiation');
  const route = pathfinder.findNearestSafeHaven(sector, lastClickedCol, lastClickedRow, 0.58);
  if (route.found) {
    viewer.renderRoute(route.pathIndices, true);
    const goalIdx = route.pathIndices[route.pathIndices.length - 1];
    const svf = (sector.skyViewFactor[goalIdx] * 100).toFixed(0);
    telemetry.textContent = `⚡ SPE SHELTER FOUND in ${route.computeTimeMs}ms | Sprint Dist: ${route.distanceMeters}m | Alcove Sky-View: ${svf}% (Blocks ${100 - Number(svf)}% radiation) | O2: ${route.estimatedO2Liters}L`;
  } else {
    telemetry.textContent = `⚠️ No nearby canyon alcove (<58% Sky-View) reachable from (${lastClickedCol},${lastClickedRow})`;
  }
};
hud.appendChild(flareBtn);

const solLabel = document.createElement('label');
solLabel.textContent = 'Sol Hr: 14.0 ';
const solSlider = document.createElement('input');
solSlider.type = 'range';
solSlider.min = '6';
solSlider.max = '18';
solSlider.step = '0.2';
solSlider.value = '14';
solSlider.oninput = () => {
  const hr = parseFloat(solSlider.value);
  solLabel.firstChild!.textContent = `Sol Hr: ${hr.toFixed(1)} `;
  viewer.setSolHour(hr);
  recomputeSolarShadow(sector.elevation, sector.solarShadow, sector.gridSize, sector.worldSizeMeters, hr);
  if (viewer.getCurrentMode() === 'solar') {
    viewer.applyHeatmap('solar');
  }
  if (lastClickedCol !== sector.site.habCol || lastClickedRow !== sector.site.habRow) {
    const route = pathfinder.findRoute(sector, sector.site.habCol, sector.site.habRow, lastClickedCol, lastClickedRow);
    if (route.found) {
      viewer.renderRoute(route.pathIndices, false);
      telemetry.textContent = `[Sol Hr ${hr.toFixed(1)}] Dynamic A* Route to (${lastClickedCol},${lastClickedRow}): ${route.distanceMeters}m, +${route.netElevationGainM}m climb, Sunlit:${route.sunlitPercent}%, CommsLOS:${route.commsCoveragePercent}%, O2:${route.estimatedO2Liters}L (${route.computeTimeMs}ms, ${sector.memoryKB}KB RAM)`;
    }
  }
};
solLabel.appendChild(solSlider);
hud.appendChild(solLabel);
document.body.appendChild(hud);

// Bottom Telemetry Readout Bar
const telemetry = document.createElement('div');
telemetry.style.cssText =
  'position:fixed;bottom:12px;left:12px;right:12px;font-family:monospace;font-size:12px;background:rgba(13,9,7,0.9);padding:8px 12px;border:1px solid #00f0ff;color:#00f0ff;';
telemetry.textContent = `${sector.site.name} [${sector.site.coordsLabel}] | Click any terrain cell to compute Anisotropic A* EVA Route from Cyan Hab`;
document.body.appendChild(telemetry);

// 4. 3D Raycast -> Cell Inspection + Live Anisotropic A* Route Calculation
viewer.onTerrainClick((col, row) => {
  lastClickedCol = col;
  lastClickedRow = row;
  const idx = row * sector.gridSize + col;
  const elev = sector.elevation[idx].toFixed(1);
  const slope = sector.slopeDeg[idx].toFixed(1);
  const tiu = sector.thermalInertia[idx].toFixed(0);
  const svf = (sector.skyViewFactor[idx] * 100).toFixed(0);
  const unit = GEOLOGIC_UNIT_LABELS[sector.geologicUnit[idx]];

  const route = pathfinder.findRoute(sector, sector.site.habCol, sector.site.habRow, col, row);
  if (route.found) {
    viewer.renderRoute(route.pathIndices, false);
    telemetry.textContent = `Target (${col},${row}) [${unit}] Elev:${elev}m Slope:${slope}° TIU:${tiu} SkyView:${svf}% | A* Route: ${route.distanceMeters}m, +${route.netElevationGainM}m climb, MaxSlope:${route.maxSlopeDeg}°, O2:${route.estimatedO2Liters}L (${route.computeTimeMs}ms, ${sector.memoryKB}KB RAM)`;
  } else {
    viewer.clearRoute();
    telemetry.textContent = `⚠️ Target (${col},${row}) IMPASSABLE (Slope:${slope}° exceeds 32° EVA safety limit or isolated by cliff walls)`;
  }
});

viewer.startRenderLoop();