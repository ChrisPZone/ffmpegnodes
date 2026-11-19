import { describe, expect, it } from "vitest";
import type { GEdge, GNode, NodeData, ParamValues, ProbeResult } from "../../model/types";
import { serialize } from "../../serializer";
import { filterText } from "../../serializer/filtergraph";
import { DEFAULT_OPEN, matchingPad, matchItems, paletteSections, PALETTE_ITEMS } from "../../ui/paletteItems";
import { negotiate } from "../../validation/negotiate";
import { getPads, newFilterData, newInputData, newMuxerData, normalizeMuxerSlots } from "./index";
import { atempoChain, defaultParams, FILTERS, FILTERS_BY_ID } from "./filters";
import { encoder, pushNode } from "../../test/fixtures";

const text = (id: string, params: ParamValues = {}) => {
  const def = FILTERS_BY_ID[id];
  return filterText(def, { ...defaultParams(def.params), ...params });
};

describe("filter text", () => {
  it("renders defaults of the new filters", () => {
    expect(text("transpose")).toBe("transpose=dir=clock");
    expect(text("flip")).toBe("hflip");
    expect(text("flip", { dir: "both" })).toBe("hflip,vflip");
    expect(text("pad")).toBe("pad=w=1920:h=1080:x=(ow-iw)/2:y=(oh-ih)/2");
    expect(text("setsar", { mode: "dar", r: "16:9" })).toBe("setdar=16\\\\:9");
    expect(text("trim", { start: "10", duration: "5" })).toBe("trim=start=10:duration=5,setpts=PTS-STARTPTS");
    expect(text("atrim", { start: "1:30" })).toBe("atrim=start=1\\\\:30,asetpts=PTS-STARTPTS");
    expect(text("speed", { factor: 0.5 })).toBe("setpts=PTS/0.5");
    expect(text("fade", { type: "out", start_time: "9" })).toBe("fade=type=out:start_time=9:duration=1");
    expect(text("concat")).toBe("concat=n=2:v=1:a=1");
    expect(text("bwdif")).toBe("bwdif=mode=send_frame");
    expect(text("hqdn3d")).toBe("hqdn3d=4:3:6:4.5");
    expect(text("hqdn3d", { strength: "custom", luma_spatial: 2 })).toBe("hqdn3d=luma_spatial=2:chroma_spatial=3:luma_tmp=6:chroma_tmp=4.5");
    expect(text("unsharp")).toBe("unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=1");
    expect(text("deband")).toBe("deband=1thr=0.02:2thr=0.02:3thr=0.02:4thr=0.02:range=16");
    expect(text("stack", { dir: "v", inputs: 3 })).toBe("vstack=inputs=3");
    expect(text("passfilter", { type: "lowpass", frequency: 12000 })).toBe("lowpass=frequency=12000");
    expect(text("atempo", { tempo: 3 })).toBe("atempo=2,atempo=1.5");
    expect(text("adelay", { ms: 250 })).toBe("adelay=delays=250:all=1");
    expect(text("apad")).toBe("apad=pad_dur=1");
    expect(text("apad", { mode: "whole", whole_dur: "60" })).toBe("apad=whole_dur=60");
    expect(text("pan")).toBe("aformat=channel_layouts=stereo");
    expect(text("pan", { preset: "swap" })).toBe("pan=stereo|c0=c1|c1=c0");
    expect(text("aresample", { async: true })).toBe("aresample=48000:async=1");
    expect(text("alimiter")).toBe("alimiter=limit=-1dB:level=0");
  });

  it("escapes file paths and text for the filtergraph", () => {
    expect(text("subtitles", { filename: "C:\\subs\\a.srt" })).toBe("subtitles=filename=C\\\\:/subs/a.srt");
    expect(text("lut3d", { file: "D:/luts/look.cube" })).toBe("lut3d=file=D\\\\:/luts/look.cube");
    expect(text("drawtext", { text: "Hi, it's 10:00" })).toBe(
      "drawtext=text=Hi\\, it\\\\\\'s 10\\\\:00:fontsize=48:fontcolor=white:x=(w-text_w)/2:y=h-text_h-40",
    );
    // hidden params are not emitted
    expect(text("drawtext", { box: true })).toContain("box=1:boxcolor=black@0.5:boxborderw=10");
    expect(text("drawtext")).not.toContain("boxcolor");
  });

  it("chains atempo within 0.5–2", () => {
    expect(atempoChain(1.25)).toEqual([1.25]);
    expect(atempoChain(5)).toEqual([2, 2, 1.25]);
    expect(atempoChain(0.2)).toEqual([0.5, 0.5, 0.8]);
  });

  it("every filter has a category and unique id", () => {
    expect(new Set(FILTERS.map((f) => f.id)).size).toBe(FILTERS.length);
    expect(FILTERS.every((f) => f.category)).toBe(true);
  });
});

