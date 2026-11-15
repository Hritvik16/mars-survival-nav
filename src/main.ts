import {
  createSyntheticSector,
  GEOLOGIC_UNIT_LABELS,
  MARS_SITES,
  type LayerMode,
  type SiteId,
} from './core/sectorData';
import { AnisotropicPathfinder } from './core/pathfinder';
import { loadSectorFromBinary } from './core/sectorGrid';
import { deployOptimalCommsRelay, recomputeSolarShadow } from './core/solarAndComms';
import { Scene3DHarness } from './viewer/scene3D';
import { WristHudPanel } from './viewer/wristHud';

document.body.style.margin = '0';

let sector = createSyntheticSector(128, 2048, 'mount_sharp');
const pathfinder = new AnisotropicPathfinder(128 * 128);
let lastClickedCol = sector.site.habCol;
let lastClickedRow = sector.site.habRow;
let activeLoopMode = false;
let lastReachablePct = 78;

const appEl = document.querySelector<HTMLDivElement>('#app')!;
const viewer = new Scene3DHarness(appEl, sector);

const wristHud = new WristHudPanel(
  (wpCol, wpRow) => {
    activeLoopMode = false;
    lastClickedCol = wpCol;
    lastClickedRow = wpRow;
    updateRouteAndHud(wpCol, wpRow);
  },
  (payloadKg) => {
    const env = pathfinder.computeWalkbackEnvelope(sector, payloadKg);
    lastReachablePct = env.reachablePercent;
    if (viewer.getCurrentMode() === 'walkback') {
      viewer.applyHeatmap('walkback');
    }
    if (activeLoopMode) {
      runFullScienceLoop();
    } else if (lastClickedCol !== sector.site.habCol || lastClickedRow !== sector.site.habRow) {
      updateRouteAndHud(lastClickedCol, lastClickedRow);
    } else {
      wristHud.updateIdle(sector, lastReachablePct);
    }
  },
  () => {
    runFullScienceLoop();
  }
);

viewer.onVisorTelemetry((sample) => {
  wristHud.updateVisorOverlay(sample);
});

const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:12px;left:12px;right:12px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-family:monospace;font-size:11px;background:rgba(13,9,7,0.9);padding:6px 10px;border:1px solid #ff9d5c;color:#ff9d5c;';

const siteSelect = document.createElement('select');
siteSelect.style.cssText =
  'padding:4px 6px;background:#1e1e1e;color:#00f0ff;border:1px solid #00f0ff;font-family:monospace;font-size:11px;cursor:pointer;';
(Object.keys(MARS_SITES) as SiteId[]).forEach((id) => {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = MARS_SITES[id].name;
  siteSelect.appendChild(opt);
});

async function activateSite(siteId: SiteId): Promise<void> {
  const hr = parseFloat(solSlider.value || '14');
  try {
    sector = await loadSectorFromBinary(siteId, hr);
  } catch {
    sector = createSyntheticSector(128, 2048, siteId);
  }
  activeLoopMode = false;
  lastClickedCol = sector.site.habCol;
  lastClickedRow = sector.site.habRow;
  const env = pathfinder.computeWalkbackEnvelope(sector, wristHud.getPayloadMassKg());
  lastReachablePct = env.reachablePercent;
  viewer.setSector(sector);
  syncPovButtonLabel();
  wristHud.updateIdle(sector, lastReachablePct);
  telemetry.textContent = `Loaded /data/${siteId}/manifest.json (${sector.memoryKB}KB) | Click = Route | Shift+Click = Drop In-Situ Hazard Block`;
}

siteSelect.onchange = () => {
  void activateSite(siteSelect.value as SiteId);
};
hud.appendChild(siteSelect);

