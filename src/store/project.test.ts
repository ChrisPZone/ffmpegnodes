import { describe, expect, it } from "vitest";
import { parseProject } from "./graph";

const file = (app: string) => JSON.stringify({ app, version: 1, nodes: [], edges: [] });

describe("project files", () => {
  it("opens ffmpegnodes files and those saved before the rename", () => {
    expect(parseProject(file("ffmpegnodes")).app).toBe("ffmpegnodes");
    expect(parseProject(file("ffmpeg-node-gui")).nodes).toEqual([]);
    expect(() => parseProject(file("something-else"))).toThrow(/Not an ffmpegnodes graph file/);
  });
});
