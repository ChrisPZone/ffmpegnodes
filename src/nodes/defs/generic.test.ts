import { describe, expect, it } from "vitest";
import { MOCK_FILTER_HELP } from "../../ipc/mockFilterHelp";
import type { GEdge, GNode, NodeData, ProbeResult } from "../../model/types";
import { serialize } from "../../serializer";
import { filterText } from "../../serializer/filtergraph";
import { genericItems, matchingPad, matchItems, paletteSections } from "../../ui/paletteItems";
import { getPads, newInputData, newMuxerData, nodeMedia, normalizeMuxerSlots } from "./index";
import { genericDef, newGenericFilterData, offerGeneric, parseFilterHelp, parseIo, type GenericFilterSpec } from "./generic";
import { encoder, pushNode } from "../../test/fixtures";

const OVERLAY_HELP = `Filter overlay
  Overlay a video source on top of the input.
    slice threading supported
    Inputs:
       #0: main (video)
       #1: overlay (video)
    Outputs:
       #0: default (video)
overlay AVOptions:
   x                 <string>     ..FV.....T. set the x expression (default "0")
   eof_action        <int>        ..FV....... Action to take when encountering EOF from secondary input  (from 0 to 2) (default repeat)
     repeat          0            ..FV....... Repeat the previous frame.
     endall          1            ..FV....... End both streams.
   shortest          <boolean>    ..FV....... force termination when the shortest input terminates (default false)
   alpha             <int>        ..FV....... alpha format (from 0 to 2) (default auto)
     auto            0            ..FV.......
     straight        2            ..FV.......

framesync AVOptions:
   eof_action        <int>        ..FV....... Action to take when encountering EOF from secondary input  (from 0 to 2) (default repeat)
     repeat          0            ..FV....... Repeat the previous frame.
   ts_sync_mode      <int>        ..FV....... How strictly to sync streams based on secondary input timestamps (from 0 to 1) (default default)
     default         0            ..FV....... Frame from secondary input with the nearest lower or equal timestamp to the primary input frame
     nearest         1            ..FV....... Frame from secondary input with the absolute nearest timestamp to the primary input frame
   flags             <flags>      ..FV....... test flags (default 0)
     a                            ..FV....... first
     b                            ..FV....... second
`;

const spec = (name: string, io: string, help = true): GenericFilterSpec => ({
  name,
  io,
  description: name,
  help: help ? parseFilterHelp(MOCK_FILTER_HELP[name] ?? OVERLAY_HELP) : undefined,
});
const def = (s: GenericFilterSpec) => genericDef(s);
const param = (s: GenericFilterSpec, name: string) => def(s).params.find((p) => p.name === name);

