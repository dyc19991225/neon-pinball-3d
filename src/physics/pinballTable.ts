import * as THREE from 'three';
import type { PinballAudio } from '../audio/pinballAudio';

interface WallSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  restitution: number;
  isSlingshot?: boolean;
  slingBoost?: number;
  slingMesh?: THREE.Mesh;
  slingMat?: THREE.MeshStandardMaterial;
  slingBaseHex?: number;
  flashTimer?: number;
  oneWayUp?: boolean; // Allows ball moving with vz < 0 out of shooter lane, blocks return
}

interface FlipperEntity {
  side: 'left' | 'right';
  px: number;
  pz: number;
  length: number;
  radius: number;
  restAngle: number;
  activeAngle: number;
  angle: number;
  omega: number;
  pressed: boolean;
  pivotGroup: THREE.Group;
  mat: THREE.MeshStandardMaterial;
}

interface PopBumper {
  x: number;
  z: number;
  radius: number;
  baseHex: number;
  group: THREE.Group;
  capMat: THREE.MeshStandardMaterial;
  ringMat: THREE.MeshBasicMaterial;
  springPos: number;
  springVel: number;
  flashTimer: number;
  points: number;
}

interface DropTarget {
  x: number;
  z: number;
  radius: number;
  bank: 'left' | 'right';
  down: boolean;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  baseHex: number;
  flashTimer: number;
}

interface RolloverLane {
  x: number;
  z: number;
  lit: boolean;
  cooldown: number;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
}

interface BallEntity {
  x: number;
  z: number;
  vx: number;
  vz: number;
  colorHex: number;
  mesh: THREE.Mesh;
  trailPts: THREE.Vector3[];
  trailGeo: THREE.BufferGeometry;
  trailMesh: THREE.Mesh;
  capturedTimer: number;
}

interface ShockWave {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  progress: number;
  maxScale: number;
}

interface SparkBurst {
  points: THREE.Points;
  vels: Float32Array;
  mat: THREE.PointsMaterial;
  geo: THREE.BufferGeometry;
  age: number;
}

const R_BALL = 0.42;
const SUB_STEPS = 10;
const GRAVITY_Z = 18.8;
const MAX_SPEED = 42.0;

const RANKS = [
  '🚀 太空见习学员 (Cadet)',
  '🛰️ 轨道巡航少尉 (Ensign)',
  '⚡ 脉冲星舰长 (Captain)',
  '🌌 超新星指挥官 (Commander)',
  '👑 银河舰队统帅 (Fleet Admiral)',
];

export class NeonPinballTable {
  private readonly scene: THREE.Scene;
  private readonly audio: PinballAudio;

  private walls: WallSeg[] = [];
  private flippers: FlipperEntity[] = [];
  private bumpers: PopBumper[] = [];
  private targets: DropTarget[] = [];
  private rollovers: RolloverLane[] = [];
  private balls: BallEntity[] = [];
  private waves: ShockWave[] = [];
  private sparks: SparkBurst[] = [];

  // Plunger state (2nd-order spring!)
  private plungerPull = 0; // 0 .. 1
  private plungerCharging = false;
  private plungerPos = 0;
  private plungerVel = 0;
  private plungerMesh!: THREE.Group;

  // Wormhole center saucer
  private readonly wormholePos = { x: -0.9, z: 0.5 };
  private wormholeRing!: THREE.Mesh;
  private wormholeInner!: THREE.Mesh;
  private wormholeCaptures = 0;

  // Ball Saver shield between flippers
  private saverTimer = 15.0;
  private saverMesh!: THREE.Mesh;
  private saverMat!: THREE.MeshBasicMaterial;

  // Game progression state
  public score = 0;
  public highScore = 0;
  public ballsRemaining = 3;
  public multiplier = 1;
  public rankIdx = 0;
  public comboCount = 0;
  private comboTimer = 0;
  public tiltPenaltyTimer = 0;
  private nudgeHeat = 0;

  // Callbacks to main HUD & Camera Rig
  public onImpactFeel: ((trauma: number, hitstopSec: number, flash?: number) => void) | null = null;
  public onCallout: ((msg: string) => void) | null = null;

  private readonly ringGeo = new THREE.SphereGeometry(1, 20, 14);

  constructor(scene: THREE.Scene, audio: PinballAudio) {
    this.scene = scene;
    this.audio = audio;
    const saved = Number(localStorage.getItem('neon_pinball_hi') || '0');
    if (Number.isFinite(saved)) this.highScore = saved;

    this.buildCabinetAndWalls();
    this.buildFlippers();
    this.buildBumpersAndTargets();
    this.buildWormholeAndPlunger();
    this.spawnBallInShooterLane(0x38bdf8);
  }

  public getRankTitle(): string {
    return RANKS[Math.min(RANKS.length - 1, this.rankIdx)];
  }

  public getLeadBallPos(): { x: number; z: number } {
    if (this.balls.length === 0) return { x: -0.9, z: 4 };
    let lead = this.balls[0];
    for (const b of this.balls) {
      if (b.z > lead.z && b.x < 6.8) lead = b;
    }
    return { x: lead.x, z: lead.z };
  }

  public getActiveBallCount(): number {
    return this.balls.length;
  }

  public getSaverSeconds(): number {
    return Math.max(0, Math.ceil(this.saverTimer));
  }

  // ==========================================================================
  // 1. Build Neon Space-Cadet Cabinet, Rails, Arch & Slingshots
  // ==========================================================================
  private buildCabinetAndWalls(): void {
    // Glossy Dark Cyber Playfield Deck
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(18.6, 0.6, 31.6),
      new THREE.MeshStandardMaterial({
        color: 0x090e1c,
        roughness: 0.28,
        metalness: 0.55,
      })
    );
    deck.position.set(0, -0.32, -0.4);
    this.scene.add(deck);

