/**
 * particles.ts — short-lived debris sparks thrown off by merges.
 *
 * Backed by parallel Float32Arrays with a fixed capacity and a swap-remove on
 * expiry, so the pool never allocates or garbage-collects mid-frame.
 */

import type { Camera, Projected } from './camera';

const CAPACITY = 900;

export class Sparks {
  private x = new Float32Array(CAPACITY);
  private y = new Float32Array(CAPACITY);
  private z = new Float32Array(CAPACITY);
  private vx = new Float32Array(CAPACITY);
  private vy = new Float32Array(CAPACITY);
  private vz = new Float32Array(CAPACITY);
  private life = new Float32Array(CAPACITY);
  private maxLife = new Float32Array(CAPACITY);
  private size = new Float32Array(CAPACITY);
  private color: string[] = new Array(CAPACITY).fill('#ffffff');
  count = 0;

  /** Ring-shaped burst at a merge site, carried along by the merged body. */
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: string,
    n: number,
    speed: number,
  ): void {
    for (let i = 0; i < n; i++) {
      if (this.count >= CAPACITY) return;
      const k = this.count++;
      // Uniform direction on the sphere, so a burst is a shell rather than a
      // ring seen edge-on when the camera tilts.
      const cz = Math.random() * 2 - 1;
      const angle = Math.random() * Math.PI * 2;
      const sr = Math.sqrt(1 - cz * cz);
      const s = speed * (0.35 + Math.random() * 0.9);
      this.x[k] = x;
      this.y[k] = y;
      this.z[k] = z;
      this.vx[k] = vx + Math.cos(angle) * sr * s;
      this.vy[k] = vy + Math.sin(angle) * sr * s;
      this.vz[k] = vz + cz * s;
      const life = 26 + Math.random() * 34;
      this.life[k] = life;
      this.maxLife[k] = life;
      this.size[k] = 0.8 + Math.random() * 1.8;
      this.color[k] = color;
    }
  }

  /** Ballistic drift with drag; `dt` is in frame-units, not sim-ticks. */
  update(dt: number): void {
    const drag = Math.pow(0.965, dt);
    for (let i = 0; i < this.count; i++) {
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.vz[i] *= drag;
      this.life[i] -= dt;

      if (this.life[i] <= 0) {
        // Swap-remove: move the last live particle into this slot.
        const last = --this.count;
        this.x[i] = this.x[last];
        this.y[i] = this.y[last];
        this.z[i] = this.z[last];
        this.vx[i] = this.vx[last];
        this.vy[i] = this.vy[last];
        this.vz[i] = this.vz[last];
        this.life[i] = this.life[last];
        this.maxLife[i] = this.maxLife[last];
        this.size[i] = this.size[last];
        this.color[i] = this.color[last];
        i--;
      }
    }
  }

  clear(): void {
    this.count = 0;
  }

  /**
   * Draw into screen space. The caller supplies the world->screen mapping so
   * this module stays independent of the camera.
   */
  /** Draw through the camera; particles are billboarded points of light. */
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const p: Projected = { x: 0, y: 0, depth: 0, scale: 0, visible: false };
    for (let i = 0; i < this.count; i++) {
      camera.project(this.x[i], this.y[i], this.z[i], p);
      if (!p.visible) continue;
      const t = this.life[i] / this.maxLife[i];
      ctx.globalAlpha = t * t;
      ctx.fillStyle = this.color[i];
      const r = Math.max(0.6, this.size[i] * p.scale * (0.4 + t * 0.6));
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }
}
