// src/viewer/wristHud.ts
/**
 * @file wristHud.ts
 * @module viewer/wristHud
 *
 * DOM/HTML "wrist co-processor" panel and the helmet-visor overlay. It formats RouteResult numbers,
 * draws the three PLSS gauges, the elevation / ice profile SVG, the loadout selector, the NASA
 * imagery cards and the citation links. It performs NO route physics; the only arithmetic here is
 * presentation scaling documented per method.
 */
import { GEOLOGIC_UNIT_LABELS, type SectorBuffers } from '../core/sectorData';
import {
  EVA_INSTRUMENTS,
  PLSS_MAX_BATTERY_WH,
  PLSS_MAX_COOLING_WATER_L,
  PLSS_MAX_O2_LITERS,
  SINGLE_SORTIE_WALKBACK_LIMIT_O2,
  type DiscoveryHotspot,
  type RouteResult,
} from '../core/pathfinder';
import type { VisorTelemetrySample } from './scene3D';

/**
 * Per-geologic-class boot-surface card. Index in UNIT_SURFACE_POV = geologic class id 0..3.
 * piaId is the catalogue id SHOWN in the HUD text; imgUrl is the file actually loaded.
 */
interface SurfacePovInfo {
  readonly piaId: string;
  readonly missionCam: string;
  readonly imgUrl: string;
  readonly surfaceHazardNote: string;
  readonly recommendedInstrumentIds: readonly string[];
}

/**
 * Class 0 -> PIA20168 (Curiosity, Bagnold Dunes), 1 -> PIA19912 (Curiosity, sulfate strata),
 * 2 -> displayed id "PIA19307" but file /images/PIA19077.jpg, 3 -> displayed id "PIA10907" but file
 * /images/PIA10940.jpg (Phoenix workplace map per the JPEG metadata). The two labelled ids do not
 * match the shipped file names; the hazard notes and instrument recommendations are authored text.
 */
const UNIT_SURFACE_POV: readonly SurfacePovInfo[] = [
  {
    piaId: 'PIA20168',
    missionCam: 'MSL Curiosity Mastcam — Bagnold Dunes Eolian Sand Ripples',
    imgUrl: '/images/PIA20168.jpg',
    surfaceHazardNote:
      'Unconsolidated fine basaltic drift (<100 TIU). High boot sinkage & rover wheel slip risk.',
    recommendedInstrumentIds: ['hammer_scoop', 'gpr_wand'],
  },
  {
    piaId: 'PIA19912',
    missionCam: 'MSL Curiosity Mastcam — Cross-Bedded Sulfate Sandstone Strata',
    imgUrl: '/images/PIA19912.jpg',
    surfaceHazardNote:
      'Firm cross-bedded sulfate sandstone (240–300 TIU). Ancient water-deposited sedimentary benches.',
    recommendedInstrumentIds: ['core_drill', 'sherloc_pixl'],
  },
  {
    piaId: 'PIA19307',
    missionCam: 'MSL Curiosity Mastcam — "Garden City" Cemented Boxwork Veins',
    imgUrl: '/images/PIA19077.jpg',
    surfaceHazardNote:
      'High-traction bedrock & intersecting mineral fracture ridges (>340 TIU) from ancient groundwater.',
    recommendedInstrumentIds: ['sherloc_pixl', 'hammer_scoop', 'seis_pack'],
  },
  {
    piaId: 'PIA10907',
    missionCam: 'NASA Phoenix Lander SSI — Subsurface Water-Ice Table in Trench',
    imgUrl: '/images/PIA10940.jpg',
    surfaceHazardNote:
      'Shallow >80% pure water-ice table (<1.5m depth) beneath thin sublimation lag.',
    recommendedInstrumentIds: ['cryo_auger', 'gpr_wand'],
  },
];

/**
 * The right-hand HUD panel plus visor overlay and the full-screen image lightbox.
 * Callbacks: onSelectWaypoint(col,row) route to a waypoint / hotspot; onLoadoutChange(payloadKg)
 * called when an instrument or the rover-assist box is toggled; onRunScienceLoop() runs the full loop.
 */
export class WristHudPanel {
  private readonly panel: HTMLDivElement;
  private readonly visorOverlay: HTMLDivElement;
  private readonly lightboxModal: HTMLDivElement;
  private readonly selectedInstrumentIds = new Set<string>(
    EVA_INSTRUMENTS.filter((i) => i.defaultSelected).map((i) => i.id)
  );
  private openDrawers = new Set<string>(['pov']);
  private roverAssistEnabled = false;

  public isRoverAssistEnabled(): boolean {
    return this.roverAssistEnabled;
  }
  private svgCoords: { x: number; y: number }[] = [];

  private onSelectWaypoint?: (col: number, row: number) => void;
  private onLoadoutChange?: (payloadMassKg: number) => void;
  private onRunScienceLoop?: () => void;