(
  [
    'mars',
    'slope',
    'sand',
    'roughness',
    'radiation',
    'solar',
    'comms',
    'walkback',
    'discovery',
  ] as const
).forEach((mode: LayerMode) => {
  const btn = document.createElement('button');
  btn.textContent =
    mode === 'walkback' ? '◎ WALKBACK' : mode === 'discovery' ? '✨ DISCOVERY' : mode.toUpperCase();
  btn.style.cssText =
    mode === 'walkback' || mode === 'discovery'
      ? 'padding:4px 6px;background:#0d2622;color:#00ff88;border:1px solid #00ff88;font-family:monospace;font-weight:bold;cursor:pointer;'
      : 'padding:4px 6px;background:#1e1e1e;color:#ff9d5c;border:1px solid #ff9d5c;font-family:monospace;cursor:pointer;';
  btn.onclick = () => {
    viewer.applyHeatmap(mode);
    if (mode === 'walkback') {
      telemetry.textContent = `◎ WALKBACK ISOCHRONE FIELD | White Ring = 95L Point-of-No-Return (${lastReachablePct}% of sector safely reachable with ${wristHud.getPayloadMassKg()}kg pack)`;
    } else if (mode === 'discovery') {
      telemetry.textContent = `✨ SHANNON-ENTROPY GEOLOGICAL CONTACT MAP | Bright Emerald/Gold = High-Entropy Unconformity Outcrops where multiple rock strata meet`;
    }
  };
  hud.appendChild(btn);
});

// 3D Volumetric Subsurface Stratigraphic & SHARAD Radargram Curtain Toggle
const strataBtn = document.createElement('button');
strataBtn.textContent = '🪨 3D STRATA';
strataBtn.title = 'Toggle translucent 3D Subsurface Stratigraphic & SHARAD Water-Ice Radar Curtain under active route';
strataBtn.style.cssText =
  'padding:4px 6px;background:#1a1429;color:#00f0ff;border:1px solid #00f0ff;font-family:monospace;font-weight:bold;cursor:pointer;';
strataBtn.onclick = () => {
  if (!viewer.hasActiveRoute()) {
    runFullScienceLoop();
  }
  const active = viewer.toggleStrataCurtain();
  strataBtn.style.background = active ? '#004455' : '#1a1429';
  telemetry.textContent = active
    ? `🪨 3D SUBSURFACE STRATIGRAPHIC & SHARAD RADAR CURTAIN ACTIVE | Cyan Band = Subsurface Water-Ice Lens, Ochre = Hesperian Sulfate, Emerald = Noachian Clay`
    : `🪨 Returned to opaque surface topography`;
};
hud.appendChild(strataBtn);

const relayBtn = document.createElement('button');
relayBtn.textContent = '📡 RELAY';
relayBtn.title = 'Solve optimal 2-hop UHF Comms Relay ridge placement to eliminate canyon blackouts';
relayBtn.style.cssText =
  'padding:4px 6px;background:#2b2108;color:#ffcc00;border:1px solid #ffcc00;font-family:monospace;font-weight:bold;cursor:pointer;';
relayBtn.onclick = () => {
  const res = deployOptimalCommsRelay(
    sector.elevation,
    sector.slopeDeg,
    sector.thermalInertia,
    sector.commsLos,
    sector.gridSize,
    sector.worldSizeMeters,
    sector.site.habCol,
    sector.site.habRow,
    viewer.getActivePathIndices()
  );
  viewer.renderRelayBeacon(res.relayCol, res.relayRow);
  viewer.applyHeatmap('comms');
  if (activeLoopMode) {
    runFullScienceLoop();
  } else if (lastClickedCol !== sector.site.habCol || lastClickedRow !== sector.site.habRow) {
    updateRouteAndHud(lastClickedCol, lastClickedRow);
  }
  telemetry.textContent = `📡 2-HOP UHF RELAY DEPLOYED at Ridge (${res.relayCol},${res.relayRow}) in ${res.computeTimeMs}ms | Sector UHF Coverage boosted: ${res.beforeCoveragePct}% → ${res.afterCoveragePct}%`;
};
hud.appendChild(relayBtn);

const flareBtn = document.createElement('button');
flareBtn.textContent = '⚡ SHELTER';
flareBtn.style.cssText =
  'padding:4px 6px;background:#3a1010;color:#00ff88;border:1px solid #00ff88;font-family:monospace;font-weight:bold;cursor:pointer;';
flareBtn.onclick = () => {
  activeLoopMode = false;
  viewer.applyHeatmap('radiation');
  const payloadKg = wristHud.getPayloadMassKg();
  const hr = parseFloat(solSlider.value || '14');
  const route = pathfinder.findNearestSafeHaven(
    sector,
    lastClickedCol,
    lastClickedRow,
    0.58,
    payloadKg,
    hr
  );
  if (route.found) {
    viewer.renderRoute(route.pathIndices, true, undefined, route.pathCepMeters);
    const goalIdx = route.pathIndices[route.pathIndices.length - 1];
    const svf = (sector.skyViewFactor[goalIdx] * 100).toFixed(0);
    telemetry.textContent = `⚡ SPE SHELTER FOUND in ${route.computeTimeMs}ms | Dist: ${route.distanceMeters}m | Sky-View: ${svf}% | O2: ${route.estimatedO2Liters}L`;
  }
};
hud.appendChild(flareBtn);