    // Subtle Tron grid etched on playfield
    const grid = new THREE.GridHelper(30, 30, 0x1e3a5f, 0x111c33);
    grid.position.set(0, 0.01, -0.4);
    this.scene.add(grid);

    // Outer Neon Frame Walls
    this.addNeonWall(-8.8, -6.5, -8.8, 9.6, 0x38bdf8, 0.55); // Left outer rail
    this.addNeonWall(8.8, 14.2, 8.8, -6.5, 0x38bdf8, 0.55); // Right shooter outer rail
    this.addNeonWall(7.0, 14.2, 7.0, -5.4, 0xf59e0b, 0.55); // Shooter lane divider
    this.addNeonWall(7.0, 14.2, 8.8, 14.2, 0xf59e0b, 0.25); // Shooter bottom floor

    // One-way launch gate at top of shooter lane so balls enter arch cleanly & never fall back in!
    this.walls.push({
      ax: 7.0,
      az: -5.4,
      bx: 8.8,
      bz: -6.5,
      restitution: 0.65,
      oneWayUp: true,
    });

    // Smooth 20-segment Top Semicircular Launch Arch (Center (0, -6.5), Radius 8.8)
    const archSegs = 20;
    for (let i = 0; i < archSegs; i++) {
      const a0 = -(i / archSegs) * Math.PI;
      const a1 = -((i + 1) / archSegs) * Math.PI;
      const x0 = Math.cos(a0) * 8.8;
      const z0 = -6.5 + Math.sin(a0) * 8.8;
      const x1 = Math.cos(a1) * 8.8;
      const z1 = -6.5 + Math.sin(a1) * 8.8;
      this.addNeonWall(x0, z0, x1, z1, i % 2 === 0 ? 0x38bdf8 : 0xa855f7, 0.52);
    }

    // Bottom Left & Right Inlane Aprons feeding directly onto the Flippers!
    this.addNeonWall(-8.8, 9.6, -3.35, 12.55, 0x38bdf8, 0.42);
    this.addNeonWall(7.0, 9.6, 1.55, 12.55, 0x38bdf8, 0.42);

    // Guide rails above inlanes
    this.addNeonWall(-7.2, 6.2, -7.2, 8.8, 0x22d3ee, 0.5);
    this.addNeonWall(5.4, 6.2, 5.4, 8.8, 0x22d3ee, 0.5);

