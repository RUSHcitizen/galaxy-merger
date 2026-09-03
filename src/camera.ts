/**
 * camera.ts — world <-> screen transform with smooth pan, zoom and follow.
 *
 * Physics runs entirely in world coordinates; the renderer converts to screen
 * space itself rather than using a canvas transform, so glow sprites can be
 * rasterised at their true on-screen size and stay crisp at any zoom.
 */

import { CAMERA } from './config';
import type { Body } from './physics';

export class Camera {
  /** World coordinates shown at the centre of the viewport. */
  x = 0;
  y = 0;
  zoom = 1;

  /** Viewport size in CSS px, kept in sync by the renderer. */
  vw = 1;
  vh = 1;

  /**
   * Frame rotation in radians. Non-zero puts the view in a *rotating reference
   * frame*: co-rotating with a body's orbit makes its primary and itself sit
   * still, and the Lagrange points — which are fixed only in this frame —
   * become stationary spots you can actually park something at.
   */
  rotation = 0;
  private cos = 1;
  private sin = 0;
  /** Set when the frame angle changed this frame. */
  rotationChanged = false;

  private targetZoom = 1;
  /** Camera position at the end of the previous frame. */
  private lastX = 0;
  private lastY = 0;
  /** True for the frame in which the view changed, so trails can be fixed up. */
  moved = false;
  /** Pan applied this frame, in screen px — lets the renderer shift trails. */
  panScreenX = 0;
  panScreenY = 0;
  /** Set when zoom changed, which trails cannot be salvaged through. */
  zoomed = false;

  setViewport(w: number, h: number): void {
    if (w !== this.vw || h !== this.vh) {
      this.vw = w;
      this.vh = h;
      this.zoomed = true;
    }
  }

  setRotation(angle: number): void {
    if (angle === this.rotation) return;
    this.rotation = angle;
    this.cos = Math.cos(angle);
    this.sin = Math.sin(angle);
    this.rotationChanged = true;
  }

  /*
   * Projection. With a rotating frame the screen x of a point depends on both
   * world coordinates, so these take the full point rather than one axis.
   */

  screenX(wx: number, wy: number): number {
    const dx = wx - this.x;
    const dy = wy - this.y;
    return (dx * this.cos - dy * this.sin) * this.zoom + this.vw * 0.5;
  }

  screenY(wx: number, wy: number): number {
    const dx = wx - this.x;
    const dy = wy - this.y;
    return (dx * this.sin + dy * this.cos) * this.zoom + this.vh * 0.5;
  }

  worldX(sx: number, sy: number): number {
    const ux = (sx - this.vw * 0.5) / this.zoom;
    const uy = (sy - this.vh * 0.5) / this.zoom;
    return this.x + ux * this.cos + uy * this.sin;
  }

  worldY(sx: number, sy: number): number {
    const ux = (sx - this.vw * 0.5) / this.zoom;
    const uy = (sy - this.vh * 0.5) / this.zoom;
    return this.y - ux * this.sin + uy * this.cos;
  }

  /** Drag the world by a screen-space delta. */
  panByScreen(dx: number, dy: number): void {
    // Undo the frame rotation so a drag moves the world the way it looks.
    const ux = dx / this.zoom;
    const uy = dy / this.zoom;
    this.x -= ux * this.cos + uy * this.sin;
    this.y -= -ux * this.sin + uy * this.cos;
  }

  /** Zoom about a screen anchor so the point under the cursor stays put. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const next = Math.min(
      CAMERA.MAX_ZOOM,
      Math.max(CAMERA.MIN_ZOOM, this.targetZoom * factor),
    );
    if (next === this.targetZoom) return;

    // Anchor: keep the world point under the cursor fixed across the change.
    const wx = this.worldX(sx, sy);
    const wy = this.worldY(sx, sy);
    this.targetZoom = next;
    this.zoom = next;
    // Re-solve the centre so that (wx, wy) still lands on (sx, sy).
    const ux = (sx - this.vw * 0.5) / this.zoom;
    const uy = (sy - this.vh * 0.5) / this.zoom;
    this.x = wx - (ux * this.cos + uy * this.sin);
    this.y = wy - (-ux * this.sin + uy * this.cos);
    this.zoomed = true;
  }

  setZoom(z: number): void {
    this.targetZoom = Math.min(CAMERA.MAX_ZOOM, Math.max(CAMERA.MIN_ZOOM, z));
    this.zoom = this.targetZoom;
    this.zoomed = true;
  }

  centerOn(wx: number, wy: number): void {
    this.x = wx;
    this.y = wy;
    this.zoomed = true;
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
    this.setRotation(0);
    this.setZoom(1);
  }

  /**
   * Per-frame update. Movement since the previous frame — whether from a mouse
   * drag or from easing toward a followed body — is reported as a screen-space
   * pan so the renderer can translate the trail buffer instead of discarding
   * it. Zoom changes cannot be salvaged that way and force a clear.
   */
  update(follow: Body | null): void {
    if (follow) {
      this.x += (follow.x - this.x) * CAMERA.SMOOTHING;
      this.y += (follow.y - this.y) * CAMERA.SMOOTHING;
    }

    this.panScreenX = (this.lastX - this.x) * this.zoom;
    this.panScreenY = (this.lastY - this.y) * this.zoom;
    this.lastX = this.x;
    this.lastY = this.y;

    this.moved =
      this.zoomed ||
      Math.abs(this.panScreenX) > 0.01 ||
      Math.abs(this.panScreenY) > 0.01;
  }


  /**
   * Called by the renderer once it has reacted to this frame's movement, so
   * the one-shot `zoomed` flag does not force a second trail clear.
   */
  clearMoved(): void {
    this.moved = false;
    this.zoomed = false;
    this.rotationChanged = false;
    this.panScreenX = 0;
    this.panScreenY = 0;
  }
}
