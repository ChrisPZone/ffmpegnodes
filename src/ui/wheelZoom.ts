// Mouse-wheel zoom for the canvas with a fixed step per wheel notch. React Flow's own wheel
// zoom scales with the reported wheel distance, which on Windows is often large and makes
// each notch jump a lot.

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
export const DEFAULT_ZOOM_STEP = 10;
export const ZOOM_STEP_RANGE = { min: 3, max: 30 } as const;

/** Pixels per wheel notch as browsers report it for a normal mouse (deltaMode 0). */
const NOTCH = 100;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Wheel distance in notches (fractions for touchpads and smooth wheels), at most 3 per event. */
export function wheelNotches(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY;
  return Math.max(-3, Math.min(3, px / NOTCH));
}

/**
 * Viewport after zooming by `notches` (positive = out, like deltaY) around the point
 * (px, py) in pane coordinates, which stays where it is on screen.
 */
export function zoomAt(v: Viewport, notches: number, stepPercent: number, px: number, py: number): Viewport {
  const step = Math.max(ZOOM_STEP_RANGE.min, Math.min(ZOOM_STEP_RANGE.max, stepPercent || DEFAULT_ZOOM_STEP)) / 100;
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * Math.pow(1 + step, -notches)));
  const k = zoom / v.zoom;
  return { x: px - (px - v.x) * k, y: py - (py - v.y) * k, zoom };
}
