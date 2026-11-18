/**
 * Zero-MP3 Procedural Space-Cadet Pinball WebAudio Synthesizer ($gamefeel-3d Grade S compliant)
 * Synthesizes high-voltage solenoid flipper clacks, FM bumper combo bells, slingshot zaps,
 * plunger spring tension & launch, wormhole vortex capture, and Multiball arcade fanfares.
 */
export class PinballAudio {
  private ctx: AudioContext | null = null;
  private lowpassBus: BiquadFilterNode | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private muted = false;
  private lastWallClack = 0;

  // Plunger charge hum loop
  private chargeOsc: OscillatorNode | null = null;
  private chargeGain: GainNode | null = null;

  public unlock(): void {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      const t = this.ctx.currentTime;

      this.lowpassBus = this.ctx.createBiquadFilter();
      this.lowpassBus.type = 'lowpass';
      this.lowpassBus.frequency.setValueAtTime(20000, t);

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.66, t);

      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-14, t);
      comp.knee.setValueAtTime(16, t);
      comp.ratio.setValueAtTime(6, t);
      comp.attack.setValueAtTime(0.002, t);
      comp.release.setValueAtTime(0.15, t);

      this.lowpassBus.connect(this.masterGain);
      this.masterGain.connect(comp);
      comp.connect(this.ctx.destination);

      const len = this.ctx.sampleRate * 1.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      this.initChargeHum();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
  }

  private initChargeHum(): void {
    if (!this.ctx || !this.lowpassBus) return;
    const t = this.ctx.currentTime;
    this.chargeGain = this.ctx.createGain();
    this.chargeGain.gain.setValueAtTime(0, t);

    this.chargeOsc = this.ctx.createOscillator();
    this.chargeOsc.type = 'sawtooth';
    this.chargeOsc.frequency.setValueAtTime(110, t);
    this.chargeOsc.connect(this.chargeGain).connect(this.lowpassBus);
    this.chargeOsc.start(t);
  }

  public setPlungerCharge(ratio: number): void {
    if (!this.ctx || !this.chargeGain || !this.chargeOsc) return;
    const t = this.ctx.currentTime;
    if (ratio <= 0.01) {
      this.chargeGain.gain.setTargetAtTime(0, t, 0.025);
    } else {
      this.chargeGain.gain.setTargetAtTime(0.14 * ratio, t, 0.03);
      this.chargeOsc.frequency.setTargetAtTime(110 + ratio * 380, t, 0.035);
    }
  }

  public setSlowMoMuffle(slowMo: boolean): void {
    if (!this.ctx || !this.lowpassBus) return;
    this.lowpassBus.frequency.setTargetAtTime(slowMo ? 820 : 20000, this.ctx.currentTime, 0.04);
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.66, this.ctx.currentTime, 0.02);
    }
    return this.muted;
  }

  private noise(dur: number, freq: number, q: number, type: BiquadFilterType, gain: number): void {
    if (!this.ctx || !this.noiseBuf || !this.lowpassBus) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.Q.setValueAtTime(q, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(this.lowpassBus);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private sweep(f0: number, f1: number, dur: number, type: OscillatorType, gain: number, delay = 0): void {
    if (!this.ctx || !this.lowpassBus) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(g).connect(this.lowpassBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Mechanical solenoid flipper coil snap */
  public playFlipperSnap(up: boolean): void {
    this.unlock();
    if (up) {
      this.noise(0.045, 2200, 1.4, 'bandpass', 0.42);
      this.sweep(230, 58, 0.065, 'triangle', 0.52);
    } else {
      this.noise(0.03, 1200, 1.2, 'lowpass', 0.2);
      this.sweep(120, 44, 0.045, 'sine', 0.24);
    }
  }

  /** Space-Cadet ascending combo Pop Bumper bell + punch */
  public playBumperHit(combo = 1): void {
    this.unlock();
    const scale = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98];
    const base = scale[(combo - 1) % scale.length] * (1 + Math.floor((combo - 1) / 6) * 0.12);
    this.noise(0.06, 1850, 1.1, 'bandpass', 0.48);
    this.sweep(185, 38, 0.14, 'sine', 0.65);
    this.sweep(base, base * 1.02, 0.18, 'triangle', 0.36);
    this.sweep(base * 2, base * 1.5, 0.12, 'sine', 0.22);
  }

  public playSlingshotZap(): void {
    this.unlock();
    this.noise(0.07, 2600, 1.6, 'highpass', 0.42);
    this.sweep(680, 165, 0.13, 'sawtooth', 0.38);
    this.sweep(1360, 420, 0.09, 'sine', 0.25);
  }

  public playPlungerLaunch(powerRatio: number): void {
    this.unlock();
    this.setPlungerCharge(0);
    const p = Math.max(0.3, powerRatio);
    this.noise(0.18, 1100, 0.9, 'bandpass', 0.55 * p);
    this.sweep(120, 620 * p + 180, 0.24, 'sawtooth', 0.42 * p);
    this.sweep(260, 55, 0.16, 'triangle', 0.48);
  }

  public playRolloverDing(allLit = false): void {
    this.unlock();
    if (!allLit) {
      this.sweep(1174.66, 1760, 0.12, 'sine', 0.28);
    } else {
      [880, 1108.7, 1318.5, 1760].forEach((f, i) => {
        this.sweep(f, f * 1.03, 0.16, 'triangle', 0.3, i * 0.055);
      });
    }
  }

  public playDropTargetDown(bankCleared = false): void {
    this.unlock();
    this.noise(0.08, 2800, 1.5, 'bandpass', 0.42);
    this.sweep(540, 210, 0.11, 'square', 0.28);
    if (bankCleared) {
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
        this.sweep(f, f * 1.04, 0.22, 'sawtooth', 0.26, 0.06 + i * 0.06);
      });
    }
  }

  public playWormholeCapture(): void {
    this.unlock();
    this.sweep(220, 1280, 0.65, 'sine', 0.42);
    this.sweep(330, 1920, 0.65, 'triangle', 0.26, 0.08);
  }

  public playMultiballJackpot(): void {
    this.unlock();
    this.noise(0.35, 950, 0.8, 'bandpass', 0.65);
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98, 2093.0];
    notes.forEach((f, i) => {
      this.sweep(f, f * 1.02, 0.26, 'sawtooth', 0.28, i * 0.065);
      this.sweep(f * 0.5, f * 0.51, 0.26, 'triangle', 0.24, i * 0.065);
    });
  }

  public playNudgeBump(tilted = false): void {
    this.unlock();
    this.noise(0.14, 320, 0.9, 'lowpass', 0.65);
    this.sweep(110, 28, 0.16, 'triangle', 0.58);
    if (tilted) {
      this.sweep(310, 145, 0.48, 'sawtooth', 0.45, 0.05);
    }
  }

  public playBallDrain(saved = false): void {
    this.unlock();
    if (saved) {
      [659.25, 880, 1318.5].forEach((f, i) => this.sweep(f, f * 1.05, 0.18, 'triangle', 0.34, i * 0.06));
    } else {
      [440, 370, 311, 220].forEach((f, i) => this.sweep(f, f * 0.88, 0.24, 'sawtooth', 0.28, i * 0.09));
    }
  }

  public playWallClack(speed: number): void {
    if (!this.ctx || speed < 7) return;
    const now = performance.now();
    if (now - this.lastWallClack < 42) return;
    this.lastWallClack = now;
    const g = Math.min(0.26, speed * 0.008);
    this.noise(0.028, 2400, 1.8, 'bandpass', g);
  }
}
