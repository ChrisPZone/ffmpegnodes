import { describe, expect, it } from "vitest";
import { detectSequence, inputDemuxArgs, isSequencePattern, numberedName, sequenceFromPattern, splitPath } from "./sequence";

const range = (a: number, b: number, f: (n: number) => string) => Array.from({ length: b - a + 1 }, (_, i) => f(a + i));

describe("detectSequence", () => {
  it("finds the range from a frame in the middle", () => {
    const files = [...range(1001, 1240, (n) => `shot_${n}.exr`), "notes.txt", "shot_1001.png"];
    expect(detectSequence("shot_1120.exr", files)).toEqual({ pattern: "shot_%04d.exr", first: 1001, last: 1240, count: 240, missing: [], missingCount: 0 });
  });

  it("keeps zero padding", () => {
    const s = detectSequence("img.0005.png", range(0, 30, (n) => `img.${String(n).padStart(4, "0")}.png`));
    expect(s).toMatchObject({ pattern: "img.%04d.png", first: 0, last: 30, count: 31 });
  });

  it("uses %d for unpadded numbers of different widths", () => {
    const s = detectSequence("f5.jpg", range(1, 120, (n) => `f${n}.jpg`));
    expect(s).toMatchObject({ pattern: "f%d.jpg", first: 1, last: 120, count: 120 });
  });

  it("lets a padded pattern grow past its width", () => {
    const s = detectSequence("a_9998.png", ["a_9998.png", "a_9999.png", "a_10000.png", "a_0997.png", "a_00001.png"]);
    expect(s).toMatchObject({ pattern: "a_%04d.png", first: 997, last: 10000, count: 4 });
    expect(detectSequence("a_9998.png", ["a_9998.png", "a_9999.png", "a_10000.png"])?.pattern).toBe("a_%d.png");
  });

  it("reports missing frames", () => {
    const files = range(1, 100, (n) => `s_${String(n).padStart(3, "0")}.dpx`).filter((f) => !/_0(07|50|51)\./.test(f));
    expect(detectSequence("s_001.dpx", files)).toMatchObject({ first: 1, last: 100, count: 97, missing: [7, 50, 51], missingCount: 3 });
  });

  it("caps the missing list but counts all gaps", () => {
    const s = detectSequence("x_1.png", ["x_1.png", "x_1000.png"]);
    expect(s?.missing).toHaveLength(20);
    expect(s?.missingCount).toBe(998);
  });

  it("escapes % in the name", () => {
    expect(detectSequence("50%_01.png", ["50%_01.png", "50%_02.png"])?.pattern).toBe("50%%_%02d.png");
  });

  it("returns null for a lone or unnumbered file", () => {
    expect(detectSequence("poster.png", ["poster.png"])).toBeNull();
    expect(detectSequence("shot_1001.exr", ["shot_1001.exr", "other_1002.exr"])).toBeNull();
  });

  it("uses the last number in the name", () => {
    expect(numberedName("v2_shot_0010.exr")).toEqual({ prefix: "v2_shot_", digits: "0010", suffix: ".exr" });
    expect(numberedName("frame0010_final.png")).toEqual({ prefix: "frame", digits: "0010", suffix: "_final.png" });
  });
});

describe("sequenceFromPattern", () => {
  it("finds the range of a typed pattern", () => {
    const files = [...range(1001, 1010, (n) => `shot_${n}.exr`), "50%_01.png", "50%_02.png"];
    expect(sequenceFromPattern("shot_%04d.exr", files)).toMatchObject({ pattern: "shot_%04d.exr", first: 1001, last: 1010 });
    expect(sequenceFromPattern("50%%_%02d.png", files)).toMatchObject({ first: 1, last: 2 });
    expect(sequenceFromPattern("other_%04d.exr", files)).toBeNull();
    expect(sequenceFromPattern("shot.exr", files)).toBeNull();
  });
});

describe("paths", () => {
  it("splits Windows and POSIX paths", () => {
    expect(splitPath("C:\\renders\\v1\\shot_1001.exr")).toEqual({ dir: "C:\\renders\\v1\\", name: "shot_1001.exr" });
    expect(splitPath("/tmp/a.png")).toEqual({ dir: "/tmp/", name: "a.png" });
  });

  it("recognizes patterns", () => {
    expect(isSequencePattern("C:/r/shot_%04d.exr")).toBe(true);
    expect(isSequencePattern("C:/r/f%d.png")).toBe(true);
    expect(isSequencePattern("C:/r/50%%.png")).toBe(false);
    expect(isSequencePattern("C:/r%04d/a.png")).toBe(false);
  });
});

describe("inputDemuxArgs", () => {
  it("emits the set options in order", () => {
    const o = { framerate: "60", start_number: "1001", start_number_range: "", pattern_type: "sequence", loop: "1" };
    expect(inputDemuxArgs(o)).toEqual(["-framerate", "60", "-start_number", "1001", "-pattern_type", "sequence", "-loop", "1"]);
    expect(inputDemuxArgs({ framerate: " " })).toEqual([]);
  });
});
