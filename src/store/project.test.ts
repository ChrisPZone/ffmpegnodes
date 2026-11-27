import { describe, expect, it } from "vitest";
import { parseProject } from "./graph";

const file = (app: string) => JSON.stringify({ app, version: 1, nodes: [], edges: [] });

describe("project files", () => {
  it("opens ffmpegnodes files and those saved before the rename", () => {
    expect(parseProject(file("ffmpegnodes")).app).toBe("ffmpegnodes");
    expect(parseProject(file("ffmpeg-node-gui")).nodes).toEqual([]);
    expect(() => parseProject(file("something-else"))).toThrow(/Not an ffmpegnodes graph file/);
  });

  it("fills in input options added later", () => {
    const old = { kind: "input", path: "a.mkv", options: { ss: "5", t: "", hwaccel: "", hwaccel_device: "", gpuFrames: "auto", threads: "", r: "" } };
    const p = parseProject(JSON.stringify({ app: "ffmpegnodes", version: 1, nodes: [{ id: "i", position: { x: 0, y: 0 }, data: old }], edges: [] }));
    expect(p.nodes[0].data).toMatchObject({ options: { ss: "5", framerate: "", start_number: "", pattern_type: "", loop: "" } });
  });
});