    // Left & Right Triangular High-Voltage Slingshot Kickers!
    this.buildSlingshot(-6.0, 6.8, -3.85, 10.4, -6.0, 10.0, 0xf472b6);
    this.buildSlingshot(4.2, 6.8, 2.05, 10.4, 4.2, 10.0, 0xf472b6);
  }

  private addNeonWall(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    colorHex: number,
    restitution: number
  ): void {
    this.walls.push({ ax, az, bx, bz, restitution });
    const len = Math.hypot(bx - ax, bz - az);
    const angle = Math.atan2(bz - az, bx - ax);
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(len + 0.16, 0.68, 0.22),
      new THREE.MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 0.65,
        roughness: 0.25,
        metalness: 0.5,
      })
    );
    rail.position.set((ax + bx) * 0.5, 0.34, (az + bz) * 0.5);
    rail.rotation.y = -angle;
    this.scene.add(rail);
  }

  private buildSlingshot(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    cx: number,
    cz: number,
    hex: number
  ): void {
    const mat = new THREE.MeshStandardMaterial({
      color: hex,
      emissive: hex,
      emissiveIntensity: 0.85,
      roughness: 0.3,
    });
    const len = Math.hypot(bx - ax, bz - az);
    const angle = Math.atan2(bz - az, bx - ax);
    const kickerFace = new THREE.Mesh(new THREE.BoxGeometry(len, 0.62, 0.26), mat);
    kickerFace.position.set((ax + bx) * 0.5, 0.32, (az + bz) * 0.5);
    kickerFace.rotation.y = -angle;
    this.scene.add(kickerFace);

    // Kicker active face + 2 side backing walls
    this.walls.push({
      ax,
      az,
      bx,
      bz,
      restitution: 1.35,
      isSlingshot: true,
      slingBoost: 23.5,
      slingMesh: kickerFace,
      slingMat: mat,
      slingBaseHex: hex,
      flashTimer: 0,
    });
    this.addNeonWall(bx, bz, cx, cz, 0x64748b, 0.45);
    this.addNeonWall(cx, cz, ax, az, 0x64748b, 0.45);
  }

  // ==========================================================================
  // 2. Build Solenoid Flippers (Left, Right + Upper-Left Space-Cadet Flipper!)
  // ==========================================================================
  private buildFlippers(): void {
    // Left Main Flipper
    this.createFlipper('left', -3.35, 12.55, 2.22, 0.44, -0.58, 0x38bdf8);
    // Right Main Flipper
    this.createFlipper('right', 1.55, 12.55, 2.22, Math.PI - 0.44, Math.PI + 0.58, 0x38bdf8);
    // Upper-Left Space-Cadet Bonus Flipper for cross-table Wormhole & Drop-Target shots!
    this.createFlipper('left', -7.25, 2.1, 1.85, 0.52, -0.52, 0xfacc15);
  }

  private createFlipper(
    side: 'left' | 'right',
    px: number,
    pz: number,
    length: number,
    restAngle: number,
    activeAngle: number,
    hex: number
  ): void {
    const pivotGroup = new THREE.Group();
    pivotGroup.position.set(px, 0.36, pz);

    const mat = new THREE.MeshStandardMaterial({
      color: hex,
      emissive: hex,
      emissiveIntensity: 0.78,
      roughness: 0.2,
      metalness: 0.45,
    });

    const body = new THREE.Mesh(new THREE.BoxGeometry(length, 0.56, 0.52), mat);
    body.position.x = length * 0.5;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.62, 16), mat);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.56, 14), mat);
    tip.position.x = length;

    pivotGroup.add(hub, body, tip);
    pivotGroup.rotation.y = -restAngle;
    this.scene.add(pivotGroup);

    this.flippers.push({
      side,
      px,
      pz,
      length,
      radius: 0.3,
      restAngle,
      activeAngle,
      angle: restAngle,
      omega: 0,
      pressed: false,
      pivotGroup,
      mat,
    });
  }

  public setFlipperPressed(side: 'left' | 'right', down: boolean): void {
    let changed = false;
    for (const f of this.flippers) {
      if (f.side === side && f.pressed !== down) {
        f.pressed = down;
        changed = true;
      }
    }
    if (changed) {
      this.audio.playFlipperSnap(down);
      if (down) this.cycleRolloverLanes(side === 'right' ? 1 : -1);
    }
  }

  private cycleRolloverLanes(dir: 1 | -1): void {
    if (this.rollovers.length < 3) return;
    const states = this.rollovers.map((r) => r.lit);
    for (let i = 0; i < 3; i++) {
      const srcIdx = (i - dir + 3) % 3;
      this.rollovers[i].lit = states[srcIdx];
      this.rollovers[i].mat.color.setHex(this.rollovers[i].lit ? 0xfacc15 : 0x1e293b);
    }
  }

  // ==========================================================================
  // 3. Build 4 Neon Pop Bumpers, 3 Top Rollover Lanes & 6 Cyber Drop-Targets
  // ==========================================================================
  private buildBumpersAndTargets(): void {
    const bumperSpecs = [
      { x: -3.2, z: -6.8, hex: 0xf43f5e, pts: 1500 },
      { x: 1.4, z: -6.8, hex: 0x22d3ee, pts: 1500 },
      { x: -0.9, z: -4.2, hex: 0xa855f7, pts: 2500 },
      { x: -3.7, z: -1.8, hex: 0xf59e0b, pts: 2000 },
    ];

    for (const s of bumperSpecs) {
      const group = new THREE.Group();
      group.position.set(s.x, 0, s.z);

      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.52, 0.6, 16),
        new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.85, roughness: 0.18 })
      );
      post.position.y = 0.3;

      const capMat = new THREE.MeshStandardMaterial({
        color: s.hex,
        emissive: s.hex,
        emissiveIntensity: 1.15,
        roughness: 0.22,
        metalness: 0.35,
      });
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.82, 0.38, 22), capMat);
      cap.position.y = 0.68;

      const ringMat = new THREE.MeshBasicMaterial({
        color: s.hex,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
      });
      const baseHalo = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.08, 10, 28), ringMat);
      baseHalo.rotation.x = Math.PI / 2;
      baseHalo.position.y = 0.08;

      group.add(post, cap, baseHalo);
      this.scene.add(group);

      this.bumpers.push({
        x: s.x,
        z: s.z,
        radius: 0.92,
        baseHex: s.hex,
        group,
        capMat,
        ringMat,
        springPos: 1,
        springVel: 0,
        flashTimer: 0,
        points: s.pts,
      });
    }

    // 3 Top Rollover Multiplier Lanes (I - O - N) + Lane Divider Fins
    const laneXs = [-3.1, -0.9, 1.3];
    for (const dividerX of [-4.2, -2.0, 0.2, 2.4]) {
      this.addNeonWall(dividerX, -11.4, dividerX, -9.4, 0x818cf8, 0.45);
    }
    for (const lx of laneXs) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x1e293b });
      const pad = new THREE.Mesh(new THREE.CircleGeometry(0.46, 20), mat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(lx, 0.05, -10.4);
      this.scene.add(pad);
      this.rollovers.push({ x: lx, z: -10.4, lit: false, cooldown: 0, mesh: pad, mat });
    }

    // Left & Right 3-Bank Drop Targets!
    for (let i = 0; i < 3; i++) {
      this.createDropTarget(5.1, -3.6 + i * 1.55, 'right', 0x4ade80);
      this.createDropTarget(-7.1, -5.2 + i * 1.55, 'left', 0xf472b6);
    }
  }

  private createDropTarget(x: number, z: number, bank: 'left' | 'right', hex: number): void {
    const mat = new THREE.MeshStandardMaterial({
      color: hex,
      emissive: hex,
      emissiveIntensity: 0.9,
      roughness: 0.25,
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.72, 1.05), mat);
    mesh.position.set(x, 0.36, z);
    this.scene.add(mesh);
    this.targets.push({
      x,
      z,
      radius: 0.56,
      bank,
      down: false,
      mesh,
      mat,
      baseHex: hex,
      flashTimer: 0,
    });
  }

  // ==========================================================================
  // 4. Build Space-Cadet Center Hyperspace Wormhole + Coil Plunger + Auto-Save
  // ==========================================================================
  private buildWormholeAndPlunger(): void {
    // Center Hyperspace Wormhole Saucer
    this.wormholeRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.18, 0.12, 12, 36),
      new THREE.MeshBasicMaterial({
        color: 0xc084fc,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
      })
    );
    this.wormholeRing.rotation.x = Math.PI / 2;
    this.wormholeRing.position.set(this.wormholePos.x, 0.14, this.wormholePos.z);

    this.wormholeInner = new THREE.Mesh(
      new THREE.TorusGeometry(0.68, 0.08, 10, 28),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
      })
    );
    this.wormholeInner.rotation.x = Math.PI / 2;
    this.wormholeInner.position.set(this.wormholePos.x, 0.18, this.wormholePos.z);
    this.scene.add(this.wormholeRing, this.wormholeInner);

    // Shooter Lane Spring Plunger
    this.plungerMesh = new THREE.Group();
    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.24, 2.4, 14),
      new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.75, roughness: 0.25 })
    );
    rod.rotation.x = Math.PI / 2;
    rod.position.z = 1.2;
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.55, 0.35),
      new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0xea580c, emissiveIntensity: 0.65 })
    );
    this.plungerMesh.add(rod, head);
    this.plungerMesh.position.set(7.9, 0.35, 12.6);
    this.scene.add(this.plungerMesh);

    // Auto-Save Plasma Shield Beacon between Flippers
    this.saverMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.saverMesh = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.68, 24), this.saverMat);
    this.saverMesh.rotation.x = -Math.PI / 2;
    this.saverMesh.position.set(-0.9, 0.06, 12.6);
    this.scene.add(this.saverMesh);
  }

  // ==========================================================================
  // 5. Ball Spawning, Plunger Launch, Multiball & Table Nudge!
  // ==========================================================================
  public spawnBallInShooterLane(hex = 0x38bdf8): void {
    this.createBall(7.9, 11.6, 0, 0, hex);
  }

  private createBall(x: number, z: number, vx: number, vz: number, hex: number): void {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(R_BALL, 24, 20),
      new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        emissive: hex,
        emissiveIntensity: 0.38,
        metalness: 0.94,
        roughness: 0.08,
      })
    );
    mesh.position.set(x, R_BALL, z);
    this.scene.add(mesh);

    // Sub-stepped glowing comet ribbon trail ($gamefeel-3d Rule #7)
    const trailGeo = new THREE.BufferGeometry();
    const trailMat = new THREE.MeshBasicMaterial({
      color: hex,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const trailMesh = new THREE.Mesh(trailGeo, trailMat);
    trailMesh.frustumCulled = false;
    this.scene.add(trailMesh);

    this.balls.push({
      x,
      z,
      vx,
      vz,
      colorHex: hex,
      mesh,
      trailPts: [],
      trailGeo,
      trailMesh,
      capturedTimer: 0,
    });
  }

  public setPlungerHold(holding: boolean): void {
    if (holding) {
      this.plungerCharging = true;
    } else if (this.plungerCharging) {
      this.plungerCharging = false;
      const ratio = Math.max(0.38, this.plungerPull);
      this.audio.playPlungerLaunch(ratio);
      this.plungerVel = -28 * ratio;

      // Fire any ball waiting in the shooter lane!
      let launched = false;
      for (const b of this.balls) {
        if (b.x > 6.9 && b.z > 8.5) {
          b.vz = -(31 + ratio * 10 + (Math.random() - 0.5) * 1.6);
          b.vx = -0.35;
          launched = true;
        }
      }
      // Convenience: if player hits Space when all balls are already in play, give a subtle skill-shot nudge if none in lane
      if (launched) {
        this.saverTimer = Math.max(this.saverTimer, 14.0);
        this.onImpactFeel?.(0.28 * ratio, 0);
        this.onCallout?.('🚀 满蓄力弹射升空！冲刺顶部倍率通道！');
      }
      this.plungerPull = 0;
    }
  }

  public triggerPartyMultiball(count = 4): void {
    this.audio.playMultiballJackpot();
    this.saverTimer = Math.max(this.saverTimer, 16.0);
    const palette = [0xfacc15, 0xf472b6, 0x4ade80, 0xc084fc, 0x38bdf8];
    for (let i = 0; i < count; i++) {
      const ang = -Math.PI * 0.85 + (i / Math.max(1, count - 1)) * Math.PI * 0.7;
      const spd = 21 + Math.random() * 7;
      this.createBall(
        this.wormholePos.x + Math.cos(ang) * 0.6,
        this.wormholePos.z + Math.sin(ang) * 0.6,
        Math.cos(ang) * spd,
        Math.sin(ang) * spd,
        palette[i % palette.length]
      );
    }
    this.spawnFresnelWave(this.wormholePos.x, this.wormholePos.z, 0xfacc15, 7.5);
    this.onImpactFeel?.(0.72, 0.055, 0.75);
    this.onCallout?.(`🔥 HYPER MULTIBALL ×${this.balls.length} 满屏狂暴多球开启！`);
  }

  public nudgeTable(): void {
    if (this.tiltPenaltyTimer > 0) return;
    this.nudgeHeat += 1.0;
    if (this.nudgeHeat >= 3.0) {
      this.tiltPenaltyTimer = 3.2;
      this.audio.playNudgeBump(true);
      this.onImpactFeel?.(0.68, 0.04, 0.45);
      this.onCallout?.('⚠️ TILT 违规剧烈晃台！挡板锁死 3 秒！');
      return;
    }
    this.audio.playNudgeBump(false);
    const kickX = (Math.random() > 0.5 ? 1 : -1) * 5.2;
    for (const b of this.balls) {
      b.vx += kickX;
      b.vz -= 4.2;
    }
    this.onImpactFeel?.(0.32, 0);
    this.onCallout?.('⚡ 晃台救球！小心连续猛晃触发 TILT！');
  }

  public resetNewGame(): void {
    for (const b of this.balls) {
      this.scene.remove(b.mesh);
      this.scene.remove(b.trailMesh);
      b.trailGeo.dispose();
    }
    this.balls.length = 0;
    this.score = 0;
    this.ballsRemaining = 3;
    this.multiplier = 1;
    this.rankIdx = 0;
    this.comboCount = 0;
    this.saverTimer = 16.0;
    this.resetBank('left');
    this.resetBank('right');
    for (const r of this.rollovers) {
      r.lit = false;
      r.mat.color.setHex(0x1e293b);
    }
    this.spawnBallInShooterLane(0x38bdf8);
    this.onCallout?.('🕹️ 新一局太空军校生开启！按住 [Space] 蓄力发射！');
  }

  private addPoints(pts: number): void {
    this.score += Math.round(pts * this.multiplier);
    if (this.score > this.highScore) {
      this.highScore = this.score;
      localStorage.setItem('neon_pinball_hi', String(this.highScore));
    }
  }

  // ==========================================================================
  // 6. Main Update: 10x Sub-Stepped Analytical Physics + Springs + Neon VFX!
  // ==========================================================================
  public update(rawDt: number, scaledDt: number, elapsed: number): void {
    if (this.saverTimer > 0) this.saverTimer = Math.max(0, this.saverTimer - scaledDt);
    this.saverMesh.visible = this.saverTimer > 0;
    if (this.saverMesh.visible) {
      this.saverMat.opacity = 0.35 + Math.sin(elapsed * 16) * 0.3;
      this.saverMesh.rotation.z = elapsed * 2.5;
    }

    if (this.comboTimer > 0) {
      this.comboTimer -= scaledDt;
      if (this.comboTimer <= 0) this.comboCount = 0;
    }

    this.nudgeHeat = Math.max(0, this.nudgeHeat - 0.55 * rawDt);
    if (this.tiltPenaltyTimer > 0) {
      this.tiltPenaltyTimer = Math.max(0, this.tiltPenaltyTimer - rawDt);
    }

    // Plunger 2nd-order spring & charge
    if (this.plungerCharging) {
      this.plungerPull = Math.min(1, this.plungerPull + rawDt * 1.35);
      this.plungerPos = this.plungerPull * 1.85;
      this.audio.setPlungerCharge(this.plungerPull);
    } else {
      const force = -240 * this.plungerPos - 18 * this.plungerVel;
      this.plungerVel += force * rawDt;
      this.plungerPos += this.plungerVel * rawDt;
    }
    this.plungerMesh.position.z = 12.6 + Math.max(-0.25, this.plungerPos);

    // Animate Wormhole rings
    this.wormholeRing.rotation.z = elapsed * 3.2;
    this.wormholeInner.rotation.z = -elapsed * 5.8;

    // Update Pop Bumper 2nd-order volume-preserving squash springs + 2-frame white hit-flash!
    for (const bmp of this.bumpers) {
      const f = (1 - bmp.springPos) * 320 - bmp.springVel * 19;
      bmp.springVel += f * rawDt;
      bmp.springPos += bmp.springVel * rawDt;
      const sy = Math.max(0.55, bmp.springPos);
      const sxz = 1 / Math.sqrt(sy); // Volume-preserving squash & stretch ($gamefeel-3d Rule #9)
      bmp.group.scale.set(sxz, sy, sxz);

      if (bmp.flashTimer > 0) {
        bmp.flashTimer -= rawDt;
        bmp.capMat.emissive.setHex(0xffffff);
        bmp.capMat.emissiveIntensity = 2.6;
      } else {
        bmp.capMat.emissive.setHex(bmp.baseHex);
        bmp.capMat.emissiveIntensity = 1.15;
      }
    }

    // Slingshot & Drop-Target hit-flash decay
    for (const w of this.walls) {
      if (w.isSlingshot && w.slingMat && w.slingBaseHex !== undefined) {
        if ((w.flashTimer ?? 0) > 0) {
          w.flashTimer = (w.flashTimer ?? 0) - rawDt;
          w.slingMat.emissive.setHex(0xffffff);
          w.slingMat.emissiveIntensity = 2.4;
        } else {
          w.slingMat.emissive.setHex(w.slingBaseHex);
          w.slingMat.emissiveIntensity = 0.85;
        }
      }
    }

    for (const t of this.targets) {
      if (t.flashTimer > 0) {
        t.flashTimer -= rawDt;
        t.mat.emissive.setHex(0xffffff);
      } else {
        t.mat.emissive.setHex(t.baseHex);
      }
      const targetY = t.down ? -0.32 : 0.36;
      t.mesh.position.y = THREE.MathUtils.lerp(t.mesh.position.y, targetY, 1 - Math.exp(-22 * rawDt));
    }

    for (const r of this.rollovers) {
      if (r.cooldown > 0) r.cooldown -= rawDt;
    }

    // 10x Sub-stepped Analytical Ball & Flipper Physics!
    const subDt = scaledDt / SUB_STEPS;
    for (let step = 0; step < SUB_STEPS; step++) {
      this.stepFlippers(subDt);
      this.stepBalls(subDt);
    }

    // Update Ball Visuals & Sub-Stepped Additive Ribbon Trails
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.mesh.position.set(b.x, R_BALL, b.z);
      this.updateBallTrail(b);

      // Check bottom drain (`z > 15.0`)
      if (b.z > 15.0) {
        this.scene.remove(b.mesh);
        this.scene.remove(b.trailMesh);
        b.trailGeo.dispose();
        this.balls.splice(i, 1);

        if (this.balls.length > 0) {
          // Still in Multiball!
          continue;
        }

        if (this.saverTimer > 0) {
          // AUTO-SAVE SHIELD RESCUE!
          this.audio.playBallDrain(true);
          this.createBall(7.9, 10.5, -0.3, -37.5, 0x4ade80);
          this.onCallout?.('🛡️ 护盾自动救球成功！弹珠已重返战场！');
        } else {
          this.audio.playBallDrain(false);
          this.ballsRemaining--;
          this.multiplier = 1;
          if (this.ballsRemaining > 0) {
            this.saverTimer = 14.0;
            this.spawnBallInShooterLane(0x38bdf8);
            this.onCallout?.(`🎱 剩余弹珠 ${this.ballsRemaining} 颗 · 按住 [Space] 发射！`);
          } else {
            this.onCallout?.(`🏁 本局结束！最终得分 ${this.score.toLocaleString()} · 按 [R] 再来一局！`);
          }
        }
      }
    }

    // Update GLSL Fresnel Shockwaves & Tangent Sparks on rawDt!
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.progress += rawDt * 3.4;
      w.mat.uniforms.uProgress.value = w.progress;
      w.mesh.scale.setScalar(0.4 + Math.pow(Math.min(1, w.progress), 0.55) * w.maxScale);
      if (w.progress >= 1) {
        this.scene.remove(w.mesh);
        w.mat.dispose();
        this.waves.splice(i, 1);
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i];
      sp.age += rawDt;
      const posAttr = sp.geo.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      for (let k = 0; k < sp.vels.length; k += 3) {
        arr[k] += sp.vels[k] * rawDt;
        arr[k + 1] += sp.vels[k + 1] * rawDt;
        arr[k + 2] += sp.vels[k + 2] * rawDt;
        sp.vels[k + 1] -= 18 * rawDt;
      }
      posAttr.needsUpdate = true;
      sp.mat.opacity = Math.max(0, 1 - sp.age / 0.36);
      if (sp.age >= 0.36) {
        this.scene.remove(sp.points);
        sp.geo.dispose();
        sp.mat.dispose();
        this.sparks.splice(i, 1);
      }
    }
  }

  private stepFlippers(dt: number): void {
    const tiltLocked = this.tiltPenaltyTimer > 0;
    for (const f of this.flippers) {
      const target = f.pressed && !tiltLocked ? f.activeAngle : f.restAngle;
      const diff = target - f.angle;
      const maxStep = 28.0 * dt;
      if (Math.abs(diff) <= maxStep) {
        f.omega = dt > 1e-6 ? diff / dt : 0;
        f.angle = target;
      } else {
        const stepAngle = Math.sign(diff) * maxStep;
        f.omega = Math.sign(diff) * 28.0;
        f.angle += stepAngle;
      }
      f.pivotGroup.rotation.y = -f.angle;
    }
  }

  private stepBalls(dt: number): void {
    for (let bi = 0; bi < this.balls.length; bi++) {
      const b = this.balls[bi];

      // Wormhole capture hold & kickout!
      if (b.capturedTimer > 0) {
        b.capturedTimer -= dt;
        const spinAng = performance.now() * 0.018;
        b.x = this.wormholePos.x + Math.cos(spinAng) * 0.42 * b.capturedTimer;
        b.z = this.wormholePos.z + Math.sin(spinAng) * 0.42 * b.capturedTimer;
        b.vx = 0;
        b.vz = 0;
        if (b.capturedTimer <= 0) {
          this.wormholeCaptures++;
          this.rankIdx = Math.min(RANKS.length - 1, this.rankIdx + 1);
          this.addPoints(50000);
          if (this.wormholeCaptures % 2 === 1 && this.balls.length < 3) {
            // Launch 2 bonus Multiballs right out of the Wormhole!
            const outAng = Math.PI * 0.65 + (Math.random() - 0.5) * 0.4;
            b.vx = Math.cos(outAng) * 25;
            b.vz = Math.sin(outAng) * 25;
            this.triggerPartyMultiball(2);
          } else {
            const outAng = -Math.PI * 0.35 + (Math.random() - 0.5) * 0.5;
            b.vx = Math.cos(outAng) * 26;
            b.vz = Math.sin(outAng) * 26;
            this.audio.playSlingshotZap();
            this.spawnFresnelWave(this.wormholePos.x, this.wormholePos.z, 0xc084fc, 5.2);
            this.onImpactFeel?.(0.45, 0.03, 0.35);
            this.onCallout?.(`🌌 虫洞晋升：${this.getRankTitle()} (+${(50000 * this.multiplier).toLocaleString()})`);
          }
        }
        continue;
      }

      // Gravity along inclined playfield (+Z)
      b.vz += GRAVITY_Z * dt;

      // Subtle magnetic funnel pull near Wormhole saucer
      const wdx = this.wormholePos.x - b.x;
      const wdz = this.wormholePos.z - b.z;
      const wDist = Math.hypot(wdx, wdz);
      if (wDist < 1.95 && wDist > 0.05) {
        b.vx += (wdx / wDist) * 14 * dt;
        b.vz += (wdz / wDist) * 14 * dt;
        if (wDist < 0.62 && Math.hypot(b.vx, b.vz) < 25) {
          b.capturedTimer = 0.85;
          this.audio.playWormholeCapture();
          this.onCallout?.('🌀 奇点虫洞捕获弹珠！正在充能跃迁...');
          continue;
        }
      }

      // Clamp max ball speed for arcade control
      const spd = Math.hypot(b.vx, b.vz);
      if (spd > MAX_SPEED) {
        b.vx = (b.vx / spd) * MAX_SPEED;
        b.vz = (b.vz / spd) * MAX_SPEED;
      }

      b.x += b.vx * dt;
      b.z += b.vz * dt;

      // Keep waiting ball resting cleanly on plunger head inside shooter lane
      if (b.x > 7.0 && b.z > 12.0 && b.vz > 0) {
        b.z = 12.0;
        b.vz = 0;
        b.vx = 0;
      }

      // 1) Wall & Slingshot Collisions
      for (const w of this.walls) {
        if (w.oneWayUp && b.vz < 0 && b.x > 6.9) continue;
        this.collideBallSegment(b, w);
      }

      // 2) Rotating Capsule Flipper Collisions
      for (const f of this.flippers) {
        this.collideBallFlipper(b, f);
      }

      // 3) Pop Bumper Collisions
      for (const bmp of this.bumpers) {
        const dx = b.x - bmp.x;
        const dz = b.z - bmp.z;
        const dist = Math.hypot(dx, dz);
        const minDist = R_BALL + bmp.radius;
        if (dist < minDist && dist > 1e-5) {
          const nx = dx / dist;
          const nz = dz / dist;
          b.x = bmp.x + nx * (minDist + 0.02);
          b.z = bmp.z + nz * (minDist + 0.02);

          const kickSpd = Math.max(24.5, Math.hypot(b.vx, b.vz) * 1.12);
          b.vx = nx * kickSpd;
          b.vz = nz * kickSpd;

          this.comboCount++;
          this.comboTimer = 2.6;
          bmp.springPos = 0.62;
          bmp.springVel = -7.5;
          bmp.flashTimer = 0.06;
          this.addPoints(bmp.points * Math.min(5, this.comboCount));

          this.audio.playBumperHit(this.comboCount);
          this.spawnFresnelWave(bmp.x, bmp.z, bmp.baseHex, 3.2);
          this.spawnSparks(b.x, b.z, nx, nz, bmp.baseHex, 14);
          this.onImpactFeel?.(0.28, this.comboCount >= 3 ? 0.022 : 0.012);
        }
      }

      // 4) Drop-Target Collisions
      for (const t of this.targets) {
        if (t.down) continue;
        const dx = b.x - t.x;
        const dz = b.z - t.z;
        const dist = Math.hypot(dx, dz);
        const minDist = R_BALL + t.radius;
        if (dist < minDist && dist > 1e-5) {
          const nx = dx / dist;
          const nz = dz / dist;
          b.x = t.x + nx * (minDist + 0.02);
          b.z = t.z + nz * (minDist + 0.02);
          const vn = b.vx * nx + b.vz * nz;
          if (vn < 0) {
            b.vx -= 1.85 * vn * nx;
            b.vz -= 1.85 * vn * nz;
          }

          t.down = true;
          t.flashTimer = 0.08;
          this.addPoints(4000);
          this.spawnSparks(t.x, t.z, nx, nz, t.baseHex, 12);

          const bankTargets = this.targets.filter((x) => x.bank === t.bank);
          const allDown = bankTargets.every((x) => x.down);
          this.audio.playDropTargetDown(allDown);
          if (allDown) {
            this.addPoints(25000);
            this.onImpactFeel?.(0.46, 0.032, 0.35);
            this.onCallout?.(`🎯 护盾靶组全破！奖励 +${(25000 * this.multiplier).toLocaleString()} 并额外发射援军弹珠！`);
            setTimeout(() => this.resetBank(t.bank), 550);
            if (this.balls.length < 5) {
              this.triggerPartyMultiball(1);
            }
          }
        }
      }

      // 5) Top Rollover Multiplier Lanes
      for (const r of this.rollovers) {
        if (r.cooldown <= 0 && Math.hypot(b.x - r.x, b.z - r.z) < 0.65) {
          r.cooldown = 0.45;
          r.lit = true;
          r.mat.color.setHex(0xfacc15);
          this.addPoints(2000);
          const allLit = this.rollovers.every((x) => x.lit);
          this.audio.playRolloverDing(allLit);
          if (allLit) {
            this.multiplier = Math.min(10, this.multiplier + 1);
            this.onCallout?.(`⚡ 顶部通道全亮！全局得分倍率升至 ×${this.multiplier}！`);
            for (const x of this.rollovers) {
              x.lit = false;
              x.mat.color.setHex(0x1e293b);
            }
          }
        }
      }

      // 6) Ball-to-Ball Elastic Chrome Clack during Multiball!
      for (let bj = bi + 1; bj < this.balls.length; bj++) {
        const b2 = this.balls[bj];
        if (b2.capturedTimer > 0) continue;
        const dx = b2.x - b.x;
        const dz = b2.z - b.z;
        const dist = Math.hypot(dx, dz);
        const minDist = R_BALL * 2;
        if (dist < minDist && dist > 1e-5) {
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = (minDist - dist) * 0.5;
          b.x -= nx * overlap;
          b.z -= nz * overlap;
          b2.x += nx * overlap;
          b2.z += nz * overlap;
          const dvx = b.vx - b2.vx;
          const dvz = b.vz - b2.vz;
          const relVn = dvx * nx + dvz * nz;
          if (relVn > 0) {
            b.vx -= relVn * nx * 0.96;
            b.vz -= relVn * nz * 0.96;
            b2.vx += relVn * nx * 0.96;
            b2.vz += relVn * nz * 0.96;
            this.audio.playWallClack(relVn);
          }
        }
      }
    }
  }

  private resetBank(bank: 'left' | 'right'): void {
    for (const t of this.targets) {
      if (t.bank === bank) {
        t.down = false;
        t.flashTimer = 0.08;
      }
    }
  }

  private collideBallSegment(b: BallEntity, w: WallSeg): void {
    const abx = w.bx - w.ax;
    const abz = w.bz - w.az;
    const abLenSq = abx * abx + abz * abz;
    if (abLenSq < 1e-6) return;
    const t = Math.max(0, Math.min(1, ((b.x - w.ax) * abx + (b.z - w.az) * abz) / abLenSq));
    const cx = w.ax + abx * t;
    const cz = w.az + abz * t;
    const dx = b.x - cx;
    const dz = b.z - cz;
    const dist = Math.hypot(dx, dz);
    const minDist = R_BALL + 0.11;

    if (dist < minDist && dist > 1e-6) {
      const nx = dx / dist;
      const nz = dz / dist;
      b.x = cx + nx * minDist;
      b.z = cz + nz * minDist;

      const vn = b.vx * nx + b.vz * nz;
      if (vn < 0) {
        if (w.isSlingshot && w.slingBoost) {
          b.vx = nx * w.slingBoost + (b.vx - vn * nx) * 0.6;
          b.vz = nz * w.slingBoost + (b.vz - vn * nz) * 0.6;
          w.flashTimer = 0.065;
          this.addPoints(1200);
          this.audio.playSlingshotZap();
          this.spawnSparks(cx, cz, nx, nz, 0xf472b6, 12);
          this.onImpactFeel?.(0.22, 0.012);
        } else {
          b.vx -= (1 + w.restitution) * vn * nx;
          b.vz -= (1 + w.restitution) * vn * nz;
          this.audio.playWallClack(-vn);
        }
      }
    }
  }

  private collideBallFlipper(b: BallEntity, f: FlipperEntity): void {
    const dirX = Math.cos(f.angle);
    const dirZ = Math.sin(f.angle);
    const tx = f.px + dirX * f.length;
    const tz = f.pz + dirZ * f.length;

    const abx = tx - f.px;
    const abz = tz - f.pz;
    const lenSq = abx * abx + abz * abz;
    const t = Math.max(0, Math.min(1, ((b.x - f.px) * abx + (b.z - f.pz) * abz) / lenSq));
    const cx = f.px + abx * t;
    const cz = f.pz + abz * t;

    const dx = b.x - cx;
    const dz = b.z - cz;
    const dist = Math.hypot(dx, dz);
    const minDist = R_BALL + f.radius;

    if (dist < minDist && dist > 1e-6) {
      const nx = dx / dist;
      const nz = dz / dist;
      b.x = cx + nx * (minDist + 0.015);
      b.z = cz + nz * (minDist + 0.015);

      // Rotational surface velocity of flipper at contact radius r = t * length!
      const rContact = t * f.length;
      const surfVx = -f.omega * rContact * dirZ;
      const surfVz = f.omega * rContact * dirX;

      const relVx = b.vx - surfVx;
      const relVz = b.vz - surfVz;
      const relVn = relVx * nx + relVz * nz;

      if (relVn < 0) {
        const bounce = Math.abs(f.omega) > 1 ? 0.82 : 0.42;
        b.vx = surfVx * 1.12 + (relVx - (1 + bounce) * relVn * nx);
        b.vz = surfVz * 1.12 + (relVz - (1 + bounce) * relVn * nz);

        if (Math.abs(f.omega) > 4) {
          this.spawnSparks(cx, cz, nx, nz, 0x38bdf8, 10);
          this.onImpactFeel?.(0.18, 0);
        }
      }
    }
  }

  // ==========================================================================
  // 7. Sub-Stepped Ball Ribbon Trail + GLSL Fresnel Ring + Tangent Sparks
  // ==========================================================================
  private updateBallTrail(b: BallEntity): void {
    const cur = new THREE.Vector3(b.x, 0.22, b.z);
    if (b.trailPts.length > 0) {
      const prev = b.trailPts[0];
      const d = prev.distanceTo(cur);
      if (d > 0.22 && d < 5.0) {
        // Sub-step intermediate trail vertices so fast arcs never kink ($gamefeel-3d Rule #7)
        const steps = Math.min(5, Math.ceil(d / 0.2));
        for (let s = 1; s < steps; s++) {
          b.trailPts.unshift(prev.clone().lerp(cur, s / steps));
        }
      }
    }
    b.trailPts.unshift(cur);
    if (b.trailPts.length > 18) b.trailPts.length = 18;
    if (b.trailPts.length < 2) return;

    const verts = new Float32Array(b.trailPts.length * 2 * 3);
    for (let i = 0; i < b.trailPts.length; i++) {
      const p = b.trailPts[i];
      const next = b.trailPts[Math.min(b.trailPts.length - 1, i + 1)];
      let tx = p.x - next.x;
      let tz = p.z - next.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const px = -tz;
      const pz = tx;
      const halfW = (1 - i / b.trailPts.length) * 0.34;

      const base = i * 6;
      verts[base] = p.x + px * halfW;
      verts[base + 1] = p.y;
      verts[base + 2] = p.z + pz * halfW;
      verts[base + 3] = p.x - px * halfW;
      verts[base + 4] = p.y;
      verts[base + 5] = p.z - pz * halfW;
    }

    const indices: number[] = [];
    for (let i = 0; i < b.trailPts.length - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    b.trailGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    b.trailGeo.setIndex(indices);
  }

  private spawnFresnelWave(x: number, z: number, hex: number, maxScale: number): void {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uProgress: { value: 0 },
        uCol: { value: new THREE.Color(hex) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uProgress; uniform vec3 uCol;
        varying vec3 vN; varying vec3 vV;
        void main() {
          float f = pow(1.0 - abs(dot(vN, vV)), 2.4);
          float a = f * pow(max(0.0, 1.0 - uProgress), 1.5) * 1.2;
          gl_FragColor = vec4(mix(vec3(1.0), uCol, 0.65) * 1.5, a);
        }
      `,
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.position.set(x, 0.4, z);
    this.scene.add(mesh);
    this.waves.push({ mesh, mat, progress: 0, maxScale });
  }

  private spawnSparks(x: number, z: number, nx: number, nz: number, hex: number, count: number): void {
    const pos = new Float32Array(count * 3);
    const vels = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * 1.4;
      const dx = nx * Math.cos(spread) - nz * Math.sin(spread);
      const dz = nx * Math.sin(spread) + nz * Math.cos(spread);
      const spd = 6 + Math.random() * 12;
      pos[i * 3] = x;
      pos[i * 3 + 1] = 0.45;
      pos[i * 3 + 2] = z;
      vels[i * 3] = dx * spd;
      vels[i * 3 + 1] = 3 + Math.random() * 5;
      vels[i * 3 + 2] = dz * spd;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: hex,
      size: 0.28,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.sparks.push({ points, vels, mat, geo, age: 0 });
  }
}