// ---------------------------------------------------------------- graphs

const PROBE: ProbeResult = {
  format: { duration: "10.0", format_name: "matroska,webm" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "25/1" },
    { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, channel_layout: "stereo" },
  ],
};

function graph() {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  let n = 0;
  const add = (data: NodeData) => {
    const id = `n${n++}`;
    pushNode(nodes, edges, id, data);
    return id;
  };
  const link = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
    edges.push({ id: `e${edges.length}`, source, sourceHandle, target, targetHandle });
  const toMux = (source: string, mux: string) => {
    const node = nodes.find((x) => x.id === mux)!;
    const d = node.data as ReturnType<typeof newMuxerData>;
    link(source, "out", mux, d.slots[d.slots.length - 1].id);
    node.data = normalizeMuxerSlots(d, mux, edges) ?? d;
  };
  return { nodes, edges, add, link, toMux, input: (p: string) => add({ ...newInputData(p), probe: PROBE }) };
}

describe("multi-pad filters", () => {
  it("concat wires segments in ffmpeg's order and maps both outputs", () => {
    const g = graph();
    const a = g.input("a.mkv");
    const b = g.input("b.mkv");
    const cat = g.add(newFilterData("concat"));
    const venc = g.add(encoder("video", "libx264"));
    const aenc = g.add(encoder("audio", "aac"));
    const mux = g.add(newMuxerData("out.mkv"));
    // connect out of order on purpose
    g.link(b, "f1", cat, "s1a0");
    g.link(a, "f0", cat, "s0v0");
    g.link(b, "f0", cat, "s1v0");
    g.link(a, "f1", cat, "s0a0");
    g.link(cat, "v0", venc, "in");
    g.link(cat, "a0", aenc, "in");
    g.toMux(venc, mux);
    g.toMux(aenc, mux);
    const r = serialize({ nodes: g.nodes, edges: g.edges });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.args[r.args.indexOf("-filter_complex") + 1]).toBe("[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]");
    expect(r.args.join(" ")).toContain("-map [v] -c:v:0 libx264");
    expect(r.args.join(" ")).toContain("-map [a] -c:a:0 aac");
  });

  it("concat pads follow the segment/stream counts", () => {
    const pads = getPads({ id: "x", position: { x: 0, y: 0 }, data: { ...newFilterData("concat"), params: { n: 3, v: 1, a: 2 } } });
    expect(pads.inputs.map((p) => p.id)).toEqual(["s0v0", "s0a0", "s0a1", "s1v0", "s1a0", "s1a1", "s2v0", "s2a0", "s2a1"]);
    expect(pads.outputs.map((p) => `${p.id}:${p.type.media}`)).toEqual(["v0:video", "a0:audio", "a1:audio"]);
  });

  it("negotiates formats through transpose, stack, bwdif and pan", () => {
    const g = graph();
    const inp = g.input("a.mkv");
    const tr = g.add(newFilterData("transpose"));
    const st = g.add({ ...newFilterData("stack"), params: { ...newFilterData("stack").params, inputs: 2 } });
    const bw = g.add({ ...newFilterData("bwdif"), params: { ...newFilterData("bwdif").params, mode: "send_field" } });
    const pan = g.add({ ...newFilterData("pan"), params: { ...newFilterData("pan").params, preset: "mono" } });
    g.link(inp, "f0", tr, "in");
    g.link(tr, "out", st, "in0");
    g.link(tr, "out", st, "in1");
    g.link(st, "out", bw, "in");
    g.link(inp, "f1", pan, "in");
    const neg = negotiate({ nodes: g.nodes, edges: g.edges });
    expect(neg.padFormat(tr, "out")).toMatchObject({ width: 1080, height: 1920 });
    expect(neg.padFormat(st, "out")).toMatchObject({ width: 2160, height: 1920 });
    expect(neg.padFormat(bw, "out")).toMatchObject({ fps: 50 });
    expect(neg.padFormat(pan, "out")).toMatchObject({ channels: 1 });
  });
});