describe("ffmpeg -h filter= parsing", () => {
  it("reads pads, options, aliases, enums and the timeline flag", () => {
    const h = parseFilterHelp(MOCK_FILTER_HELP.vignette);
    expect(h.description).toBe("Make or reverse a vignette effect.");
    expect(h.inputs).toEqual({ kind: "static", pads: [{ name: "default", media: "video" }] });
    expect(h.timeline).toBe(true);
    const angle = h.options.find((o) => o.name === "angle")!;
    expect(angle).toMatchObject({ type: "string", default: "PI/5", aliases: ["a"] });
    expect(h.options.some((o) => o.name === "a")).toBe(false);
    const mode = h.options.find((o) => o.name === "mode")!;
    expect(mode).toMatchObject({ type: "int", default: "forward", min: 0, max: 1 });
    expect(mode.consts.map((c) => c.name)).toEqual(["forward", "backward"]);
    expect(h.options.find((o) => o.name === "aspect")).toMatchObject({ type: "rational", default: "1/1", min: 0, max: undefined });
  });

  it("keeps the first of options repeated in later sections and named pads", () => {
    const h = parseFilterHelp(OVERLAY_HELP);
    expect(h.inputs).toEqual({ kind: "static", pads: [{ name: "main", media: "video" }, { name: "overlay", media: "video" }] });
    expect(h.options.map((o) => o.name)).toEqual(["x", "eof_action", "shortest", "alpha", "ts_sync_mode", "flags"]);
    expect(h.options.find((o) => o.name === "eof_action")!.consts).toHaveLength(2);
    expect(h.timeline).toBe(false);
  });

  it("recognizes source and dynamic sides", () => {
    expect(parseFilterHelp(MOCK_FILTER_HELP.sine)).toMatchObject({ inputs: { kind: "none" }, outputs: { kind: "static", pads: [{ media: "audio" }] } });
    expect(parseFilterHelp(MOCK_FILTER_HELP.xstack).inputs).toEqual({ kind: "dynamic" });
    expect(parseFilterHelp(MOCK_FILTER_HELP.channelsplit).outputs).toEqual({ kind: "dynamic" });
    expect(parseIo("VV->V").inputs).toMatchObject({ kind: "static", pads: [{ media: "video" }, { media: "video" }] });
    expect(parseIo("|->A").inputs).toEqual({ kind: "none" });
    expect(parseIo("N->A").inputs).toEqual({ kind: "dynamic" });
  });
});

describe("generic filter definition", () => {
  it("maps ffmpeg option types to widgets", () => {
    const o = spec("overlay", "VV->V");
    expect(param(o, "eof_action")).toMatchObject({ type: "enum", default: "repeat" });
    expect(param(o, "shortest")).toMatchObject({ type: "bool", default: false });
    expect(param(o, "alpha")!.options!.map((x) => x.value)).toEqual(["auto", "straight"]);
    expect(param(o, "flags")).toMatchObject({ type: "string", default: "", placeholder: "a+b" });
    const s = spec("sine", "|->A");
    expect(param(s, "frequency")).toMatchObject({ type: "float", default: 440 });
    expect(param(s, "sample_rate")).toMatchObject({ type: "int", default: 44100 });
    expect(param(spec("vignette", "V->V"), "enable")).toBeDefined();
  });

  it("emits only changed options, then the extra text", () => {
    const v = spec("vignette", "V->V");
    expect(filterText(def(v), {})).toBe("vignette");
    expect(filterText(def(v), { angle: "PI/4", mode: "backward", dither: false })).toBe("vignette=angle=PI/4:mode=backward:dither=0");
    expect(filterText(def(v), { mode: "forward", _raw: "x0=w/3" })).toBe("vignette=x0=w/3");
    expect(filterText(def(v), { angle: "PI/4", _raw: "x0=w/3" })).toBe("vignette=angle=PI/4:x0=w/3");
    expect(filterText(def(v), { enable: "between(t,1,2)" })).toBe("vignette=enable=between(t\\,1\\,2)");
  });

  it("builds pads from help, from the io string before help arrives, and from count options", () => {
    const n = (s: GenericFilterSpec, params = {}) => getPads({ id: "x", position: { x: 0, y: 0 }, data: { kind: "filter", defId: "generic", params, generic: s } });
    expect(n(spec("overlay", "VV->V")).inputs.map((p) => p.label)).toEqual(["main", "overlay"]);
    expect(n(spec("overlay", "VV->V", false)).inputs.map((p) => p.id)).toEqual(["in0", "in1"]);
    expect(n(spec("sine", "|->A")).inputs).toEqual([]);
    expect(n(spec("xstack", "N->V")).inputs).toHaveLength(2);
    expect(n(spec("xstack", "N->V"), { inputs: 4 }).inputs.map((p) => p.type.media)).toEqual(["video", "video", "video", "video"]);
    // channelsplit has no count option: a UI-only pad count, media guessed from the input
    const cs = spec("channelsplit", "A->N");
    expect(n(cs).outputs.map((p) => `${p.id}:${p.type.media}`)).toEqual(["out0:audio", "out1:audio"]);
    expect(n(cs, { _nout: 6 }).outputs).toHaveLength(6);
    expect(filterText(def(cs), { _nout: 6 })).toBe("channelsplit");
    expect(def(spec("showwaves", "A->V")).media).toBe("av");
    expect(nodeMedia({ kind: "filter", defId: "generic", params: {}, generic: spec("sine", "|->A") })).toBe("audio");
  });
});