const povBtn = document.createElement('button');
povBtn.textContent = '🧑‍🚀 VISOR POV';
povBtn.style.cssText =
  'padding:4px 7px;background:#0e2229;color:#00f0ff;border:1px solid #00f0ff;font-family:monospace;font-weight:bold;cursor:pointer;';

const walkSlider = document.createElement('input');
walkSlider.type = 'range';
walkSlider.min = '0';
walkSlider.max = '100';
walkSlider.step = '0.5';
walkSlider.value = '0';
walkSlider.style.width = '54px';
walkSlider.title = 'Scrub astronaut position along active EVA route';

function syncPovButtonLabel(): void {
  povBtn.textContent = viewer.isPovMode() ? '🛰️ ORBITAL' : '🧑‍🚀 VISOR POV';
  povBtn.style.background = viewer.isPovMode() ? '#291d0e' : '#0e2229';
}

povBtn.onclick = () => {
  if (!viewer.hasActiveRoute()) {
    const wp = sector.site.waypoints[0];
    lastClickedCol = wp.col;
    lastClickedRow = wp.row;
    updateRouteAndHud(wp.col, wp.row);
  }
  const nextMode = !viewer.isPovMode();
  viewer.setPovMode(nextMode);
  syncPovButtonLabel();
};

walkSlider.oninput = () => {
  viewer.setAutoWalk(false);
  const p01 = parseFloat(walkSlider.value) / 100;
  viewer.setRouteProgress(p01, true);
  wristHud.setElevationProgress(p01);
};

hud.appendChild(povBtn);
hud.appendChild(walkSlider);

const solLabel = document.createElement('label');
solLabel.textContent = 'Sol:14.0 ';
const solSlider = document.createElement('input');
solSlider.type = 'range';
solSlider.min = '6';
solSlider.max = '18';
solSlider.step = '0.2';
solSlider.value = '14';
solSlider.style.width = '52px';

function runFullScienceLoop(): void {
  activeLoopMode = true;
  const hr = parseFloat(solSlider.value || '14');
  const payloadKg = wristHud.getPayloadMassKg();
  const loopRoute = pathfinder.findScienceLoop(sector, payloadKg, hr);
  const firstWp = sector.site.waypoints[0];
  const hotspot = pathfinder.findRouteDiscoveryHotspot(sector, loopRoute.pathIndices);
  wristHud.updateRouteComparison(sector, firstWp.col, firstWp.row, loopRoute, loopRoute, hotspot);

  if (loopRoute.found) {
    viewer.renderRoute(loopRoute.pathIndices, false, undefined, loopRoute.pathCepMeters);
    if (hotspot.found) viewer.renderDiscoveryHotspot(hotspot.col, hotspot.row);
    telemetry.textContent = `🔗 4D SCIENCE LOOP [${loopRoute.waypointOrderLabel}] | Dist: ${(loopRoute.distanceMeters / 1000).toFixed(2)}km | Max CEP: ±${loopRoute.maxCepMeters}m | Min SHARAD Ice: -${loopRoute.minIceDepthMeters}m`;
  } else {
    viewer.clearRoute();
    telemetry.textContent = `⚠️ Science Loop blocked: payload mass (${payloadKg}kg) or In-Situ Hazard blocks safe passage`;
  }
}