// ---------------------------------------------------------------- palette

describe("palette search", () => {
  const labels = (q: string) => matchItems(q).map((i) => i.key);

  it("finds filters by synonym", () => {
    expect(labels("deinterlace")[0]).toBe("filter:bwdif");
    expect(labels("letterbox").slice(0, 2).sort()).toEqual(["filter:letterbox", "filter:pad"]);
    expect(labels("black bars")[0]).toBe("filter:letterbox");
    expect(labels("speed")).toEqual(expect.arrayContaining(["filter:speed", "filter:atempo"]));
    expect(labels("fade")).toEqual(expect.arrayContaining(["filter:fade", "filter:afade"]));
  });

  it("ranks label matches first and requires every word", () => {
    expect(labels("scale")[0]).toBe("filter:scale");
    expect(labels("scale cuda")).toEqual(["filter:scale_cuda"]);
    expect(labels("zzzz")).toEqual([]);
  });

  it("lists every item exactly once across sections", () => {
    const keys = paletteSections().flatMap((s) => s.items.map((i) => i.key));
    expect(keys.sort()).toEqual(PALETTE_ITEMS.map((i) => i.key).sort());
    expect(paletteSections().every((s) => DEFAULT_OPEN.has(s.id) || s.items.length)).toBe(true);
    expect(paletteSections()[0]).toMatchObject({ title: "Input / Output", items: ["input", "encoder:video", "encoder:audio", "encoder:subtitle", "encparams:video", "encparams:audio", "encparams:subtitle", "muxer"].map((key) => ({ key })) });
    expect(paletteSections().some((s) => s.id === "output" || s.id === "encoders")).toBe(false);
  });

  it("offers only nodes that can take a dropped wire", () => {
    const audioFrames = { side: "source" as const, type: { domain: "frames" as const, media: "audio" as const } };
    const ok = PALETTE_ITEMS.filter((it) => matchingPad(it.spec, audioFrames) !== undefined).map((i) => i.key);
    expect(ok).toContain("filter:loudnorm");
    expect(ok).toContain("encoder:audio");
    expect(ok).toContain("filter:concat"); // has audio segment pads
    expect(ok).not.toContain("filter:scale");
    expect(ok).not.toContain("muxer");
    const packets = { side: "source" as const, type: { domain: "packets" as const, media: "video" as const } };
    expect(PALETTE_ITEMS.filter((it) => matchingPad(it.spec, packets) !== undefined).map((i) => i.key)).toEqual(["muxer"]);
    // dragging backwards from an encoder's input: anything producing video frames
    const fromEncoderInput = { side: "target" as const, type: { domain: "frames" as const, media: "video" as const } };
    expect(matchingPad({ kind: "filter", defId: "concat" }, fromEncoderInput)).toBe("v0");
  });
});