describe("generic filters in the palette and the command", () => {
  const caps = {
    version: "",
    encoders: [],
    muxers: [],
    filters: [
      { name: "scale", io: "V->V", description: "Scale" },
      { name: "vignette", io: "V->V", description: "Make or reverse a vignette effect." },
      { name: "sine", io: "|->A", description: "Generate sine wave audio signal." },
      { name: "aecho", io: "A->A", description: "Add echoing to the audio." },
      { name: "nullsink", io: "V->|", description: "Do absolutely nothing" },
      { name: "scale_npp", io: "V->V", description: "NPP" },
      { name: "setpts", io: "V->V", description: "Set PTS" },
    ],
  };

  it("offers the build's other filters, not sinks, hardware or curated ones", () => {
    expect(genericItems(caps).map((i) => `${i.label}:${i.section}`)).toEqual(["aecho:ff:audio", "setpts:ff:video", "sine:ff:source", "vignette:ff:video"]);
    expect(offerGeneric({ name: "pan", io: "A->A" })).toBe(true);
    const ids = paletteSections([...genericItems(caps)]).map((s) => `${s.id}${s.heading ? `(${s.heading})` : ""}`);
    expect(ids).toEqual(["ff:video(All ffmpeg filters)", "ff:audio", "ff:source"]);
    expect(matchItems("vign", genericItems(caps))[0].label).toBe("vignette");
    const audioWire = { side: "source" as const, type: { domain: "frames" as const, media: "audio" as const } };
    expect(genericItems(caps).filter((i) => matchingPad(i.spec, audioWire)).map((i) => i.label)).toEqual(["aecho"]);
  });

  it("serializes a generic chain and a source filter", () => {
    const PROBE: ProbeResult = {
      format: { duration: "10" },
      streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 640, height: 360, pix_fmt: "yuv420p", avg_frame_rate: "25/1" }],
    };
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    let k = 0;
    const add = (data: NodeData) => {
      const id = `n${k++}`;
      pushNode(nodes, edges, id, data);
      return id;
    };
    const link = (s: string, sh: string, t: string, th: string) => edges.push({ id: `e${edges.length}`, source: s, sourceHandle: sh, target: t, targetHandle: th });
    const inp = add({ ...newInputData("a.mp4"), probe: PROBE });
    const vig = add({ ...newGenericFilterData({ name: "vignette", io: "V->V", description: "" }), generic: spec("vignette", "V->V"), params: { mode: "backward" } });
    const sine = add({ ...newGenericFilterData({ name: "sine", io: "|->A", description: "" }), generic: spec("sine", "|->A"), params: { duration: "2" } });
    const venc = add(encoder("video", "libx264"));
    const aenc = add(encoder("audio", "aac"));
    const mux = add(newMuxerData("out.mkv"));
    link(inp, "f0", vig, "in0");
    link(vig, "out0", venc, "in");
    link(sine, "out0", aenc, "in");
    for (const e of [venc, aenc]) {
      const m = nodes.find((x) => x.id === mux)!;
      const d = m.data as ReturnType<typeof newMuxerData>;
      link(e, "out", mux, d.slots[d.slots.length - 1].id);
      m.data = normalizeMuxerSlots(d, mux, edges) ?? d;
    }
    const r = serialize({ nodes, edges });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.args[r.args.indexOf("-filter_complex") + 1]).toBe("[0:v]vignette=mode=backward[v];sine=duration=2[a]");
  });
});
