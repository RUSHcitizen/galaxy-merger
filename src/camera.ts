/**
 * camera.ts — a perspective camera that orbits a target point.
 *
 * The camera is described in spherical terms — a look-at target, a distance, a
 * yaw and a pitch — which is the natural control scheme for inspecting an
 * orbital system: drag to swing around it, wheel to move closer.
 *
 * Projection is done here rather than with a canvas transform, so glow sprites
 * can be rasterised at their true on-screen size and stay crisp at any depth.
 * `project` returns a screen position *and* a scale factor, and the renderer
 * uses that scale for everything from sprite size to line width, which is what
 * makes near bodies read as near.
 */

import { CAMERA } from './config';
import { V, type Body, type Vec3 } from './physics';

export interface Projected {
  x: number;
  y: number;
  /** Distance along the view axis. Negative means behind the camera. */
  depth: number;
  /** World-units-to-pixels at this depth; 0 when behind the camera. */
  scale: number;
  visible: boolean;
}

export class Camera {
  /** World point the camera looks at. */
  target: Vec3 = { x: 0, y: 0, z: 0 };
  /** Distance from the target. Zooming moves the camera in and out. */
  distance = 1400;
  /** Rotation about the world z axis. */
  yaw = 0;
  /**
   * Elevation above the reference plane. Starts slightly tilted: dead-on the
   * plane is a straight line, and straight down is the old 2D view.
   */
  pitch = 0.42;

  /** Viewport size in CSS px, kept in sync by the renderer. */
  vw = 1;
  vh = 1;

  /**
   * Frame rotation in radians, applied about the orbit normal of whatever is
   * being co-rotated with. Non-zero puts the view in a *rotating reference
   * frame*: the Lagrange points — fixed only in that frame — stop moving.
   */
  rotation = 0;
  /** Axis the frame rotation turns about (the reference orbit's normal). */
  rotationAxis: Vec3 = { x: 0, y: 0, z: 1 };

  /** Set when the projection changed in a way trails cannot survive. */
  viewChanged = true;
  /** True for the frame in which anything about the view moved. */
  moved = true;

  /** Focal length in pixels, derived from the vertical field of view. */
  private focal = 1;
  /** Camera basis: `forward` toward the target, plus right and up. */
  private fwd: Vec3 = { x: 0, y: 0, z: -1 };
  private right: Vec3 = { x: 1, y: 0, z: 0 };
  private up: Vec3 = { x: 0, y: 1, z: 0 };
  /** Camera position in world space. */
  private eye: Vec3 = { x: 0, y: 0, z: 0 };
  /** Cached frame-rotation matrix rows (identity when rotation is 0). */
  private rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  constructor() {
    this.rebuild();
  }

  setViewport(w: number, h: number): void {
    if (w !== this.vw || h !== this.vh) {
      this.vw = w;
      this.vh = h;
      this.rebuild();
      this.viewChanged = true;
    }
  }

  /** Recompute the camera basis, position and focal length. */
  private rebuild(): void {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);

    // Offset from target to eye, in world space.
    const ox = cp * cy;
    const oy = cp * sy;
    const oz = sp;
    this.eye = {
      x: this.target.x + ox * this.distance,
      y: this.target.y + oy * this.distance,
      z: this.target.z + oz * this.distance,
    };

    this.fwd = { x: -ox, y: -oy, z: -oz };
    // Right is horizontal (perpendicular to world up), so the horizon stays
    // level however far the camera is tilted.
    this.right = { x: -sy, y: cy, z: 0 };
    this.up = V.cross(this.right, this.fwd);

    // Vertical FOV to focal length: half-height / tan(fov/2).
    this.focal = this.vh * 0.5 / Math.tan(CAMERA.FOV * 0.5);

