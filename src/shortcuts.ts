/**
 * shortcuts.ts — the keyboard map, defined once.
 *
 * Both the key handler and the help overlay read this list, so a shortcut
 * cannot end up documented but unhandled (or handled but undocumented). The UI
 * supplies the actions by id; nothing here knows what a shortcut does.
 */

export type ShortcutId =
  | 'pause'
  | 'step'
  | 'clear'
  | 'blackhole'
  | 'follow'
  | 'orbits'
  | 'vectors'
  | 'predict'
  | 'recentre'
  | 'mute'
  | 'rotframe'
  | 'delete'
  | 'deselect'
  | 'panel'
  | 'help'
  | 'scene';

export interface Shortcut {
  id: ShortcutId;
  /** Keys as shown in the overlay. */
  keys: string[];
  label: string;
  group: 'Simulation' | 'View' | 'Selection' | 'Interface';
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'pause', keys: ['Space'], label: 'Pause / resume', group: 'Simulation' },
  { id: 'step', keys: ['.'], label: 'Advance one frame (while paused)', group: 'Simulation' },
  { id: 'clear', keys: ['C'], label: 'Clear all bodies', group: 'Simulation' },
  { id: 'blackhole', keys: ['B'], label: 'Spawn a black hole at centre', group: 'Simulation' },
  { id: 'scene', keys: ['1 – 6'], label: 'Load scene 1 to 6', group: 'Simulation' },

  { id: 'recentre', keys: ['R'], label: 'Recentre the view', group: 'View' },
  { id: 'orbits', keys: ['O'], label: 'Toggle orbit ellipse', group: 'View' },
  { id: 'vectors', keys: ['V'], label: 'Toggle velocity vectors', group: 'View' },
  { id: 'predict', keys: ['T'], label: 'Toggle trajectory preview', group: 'View' },
  { id: 'rotframe', keys: ['G'], label: 'Rotating reference frame', group: 'View' },

  { id: 'follow', keys: ['F'], label: 'Follow the selected body', group: 'Selection' },
  { id: 'delete', keys: ['Del'], label: 'Delete the selected body', group: 'Selection' },
  { id: 'deselect', keys: ['Esc'], label: 'Deselect / close overlay', group: 'Selection' },

  { id: 'mute', keys: ['M'], label: 'Mute / unmute sound', group: 'Interface' },
  { id: 'panel', keys: ['H'], label: 'Hide the control panel', group: 'Interface' },
  { id: 'help', keys: ['?'], label: 'Show this list', group: 'Interface' },
];

/** Mouse and trackpad grammar — display only, handled in ui.ts. */
export const POINTER_HELP: Array<{ keys: string[]; label: string }> = [
  { keys: ['Drag'], label: 'Fling a new body along the drag vector' },
  { keys: ['Click'], label: 'Select a body and read its orbit' },
  { keys: ['Shift', 'Click'], label: 'Insert a body on a circular orbit' },
  { keys: ['Right drag'], label: 'Pan the camera' },
  { keys: ['Wheel'], label: 'Zoom about the cursor' },
];

/**
 * Map a keydown to a shortcut id, or null. Digits map to `scene`; the caller
 * reads the digit off the event itself.
 */
export function matchShortcut(e: KeyboardEvent): ShortcutId | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;

  if (e.key >= '1' && e.key <= '9') return 'scene';

  switch (e.key) {
    case ' ':
      return 'pause';
    case '.':
      return 'step';
    case 'Escape':
      return 'deselect';
    case 'Delete':
    case 'Backspace':
      return 'delete';
    case '?':
    case '/':
      return 'help';
  }

  switch (e.key.toLowerCase()) {
    case 'c':
      return 'clear';
    case 'b':
      return 'blackhole';
    case 'f':
      return 'follow';
    case 'o':
      return 'orbits';
    case 'v':
      return 'vectors';
    case 't':
      return 'predict';
    case 'r':
      return 'recentre';
    case 'm':
      return 'mute';
    case 'g':
      return 'rotframe';
    case 'h':
      return 'panel';
    default:
      return null;
  }
}
