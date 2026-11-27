import { describe, expect, it } from "vitest";
import type { GEdge, GNode, Graph, NodeData, ProbeResult } from "../model/types";
import { newFilterData, newInputData, newMuxerData, normalizeMuxerSlots } from "../nodes/defs";
import { serialize } from "../serializer";
import { checkCompat } from "./compat";
import { checkConnection } from "./connections";
import { validate } from "./diagnostics";
import { negotiate } from "./negotiate";
import { encoder, pushNode } from "../test/fixtures";

const PROBE: ProbeResult = {
  format: { duration: "5" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "25/1" },
    { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, channel_layout: "stereo" },
    { index: 2, codec_type: "subtitle", codec_name: "subrip" },
  ],
};

function build(fn: (add: (d: NodeData) => string, link: (s: string, sh: string, t: string, th: string) => void) => void): Graph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  let i = 0;
  let ei = 0;
  const add = (data: NodeData) => {
    const id = `n${i++}`;
    pushNode(nodes, edges, id, data);
    return id;
  };
  const link = (source: string, sourceHandle: string, target: string, targetHandle: string) => {
    const t = nodes.find((n) => n.id === target)!;
    if (t.data.kind === "muxer") targetHandle = t.data.slots[t.data.slots.length - 1].id;
    edges.push({ id: `e${ei++}`, source, sourceHandle, target, targetHandle });
    if (t.data.kind === "muxer") t.data = normalizeMuxerSlots(t.data, t.id, edges) ?? t.data;
  };
  fn(add, link);
  return { nodes, edges };
}

const run = (g: Graph) => {
  const ser = serialize(g);
  return validate(g, ser, negotiate(g));
};

describe("connections", () => {
  it("only connects matching domain and media, and refuses loops", () => {
    let ids: string[] = [];
    const g = build((add) => {
      ids = [add({ ...newInputData("a.mkv"), probe: PROBE }), add(encoder("audio")), add(newMuxerData("o.mkv")), add(newFilterData("scale")), add(newFilterData("fps"))];
    });
    const [inp, aenc, mux, scale, fps] = ids;
    expect(checkConnection(g, { source: inp, sourceHandle: "f0", target: aenc, targetHandle: "in" }).ok).toBe(false);
    expect(checkConnection(g, { source: inp, sourceHandle: "f1", target: aenc, targetHandle: "in" }).ok).toBe(true);
    expect(checkConnection(g, { source: inp, sourceHandle: "f1", target: mux, targetHandle: "s0" }).ok).toBe(false); // frames → muxer
    expect(checkConnection(g, { source: inp, sourceHandle: "p2", target: mux, targetHandle: "s0" }).ok).toBe(true); // copy
    g.edges.push({ id: "x", source: scale, sourceHandle: "out", target: fps, targetHandle: "in" });
    expect(checkConnection(g, { source: fps, sourceHandle: "out", target: scale, targetHandle: "in" }).reason).toMatch(/loop/);
  });
});

describe("diagnostics", () => {
  it("flags main10 without a 10-bit format and offers a fix", () => {
    const g = build((add, link) => {
      const inp = add({ ...newInputData("a.mkv"), probe: PROBE });
      const base = encoder("video", "libx265");
      const enc = add({ ...base, params: { ...base.params, profile: "main10" } });
      const mux = add(newMuxerData("o.mkv"));
      link(inp, "f0", enc, "in");
      link(enc, "out", mux, "");
    });
    const d = run(g).find((x) => x.message.includes("10-bit"));
    expect(d?.severity).toBe("error");
    expect((d?.fix?.patch as { params: { pix_fmt: string } }).params.pix_fmt).toBe("yuv420p10le");
  });

  it("warns about hvc1 and refuses SubRip in MP4", () => {
    const g = build((add, link) => {
      const inp = add({ ...newInputData("a.mkv"), probe: PROBE });
      const enc = add(encoder("video", "libx265"));
      const mux = add(newMuxerData("o.mp4"));
      link(inp, "f0", enc, "in");
      link(enc, "out", mux, "");
      link(inp, "p2", mux, "");
    });
    const ds = run(g);
    expect(ds.some((d) => d.severity === "warning" && /hvc1/.test(d.message) && d.fix)).toBe(true);
    expect(ds.some((d) => d.severity === "error" && /subrip/.test(d.message))).toBe(true);
  });

  it("tracks formats through filters (loudnorm → 192 kHz)", () => {
    let enc = "";
    const g = build((add, link) => {
      const inp = add({ ...newInputData("a.mkv"), probe: PROBE });
      const loud = add(newFilterData("loudnorm"));
      enc = add(encoder("audio"));
      const mux = add(newMuxerData("o.m4a"));
      link(inp, "f1", loud, "in");
      link(loud, "out", enc, "in");
      link(enc, "out", mux, "");
    });
    expect(run(g).some((d) => d.nodeId === enc && d.fix?.label === "Set 48 kHz")).toBe(true);
    const neg = negotiate(g);
    expect([...neg.edges.values()][1].label).toBe("192 kHz stereo");
  });

  it("computes scale -2 heights for edge labels", () => {
    const g = build((add, link) => {
      const inp = add({ ...newInputData("a.mkv"), probe: PROBE });
      const s = add({ ...newFilterData("scale"), params: { w: "1280", h: "-2", flags: "" } });
      const enc = add(encoder("video"));
      link(inp, "f0", s, "in");
      link(s, "out", enc, "in");
    });
    expect(negotiate(g).edges.get("e1")?.label).toBe("1280×720 yuv420p 25fps");
  });

  it("rejects writing over an input", () => {
    const g = build((add, link) => {
      const inp = add({ ...newInputData("C:\\v\\a.mkv"), probe: PROBE });
      const mux = add(newMuxerData("c:/v/a.mkv"));
      link(inp, "p0", mux, "");
    });
    expect(run(g).some((d) => /overwrite/.test(d.message))).toBe(true);
  });

  it("warns about missing sequence frames and endless loops", () => {
    let mux = "";
    const sequence = { pattern: "s_%04d.png", first: 1, last: 10, count: 8, missing: [4, 5], missingCount: 2 };
    const g = build((add, link) => {
      const inp = add({ ...newInputData("c:/v/s_%04d.png"), probe: PROBE, sequence, options: { ...newInputData("").options, loop: "1" } });
      mux = add(newMuxerData("c:/v/out.mkv"));
      link(inp, "p0", mux, "");
    });
    const msgs = run(g).map((d) => d.message);
    expect(msgs.some((m) => /2 frames .* missing.*frame 4/.test(m))).toBe(true);
    expect(msgs.some((m) => /Loop repeats/.test(m))).toBe(true);
    const m = g.nodes.find((n) => n.id === mux)!;
    (m.data as ReturnType<typeof newMuxerData>).shortest = true;
    expect(run(g).some((d) => /Loop repeats/.test(d.message))).toBe(false);
  });
});

