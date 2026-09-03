/**
 * audio.ts — synthesized sound effects.
 *
 * Everything is generated with oscillators and one shared noise buffer, so the
 * app still ships zero audio assets and works offline. Browsers refuse to start
 * an AudioContext before a user gesture, so the context is created lazily on
 * the first real interaction rather than at load.
 *
 * The hard constraint is that merges are not rare events: an accretion disc can
 * produce dozens in a single frame. Every sound therefore goes through a voice
 * cap and a per-kind minimum interval, and the caller aggregates a frame's
 * merges into one call rather than firing a voice per collision.
 */

export type SoundKind = 'merge' | 'launch' | 'blackhole' | 'select' | 'scene' | 'ui';

/** Minimum gap between two sounds of the same kind, ms. */
const MIN_INTERVAL: Record<SoundKind, number> = {
  merge: 55,
  launch: 40,
  blackhole: 200,
  select: 60,
  scene: 200,
  ui: 40,
};

/** Concurrent voices allowed before new sounds are dropped. */
const MAX_VOICES = 12;

const STORAGE_KEY = 'cgs.audio';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices = 0;
  private lastPlayed: Partial<Record<SoundKind, number>> = {};
  private failed = false;

  enabled = true;
  volume = 0.35;

  constructor() {
    // Restore the user's preference; a muted sandbox should stay muted.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { enabled?: boolean; volume?: number };
        if (typeof saved.enabled === 'boolean') this.enabled = saved.enabled;
        if (typeof saved.volume === 'number') this.volume = clamp(saved.volume, 0, 1);
      }
    } catch {
      /* storage can be unavailable or blocked; defaults are fine */
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ enabled: this.enabled, volume: this.volume }),
      );
    } catch {
      /* ignore */
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.02);
    }
    this.persist();
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.master && this.ctx && this.enabled) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
    this.persist();
  }

  /**
   * Called from the first user gesture. Creating the context any earlier gets
   * it suspended by the browser's autoplay policy.
   */
  unlock(): void {
    if (this.failed) return;
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (this.failed) return null;

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.failed = true;
      return null;
    }

    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.enabled ? this.volume : 0;
      // A gentle ceiling: additive synth voices stack, and merges can fire in
      // bursts. Without this a big collision cascade clips hard.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.18;
      master.connect(limiter).connect(ctx.destination);

      this.ctx = ctx;
      this.master = master;
      this.noise = makeNoiseBuffer(ctx, 0.5);
      return ctx;
    } catch {
      this.failed = true;
      return null;
    }
  }

  /** Shared gate: honours mute, the voice cap and the per-kind interval. */
  private gate(kind: SoundKind): AudioContext | null {
    if (!this.enabled || this.failed) return null;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    if (this.voices >= MAX_VOICES) return null;

    const now = performance.now();
    const last = this.lastPlayed[kind] ?? -Infinity;
    if (now - last < MIN_INTERVAL[kind]) return null;
    this.lastPlayed[kind] = now;
    return ctx;
  }

  /** Track a voice so the cap means something; released when the node ends. */
  private hold(node: AudioScheduledSourceNode): void {
    this.voices++;
    node.onended = () => {
      this.voices--;
      node.onended = null;
    };
  }

  private env(ctx: AudioContext, peak: number, attack: number, decay: number): GainNode {
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(this.master!);
    return g;
  }

  /**
   * Collision. `intensity` (0..1) comes from the combined size of what merged,
   * and drives both pitch and weight: small pebbles tick, big bodies thud.
   */
  merge(intensity: number): void {
    const ctx = this.gate('merge');
    if (!ctx || !this.noise) return;
    const k = clamp(intensity, 0, 1);
    const t = ctx.currentTime;

    // Body: a sine dropping in pitch — the "thump".
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f0 = 220 - 150 * k;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(28, f0 * 0.4), t + 0.16 + k * 0.2);
    osc.connect(this.env(ctx, 0.22 + k * 0.3, 0.006, 0.18 + k * 0.25));
    osc.start(t);
    osc.stop(t + 0.5 + k * 0.3);
    this.hold(osc);

    // Transient: a short filtered noise burst for the impact edge.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + 1600 * (1 - k);
    bp.Q.value = 0.8;
    src.connect(bp).connect(this.env(ctx, 0.12 + k * 0.1, 0.003, 0.09));
    src.start(t);
    src.stop(t + 0.18);
    this.hold(src);
  }

  /** Fling: a short pitched sweep whose height tracks launch speed. */
  launch(speed: number): void {
    const ctx = this.gate('launch');
    if (!ctx) return;
    const k = clamp(speed / 12, 0, 1);
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180 + 120 * k, t);
    osc.frequency.exponentialRampToValueAtTime(520 + 700 * k, t + 0.17);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    osc.connect(lp).connect(this.env(ctx, 0.16, 0.012, 0.16));
    osc.start(t);
    osc.stop(t + 0.32);
    this.hold(osc);
  }

  /** Black hole: a sub-bass swell with a noise wash over it. */
  blackhole(): void {
    const ctx = this.gate('blackhole');
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(26, t + 0.9);
    osc.connect(this.env(ctx, 0.5, 0.05, 0.9));
    osc.start(t);
    osc.stop(t + 1.2);
    this.hold(osc);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.9);
    src.connect(lp).connect(this.env(ctx, 0.14, 0.06, 0.85));
    src.start(t);
    src.stop(t + 1.1);
    this.hold(src);
  }

  /** Selecting a body: a clean high blip. */
  select(): void {
    const ctx = this.gate('select');
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.07);
    osc.connect(this.env(ctx, 0.1, 0.005, 0.09));
    osc.start(t);
    osc.stop(t + 0.2);
    this.hold(osc);
  }

  /** Loading a scene: a rising three-note arpeggio. */
  scene(): void {
    const ctx = this.gate('scene');
    if (!ctx) return;
    const t = ctx.currentTime;
    // A major triad, quietly — this fires on every preset button.
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const at = t + i * 0.06;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
      g.connect(this.master!);
      osc.connect(g);
      osc.start(at);
      osc.stop(at + 0.4);
      this.hold(osc);
    });
  }

  /** Buttons and toggles: a very short, very quiet tick. */
  ui(): void {
    const ctx = this.gate('ui');
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 320;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    g.connect(this.master!);
    osc.connect(g);
    osc.start(t);
    osc.stop(t + 0.06);
    this.hold(osc);
  }
}

/* ------------------------------------------------------------------ helpers */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** One reusable white-noise buffer; generating it per sound would be wasteful. */
function makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}
