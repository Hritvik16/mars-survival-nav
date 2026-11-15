// src/viewer/scene3D.ts
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SINGLE_SORTIE_WALKBACK_LIMIT_O2 } from '../core/pathfinder';
import type { LayerMode, SectorBuffers } from '../core/sectorData';
import { hasLineOfSight } from '../core/solarAndComms';

export interface VisorTelemetrySample {
  readonly progressPct: number;
  readonly col: number;
  readonly row: number;
  readonly elevMeters: number;
  readonly slopeDeg: number;
  readonly headingDeg: number;
  readonly headingCardinal: string;
  readonly skyViewPct: number;
  readonly sunlit: boolean;
  readonly commsLos: boolean;
  readonly geologicUnitId: number;
  readonly cepMeters: number;
  readonly navModeLabel: string;
  readonly iceDepthMeters: number;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
const UNIT_IMAGE_URLS = [
  '/images/PIA20168.jpg',
  '/images/PIA19912.jpg',
  '/images/PIA19077.jpg',
  '/images/PIA10940.jpg',
] as const;

export class Scene3DHarness {
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly controls: OrbitControls;

  private sector: SectorBuffers;
  private currentMode: LayerMode = 'mars';
  private readonly sceneSpan = 100;
  private geometry: THREE.PlaneGeometry;
  private material: THREE.MeshStandardMaterial;
  private colorBuffer: Float32Array;
  private terrainMesh: THREE.Mesh;
  private sunLight: THREE.DirectionalLight;

  private unitImages: (HTMLImageElement | null)[] = [null, null, null, null];
  private detailCanvas: HTMLCanvasElement;
  private detailTexture: THREE.CanvasTexture;

  private habMesh: THREE.Mesh;
  private habLabel: THREE.Sprite;
  private relayGroup = new THREE.Group();
  private hotspotGroup = new THREE.Group();
  private landmarkGroup = new THREE.Group();
  private hazardGroup = new THREE.Group();
  private cepRingGroup = new THREE.Group();
  private strataCurtainMesh: THREE.Mesh | null = null;
  private strataCurtainVisible = false;

  private targetMesh: THREE.Mesh;
  private astronautMesh: THREE.Mesh;
  private waypointGroup = new THREE.Group();
  private labelGroup = new THREE.Group();
  private routeMesh: THREE.Mesh | null = null;
  private roverRouteMesh: THREE.Mesh | null = null;
  private roverDropGroup = new THREE.Group();
  private naiveRouteMesh: THREE.Mesh | null = null;
  private activeCurve: THREE.CatmullRomCurve3 | null = null;
  private activePathIndices: Int32Array = new Int32Array(0);
  private activePathCep: Float32Array = new Float32Array(0);
  private activeIsSafeHaven = false;

  private povMode = false;
  private autoWalkActive = false;
  private routeProgress = 0;
  private smoothedCamPos = new THREE.Vector3();
  private smoothedLookPos = new THREE.Vector3();
  private savedOrbitalPos = new THREE.Vector3(0, 78, 78);
  private savedOrbitalTarget = new THREE.Vector3(0, 0, 0);
  private onVisorUpdate?: (sample: VisorTelemetrySample | null) => void;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  constructor(container: HTMLElement, sector: SectorBuffers) {
    this.sector = sector;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0907);
    this.scene.fog = new THREE.FogExp2(0x1a0f0a, 0.0038);

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.05,
      500
    );
    this.camera.position.copy(this.savedOrbitalPos);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = '';
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.46;

    this.scene.add(new THREE.AmbientLight(0xffcfb3, 0.52));
    this.sunLight = new THREE.DirectionalLight(0xfff0dd, 1.5);
    this.setSolHour(14.0);
    this.scene.add(this.sunLight);

    const { gridSize } = sector;
    this.geometry = new THREE.PlaneGeometry(
      this.sceneSpan,
      this.sceneSpan,
      gridSize - 1,
      gridSize - 1
    );
    this.geometry.rotateX(-Math.PI / 2);