describe("GPU diagnostics", () => {
  const cuda = (gpuFrames: "auto" | "off" = "auto") => ({ ...newInputData("a.mkv"), probe: PROBE, options: { ...newInputData("").options, hwaccel: "cuda", gpuFrames } });

  it("uploads CPU frames in front of scale_cuda and offers to decode with cuda", () => {
    let sc = "";
    let inp = "";
    const g = build((add, link) => {
      inp = add({ ...newInputData("a.mkv"), probe: PROBE });
      sc = add(newFilterData("scale_cuda"));
      const enc = add(encoder("video", "hevc_nvenc"));
      link(inp, "f0", sc, "in");
      link(sc, "out", enc, "in");
    });
    const diags = run(g);
    expect(diags.filter((x) => x.severity === "error")).toEqual([]);
    const d = diags.find((x) => x.nodeId === sc && /uploaded to the GPU/.test(x.message));
    expect(d?.severity).toBe("info");
    expect(d?.fix?.label).toBe("Decode with cuda");
    expect(d?.fix?.nodeId).toBe(inp);
  });

  it("explains a download in front of a CPU filter after a CUDA one", () => {
    let crop = "";
    const g = build((add, link) => {
      const inp = add(cuda());
      const sc = add(newFilterData("scale_cuda"));
      crop = add(newFilterData("crop"));
      const enc = add(encoder("video", "hevc_nvenc"));
      link(inp, "f0", sc, "in");
      link(sc, "out", crop, "in");
      link(crop, "out", enc, "in");
    });
    const diags = run(g);
    expect(diags.filter((x) => x.severity === "error")).toEqual([]);
    expect(diags.find((x) => x.nodeId === crop && /hwdownload/.test(x.message))?.severity).toBe("info");
  });

  it("explains which CPU filter forces frames into system memory", () => {
    let inp = "";
    const g = build((add, link) => {
      inp = add(cuda());
      const crop = add(newFilterData("crop"));
      const enc = add(encoder("video", "hevc_nvenc"));
      link(inp, "f0", crop, "in");
      link(crop, "out", enc, "in");
    });
    expect(run(g).some((d) => d.nodeId === inp && d.severity === "info" && /Crop \(CPU filter\)/.test(d.message))).toBe(true);
  });

  it("main10 on 8-bit GPU frames: no pix_fmt fix, highbitdepth instead", () => {
    let enc = "";
    const make = (highbitdepth: boolean) =>
      build((add, link) => {
        const inp = add(cuda());
        const base = encoder("video", "hevc_nvenc");
        enc = add({ ...base, params: { ...base.params, profile: "main10", highbitdepth } });
        link(inp, "f0", enc, "in");
      });
    const d = run(make(false)).find((x) => x.nodeId === enc && /10-bit/.test(x.message));
    expect(d?.severity).toBe("error");
    expect(d?.fix?.label).toBe("10-bit from 8-bit input");
    expect(run(make(true)).some((x) => x.nodeId === enc && /10-bit/.test(x.message))).toBe(false);
  });

  it("labels GPU-resident edges and warns about an unknown GPU index", () => {
    let enc = "";
    const g = build((add, link) => {
      const inp = add(cuda());
      const sc = add({ ...newFilterData("scale_cuda"), params: { w: "1280", h: "-2", format: "p010le", interp_algo: "" } });
      const base = encoder("video", "hevc_nvenc");
      enc = add({ ...base, params: { ...base.params, gpu: "3" } });
      link(inp, "f0", sc, "in");
      link(sc, "out", enc, "in");
    });
    const neg = negotiate(g);
    expect(neg.edges.get("e0")?.label).toBe("1920×1080 nv12 25fps · GPU (cuda)");
    expect(neg.edges.get("e1")?.label).toBe("1280×720 p010le 25fps · GPU (cuda)");
    // frames arrive on the GPU, so the encoder's -gpu is ignored and not checked
    expect(validate(g, serialize(g), neg, undefined, [{ index: 0, name: "A" }]).some((d) => d.nodeId === enc && /GPU 3/.test(d.message))).toBe(false);
  });
});

describe("compat table", () => {
  it("knows common container rules", () => {
    expect(checkCompat("webm", "video", "h264").level).toBe("error");
    expect(checkCompat("mp4", "video", "vp9").level).toBe("warning");
    expect(checkCompat("matroska", "subtitle", "subrip").level).toBe("ok");
    expect(checkCompat("adts", "video", "h264").level).toBe("error");
  });
});