function updateRouteAndHud(col: number, row: number): void {
  const hr = parseFloat(solSlider.value || '14');
  const payloadKg = wristHud.getPayloadMassKg();
  const idx = row * sector.gridSize + col;
  const elev = sector.elevation[idx].toFixed(1);
  const slope = sector.slopeDeg[idx].toFixed(1);
  const unit = GEOLOGIC_UNIT_LABELS[sector.geologicUnit[idx]];

  const route = wristHud.isRoverAssistEnabled()
    ? pathfinder.findRoverAssistedRoute(
        sector,
        sector.site.habCol,
        sector.site.habRow,
        col,
        row,
        payloadKg,
        hr
      )
    : pathfinder.findRoute(
        sector,
        sector.site.habCol,
        sector.site.habRow,
        col,
        row,
        payloadKg,
        hr
      );
  const naive = pathfinder.evaluateDirectPath(
    sector,
    sector.site.habCol,
    sector.site.habRow,
    col,
    row,
    payloadKg,
    hr
  );
  const hotspot = pathfinder.findRouteDiscoveryHotspot(sector, route.pathIndices);
  wristHud.updateRouteComparison(sector, col, row, route, naive, hotspot);
  wristHud.setElevationProgress(viewer.getRouteProgress());

  if (route.found) {
    viewer.renderRoute(route.pathIndices, false, naive.pathIndices, route.pathCepMeters, route.roverPathIndices);
    if (hotspot.found) viewer.renderDiscoveryHotspot(hotspot.col, hotspot.row);
    telemetry.textContent = `[Dep Sol ${hr.toFixed(1)} → Arr ${route.arrivalSolHour.toFixed(1)}] Target (${col},${row}) [${unit}] Elev:${elev}m Slope:${slope}° | Max CEP: ±${route.maxCepMeters}m | Ice: -${route.minIceDepthMeters}m`;
  } else {
    viewer.renderRoute(new Int32Array(0), false, naive.pathIndices);
    telemetry.textContent = `⚠️ Target (${col},${row}) IMPASSABLE with ${payloadKg}kg loadout or In-Situ Hazard Block`;
  }
}

solSlider.oninput = () => {
  const hr = parseFloat(solSlider.value);
  solLabel.firstChild!.textContent = `Sol:${hr.toFixed(1)} `;
  viewer.setSolHour(hr);
  recomputeSolarShadow(
    sector.elevation,
    sector.solarShadow,
    sector.gridSize,
    sector.worldSizeMeters,
    hr
  );
  const env = pathfinder.computeWalkbackEnvelope(sector, wristHud.getPayloadMassKg());
  lastReachablePct = env.reachablePercent;
  viewer.applyHeatmap(viewer.getCurrentMode());

  if (activeLoopMode) {
    runFullScienceLoop();
  } else if (lastClickedCol !== sector.site.habCol || lastClickedRow !== sector.site.habRow) {
    updateRouteAndHud(lastClickedCol, lastClickedRow);
  } else {
    wristHud.updateIdle(sector, lastReachablePct);
  }
};
solLabel.appendChild(solSlider);
hud.appendChild(solLabel);
document.body.appendChild(hud);

const telemetry = document.createElement('div');
telemetry.style.cssText =
  'position:fixed;bottom:12px;left:12px;right:12px;font-family:monospace;font-size:12px;background:rgba(13,9,7,0.9);padding:8px 12px;border:1px solid #00f0ff;color:#00f0ff;';
telemetry.textContent = `${sector.site.name} | Click = Plot 4D Route | Shift+Click = Drop/Clear In-Situ Hazard Block`;
document.body.appendChild(telemetry);

viewer.onTerrainClick((col, row, shiftKey) => {
  if (shiftKey) {
    const added = pathfinder.toggleInSituHazard(sector, col, row);
    viewer.syncInSituHazards();
    const env = pathfinder.computeWalkbackEnvelope(sector, wristHud.getPayloadMassKg());
    lastReachablePct = env.reachablePercent;
    if (viewer.getCurrentMode() === 'walkback') {
      viewer.applyHeatmap('walkback');
    }
    if (activeLoopMode) {
      runFullScienceLoop();
    } else if (lastClickedCol !== sector.site.habCol || lastClickedRow !== sector.site.habRow) {
      updateRouteAndHud(lastClickedCol, lastClickedRow);
    }
    telemetry.textContent = added
      ? `⚠️ IN-SITU SUB-PIXEL HAZARD BLOCKED at (${col},${row}) — Dynamically re-solved 4D EVA route around obstacle!`
      : `✅ Cleared In-Situ Hazard at (${col},${row}) — Re-computed optimal route`;
    return;
  }

  activeLoopMode = false;
  lastClickedCol = col;
  lastClickedRow = row;
  updateRouteAndHud(col, row);
});

void activateSite('mount_sharp');
viewer.startRenderLoop((pct) => {
  walkSlider.value = String(pct);
  wristHud.setElevationProgress(pct / 100);
});
