/**
 * share.ts — serialize a world into a URL fragment, and back.
 *
 * The encoding is deliberately plain: a compact delimited text form, base64url
 * encoded so it survives a URL. Numbers are rounded to a fixed precision, which
 * keeps a couple of hundred bodies inside a link most browsers will accept
 * while staying well under any accuracy the simulation itself preserves.
 */

import type { BodyKind } from './config';
import { makeBody, type Body, type World } from './physics';

/** Bump when the field layout changes, so old links fail cleanly. */
const VERSION = 2;
const KINDS: BodyKind[] = ['body', 'star', 'blackhole'];

/** Round to `d` decimals without trailing zeros. */
function num(v: number, d: number): string {
  return String(Number(v.toFixed(d)));
}

export function encodeWorld(world: World, distance: number): string {
  const rows = world.bodies.map((b) =>
    [
      num(b.x, 2),
      num(b.y, 2),
      num(b.z, 2),
      num(b.vx, 4),
      num(b.vy, 4),
      num(b.vz, 4),
      num(b.mass, 3),
      b.color.replace('#', ''),
      KINDS.indexOf(b.kind),
    ].join(','),
  );
  const payload = [VERSION, num(distance, 2), ...rows].join(';');
  return base64UrlEncode(payload);
}

export interface DecodedWorld {
  bodies: Body[];
  distance: number;
}

/** Returns null for anything malformed — a bad link must not break the app. */
export function decodeWorld(encoded: string): DecodedWorld | null {
  try {
    const parts = base64UrlDecode(encoded).split(';');
    if (parts.length < 2) return null;
    if (Number(parts[0]) !== VERSION) return null;

    const distance = Number(parts[1]);
    if (!isFinite(distance) || distance <= 0) return null;

    const bodies: Body[] = [];
    for (let i = 2; i < parts.length; i++) {
      const f = parts[i].split(',');
      if (f.length !== 9) return null;
      const [x, y, z, vx, vy, vz, mass] = f.slice(0, 7).map(Number);
      if (![x, y, z, vx, vy, vz, mass].every(isFinite) || mass <= 0) return null;
      const kind = KINDS[Number(f[8])];
      if (!kind) return null;
      if (!/^[0-9a-fA-F]{6}$/.test(f[7])) return null;

      bodies.push(makeBody({ x, y, z, vx, vy, vz, mass, color: '#' + f[7], kind }));
    }
    return { bodies, distance };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- base64url */

function base64UrlEncode(text: string): string {
  // btoa is byte-oriented; the payload is ASCII by construction, but encode
  // defensively so a stray character cannot throw.
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