    // Frame rotation about the stored axis (Rodrigues).
    const a = this.rotation;
    if (Math.abs(a) < 1e-12) {
      this.rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    } else {
      const { x: kx, y: ky, z: kz } = V.norm(this.rotationAxis);
      const c = Math.cos(a);
      const s = Math.sin(a);
      const t = 1 - c;
      this.rot = [
        t * kx * kx + c, t * kx * ky - s * kz, t * kx * kz + s * ky,
        t * kx * ky + s * kz, t * ky * ky + c, t * ky * kz - s * kx,
        t * kx * kz - s * ky, t * ky * kz + s * kx, t * kz * kz + c,
      ];
    }
  }

  /**
   * World point to screen. `scale` is how many pixels one world unit spans at
   * that depth, which the renderer multiplies into every size it draws.
   */
  project(wx: number, wy: number, wz: number, out: Projected): Projected {
    // Frame rotation first: it is part of the world-to-view mapping, applied
    // about the target so the reference body stays put.
    let dx = wx - this.target.x;
    let dy = wy - this.target.y;
    let dz = wz - this.target.z;
    if (this.rotation !== 0) {
      const m = this.rot;
      const rx = m[0] * dx + m[1] * dy + m[2] * dz;
      const ry = m[3] * dx + m[4] * dy + m[5] * dz;
      const rz = m[6] * dx + m[7] * dy + m[8] * dz;
      dx = rx;
      dy = ry;
      dz = rz;
    }
    // Now relative to the eye.
    const ex = dx + this.target.x - this.eye.x;
    const ey = dy + this.target.y - this.eye.y;
    const ez = dz + this.target.z - this.eye.z;

    const depth = ex * this.fwd.x + ey * this.fwd.y + ez * this.fwd.z;
    if (depth <= CAMERA.NEAR) {
      out.depth = depth;
      out.scale = 0;
      out.visible = false;
      out.x = 0;
      out.y = 0;
      return out;
    }

    const sx = ex * this.right.x + ey * this.right.y + ez * this.right.z;
    const sy = ex * this.up.x + ey * this.up.y + ez * this.up.z;
    const k = this.focal / depth;

    out.x = this.vw * 0.5 + sx * k;
    // Screen y grows downward.
    out.y = this.vh * 0.5 - sy * k;
    out.depth = depth;
    out.scale = k;
    out.visible = true;
    return out;
  }

  /** Camera position, for depth sorting and lighting. */
  get eyePos(): Vec3 {
    return this.eye;
  }

  /** Unit ray direction through a screen pixel, in world space. */
  rayDirection(sx: number, sy: number): Vec3 {
    const px = sx - this.vw * 0.5;
    const py = this.vh * 0.5 - sy;
    const d: Vec3 = {
      x: this.fwd.x * this.focal + this.right.x * px + this.up.x * py,
      y: this.fwd.y * this.focal + this.right.y * px + this.up.y * py,
      z: this.fwd.z * this.focal + this.right.z * px + this.up.z * py,
    };
    const n = V.norm(d);
    if (this.rotation === 0) return n;
    // Undo the frame rotation so the ray is expressed in world space.
    const m = this.rot;
    return {
      x: m[0] * n.x + m[3] * n.y + m[6] * n.z,
      y: m[1] * n.x + m[4] * n.y + m[7] * n.z,
      z: m[2] * n.x + m[5] * n.y + m[8] * n.z,
    };
  }

  /** Ray origin in world space (the eye, un-rotated by the frame). */
  rayOrigin(): Vec3 {
    if (this.rotation === 0) return this.eye;
    const dx = this.eye.x - this.target.x;
    const dy = this.eye.y - this.target.y;
    const dz = this.eye.z - this.target.z;
    const m = this.rot;
    return {
      x: this.target.x + m[0] * dx + m[3] * dy + m[6] * dz,
      y: this.target.y + m[1] * dx + m[4] * dy + m[7] * dz,
      z: this.target.z + m[2] * dx + m[5] * dy + m[8] * dz,
    };
  }

  /**
   * Where a screen point lands in the world.
   *
   * Preference is the reference plane (z = 0), which is where the grid is drawn
   * and where most scenes live, so what you click is what you get. When the
   * camera is near edge-on that plane is nearly parallel to the ray and the
   * intersection runs away to the horizon, so below a minimum grazing angle it
   * falls back to the plane through the target that faces the camera.
   */
  screenToWorld(sx: number, sy: number): Vec3 {
    const o = this.rayOrigin();
    const d = this.rayDirection(sx, sy);

    if (Math.abs(d.z) > CAMERA.MIN_GRAZE) {
      const t = -o.z / d.z;
      if (t > 0 && t < this.distance * 12) {
        return { x: o.x + d.x * t, y: o.y + d.y * t, z: 0 };
      }
    }

    // Plane through the target, normal to the view axis.
    const nrm = this.rotation === 0 ? this.fwd : V.norm(V.sub(this.target, o));
    const denom = V.dot(d, nrm);
    if (Math.abs(denom) < 1e-9) return { ...this.target };
    const t = V.dot(V.sub(this.target, o), nrm) / denom;
    return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  }

  /* ------------------------------------------------------------- controls */

  /** Swing around the target. */
  orbitBy(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    // Stop just short of the poles: at exactly ±90° the horizontal `right`
    // vector is still well defined, but the view flips as it crosses.
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch + dPitch));
    this.rebuild();
    this.viewChanged = true;
  }

  /** Slide the target across the view plane. */
  panBy(dxScreen: number, dyScreen: number): void {
    const k = this.distance / this.focal;
    this.target = {
      x: this.target.x - (this.right.x * dxScreen - this.up.x * dyScreen) * k,
      y: this.target.y - (this.right.y * dxScreen - this.up.y * dyScreen) * k,
      z: this.target.z - (this.right.z * dxScreen - this.up.z * dyScreen) * k,
    };
    this.rebuild();
    this.viewChanged = true;
  }

  dollyBy(factor: number): void {
    this.setDistance(this.distance * factor);
  }

  setDistance(d: number): void {
    const next = Math.min(CAMERA.MAX_DISTANCE, Math.max(CAMERA.MIN_DISTANCE, d));
    if (next === this.distance) return;
    this.distance = next;
    this.rebuild();
    this.viewChanged = true;
  }

  centerOn(x: number, y: number, z: number): void {
    this.target = { x, y, z };
    this.rebuild();
    this.viewChanged = true;
  }

  setRotation(angle: number, axis: Vec3): void {
    const changed =
      angle !== this.rotation ||
      axis.x !== this.rotationAxis.x ||
      axis.y !== this.rotationAxis.y ||
      axis.z !== this.rotationAxis.z;
    if (!changed) return;
    this.rotation = angle;
    this.rotationAxis = axis;
    this.rebuild();
    // Deliberately not a viewChanged: in a rotating frame each trail pixel was
    // drawn under the mapping in force at the time, which is exactly the
    // trajectory in that frame. Only camera motion invalidates the buffer.
    this.moved = true;
  }

  reset(): void {
    this.target = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0.42;
    this.rotation = 0;
    this.rotationAxis = { x: 0, y: 0, z: 1 };
    this.distance = 1400;
    this.rebuild();
    this.viewChanged = true;
  }

  /** Per-frame update; eases toward a followed body. */
  update(follow: Body | null): void {
    if (follow) {
      const k = CAMERA.SMOOTHING;
      const t = this.target;
      const nx = t.x + (follow.x - t.x) * k;
      const ny = t.y + (follow.y - t.y) * k;
      const nz = t.z + (follow.z - t.z) * k;
      if (Math.abs(nx - t.x) > 1e-4 || Math.abs(ny - t.y) > 1e-4 || Math.abs(nz - t.z) > 1e-4) {
        this.target = { x: nx, y: ny, z: nz };
        this.rebuild();
        this.viewChanged = true;
      }
    }
    this.moved = this.moved || this.viewChanged;
  }

  clearMoved(): void {
    this.moved = false;
    this.viewChanged = false;
  }
}
