import { describe, expect, it } from "vitest";
import type { Media, StreamInfo } from "../../model/types";
import { getPads, groupInputPads, newInputData } from "./index";

const s = (index: number, codec_type: Media): StreamInfo => ({ index, codec_type });
const pads = getPads({
  id: "in",
  position: { x: 0, y: 0 },
  data: {
    ...newInputData("movie.mkv"),
    probe: { streams: [s(0, "video"), s(1, "audio"), s(2, "audio"), s(3, "subtitle"), s(4, "subtitle"), s(5, "attachment")], format: {} },
  },
}).outputs;
const ids = (ps: { id: string }[]) => ps.map((p) => p.id);

describe("groupInputPads", () => {
  it("shows only video/audio frames by default", () => {
    const { main, groups } = groupInputPads(pads, new Set());
    expect(ids(main)).toEqual(["f0", "f1", "f2"]);
    expect(groups.map((g) => [g.id, ids(g.pads)])).toEqual([
      ["packets", ["p0", "p1", "p2"]],
      ["subtitles", ["f3", "p3", "f4", "p4"]],
      ["other", ["p5"]],
    ]);
  });

  it("promotes connected pads out of their group, in stream order", () => {
    const { main, groups } = groupInputPads(pads, new Set(["p4", "p1", "f3"]));
    expect(ids(main)).toEqual(["f0", "f1", "f2", "p1", "f3", "p4"]);
    expect(ids(groups.find((g) => g.id === "packets")!.pads)).toEqual(["p0", "p2"]);
    expect(ids(groups.find((g) => g.id === "subtitles")!.pads)).toEqual(["p3", "f4"]);
  });

  it("labels packet pads with the stream's language and format, like frame pads", () => {
    const out = getPads({
      id: "in",
      position: { x: 0, y: 0 },
      data: {
        ...newInputData("movie.mkv"),
        probe: {
          format: {},
          streams: [
            { index: 0, codec_type: "audio", codec_name: "ac3", sample_rate: "48000", channels: 6, channel_layout: "5.1", tags: { language: "ger" } },
            { index: 1, codec_type: "attachment", tags: { language: "und" } },
          ],
        },
      },
    }).outputs;
    const [f0, p0, p1] = out;
    expect(p0).toMatchObject({ label: "audio a:0 [ger]", icon: "packets" });
    expect(f0.icon).toBeUndefined();
    expect(p0.hint).toBe(f0.hint);
    expect(p0.hint).toContain("ac3");
    expect(p1).toMatchObject({ label: "attachment t:0", icon: "packets", hint: "copy" });
  });

  it("drops a group once all its pads are connected", () => {
    const { groups } = groupInputPads(pads, new Set(["p5"]));
    expect(groups.map((g) => g.id)).toEqual(["packets", "subtitles"]);
  });
});
