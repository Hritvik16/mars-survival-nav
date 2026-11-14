// src/viewer/scene3D.ts
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { LayerMode, SectorBuffers } from '../core/sectorData';

export class Scene3DHarness {
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly controls: OrbitControls;

  private sunLight: THREE.DirectionalLight;
  private terrainMesh: THREE.Mesh;
  private geometry: THREE.PlaneGeometry;
  private colorBuffer: Float32Array;
  private sector: SectorBuffers;
  private currentMode: LayerMode = 'mars';
  private habMesh: THREE.Mesh;
  private targetMesh: THREE.Mesh;
  private routeMesh: THREE.Mesh | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  constructor(container: HTMLElement, sector: SectorBuffers) {
    this.sector = sector;

    // 1. Scene & Camera
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0907);

    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 75, 95);

    // 2. Renderer & Controls
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.replaceWith(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    // 3. Lighting
    this.sunLight = new THREE.DirectionalLight(0xfff0dd, 2.2);
    this.sunLight.position.set(60, 80, 40);
    this.scene.add(this.sunLight, new THREE.AmbientLight(0x403028, 0.8));

    // 4. Terrain Geometry & Vertex Buffers
    const { gridSize, worldSizeMeters } = sector;
    this.geometry = new THREE.PlaneGeometry(
      worldSizeMeters,
      worldSizeMeters,
      gridSize - 1,
      gridSize - 1
    );
    this.geometry.rotateX(-Math.PI / 2);

    this.colorBuffer = new Float32Array(gridSize * gridSize * 3);
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colorBuffer, 3));

    this.terrainMesh = new THREE.Mesh(
      this.geometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 })
    );
    this.scene.add(this.terrainMesh);

    // Habitat lander beacon (cyan) & EVA target marker (amber/green)
    this.habMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.3, 3.2, 12),
      new THREE.MeshBasicMaterial({ color: 0x00f0ff })
    );
    this.targetMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0xffaa00 })
    );
    this.targetMesh.visible = false;
    this.scene.add(this.habMesh, this.targetMesh);

    this.syncElevationBuffer();
    this.applyHeatmap('mars');

    // 5. Responsive Window Resize
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  private gridToWorld(col: number, row: number, yOffset = 0): THREE.Vector3 {
    const { gridSize, worldSizeMeters, elevation } = this.sector;
    const x = (col / (gridSize - 1) - 0.5) * worldSizeMeters;
    const z = (row / (gridSize - 1) - 0.5) * worldSizeMeters;
    const y = elevation[row * gridSize + col] + yOffset;
    return new THREE.Vector3(x, y, z);
  }

  /** Switches active planetary sector and refreshes 3D mesh + beacons */
  public setSector(newSector: SectorBuffers): void {
    this.sector = newSector;
    this.clearRoute();
    this.syncElevationBuffer();
    this.applyHeatmap(this.currentMode);
  }

  /** Pushes CPU Float32Array elevation changes to the GPU mesh */
  public syncElevationBuffer(): void {
    const posAttr = this.geometry.attributes.position;
    const { elevation, gridSize, site } = this.sector;
    for (let i = 0; i < gridSize * gridSize; i++) {
      posAttr.setY(i, elevation[i]);
    }
    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.habMesh.position.copy(this.gridToWorld(site.habCol, site.habRow, 1.6));
  }

  /** Renders high-visibility 3D EVA route tube above terrain mesh */
  public renderRoute(pathIndices: Int32Array, isSafeHaven = false): void {
    this.clearRoute();
    if (pathIndices.length < 2) return;

    const { gridSize } = this.sector;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < pathIndices.length; i++) {
      const idx = pathIndices[i];
      const r = Math.floor(idx / gridSize);
      const c = idx % gridSize;
      pts.push(this.gridToWorld(c, r, 0.55));
    }

    const lastIdx = pathIndices[pathIndices.length - 1];
    const goalR = Math.floor(lastIdx / gridSize);
    const goalC = lastIdx % gridSize;
    this.targetMesh.position.copy(this.gridToWorld(goalC, goalR, 1.1));
    (this.targetMesh.material as THREE.MeshBasicMaterial).color.setHex(
      isSafeHaven ? 0x00ff88 : 0xffaa00
    );
    this.targetMesh.visible = true;

    const curve = new THREE.CatmullRomCurve3(pts);
    const tubeGeo = new THREE.TubeGeometry(curve, Math.min(pts.length * 2, 240), 0.35, 6, false);
    const tubeMat = new THREE.MeshBasicMaterial({
      color: isSafeHaven ? 0x00ff88 : 0x00f0ff,
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
    this.targetMesh.visible = false;
  }

  /** Fast zero-texture vertex RGB heatmap switcher */
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
      gridSize,
    } = this.sector;

    for (let i = 0; i < gridSize * gridSize; i++) {
      if (mode === 'mars') {
        const t = Math.max(0, Math.min(1, (elevation[i] + 8) / 22));
        c.setHSL(0.05 + t * 0.03, 0.65, 0.25 + t * 0.35);
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
        // Golden amber = direct solar array charging (1), Deep indigo = cold shadow drain (0)
        if (solarShadow[i] === 1) {
          c.setHSL(0.12, 0.95, 0.52);
        } else {
          c.setHSL(0.66, 0.7, 0.16);
        }
      } else {
        // Habitat UHF Comms LOS: Cyan/Green = active link (1), Crimson/Dark = radio blackout (0)
        if (commsLos[i] === 1) {
          c.setHSL(0.46, 0.9, 0.42);
        } else {
          c.setHSL(0.98, 0.85, 0.22);
        }
      }
      this.colorBuffer[i * 3] = c.r;
      this.colorBuffer[i * 3 + 1] = c.g;
      this.colorBuffer[i * 3 + 2] = c.b;
    }
    this.geometry.attributes.color.needsUpdate = true;
  }

  public getCurrentMode(): LayerMode {
    return this.currentMode;
  }

  /** Rotates sun angle based on Martian Sol hour (0 to 24) */
  public setSolHour(solHour: number): void {
    const angle = ((solHour - 6) / 12) * Math.PI; // 6:00 = sunrise, 12:00 = zenith, 18:00 = sunset
    const radius = 100;
    this.sunLight.position.set(Math.cos(angle) * radius, Math.max(8, Math.sin(angle) * radius), 35);
  }

  /** Raycasts mouse click to grid (col, row) coordinates */
  public onTerrainClick(callback: (col: number, row: number, point: THREE.Vector3) => void): void {
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // Left-click only
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);

      const hits = this.raycaster.intersectObject(this.terrainMesh);
      if (hits.length > 0) {
        const pt = hits[0].point;
        const { gridSize, worldSizeMeters } = this.sector;
        const col = Math.round(((pt.x + worldSizeMeters / 2) / worldSizeMeters) * (gridSize - 1));
        const row = Math.round(((pt.z + worldSizeMeters / 2) / worldSizeMeters) * (gridSize - 1));
        callback(col, row, pt);
      }
    });
  }

  public startRenderLoop(onFrame?: () => void): void {
    const animate = () => {
      requestAnimationFrame(animate);
      onFrame?.();
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }
}