  constructor(
    onSelectWaypoint?: (col: number, row: number) => void,
    onLoadoutChange?: (payloadMassKg: number) => void,
    onRunScienceLoop?: () => void
  ) {
    this.onSelectWaypoint = onSelectWaypoint;
    this.onLoadoutChange = onLoadoutChange;
    this.onRunScienceLoop = onRunScienceLoop;

    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'position:fixed;top:92px;right:12px;width:350px;max-height:calc(100vh - 148px);overflow-y:auto;font-family:monospace;font-size:11px;background:rgba(13,9,7,0.92);border:1px solid #ff9d5c;color:#ffdfc2;padding:10px 12px;box-sizing:border-box;pointer-events:auto;';
    document.body.appendChild(this.panel);

    this.visorOverlay = document.createElement('div');
    this.visorOverlay.style.cssText =
      'position:fixed;top:84px;left:16px;right:375px;bottom:52px;border:2px solid rgba(0,240,255,0.45);border-radius:28px;box-shadow:inset 0 0 40px rgba(0,240,255,0.15);pointer-events:none;display:none;font-family:monospace;color:#00f0ff;padding:16px 22px;box-sizing:border-box;';
    document.body.appendChild(this.visorOverlay);

    this.lightboxModal = document.createElement('div');
    this.lightboxModal.style.cssText =
      'position:fixed;inset:0;background:rgba(5,3,2,0.88);z-index:9999;display:none;align-items:center;justify-content:center;font-family:monospace;padding:24px;box-sizing:border-box;cursor:zoom-out;';
    this.lightboxModal.onclick = () => {
      this.lightboxModal.style.display = 'none';
    };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.lightboxModal.style.display = 'none';
    });
    document.body.appendChild(this.lightboxModal);
  }

  private openLightbox(imgUrl: string, title: string, subtitle: string): void {
    this.lightboxModal.innerHTML = `
      <div style="max-width:760px;width:100%;background:#120c08;border:2px solid #00f0ff;padding:14px;box-shadow:0 12px 48px rgba(0,0,0,0.85);cursor:default;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #ff9d5c44;padding-bottom:8px;margin-bottom:10px;">
          <span style="color:#00f0ff;font-size:13px;font-weight:bold;">🔍 ${title}</span>
          <button id="close-lightbox-btn" style="background:#3a1010;color:#ff9d5c;border:1px solid #ff9d5c;font-family:monospace;padding:3px 8px;cursor:pointer;">✕ ESC</button>
        </div>
        <img src="${imgUrl}" alt="${title}" style="width:100%;max-height:68vh;object-fit:contain;background:#080504;border:1px solid #ff9d5c44;display:block;margin-bottom:10px;" />
        <div style="color:#ffdfc2;font-size:12px;line-height:1.45;">
          ${subtitle}
        </div>
      </div>
    `;
    this.lightboxModal.style.display = 'flex';
    const closeBtn = this.lightboxModal.querySelector<HTMLButtonElement>('#close-lightbox-btn');
    if (closeBtn) {
      closeBtn.onclick = () => {
        this.lightboxModal.style.display = 'none';
      };
    }
  }

  /**
   * Sum of the selected instruments' massKg, rounded to 0.1 kg (default selection = 15.5 kg).
   */
  public getPayloadMassKg(): number {
    let sum = 0;
    for (const inst of EVA_INSTRUMENTS) {
      if (this.selectedInstrumentIds.has(inst.id)) sum += inst.massKg;
    }
    return Math.round(sum * 10) / 10;
  }

  /**
   * Moves the cursor line and dot on the elevation SVG to path fraction progress01 (0..1) using the
   * precomputed svgCoords (one point per route node).
   */
  public setElevationProgress(progress01: number): void {
    if (this.svgCoords.length === 0) return;
    const dot = this.panel.querySelector<SVGCircleElement>('#svg-elev-dot');
    const line = this.panel.querySelector<SVGLineElement>('#svg-elev-cursor');
    if (!dot || !line) return;

    const idx = Math.min(
      this.svgCoords.length - 1,
      Math.max(0, Math.floor(progress01 * (this.svgCoords.length - 1)))
    );
    const pt = this.svgCoords[idx];
    dot.setAttribute('cx', pt.x.toFixed(1));
    dot.setAttribute('cy', pt.y.toFixed(1));
    line.setAttribute('x1', pt.x.toFixed(1));
    line.setAttribute('x2', pt.x.toFixed(1));
  }

  /**
   * Renders the first-person visor HUD from one VisorTelemetrySample (null hides it): heading, nav
   * mode + CEP, progress and SHARAD ice depth, boot pitch and absolute elevation (slope > 20 deg shows
   * amber), the unit boot-surface photo, sunlit / shadow, UHF-locked / optical-nav, and
   * RAD SHIELD = 100 - skyViewPct %.
   */
  public updateVisorOverlay(sample: VisorTelemetrySample | null): void {
    if (!sample) {
      this.visorOverlay.style.display = 'none';
      return;
    }
    this.setElevationProgress(sample.progressPct / 100);
    this.visorOverlay.style.display = 'flex';
    this.visorOverlay.style.flexDirection = 'column';
    this.visorOverlay.style.justifyContent = 'space-between';

    const slopeWarn = sample.slopeDeg > 20;
    const unitPov = UNIT_SURFACE_POV[sample.geologicUnitId] ?? UNIT_SURFACE_POV[1];
    const unitName = GEOLOGIC_UNIT_LABELS[sample.geologicUnitId] ?? GEOLOGIC_UNIT_LABELS[1];

    this.visorOverlay.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;background:rgba(8,16,20,0.75);padding:8px 14px;border:1px solid #00f0ff66;border-radius:10px;">
        <div>
          <div style="font-size:10px;color:#ff9d5c;">xEMU HELMET VISOR // GPS-DENIED NAV</div>
          <div style="font-size:15px;font-weight:bold;color:#00ff88;">
            HDG ${String(sample.headingDeg).padStart(3, '0')}° ${sample.headingCardinal}
          </div>
          <div style="font-size:10px;color:#ffd700;">🎯 ${sample.navModeLabel}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:10px;color:#ff9d5c;">PROGRESS / SHARAD ICE</div>
          <div style="font-size:15px;font-weight:bold;color:#00f0ff;">${sample.progressPct}% | -${sample.iceDepthMeters}m</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:10px;color:#ff9d5c;">BOOT PITCH / ELEV</div>
          <div style="font-size:15px;font-weight:bold;color:${slopeWarn ? '#ffaa00' : '#00f0ff'};">
            ${sample.slopeDeg.toFixed(1)}° | ${sample.elevMeters}m
          </div>
        </div>
      </div>

      <div style="align-self:center;width:44px;height:44px;border:1px dashed rgba(0,240,255,0.5);border-radius:50%;display:flex;align-items:center;justify-content:center;color:rgba(0,240,255,0.6);font-size:10px;">
        +
      </div>

      <div>
        <div style="display:flex;gap:10px;align-items:center;max-width:400px;background:rgba(13,9,7,0.84);border:1px solid #ff9d5c88;border-radius:8px;padding:6px 8px;margin-bottom:8px;">
          <img src="${unitPov.imgUrl}" alt="${unitPov.piaId}" style="width:68px;height:50px;object-fit:cover;border:1px solid #00f0ff;flex-shrink:0;" />
          <div style="font-size:10px;line-height:1.25;color:#ffdfc2;">
            <span style="color:#00ff88;font-weight:bold;">BOOT SURFACE (${unitPov.piaId}):</span><br/>
            <b>${unitName}</b><br/>
            <span style="color:#bfa690;">${unitPov.surfaceHazardNote}</span>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;background:rgba(8,16,20,0.75);padding:6px 14px;border:1px solid #00f0ff66;border-radius:10px;font-size:11px;">
          <span>GRID: (${sample.col}, ${sample.row})</span>
          <span style="color:${sample.sunlit ? '#00ff88' : '#ffaa00'};">
            ${sample.sunlit ? '☀️ DIRECT SOLAR CHARGING' : '🌑 TOPOGRAPHIC SHADOW'}
          </span>
          <span style="color:${sample.commsLos ? '#00f0ff' : '#ffd700'};">
            ${sample.commsLos ? '📡 UHF HAB LINK LOCKED' : '🔭 OPTICAL SKYLINE NAV'}
          </span>
          <span>RAD SHIELD: ${100 - sample.skyViewPct}%</span>
        </div>
      </div>
    `;
  }

  /**
   * Idle (no route) panel: walkback-reachable %, pack mass and the displayed slope limit
   * max(22, 32 - 0.15 m) deg (the same floor the pathfinder uses), waypoint buttons, loadout and citations.
   */
  public updateIdle(sector: SectorBuffers, reachablePct = 78): void {
    const massKg = this.getPayloadMassKg();
    const maxSlope = Math.max(22.0, 32.0 - 0.15 * massKg).toFixed(1);
    this.svgCoords = [];
    this.panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;color:#00f0ff;font-weight:bold;font-size:12px;border-bottom:1px solid #ff9d5c44;padding-bottom:5px;margin-bottom:8px;">
        <span>⌚ WRIST CO-PROCESSOR</span>
        <span style="font-size:10px;color:#00ff88;">${sector.memoryKB}KB RAM</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
        <div style="background:#18110c;border:1px solid #ff9d5c44;padding:6px;">
          <div style="font-size:9px;color:#bfa690;">WALKBACK REACHABLE</div>
          <div style="font-size:13px;font-weight:bold;color:#00f0ff;">${reachablePct}% of Sector</div>
          <div style="font-size:9px;color:#bfa690;">≤${SINGLE_SORTIE_WALKBACK_LIMIT_O2}L Out & Back</div>
        </div>
        <div style="background:#18110c;border:1px solid #ff9d5c44;padding:6px;">
          <div style="font-size:9px;color:#bfa690;">PACK / SLOPE LIM</div>
          <div style="font-size:13px;font-weight:bold;color:#00ff88;">${massKg}kg / ${maxSlope}°</div>
          <div style="font-size:9px;color:#bfa690;">Shift+Click = Block Hazard</div>
        </div>
      </div>
      ${this.renderCompactWaypoints(sector)}
      ${this.renderDrawer('loadout', `🎒 Science Loadout (${massKg}kg | Lim ${maxSlope}°)`, this.renderLoadoutSelector())}
      ${this.renderDrawer('orbital', '🛰️ NASA Mars Trek & Citations', this.renderMarsTrekOrbitalCard(sector) + this.renderNasaCitations())}
    `;
    this.bindInteractiveControls(sector);
  }

  /**
   * Main route HUD. Presentation formulas (all from RouteResult):
   *   O2 shown = loop or rover route: estimatedO2 (x2.0 for the rover case, a round trip);
   *              single target: the cell's walkbackO2 round-trip value if finite, else 2 x estimatedO2;
   *   O2 ceiling = 180 L (PLSS) for loops, 95 L (single-sortie walkback limit) otherwise;
   *   o2Pct = min(100, round(100 * shown / ceiling));  red > 95 %, amber > 75 %, else green;
   *   SWME water and battery are doubled for non-loop routes (out and back), loops are already closed;
   *   waterPct = 100 * water / 4.2 L,  battPct = 100 * Wh / 850 Wh;
   *   status: BLOCKED (not found) | SHELTER OK | SAFE RETURN (shown <= ceiling) | WALKBACK EXCEEDED;
   *   naiveFatal = naive.maxSlope > smart.safeSlopeLimit OR naive sand > 160 m.
   * @param smart  optimised route;  @param naive  straight-line baseline;  @param hotspot optional contact
   */
  public updateRouteComparison(
    sector: SectorBuffers,
    col: number,
    row: number,
    smart: RouteResult,
    naive: RouteResult,
    hotspot?: DiscoveryHotspot | null
  ): void {
    const idx = row * sector.gridSize + col;
    const unitId = sector.geologicUnit[idx] ?? 1;
    const unit = GEOLOGIC_UNIT_LABELS[unitId];
    const pov = UNIT_SURFACE_POV[unitId] ?? UNIT_SURFACE_POV[1];
    const naiveFatal = naive.maxSlopeDeg > smart.safeSlopeLimitDeg || naive.sandTrapMeters > 160.0;
    const matchedWp = sector.site.waypoints.find(
      (w) => Math.hypot(w.col - col, w.row - row) <= 3
    );

    const cellWalkbackO2 = sector.walkbackO2[idx];
    const displayO2 = smart.isMultiWaypointLoop || smart.rendezvousCoord
      ? smart.estimatedO2Liters * (smart.rendezvousCoord ? 2.0 : 1.0)
      : Number.isFinite(cellWalkbackO2)
        ? cellWalkbackO2
        : smart.estimatedO2Liters * 2;
    const budgetCeiling = smart.isMultiWaypointLoop
      ? PLSS_MAX_O2_LITERS
      : SINGLE_SORTIE_WALKBACK_LIMIT_O2;
    const o2Pct = Math.min(100, Math.round((displayO2 / budgetCeiling) * 100));
    const o2Color = o2Pct > 95 ? '#ff4455' : o2Pct > 75 ? '#ffaa00' : '#00ff88';

    const waterMult = smart.isMultiWaypointLoop ? 1.0 : 2.0;
    const displayWater = smart.coolingWaterLiters * waterMult;
    const waterPct = Math.min(100, Math.round((displayWater / PLSS_MAX_COOLING_WATER_L) * 100));

    const battMult = smart.isMultiWaypointLoop ? 1.0 : 2.0;
    const displayBatt = smart.batteryWh * battMult;
    const battPct = Math.min(100, Math.round((displayBatt / PLSS_MAX_BATTERY_WH) * 100));

    const statusText = smart.found
      ? smart.isSafeHavenRoute
        ? 'SHELTER OK'
        : displayO2 <= budgetCeiling
          ? 'SAFE RETURN'
          : 'WALKBACK EXCEEDED'
      : 'BLOCKED';
    const statusColor = smart.found && displayO2 <= budgetCeiling ? '#00ff88' : '#ff4455';

    const titleLabel = smart.isMultiWaypointLoop
      ? `🔗 LOOP: ${smart.waypointOrderLabel}`
      : matchedWp
        ? `◆ ${matchedWp.code}: ${matchedWp.title}`
        : `Target (${col},${row}): ${unit}`;

    this.panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;color:#00f0ff;font-weight:bold;font-size:12px;border-bottom:1px solid #ff9d5c44;padding-bottom:4px;margin-bottom:6px;">
        <span>⌚ 4D EVA GLANCE HUD</span>
        <span style="font-size:10px;color:#ff9d5c;">Arr Sol ${smart.arrivalSolHour.toFixed(1)} | ${smart.computeTimeMs}ms</span>
      </div>

      <div style="font-size:11px;font-weight:bold;color:#ff88ee;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${titleLabel}">
        ${titleLabel}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:6px;">
        <div style="background:#16100c;border-left:3px solid ${statusColor};padding:5px 7px;">
          <div style="font-size:9px;color:#bfa690;">WALKBACK STATUS</div>
          <div style="font-size:12px;font-weight:bold;color:${statusColor};">${statusText}</div>
          <div style="font-size:9px;color:#ffd700;">Nav CEP: ±${smart.maxCepMeters}m</div>
        </div>
        <div style="background:#16100c;border-left:3px solid #00f0ff;padding:5px 7px;">
          <div style="font-size:9px;color:#bfa690;">DIST / WALK TIME</div>
          <div style="font-size:13px;font-weight:bold;color:#00f0ff;">${(smart.distanceMeters / 1000).toFixed(2)} km</div>
          <div style="font-size:9px;color:#d6c2b2;">${smart.durationMinutes} min (+${smart.netElevationGainM.toFixed(0)}m)</div>
        </div>
        <div style="background:#16100c;border-left:3px solid #00ff88;padding:5px 7px;">
          <div style="font-size:9px;color:#bfa690;">MAX SLOPE / SAND</div>
          <div style="font-size:13px;font-weight:bold;color:#00ff88;">${smart.maxSlopeDeg}° <span style="font-size:10px;color:#bfa690;">/ ${smart.safeSlopeLimitDeg}°</span></div>
          <div style="font-size:9px;color:#00ff88;">Sand: ${smart.sandTrapMeters.toFixed(0)}m</div>
        </div>
        <div style="background:#16100c;border-left:3px solid #ffaa00;padding:5px 7px;">
          <div style="font-size:9px;color:#bfa690;">SUNLIT / UHF COMMS</div>
          <div style="font-size:13px;font-weight:bold;color:#ffdfc2;">${smart.sunlitPercent}% / ${smart.commsCoveragePercent}%</div>
          <div style="font-size:9px;color:#00f0ff;">SHARAD Ice: -${smart.minIceDepthMeters}m</div>
        </div>
      </div>

      <div style="background:#140e0a;border:1px solid #ff9d5c44;padding:5px 6px;margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;font-size:9px;margin-bottom:2px;">
          <span><b>1. O₂ METABOLIC</b> (${smart.payloadMassKg}kg)</span>
          <span style="color:${o2Color};font-weight:bold;">${displayO2.toFixed(1)}L / ${budgetCeiling}L (${o2Pct}%)</span>
        </div>
        <div style="width:100%;height:5px;background:#2a1a12;margin-bottom:4px;">
          <div style="width:${o2Pct}%;height:100%;background:${o2Color};"></div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <div style="display:flex;justify-content:space-between;font-size:9px;margin-bottom:2px;">
              <span><b>2. SWME H₂O</b></span>
              <span style="color:#00f0ff;">${displayWater.toFixed(2)}/${PLSS_MAX_COOLING_WATER_L}L</span>
            </div>
            <div style="width:100%;height:4px;background:#102229;">
              <div style="width:${waterPct}%;height:100%;background:#00f0ff;"></div>
            </div>
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;font-size:9px;margin-bottom:2px;">
              <span><b>3. SUIT BATT</b></span>
              <span style="color:#ffaa00;">${displayBatt.toFixed(0)}/${PLSS_MAX_BATTERY_WH}Wh</span>
            </div>
            <div style="width:100%;height:4px;background:#291d0e;">
              <div style="width:${battPct}%;height:100%;background:#ffaa00;"></div>
            </div>
          </div>
        </div>
      </div>

      ${
        hotspot && hotspot.found
          ? `<button id="btn-hotspot-detour" data-hcol="${hotspot.col}" data-hrow="${hotspot.row}" style="width:100%;text-align:left;padding:5px 7px;margin-bottom:5px;background:#0c261b;color:#00ff88;border:1px solid #00ff88;font-family:monospace;font-size:10px;cursor:pointer;">
               ✨ <b>UNCONFORMITY DISCOVERY AT (${hotspot.col},${hotspot.row})</b> [Score ${hotspot.score}/100]<br/>
               <span style="color:#b8f5d4;">${hotspot.description} — Click to sample</span>
             </button>`
          : ''
      }

      ${smart.found ? this.renderElevationSvg(sector, smart.pathIndices, smart.isSafeHavenRoute) : ''}

      ${this.renderCompactWaypoints(sector)}

      ${this.renderDrawer(
        'pov',
        `📷 Target Surface Photo (${pov.piaId}) & Science Goal`,
        this.renderSurfacePovCard(pov, matchedWp?.scienceGoal)
      )}
      ${this.renderDrawer(
        'benchmark',
        `📊 Smart 4D A* vs. Naive Direct Table`,
        this.renderComparisonTable(smart, naive, naiveFatal)
      )}
      ${this.renderDrawer(
        'loadout',
        `🎒 Science Loadout (${smart.payloadMassKg}kg | Lim ${smart.safeSlopeLimitDeg}°)`,
        this.renderLoadoutSelector(pov.recommendedInstrumentIds)
      )}
      ${this.renderDrawer(
        'orbital',
        `🛰️ NASA Mars Trek Tile & Citations`,
        this.renderMarsTrekOrbitalCard(sector) + this.renderNasaCitations()
      )}
    `;
    this.bindInteractiveControls(sector);
  }

  /**
   * Collapsible <details> section; open state is remembered in openDrawers across re-renders.
   */
  private renderDrawer(id: string, summaryText: string, bodyHtml: string): string {
    const isOpen = this.openDrawers.has(id) ? 'open' : '';
    return `
      <details data-drawer-id="${id}" ${isOpen} style="margin-top:5px;background:#140e0a;border:1px solid #ff9d5c44;">
        <summary style="padding:5px 7px;cursor:pointer;color:#ff9d5c;font-weight:bold;font-size:10px;user-select:none;">
          ${summaryText}
        </summary>
        <div style="padding:6px 7px;border-top:1px solid #ff9d5c22;">
          ${bodyHtml}
        </div>
      </details>
    `;
  }

  /**
   * FULL LOOP button + one pill per waypoint.
   */
  private renderCompactWaypoints(sector: SectorBuffers): string {
    const pills = sector.site.waypoints
      .map(
        (wp, idx) => `
        <button data-wp-idx="${idx}" title="${wp.title}: ${wp.scienceGoal}" style="flex:1;padding:5px 4px;background:#1f1224;color:#ff88ee;border:1px solid #ff33cc;font-family:monospace;font-size:10px;font-weight:bold;cursor:pointer;">
          ◆ ${wp.code}
        </button>
      `
      )
      .join('');

    return `
      <div style="margin:6px 0;">
        <div style="display:flex;gap:4px;">
          <button id="btn-science-loop" title="Route optimal round-trip loop across all waypoints" style="flex:1.4;padding:5px 6px;background:#0d2b22;color:#00ff88;border:1px solid #00ff88;font-family:monospace;font-size:10px;font-weight:bold;cursor:pointer;">
            🔗 FULL LOOP
          </button>
          ${pills}
        </div>
      </div>
    `;
  }

  /**
   * "Smart 4D A* vs Naive Direct" table: verdict, distance, max slope, sand, CEP, SWME water / battery.
   */
  private renderComparisonTable(
    smart: RouteResult,
    naive: RouteResult,
    naiveFatal: boolean
  ): string {
    return `
      <table style="width:100%;border-collapse:collapse;font-size:10px;">
        <thead>
          <tr style="border-bottom:1px solid #ff9d5c66;color:#ff9d5c;text-align:left;">
            <th style="padding:2px 0;">Metric</th>
            <th style="color:#00f0ff;">Smart 4D A*</th>
            <th style="color:#ff4455;">Naive Direct</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:2px 0;">Verdict</td>
            <td style="color:#00ff88;font-weight:bold;">SAFE EVA</td>
            <td style="color:${naiveFatal ? '#ff4455' : '#ffaa00'};font-weight:bold;">${naive.maxSlopeDeg > smart.safeSlopeLimitDeg ? 'CLIFF FATAL' : 'RISKY'}</td>
          </tr>
          <tr>
            <td style="padding:2px 0;">Distance</td>
            <td>${(smart.distanceMeters / 1000).toFixed(2)} km</td>
            <td>${(naive.distanceMeters / 1000).toFixed(2)} km</td>
          </tr>
          <tr>
            <td style="padding:2px 0;">Max Slope</td>
            <td style="color:#00ff88;">${smart.maxSlopeDeg}°</td>
            <td style="color:#ff4455;">${naive.maxSlopeDeg}°</td>
          </tr>
          <tr>
            <td style="padding:2px 0;">Sand Traps</td>
            <td style="color:#00ff88;">${smart.sandTrapMeters.toFixed(0)} m</td>
            <td style="color:#ff4455;">${naive.sandTrapMeters.toFixed(0)} m</td>
          </tr>
          <tr>
            <td style="padding:2px 0;">GPS-Denied CEP</td>
            <td style="color:#00ff88;">±${smart.maxCepMeters} m</td>
            <td style="color:#ffaa00;">±${naive.maxCepMeters} m</td>
          </tr>
          <tr>
            <td style="padding:2px 0;">SWME H₂O / Batt</td>
            <td>${smart.coolingWaterLiters}L / ${smart.batteryWh}Wh</td>
            <td>${naive.coolingWaterLiters}L / ${naive.batteryWh}Wh</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  /**
   * Boot-surface photo (click to enlarge) with mission camera name and hazard note.
   */
  private renderSurfacePovCard(pov: SurfacePovInfo, scienceGoal?: string): string {
    return `
      <div>
        ${scienceGoal ? `<div style="color:#00ff88;margin-bottom:5px;font-size:10px;"><b>Objective:</b> ${scienceGoal}</div>` : ''}
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <div style="position:relative;flex-shrink:0;">
            <img
              data-enlarge-src="${pov.imgUrl}"
              data-enlarge-title="NASA Catalog ${pov.piaId} — ${pov.missionCam}"
              data-enlarge-sub="${pov.surfaceHazardNote}"
              src="${pov.imgUrl}"
              alt="${pov.piaId}"
              title="Click to enlarge NASA surface rover image"
              style="width:104px;height:76px;object-fit:cover;border:1px solid #00f0ff;cursor:zoom-in;display:block;"
            />
            <span style="position:absolute;bottom:2px;right:2px;background:rgba(0,0,0,0.75);color:#00f0ff;font-size:8px;padding:1px 3px;pointer-events:none;">🔍 ZOOM</span>
          </div>
          <div style="font-size:10px;line-height:1.3;color:#ffdfc2;">
            <b style="color:#00f0ff;">${pov.missionCam}</b><br/>
            ${pov.surfaceHazardNote}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Instrument checkboxes (mass in kg, heritage) plus the Companion Utility Rover Haul toggle
   * (rover carries the pack on slopes <= 14.5 deg to the rendezvous basecamp; see findRoverAssistedRoute).
   */
  private renderLoadoutSelector(recommendedIds: readonly string[] = []): string {
    const roverToggle = `
      <label style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;cursor:pointer;padding:4px 5px;background:#2b2108;border:1px solid #ffcc00;">
        <input type="checkbox" id="cb-rover-assist" ${this.roverAssistEnabled ? "checked" : ""} style="margin-top:2px;cursor:pointer;" />
        <span style="font-size:10px;line-height:1.25;color:#ffdfc2;">
          <b style="color:#ffcc00;">🛞 Companion Utility Rover Haul</b><br/>
          <span style="color:#d6c2b2;">Rover hauls pack on slopes ≤14.5° to Rendezvous Basecamp; astronaut scrambles final cliff with 2.2kg hand kit.</span>
        </span>
      </label>
    `;
    return roverToggle + EVA_INSTRUMENTS.map((inst) => {
      const checked = this.selectedInstrumentIds.has(inst.id) ? 'checked' : '';
      const isRec = recommendedIds.includes(inst.id);
      return `
        <label style="display:flex;align-items:flex-start;gap:5px;margin-bottom:4px;cursor:pointer;padding:3px;background:${isRec ? '#1a261e' : '#18110c'};border:1px solid ${isRec ? '#00ff8866' : '#ff9d5c22'};">
          <input type="checkbox" data-inst-id="${inst.id}" ${checked} style="margin-top:2px;cursor:pointer;" />
          <span style="font-size:10px;line-height:1.2;">
            <b>${inst.name}</b> <span style="color:#00f0ff;">(${inst.massKg}kg)</span>
            ${isRec ? '<span style="color:#00ff88;">[REC]</span>' : ''}<br/>
            <span style="color:#bfa690;">${inst.heritage}</span>
          </span>
        </label>
      `;
    }).join('');
  }

  /**
   * Wires the freshly rendered DOM: waypoint pills, hotspot detour button, FULL LOOP, rover toggle,
   * instrument checkboxes (each fires onLoadoutChange), drawer state and the image lightbox.
   */
  private bindInteractiveControls(sector: SectorBuffers): void {
    const buttons = this.panel.querySelectorAll<HTMLButtonElement>('button[data-wp-idx]');
    buttons.forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.getAttribute('data-wp-idx'));
        const wp = sector.site.waypoints[idx];
        if (wp && this.onSelectWaypoint) {
          this.onSelectWaypoint(wp.col, wp.row);
        }
      };
    });

    const hotspotBtn = this.panel.querySelector<HTMLButtonElement>('#btn-hotspot-detour');
    if (hotspotBtn) {
      hotspotBtn.onclick = () => {
        const hCol = Number(hotspotBtn.getAttribute('data-hcol'));
        const hRow = Number(hotspotBtn.getAttribute('data-hrow'));
        this.onSelectWaypoint?.(hCol, hRow);
      };
    }

    const loopBtn = this.panel.querySelector<HTMLButtonElement>('#btn-science-loop');
    if (loopBtn) {
      loopBtn.onclick = () => this.onRunScienceLoop?.();
    }

    const roverCb = this.panel.querySelector<HTMLInputElement>("#cb-rover-assist");
    if (roverCb) {
      roverCb.onchange = () => {
        this.roverAssistEnabled = roverCb.checked;
        this.onLoadoutChange?.(this.getPayloadMassKg());
      };
    }
    const checkboxes = this.panel.querySelectorAll<HTMLInputElement>('input[data-inst-id]');
    checkboxes.forEach((cb) => {
      cb.onchange = () => {
        const id = cb.getAttribute('data-inst-id')!;
        if (cb.checked) this.selectedInstrumentIds.add(id);
        else this.selectedInstrumentIds.delete(id);
        this.onLoadoutChange?.(this.getPayloadMassKg());
      };
    });

    const detailsList = this.panel.querySelectorAll<HTMLDetailsElement>('details[data-drawer-id]');
    detailsList.forEach((det) => {
      det.ontoggle = () => {
        const id = det.getAttribute('data-drawer-id')!;
        if (det.open) this.openDrawers.add(id);
        else this.openDrawers.delete(id);
      };
    });

    const enlargeImgs = this.panel.querySelectorAll<HTMLImageElement>('img[data-enlarge-src]');
    enlargeImgs.forEach((img) => {
      img.onclick = () => {
        this.openLightbox(
          img.getAttribute('data-enlarge-src')!,
          img.getAttribute('data-enlarge-title')!,
          img.getAttribute('data-enlarge-sub')!
        );
      };
    });
  }

  /**
   * Orbital context card with the 256x256 JPL Mars Trek tile of the site (click to enlarge).
   */
  private renderMarsTrekOrbitalCard(sector: SectorBuffers): string {
    return `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
        <div style="position:relative;flex-shrink:0;">
          <img
            data-enlarge-src="${sector.site.marsTrekTileUrl}"
            data-enlarge-title="NASA JPL Mars Trek WMTS — ${sector.site.name}"
            data-enlarge-sub="MGS MOLA / HRSC Blended Color-Shaded Elevation Tile (${sector.site.coordsLabel})"
            src="${sector.site.marsTrekTileUrl}"
            alt="NASA Mars Trek WMTS Tile"
            title="Click to enlarge NASA Mars Trek tile"
            style="width:68px;height:68px;object-fit:cover;border:1px solid #00f0ff;cursor:zoom-in;display:block;"
          />
          <span style="position:absolute;bottom:2px;right:2px;background:rgba(0,0,0,0.75);color:#00f0ff;font-size:8px;padding:1px 3px;pointer-events:none;">🔍 ZOOM</span>
        </div>
        <div style="font-size:10px;line-height:1.3;color:#d6c2b2;">
          <b>JPL Mars Trek WMTS:</b> click tile to enlarge.<br/>
          <b>Coords:</b> ${sector.site.coordsLabel}
        </div>
      </div>
    `;
  }

  /**
   * 315x56 px profile of surface elevation along the route and, dashed, the ice horizon drawn at
   * z_ice = z - 2.5 * iceTableDepth (a 2.5x vertical exaggeration of the ice depth for legibility).
   *     y = h - 6 - (z - zmin) / max(4, zmax - zmin) * (h - 16),   zmin = min z_ice, zmax = max z
   */
  private renderElevationSvg(
    sector: SectorBuffers,
    pathIndices: Int32Array,
    isSafeHaven: boolean
  ): string {
    const w = 315;
    const h = 56;
    const n = pathIndices.length;
    this.svgCoords = [];
    if (n < 2) return '';

    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const idx = pathIndices[i];
      const z = sector.elevation[idx];
      const iceZ = z - sector.iceTableDepthM[idx] * 2.5;
      if (iceZ < minZ) minZ = iceZ;
      if (z > maxZ) maxZ = z;
    }
    const spanZ = Math.max(4.0, maxZ - minZ);
    const pts: string[] = [];
    const icePts: string[] = [];
    for (let i = 0; i < n; i++) {
      const idx = pathIndices[i];
      const x = (i / (n - 1)) * (w - 10) + 5;
      const z = sector.elevation[idx];
      const iceZ = z - sector.iceTableDepthM[idx] * 2.5;
      const y = h - 6 - ((z - minZ) / spanZ) * (h - 16);
      const yIce = h - 6 - ((iceZ - minZ) / spanZ) * (h - 16);
      this.svgCoords.push({ x, y });
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      icePts.push(`${x.toFixed(1)},${yIce.toFixed(1)}`);
    }
    const stroke = isSafeHaven ? '#00ff88' : '#00f0ff';
    const first = this.svgCoords[0];
    return `
      <div style="background:#140e0a;border:1px solid #ff9d5c44;padding:4px;margin-bottom:5px;">
        <div style="display:flex;justify-content:space-between;font-size:9px;color:#ff9d5c;">
          <span>ELEVATION & SHARAD ICE HORIZON</span>
          <span style="color:#00f0ff;">--- Subsurface Ice</span>
        </div>
        <svg width="${w}" height="${h}" style="display:block;">
          <polyline fill="none" stroke="#00f0ff66" stroke-width="1.3" stroke-dasharray="3,2" points="${icePts.join(' ')}" />
          <polyline fill="none" stroke="${stroke}" stroke-width="2" points="${pts.join(' ')}" />
          <line id="svg-elev-cursor" x1="${first.x.toFixed(1)}" y1="2" x2="${first.x.toFixed(1)}" y2="${h - 2}" stroke="#ff9d5c88" stroke-width="1" stroke-dasharray="2,2" />
          <circle id="svg-elev-dot" cx="${first.x.toFixed(1)}" cy="${first.y.toFixed(1)}" r="3.8" fill="#ffffff" stroke="#ff33cc" stroke-width="1.5" />
        </svg>
      </div>
    `;
  }

  /**
   * Footer links: JPL Mars Trek, USGS Astrogeology geologic map hub, NASA Curiosity route page, Mars 2020 raw images.
   */
  private renderNasaCitations(): string {
    return `
      <div style="font-size:9px;line-height:1.35;color:#bfa690;">
        • <a href="https://trek.nasa.gov/mars/" target="_blank" style="color:#00f0ff;">JPL Mars Trek</a> &
          <a href="https://astrogeology-usgs.hub.arcgis.com/pages/interactive-maps-mars" target="_blank" style="color:#00f0ff;">USGS Geologic Map</a><br/>
        • <a href="https://science.nasa.gov/resource/curiositys-proposed-path-up-mount-sharp/" target="_blank" style="color:#00f0ff;">Curiosity Mount Sharp Route</a> &
          <a href="https://mars.nasa.gov/mars2020/multimedia/raw-images/" target="_blank" style="color:#00f0ff;">Mars 2020 Raw Images</a>
      </div>
    `;
  }
}
