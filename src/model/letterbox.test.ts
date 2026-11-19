import { describe, expect, it } from "vitest";
import { newFilterData, newInputData } from "../nodes/defs";
import { FILTERS_BY_ID } from "../nodes/defs/filters";
import { filterText } from "../serializer/filtergraph";
import { negotiate } from "../validation/negotiate";
import { letterboxDiagnostics, letterboxOptions, letterboxSource } from "./letterbox";
import type { FilterNodeData, GEdge, GNode, ProbeResult } from "./types";
import { encoder, pushNode } from "../test/fixtures";

const def = FILTERS_BY_ID.letterbox;
const PROBE: ProbeResult = {
  format: { duration: "60" },
  streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "25/1" }],
};

function graph(params: Record<string, number> = {}, extra?: Partial<FilterNodeData>, scaleFirst = false) {
  const nodes: GNode[] = [{ id: "in", position: { x: 0, y: 0 }, data: { ...newInputData("C:/v/movie.mkv"), probe: PROBE } }];
  const edges: GEdge[] = [];
  let from = "in";
  let pad = "f0";
  if (scaleFirst) {
    nodes.push({ id: "sc", position: { x: 0, y: 0 }, data: { ...newFilterData("scale"), params: { w: "1280", h: "720", flags: "" } } });
    edges.push({ id: "e0", source: "in", sourceHandle: "f0", target: "sc", targetHandle: "in" });
    from = "sc";
    pad = "out";
  }
  const base = newFilterData("letterbox");
  nodes.push({ id: "lb", position: { x: 0, y: 0 }, data: { ...base, params: { ...base.params, ...params }, ...extra } });
  pushNode(nodes, edges, "enc", encoder("video", "libx264"));
  edges.push({ id: "e1", source: from, sourceHandle: pad, target: "lb", targetHandle: "in" }, { id: "e2", source: "lb", sourceHandle: "out", target: "enc", targetHandle: "in" });
  return { nodes, edges };
}
const diags = (g: ReturnType<typeof graph>) => {
  const neg = negotiate(g);
  const e = g.edges.find((x) => x.target === "lb")!;
  const f = neg.padFormat(e.source, e.sourceHandle ?? "");
  return letterboxDiagnostics(g, g.nodes.find((n) => n.id === "lb") as GNode<FilterNodeData>, f?.media === "video" ? f.height : undefined);
};

describe("Remove letterbox node", () => {
  it("emits the same crop as letterbox.py", () => {
    expect(filterText(def, { top: 100, bottom: 110 })).toBe("crop=iw:ih-210:0:100");
    expect(filterText(def, { top: 0, bottom: 0 })).toBe("crop=iw:ih:0:0");
    // detection settings never reach the command
    expect(filterText(def, { top: 2, bottom: 2, samples: 20, blackLevel: 16 })).toBe("crop=iw:ih-4:0:2");
  });

  it("negotiates the cropped height", () => {
    const g = graph({ top: 100, bottom: 110 });
    expect(negotiate(g).padFormat("lb", "out")).toMatchObject({ width: 1920, height: 870 });
  });

  it("finds its Input stream and maps the detection settings", () => {
    const src = letterboxSource(graph(), "lb")!;
    expect(src.input.id).toBe("in");
    expect(src.stream).toMatchObject({ width: 1920, height: 1080 });
    expect(letterboxOptions({ samples: 9, startPct: 10, endPct: 90, blackLevel: 10, rowContentPct: 5, darkMean: 30 })).toEqual({
      samples: 9,
      startFrac: 0.1,
      endFrac: 0.9,
      blackLevel: 10,
      rowContentFrac: 0.05,
      darkFrameMean: 30,
    });
  });

  it("explains missing, stale and impossible detections", () => {
    expect(diags(graph()).map((d) => d.message)).toEqual(["Bars not detected yet: press Detect."]);
    const ok = { letterbox: { path: "C:/v/movie.mkv", height: 1080, usable: 9, sampled: 9 } };
    expect(diags(graph({ top: 140, bottom: 140 }, ok))).toEqual([]);
    expect(diags(graph({ top: 140, bottom: 140 }, { letterbox: { ...ok.letterbox, path: "C:/v/other.mkv" } }))[0].message).toMatch(/other\.mkv.*movie\.mkv.*Detect again/);
    expect(diags(graph({ top: 140, bottom: 140 }, ok, true))[0].message).toMatch(/1080-line frames, but this node receives 720/);
    expect(diags(graph({ top: 600, bottom: 600 }, ok)).some((d) => d.severity === "error")).toBe(true);
    expect(diags(graph({ top: 141, bottom: 140 }, ok))[0].message).toMatch(/even/);
  });
});
