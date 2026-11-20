import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM, wheelNotches, zoomAt } from "./wheelZoom";

describe("wheel zoom", () => {
  it("counts notches the same for pixel, line and large deltas", () => {
    expect(wheelNotches(100, 0)).toBe(1);
    expect(wheelNotches(-3, 1)).toBeCloseTo(-0.99);
    expect(wheelNotches(12, 0)).toBeCloseTo(0.12);
    expect(wheelNotches(1000, 0)).toBe(3);
  });

  it("zooms by one step per notch around the pointer", () => {
    const v = { x: 0, y: 0, zoom: 1 };
    const zin = zoomAt(v, -1, 10, 200, 100);
    expect(zin.zoom).toBeCloseTo(1.1);
    // the canvas point under the pointer (200, 100) stays under it
    expect((200 - zin.x) / zin.zoom).toBeCloseTo(200);
    expect((100 - zin.y) / zin.zoom).toBeCloseTo(100);
    expect(zoomAt(v, 1, 10, 0, 0).zoom).toBeCloseTo(1 / 1.1);
    expect(zoomAt(v, -1, 25, 0, 0).zoom).toBeCloseTo(1.25);
  });

  it("stays within the zoom limits and falls back to 10% for a missing setting", () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1.95 }, -3, 30, 0, 0).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, zoom: 0.21 }, 3, 30, 0, 0).zoom).toBe(MIN_ZOOM);
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, -1, 0, 0, 0).zoom).toBeCloseTo(1.1);
  });
});
