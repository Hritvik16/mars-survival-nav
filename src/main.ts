import { createSyntheticSector, type LayerMode } from './core/sectorData';
import { Scene3DHarness } from './viewer/scene3D';

document.body.style.margin = '0';

// 1. Initialize pure TypeScript sector buffers (src/core)
const sector = createSyntheticSector(128, 100);

// 2. Initialize Three.js 3D Harness (src/viewer)
const appEl = document.querySelector<HTMLDivElement>('#app')!;
const viewer = new Scene3DHarness(appEl, sector);

// 3. Minimal HUD for Layer Switching, Sol Sun Angle & Click Telemetry
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:12px;left:12px;display:flex;gap:8px;align-items:center;font-family:monospace;background:rgba(13,9,7,0.85);padding:8px 12px;border:1px solid #ff9d5c;color:#ff9d5c;';

(['mars', 'slope', 'sand'] as const).forEach((mode: LayerMode) => {
  const btn = document.createElement('button');
  btn.textContent = `Layer: ${mode.toUpperCase()}`;
  btn.style.cssText = 'padding:6px 10px;background:#1e1e1e;color:#ff9d5c;border:1px solid #ff9d5c;cursor:pointer;';
  btn.onclick = () => viewer.applyHeatmap(mode);
  hud.appendChild(btn);
});

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
};
solLabel.appendChild(solSlider);
hud.appendChild(solLabel);

const telemetry = document.createElement('span');
telemetry.textContent = '| Click terrain to inspect cell';
hud.appendChild(telemetry);
document.body.appendChild(hud);

// 4. Test 3D Raycast -> Grid Cell Lookup
viewer.onTerrainClick((col, row) => {
  const idx = row * sector.gridSize + col;
  const elev = sector.elevation[idx].toFixed(1);
  const slope = sector.slopeDeg[idx].toFixed(1);
  const tiu = sector.thermalInertia[idx].toFixed(0);
  telemetry.textContent = `| Cell (${col}, ${row}) Elev: ${elev}m Slope: ${slope}° TIU: ${tiu}`;
});

viewer.startRenderLoop();