    this.colorBuffer = new Float32Array(gridSize * gridSize * 3);
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colorBuffer, 3));

    this.detailCanvas = document.createElement('canvas');
    this.detailCanvas.width = 1024;
    this.detailCanvas.height = 1024;
    const ctx = this.detailCanvas.getContext('2d')!;
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(0, 0, 1024, 1024);

    this.detailTexture = new THREE.CanvasTexture(this.detailCanvas);
    this.detailTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.detailTexture.wrapT = THREE.ClampToEdgeWrapping;

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.detailTexture,
      bumpMap: this.detailTexture,
      bumpScale: 0.42,
      roughness: 0.84,
      metalness: 0.06,
      flatShading: false,
    });

    this.terrainMesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.terrainMesh);

    this.habMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.4, 3.2, 16),
      new THREE.MeshBasicMaterial({ color: 0x00f0ff })
    );
    this.habLabel = this.createBadgeSprite('HAB LANDER', '#00f0ff');

    this.targetMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffaa00 })
    );
    this.targetMesh.visible = false;

    this.astronautMesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.7, 2.0, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    this.astronautMesh.visible = false;

    this.scene.add(
      this.habMesh,
      this.habLabel,
      this.relayGroup,
      this.hotspotGroup,
      this.landmarkGroup,
      this.hazardGroup,
      this.cepRingGroup,
      this.roverDropGroup,
      this.targetMesh,
      this.astronautMesh,
      this.waypointGroup,
      this.labelGroup
    );

    this.syncElevationBuffer();
    this.applyHeatmap('mars');
    this.preloadNasaSurfaceImages();

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  private preloadNasaSurfaceImages(): void {
    let loaded = 0;
    UNIT_IMAGE_URLS.forEach((url, idx) => {
      const img = new Image();
      img.onload = () => {
        this.unitImages[idx] = img;
        loaded++;
        if (loaded === UNIT_IMAGE_URLS.length) {
          this.rebuildSurfaceDetailTexture();
        }
      };
      img.src = url;
    });
  }

  private rebuildSurfaceDetailTexture(): void {
    if (this.unitImages.some((img) => img === null)) return;
    const ctx = this.detailCanvas.getContext('2d')!;
    const W = 1024;
    const H = 1024;

    const unitBuffers: Uint8ClampedArray[] = [];
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = W;
    tileCanvas.height = H;
    const tCtx = tileCanvas.getContext('2d')!;

    for (let u = 0; u < 4; u++) {
      const img = this.unitImages[u]!;
      const pat = tCtx.createPattern(img, 'repeat');
      tCtx.save();
      tCtx.scale(0.32, 0.32);
      tCtx.fillStyle = pat!;
      tCtx.fillRect(0, 0, W / 0.32, H / 0.32);
      tCtx.restore();
      unitBuffers.push(tCtx.getImageData(0, 0, W, H).data);
    }

    const { gridSize, geologicUnit } = this.sector;
    const onRouteMask = new Uint8Array(gridSize * gridSize);
    for (let i = 0; i < this.activePathIndices.length; i++) {
      const centerIdx = this.activePathIndices[i];
      const cr = Math.floor(centerIdx / gridSize);
      const cc = centerIdx % gridSize;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
            onRouteMask[nr * gridSize + nc] = 1;
          }
        }
      }
    }

    const outImg = ctx.createImageData(W, H);
    const dst = outImg.data;

    for (let py = 0; py < H; py++) {
      const gr = Math.min(gridSize - 1, Math.floor((py / H) * gridSize));
      for (let px = 0; px < W; px++) {
        const gc = Math.min(gridSize - 1, Math.floor((px / W) * gridSize));
        const gIdx = gr * gridSize + gc;
        const unit = geologicUnit[gIdx] ?? 1;
        const src = unitBuffers[unit] ?? unitBuffers[1];
        const pIdx = (py * W + px) * 4;

        const lum = (src[pIdx] * 0.299 + src[pIdx + 1] * 0.587 + src[pIdx + 2] * 0.114) / 255.0;
        const isCorridor = onRouteMask[gIdx] === 1;
        const contrast = isCorridor ? 0.58 : 0.32;
        const base = isCorridor ? 0.74 : 0.84;
        const v = Math.max(0, Math.min(255, Math.round((base + (lum - 0.5) * contrast) * 255)));

        dst[pIdx] = v;
        dst[pIdx + 1] = v;
        dst[pIdx + 2] = v;
        dst[pIdx + 3] = 255;
      }
    }

    ctx.putImageData(outImg, 0, 0);
    this.detailTexture.needsUpdate = true;
  }

  /** Renders exactly one 3D In-Situ Hazard Cone per connected Shift+Click patch */
  public syncInSituHazards(): void {
    this.hazardGroup.clear();
    const { gridSize, inSituBlocked } = this.sector;
    const visited = new Uint8Array(gridSize * gridSize);
    for (let r = 2; r < gridSize - 2; r++) {
      for (let c = 2; c < gridSize - 2; c++) {
        const idx = r * gridSize + c;
        if (inSituBlocked[idx] === 1 && visited[idx] === 0) {
          for (let dr = -5; dr <= 5; dr++) {
            for (let dc = -5; dc <= 5; dc++) {
              const nr = r + dr;
              const nc = c + dc;
              if (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
                visited[nr * gridSize + nc] = 1;
              }
            }
          }
          const centerC = Math.min(gridSize - 2, c + 2);
          const centerR = Math.min(gridSize - 2, r + 2);
          const cone = new THREE.Mesh(
            new THREE.ConeGeometry(1.1, 2.6, 8),
            new THREE.MeshBasicMaterial({ color: 0xff2244 })
          );
          cone.position.copy(this.gridToWorld(centerC, centerR, 1.3));
          this.hazardGroup.add(cone);

          const badge = this.createBadgeSprite('⚠️ HAZARD BLOCK', '#ff2244');
          badge.scale.set(6.5, 1.6, 1);
          badge.position.copy(this.gridToWorld(centerC, centerR, 3.4));
          this.hazardGroup.add(badge);
        }
      }
    }
  }

  /** Toggles translucent 3D Subsurface Stratigraphic & SHARAD Radar Curtain view */
  public toggleStrataCurtain(forceState?: boolean): boolean {
    this.strataCurtainVisible =
      forceState !== undefined ? forceState : !this.strataCurtainVisible;
    this.material.transparent = this.strataCurtainVisible;
    this.material.opacity = this.strataCurtainVisible ? 0.44 : 1.0;
    this.material.needsUpdate = true;
    if (this.strataCurtainMesh) {
      this.strataCurtainMesh.visible = this.strataCurtainVisible;
    }
    return this.strataCurtainVisible;
  }

  public isStrataCurtainVisible(): boolean {
    return this.strataCurtainVisible;
  }

  /**
   * Builds a 3D Volumetric Subsurface Stratigraphic Curtain & SHARAD Water-Ice Radargram
   * ribbon directly beneath the active traverse path down to -160m depth.
   */
  private rebuildSubsurfaceCurtain(): void {
    if (this.strataCurtainMesh) {
      this.strataCurtainMesh.geometry.dispose();
      this.scene.remove(this.strataCurtainMesh);
      this.strataCurtainMesh = null;
    }
    const n = this.activePathIndices.length;
    if (n < 2) return;

    const { gridSize, worldSizeMeters, elevation, iceTableDepthM, geologicUnit } = this.sector;
    const vScale = this.sceneSpan / worldSizeMeters;
    const depthLayers = 8;
    const maxDepthMeters = 155.0;

    const positions = new Float32Array(n * depthLayers * 3);
    const colors = new Float32Array(n * depthLayers * 3);
    const indices: number[] = [];
    const c = new THREE.Color();

    for (let i = 0; i < n; i++) {
      const cellIdx = this.activePathIndices[i];
      const row = Math.floor(cellIdx / gridSize);
      const col = cellIdx % gridSize;
      const surfPos = this.gridToWorld(col, row, 0.25);
      const iceDepthM = iceTableDepthM[cellIdx];
      const unit = geologicUnit[cellIdx];
      const surfElevM = elevation[cellIdx];

      for (let d = 0; d < depthLayers; d++) {
        const frac = d / (depthLayers - 1);
        const depthM = frac * maxDepthMeters;
        const vIdx = (i * depthLayers + d) * 3;

        positions[vIdx] = surfPos.x;
        positions[vIdx + 1] = surfPos.y - depthM * vScale;
        positions[vIdx + 2] = surfPos.z;

        // Color 3D subsurface curtain by SHARAD water-ice lens and dipping Hesperian/Noachian strata
        if (Math.abs(depthM - iceDepthM * 3.2) < 14.0) {
          // Bright Cyan-White SHARAD Subsurface Water-Ice / Hydrated Horizon
          c.setRGB(0.0, 0.95, 1.0);
        } else if (depthM < 28.0) {
          // Upper Amazonian/Hesperian surface regolith & caprock
          c.setHSL(unit === 2 ? 0.04 : 0.07, 0.75, 0.42);
        } else if (surfElevM - depthM > -35.0) {
          // Dipping Hesperian Layered Sulfate Bed (Amber/Ochre)
          c.setHSL(0.09, 0.88, 0.46);
        } else {
          // Deep Noachian Phyllosilicate Clay Basement (Emerald/Teal)
          c.setHSL(0.42, 0.78, 0.32);
        }

        colors[vIdx] = c.r;
        colors[vIdx + 1] = c.g;
        colors[vIdx + 2] = c.b;
      }
    }

    for (let i = 0; i < n - 1; i++) {
      for (let d = 0; d < depthLayers - 1; d++) {
        const a = i * depthLayers + d;
        const b = (i + 1) * depthLayers + d;
        const c1 = (i + 1) * depthLayers + (d + 1);
        const d1 = i * depthLayers + (d + 1);
        indices.push(a, b, d1, b, c1, d1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    });
    this.strataCurtainMesh = new THREE.Mesh(geo, mat);
    this.strataCurtainMesh.visible = this.strataCurtainVisible;
    this.scene.add(this.strataCurtainMesh);
  }

  public renderRelayBeacon(relayCol: number, relayRow: number): void {
    this.relayGroup.clear();
    const { habCol, habRow } = this.sector.site;
    const relayPos = this.gridToWorld(relayCol, relayRow, 1.6);
    const habPos = this.gridToWorld(habCol, habRow, 2.2);

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.75, 2.8, 12),
      new THREE.MeshBasicMaterial({ color: 0xffcc00 })
    );
    mast.position.copy(relayPos);
    this.relayGroup.add(mast);

    const badge = this.createBadgeSprite('📡 UHF RELAY', '#ffcc00');
    badge.position.copy(this.gridToWorld(relayCol, relayRow, 4.3));
    this.relayGroup.add(badge);

    const beamCurve = new THREE.LineCurve3(habPos, this.gridToWorld(relayCol, relayRow, 2.5));
    const beamGeo = new THREE.TubeGeometry(beamCurve, 16, 0.12, 6, false);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffcc00,
      transparent: true,
      opacity: 0.8,
    });
    this.relayGroup.add(new THREE.Mesh(beamGeo, beamMat));
  }

  public renderDiscoveryHotspot(col: number, row: number): void {
    this.hotspotGroup.clear();
    if (col < 0 || row < 0 || this.povMode) return;
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.85, 0),
      new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    );
    gem.position.copy(this.gridToWorld(col, row, 1.4));
    this.hotspotGroup.add(gem);

    const badge = this.createBadgeSprite('✨ UNCONFORMITY', '#00ff88');
    badge.scale.set(7.5, 1.9, 1);
    badge.position.copy(this.gridToWorld(col, row, 3.6));
    this.hotspotGroup.add(badge);
  }

  public clearRelayBeacon(): void {
    this.relayGroup.clear();
  }

  private createBadgeSprite(text: string, borderHex: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(13, 9, 7, 0.86)';
    ctx.strokeStyle = borderHex;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(6, 8, 244, 48, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = borderHex;
    ctx.font = 'bold 24px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 33);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(9.5, 2.4, 1);
    return sprite;
  }

  public onVisorTelemetry(cb: (sample: VisorTelemetrySample | null) => void): void {
    this.onVisorUpdate = cb;
  }

  private gridToWorld(col: number, row: number, ySceneOffset = 0): THREE.Vector3 {
    const { gridSize, worldSizeMeters, elevation } = this.sector;
    const vScale = this.sceneSpan / worldSizeMeters;
    const x = (col / (gridSize - 1) - 0.5) * this.sceneSpan;
    const z = (row / (gridSize - 1) - 0.5) * this.sceneSpan;
    const y = elevation[row * gridSize + col] * vScale + ySceneOffset;
    return new THREE.Vector3(x, y, z);
  }

  public setSector(newSector: SectorBuffers): void {
    this.sector = newSector;
    this.setPovMode(false);
    this.clearRoute();
    this.clearRelayBeacon();
    this.hotspotGroup.clear();
    this.syncInSituHazards();
    this.syncElevationBuffer();
    this.rebuildSurfaceDetailTexture();
    this.applyHeatmap(this.currentMode);
  }

  public syncElevationBuffer(): void {
    const posAttr = this.geometry.attributes.position;
    const { elevation, gridSize, worldSizeMeters, site, landmarks } = this.sector;
    const vScale = this.sceneSpan / worldSizeMeters;
    for (let i = 0; i < gridSize * gridSize; i++) {
      posAttr.setY(i, elevation[i] * vScale);
    }
    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
    this.habMesh.position.copy(this.gridToWorld(site.habCol, site.habRow, 1.6));
    this.habLabel.position.copy(this.gridToWorld(site.habCol, site.habRow, 4.4));

    this.waypointGroup.clear();
    this.labelGroup.clear();
    for (const wp of site.waypoints) {
      const beacon = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.1, 0),
        new THREE.MeshBasicMaterial({ color: 0xff33cc })
      );
      beacon.position.copy(this.gridToWorld(wp.col, wp.row, 1.8));
      this.waypointGroup.add(beacon);

      const badge = this.createBadgeSprite(wp.shortLabel, '#ff66dd');
      badge.position.copy(this.gridToWorld(wp.col, wp.row, 4.3));
      this.labelGroup.add(badge);
    }

    // Render Gold Optical Navigation Prominence Peaks for GPS-Denied Skyline Triangulation
    this.landmarkGroup.clear();
    for (const lm of landmarks) {
      const pin = new THREE.Mesh(
        new THREE.ConeGeometry(0.55, 1.6, 4),
        new THREE.MeshBasicMaterial({ color: 0xffd700, wireframe: true })
      );
      pin.position.copy(this.gridToWorld(lm.col, lm.row, 1.2));
      this.landmarkGroup.add(pin);
    }
  }

  public renderRoute(
    pathIndices: Int32Array,
    isSafeHaven = false,
    naiveIndices?: Int32Array,
    pathCepMeters?: Float32Array,
    roverIndices?: Int32Array
  ): void {
    this.clearRoute();
    const { gridSize } = this.sector;
    this.activeIsSafeHaven = isSafeHaven;

    if (roverIndices && roverIndices.length >= 2) {
      const rPts: THREE.Vector3[] = [];
      for (let i = 0; i < roverIndices.length; i++) {
        const idx = roverIndices[i];
        rPts.push(this.gridToWorld(idx % gridSize, Math.floor(idx / gridSize), 0.62));
      }
      const rCurve = new THREE.CatmullRomCurve3(rPts);
      const rGeo = new THREE.TubeGeometry(rCurve, Math.min(rPts.length * 2, 140), 0.36, 6, false);
      const rMat = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
      this.roverRouteMesh = new THREE.Mesh(rGeo, rMat);
      this.scene.add(this.roverRouteMesh);

      const dropIdx = roverIndices[roverIndices.length - 1];
      const dropR = Math.floor(dropIdx / gridSize);
      const dropC = dropIdx % gridSize;
      const roverBox = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 1.1, 2.2),
        new THREE.MeshBasicMaterial({ color: 0xffcc00 })
      );
      roverBox.position.copy(this.gridToWorld(dropC, dropR, 1.1));
      this.roverDropGroup.add(roverBox);

      const badge = this.createBadgeSprite("🛞 ROVER BASECAMP", "#ffcc00");
      badge.scale.set(7.5, 1.9, 1);
      badge.position.copy(this.gridToWorld(dropC, dropR, 3.6));
      this.roverDropGroup.add(badge);
    }

    if (naiveIndices && naiveIndices.length >= 2) {
      const nPts: THREE.Vector3[] = [];
      for (let i = 0; i < naiveIndices.length; i++) {
        const idx = naiveIndices[i];
        nPts.push(this.gridToWorld(idx % gridSize, Math.floor(idx / gridSize), 0.25));
      }
      const nCurve = new THREE.CatmullRomCurve3(nPts);
      const nGeo = new THREE.TubeGeometry(nCurve, Math.min(nPts.length * 2, 160), 0.14, 5, false);
      const nMat = new THREE.MeshBasicMaterial({
        color: 0xff3344,
        transparent: true,
        opacity: 0.72,
      });
      this.naiveRouteMesh = new THREE.Mesh(nGeo, nMat);
      this.naiveRouteMesh.visible = !this.povMode;
      this.scene.add(this.naiveRouteMesh);
    }

    if (pathIndices.length < 2) return;

    this.activePathIndices = pathIndices;
    this.activePathCep = pathCepMeters ?? new Float32Array(pathIndices.length);
    this.rebuildSurfaceDetailTexture();
    this.rebuildActiveRouteTube();
    this.rebuildSubsurfaceCurtain();
    this.rebuildCepRings();
    this.updateCameraAlongRoute(true);
  }

  /** Renders GPS-Denied Positional Uncertainty CEP Rings along the route */
  private rebuildCepRings(): void {
    this.cepRingGroup.clear();
    if (this.povMode || this.activePathIndices.length < 6) return;
    const { gridSize } = this.sector;

    for (let i = 8; i < this.activePathIndices.length - 4; i += 12) {
      const cep = this.activePathCep[i] || 0.8;
      if (cep <= 1.0) continue; // Only highlight where UHF lock is lost and optical/IMU drift occurs
      const idx = this.activePathIndices[i];
      const r = Math.floor(idx / gridSize);
      const c = idx % gridSize;
      const radiusScene = Math.min(3.2, Math.max(0.65, cep * 0.18));
      const colorHex = cep > 5.0 ? 0xff4455 : 0xffcc00;

      const ringGeo = new THREE.RingGeometry(radiusScene * 0.82, radiusScene, 24);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: colorHex,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(this.gridToWorld(c, r, 0.38));
      this.cepRingGroup.add(ring);
    }
  }

  private rebuildActiveRouteTube(): void {
    if (this.routeMesh) {
      this.routeMesh.geometry.dispose();
      this.scene.remove(this.routeMesh);
      this.routeMesh = null;
    }
    if (this.roverRouteMesh) {
      this.roverRouteMesh.geometry.dispose();
      this.scene.remove(this.roverRouteMesh);
      this.roverRouteMesh = null;
    }
    this.roverDropGroup.clear();
    if (this.activePathIndices.length < 2) return;

    const { gridSize } = this.sector;
    const heightOffset = this.povMode ? 0.12 : 0.45;
    const tubeRadius = this.povMode ? 0.065 : 0.3;

    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < this.activePathIndices.length; i++) {
      const idx = this.activePathIndices[i];
      const r = Math.floor(idx / gridSize);
      const c = idx % gridSize;
      pts.push(this.gridToWorld(c, r, heightOffset));
    }

    const lastIdx = this.activePathIndices[this.activePathIndices.length - 1];
    const goalR = Math.floor(lastIdx / gridSize);
    const goalC = lastIdx % gridSize;
    this.targetMesh.position.copy(this.gridToWorld(goalC, goalR, this.povMode ? 0.4 : 1.1));
    this.targetMesh.scale.setScalar(this.povMode ? 0.35 : 1.0);
    (this.targetMesh.material as THREE.MeshBasicMaterial).color.setHex(
      this.activeIsSafeHaven ? 0x00ff88 : 0xffaa00
    );
    this.targetMesh.visible = true;

    this.activeCurve = new THREE.CatmullRomCurve3(pts);
    const tubeGeo = new THREE.TubeGeometry(
      this.activeCurve,
      Math.min(pts.length * 2, 260),
      tubeRadius,
      6,
      false
    );
    const tubeMat = new THREE.MeshBasicMaterial({
      color: this.activeIsSafeHaven ? 0x00ff88 : 0x00f0ff,
      transparent: true,
      opacity: this.povMode ? 0.68 : 0.95,
    });
    this.routeMesh = new THREE.Mesh(tubeGeo, tubeMat);
    this.scene.add(this.routeMesh);
  }

  public clearRoute(): void {
    if (this.routeMesh) {
      this.routeMesh.geometry.dispose();
      this.scene.remove(this.routeMesh);
      this.routeMesh = null;
    }
    if (this.naiveRouteMesh) {
      this.naiveRouteMesh.geometry.dispose();
      this.scene.remove(this.naiveRouteMesh);
      this.naiveRouteMesh = null;
    }
    if (this.strataCurtainMesh) {
      this.strataCurtainMesh.geometry.dispose();
      this.scene.remove(this.strataCurtainMesh);
      this.strataCurtainMesh = null;
    }
    this.cepRingGroup.clear();
    this.activeCurve = null;
    this.activePathIndices = new Int32Array(0);
    this.activePathCep = new Float32Array(0);
    this.targetMesh.visible = false;
    this.astronautMesh.visible = false;
  }

  public hasActiveRoute(): boolean {
    return this.activeCurve !== null && this.activePathIndices.length >= 2;
  }

  public getActivePathIndices(): Int32Array {
    return this.activePathIndices;
  }

  public isPovMode(): boolean {
    return this.povMode;
  }

  public setAutoWalk(active: boolean): void {
    this.autoWalkActive = active;
  }

  public setPovMode(enabled: boolean): void {
    if (enabled && !this.hasActiveRoute()) return;
    if (enabled && !this.povMode) {
      this.savedOrbitalPos.copy(this.camera.position);
      this.savedOrbitalTarget.copy(this.controls.target);
      this.povMode = true;
      this.autoWalkActive = true;
      this.controls.enabled = false;

      this.scene.background = new THREE.Color(0x382015);
      this.scene.fog = new THREE.FogExp2(0x4a2a1b, 0.014);
      this.material.bumpScale = 0.65;

      this.habMesh.scale.setScalar(0.28);
      this.habMesh.position.copy(
        this.gridToWorld(this.sector.site.habCol, this.sector.site.habRow, 0.45)
      );
      this.habLabel.scale.set(2.2, 0.55, 1);
      this.habLabel.position.copy(
        this.gridToWorld(this.sector.site.habCol, this.sector.site.habRow, 1.25)
      );
      this.waypointGroup.children.forEach((c) => c.scale.setScalar(0.28));
      this.labelGroup.children.forEach((l, idx) => {
        l.scale.set(2.2, 0.55, 1);
        const wp = this.sector.site.waypoints[idx];
        if (wp) l.position.copy(this.gridToWorld(wp.col, wp.row, 1.2));
      });
      this.hotspotGroup.visible = false;
      this.cepRingGroup.visible = false;
      this.material.transparent = false;
      this.material.opacity = 1.0;
      if (this.strataCurtainMesh) this.strataCurtainMesh.visible = false;
      if (this.naiveRouteMesh) this.naiveRouteMesh.visible = false;

      this.rebuildActiveRouteTube();
      this.updateCameraAlongRoute(true);
    } else if (!enabled && this.povMode) {
      this.povMode = false;
      this.autoWalkActive = false;
      this.controls.enabled = true;

      this.scene.background = new THREE.Color(0x0d0907);
      this.scene.fog = new THREE.FogExp2(0x1a0f0a, 0.0038);
      this.material.bumpScale = 0.42;

      this.habMesh.scale.setScalar(1.0);
      this.habMesh.position.copy(
        this.gridToWorld(this.sector.site.habCol, this.sector.site.habRow, 1.6)
      );
      this.habLabel.scale.set(9.5, 2.4, 1);
      this.habLabel.position.copy(
        this.gridToWorld(this.sector.site.habCol, this.sector.site.habRow, 4.4)
      );
      this.waypointGroup.children.forEach((c) => c.scale.setScalar(1.0));
      this.labelGroup.children.forEach((l, idx) => {
        l.scale.set(9.5, 2.4, 1);
        const wp = this.sector.site.waypoints[idx];
        if (wp) l.position.copy(this.gridToWorld(wp.col, wp.row, 4.3));
      });
      this.hotspotGroup.visible = true;
      this.cepRingGroup.visible = true;
      this.material.transparent = this.strataCurtainVisible;
      this.material.opacity = this.strataCurtainVisible ? 0.44 : 1.0;
      if (this.strataCurtainMesh) this.strataCurtainMesh.visible = this.strataCurtainVisible;
      if (this.naiveRouteMesh) this.naiveRouteMesh.visible = true;

      this.rebuildActiveRouteTube();
      this.camera.position.copy(this.savedOrbitalPos);
      this.controls.target.copy(this.savedOrbitalTarget);
      this.controls.update();
      this.astronautMesh.visible = false;
      this.onVisorUpdate?.(null);
    }
  }

  public setRouteProgress(progress01: number, snap = false): void {
    this.routeProgress = Math.max(0, Math.min(1, progress01));
    this.updateCameraAlongRoute(snap);
  }

  public getRouteProgress(): number {
    return this.routeProgress;
  }

  private updateCameraAlongRoute(snap = false): void {
    if (!this.activeCurve || this.activePathIndices.length < 2) {
      this.onVisorUpdate?.(null);
      return;
    }

    const u = Math.max(0, Math.min(0.992, this.routeProgress));
    const lookU = Math.min(1.0, u + 0.065);
    const pos = this.activeCurve.getPointAt(u);
    const lookPos = this.activeCurve.getPointAt(lookU);

    this.astronautMesh.position.set(pos.x, pos.y + 0.85, pos.z);
    this.astronautMesh.visible = !this.povMode;

    if (this.povMode) {
      const targetCam = new THREE.Vector3(pos.x, pos.y + 0.72, pos.z);
      const targetLook = new THREE.Vector3(lookPos.x, lookPos.y + 0.45, lookPos.z);

      if (snap || this.smoothedCamPos.lengthSq() === 0) {
        this.smoothedCamPos.copy(targetCam);
        this.smoothedLookPos.copy(targetLook);
      } else {
        this.smoothedCamPos.lerp(targetCam, 0.14);
        this.smoothedLookPos.lerp(targetLook, 0.14);
      }

      this.camera.position.copy(this.smoothedCamPos);
      this.camera.lookAt(this.smoothedLookPos);

      const n = this.activePathIndices.length;
      const stepIdx = Math.min(n - 1, Math.floor(u * (n - 1)));
      const cellIdx = this.activePathIndices[stepIdx];
      const { gridSize, worldSizeMeters } = this.sector;
      const row = Math.floor(cellIdx / gridSize);
      const col = cellIdx % gridSize;

      const dx = this.smoothedLookPos.x - this.smoothedCamPos.x;
      const dz = this.smoothedLookPos.z - this.smoothedCamPos.z;
      const headingDeg = (Math.round((Math.atan2(dx, -dz) * 180) / Math.PI) + 360) % 360;
      const cardIdx = Math.round(headingDeg / 45) % 8;

      const hasUhf = this.sector.commsLos[cellIdx] === 1;
      const cep = this.activePathCep[stepIdx] || 0.8;
      const cellStep = worldSizeMeters / (gridSize - 1);
      let visPeaks = 0;
      for (const lm of this.sector.landmarks) {
        if (
          hasLineOfSight(
            this.sector.elevation,
            gridSize,
            cellStep,
            col,
            row,
            1.8,
            lm.col,
            lm.row,
            2.0
          )
        ) {
          visPeaks++;
        }
      }

      const navModeLabel = hasUhf
        ? `UHF RANGING LOCK (±${cep.toFixed(1)}m)`
        : visPeaks >= 2
          ? `SKYLINE TRIANGULATION [${visPeaks} PEAKS] (±${cep.toFixed(1)}m)`
          : `IMU DEAD RECKONING DRIFT (±${cep.toFixed(1)}m)`;

      this.onVisorUpdate?.({
        progressPct: Math.round(u * 100),
        col,
        row,
        elevMeters: Math.round(this.sector.site.baseDatumMeters + this.sector.elevation[cellIdx]),
        slopeDeg: Math.round(this.sector.slopeDeg[cellIdx] * 10) / 10,
        headingDeg,
        headingCardinal: CARDINALS[cardIdx],
        skyViewPct: Math.round(this.sector.skyViewFactor[cellIdx] * 100),
        sunlit: this.sector.solarShadow[cellIdx] === 1,
        commsLos: hasUhf,
        geologicUnitId: this.sector.geologicUnit[cellIdx] ?? 1,
        cepMeters: cep,
        navModeLabel,
        iceDepthMeters: Math.round(this.sector.iceTableDepthM[cellIdx] * 10) / 10,
      });
    } else {
      this.onVisorUpdate?.(null);
    }
  }

  public applyHeatmap(mode: LayerMode): void {
    this.currentMode = mode;
    const c = new THREE.Color();
    const {
      elevation,
      slopeDeg,
      thermalInertia,
      roughness,
      skyViewFactor,
      solarShadow,
      commsLos,
      walkbackO2,
      discoveryScore,
      gridSize,
    } = this.sector;

    for (let i = 0; i < gridSize * gridSize; i++) {
      if (mode === 'mars') {
        const vScale = this.sceneSpan / this.sector.worldSizeMeters;
        const t = Math.max(0, Math.min(1, (elevation[i] * vScale + 8) / 22));
        c.setHSL(0.05 + t * 0.03, 0.65, 0.28 + t * 0.36);
      } else if (mode === 'slope') {
        const hazard = Math.min(slopeDeg[i] / 35, 1.0);
        c.setHSL((1.0 - hazard) * 0.33, 0.9, 0.45);
      } else if (mode === 'sand') {
        const safe = Math.max(0, Math.min(1, (thermalInertia[i] - 50) / 280));
        c.setHSL(0.58 - safe * 0.45, 0.85, 0.45);
      } else if (mode === 'roughness') {
        const rNorm = Math.min(roughness[i] / 0.9, 1.0);
        c.setHSL((1.0 - rNorm) * 0.33, 0.85, 0.45);
      } else if (mode === 'radiation') {
        const exposure = Math.max(0, Math.min(1, (skyViewFactor[i] - 0.45) / 0.55));
        c.setHSL((1.0 - exposure) * 0.48, 0.9, 0.45);
      } else if (mode === 'solar') {
        if (solarShadow[i] === 1) {
          c.setHSL(0.12, 0.95, 0.52);
        } else {
          c.setHSL(0.66, 0.7, 0.16);
        }
      } else if (mode === 'comms') {
        if (commsLos[i] === 1) {
          c.setHSL(0.46, 0.9, 0.42);
        } else {
          c.setHSL(0.98, 0.85, 0.22);
        }
      } else if (mode === 'walkback') {
        const o2 = walkbackO2[i];
        const limit = SINGLE_SORTIE_WALKBACK_LIMIT_O2;
        if (!Number.isFinite(o2)) {
          c.setHSL(0.0, 0.0, 0.08);
        } else if (Math.abs(o2 - limit) <= 2.4) {
          c.setRGB(1.0, 0.98, 0.92);
        } else if (Math.abs(o2 - limit * 0.5) <= 1.5) {
          c.setHSL(0.48, 1.0, 0.7);
        } else if (o2 < limit) {
          const frac = o2 / limit;
          c.setHSL((1.0 - frac) * 0.36, 0.9, 0.42);
        } else {
          c.setHSL(0.98, 0.85, 0.16);
        }
      } else {
        const score = discoveryScore ? discoveryScore[i] : 0;
        if (score > 55) {
          const norm = Math.min(1.0, (score - 55) / 45);
          c.setHSL(0.38 - norm * 0.24, 1.0, 0.48 + norm * 0.22);
        } else if (score > 20) {
          const norm = (score - 20) / 35;
          c.setHSL(0.55 - norm * 0.15, 0.85, 0.22 + norm * 0.22);
        } else {
          c.setHSL(0.68, 0.35, 0.12);
        }
      }

      const shadowDim =
        mode !== 'solar' && mode !== 'walkback' && mode !== 'discovery' && solarShadow[i] === 0
          ? 0.52
          : 1.0;
      this.colorBuffer[i * 3] = c.r * shadowDim;
      this.colorBuffer[i * 3 + 1] = c.g * shadowDim;
      this.colorBuffer[i * 3 + 2] = c.b * shadowDim;
    }
    this.geometry.attributes.color.needsUpdate = true;
  }

  public getCurrentMode(): LayerMode {
    return this.currentMode;
  }

  public setSolHour(solHour: number): void {
    const angle = ((solHour - 6) / 12) * Math.PI;
    this.sunLight.position.set(
      Math.cos(angle) * 100,
      Math.max(8, Math.sin(angle) * 100),
      35
    );
  }

  public onTerrainClick(
    callback: (col: number, row: number, shiftKey: boolean) => void
  ): void {
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.povMode) return;
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObject(this.terrainMesh);
      if (hits.length > 0) {
        const pt = hits[0].point;
        const { gridSize } = this.sector;
        const col = Math.round(((pt.x + this.sceneSpan / 2) / this.sceneSpan) * (gridSize - 1));
        const row = Math.round(((pt.z + this.sceneSpan / 2) / this.sceneSpan) * (gridSize - 1));
        callback(
          Math.max(1, Math.min(gridSize - 2, col)),
          Math.max(1, Math.min(gridSize - 2, row)),
          e.shiftKey
        );
      }
    });
  }

  public startRenderLoop(onProgressTick?: (pct: number) => void): void {
    let lastTime = performance.now();
    const animate = (now: number) => {
      requestAnimationFrame(animate);
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      if (this.povMode) {
        if (this.autoWalkActive && this.hasActiveRoute()) {
          let nextP = this.routeProgress + dt * 0.045;
          if (nextP >= 1.0) nextP = 0;
          this.setRouteProgress(nextP, false);
          onProgressTick?.(Math.round(nextP * 100));
        }
      } else {
        this.controls.update();
      }
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(animate);
  }
}
