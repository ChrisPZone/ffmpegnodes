import { describe, expect, it } from "vitest";
import { getPads, newEncoderData, newEncoderParamsData, newInputData, newMuxerData, normalizeMuxerSlots, PARAMS_PAD } from "../nodes/defs";
import { serialize } from "../serializer";
import { validate } from "../validation/diagnostics";
import { checkConnection } from "../validation/connections";
import { negotiate } from "../validation/negotiate";
import { encodersUsing, paramsNodeOf, resolveEncoders } from "./encoders";
import type { GEdge, GNode, Graph, MuxerNodeData, NodeData, ProbeResult, ResolvedEncoderData } from "./types";

const FIVE_AUDIO: ProbeResult = {
  format: { duration: "10" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "25/1" },
    ...[1, 2, 3, 4, 5].map((index) => ({ index, codec_type: "audio" as const, codec_name: "ac3", sample_rate: "48000", channels: 6, channel_layout: "5.1" })),
    { index: 6, codec_type: "subtitle", codec_name: "subrip" },
    { index: 7, codec_type: "subtitle", codec_name: "subrip" },
  ],
};

function graph() {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  let n = 0;
  const add = (data: NodeData) => (nodes.push({ id: `n${n}`, position: { x: 0, y: 0 }, data }), `n${n++}`);
  const link = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
    edges.push({ id: `e${edges.length}`, source, sourceHandle, target, targetHandle });
  const toMux = (source: string, mux: string) => {
    const m = nodes.find((x) => x.id === mux)!;
    const d = m.data as MuxerNodeData;
    link(source, "out", mux, d.slots[d.slots.length - 1].id);
    m.data = normalizeMuxerSlots(d, mux, edges) ?? d;
  };
  const g: Graph = { nodes, edges };
  return { g, nodes, edges, add, link, toMux };
}

describe("encoder parameters nodes", () => {
  it("encoders take codec and options from the wired parameters node", () => {
    const { g, add, link } = graph();
    const p = add({ ...newEncoderParamsData("audio", "aac"), params: { ...newEncoderParamsData("audio", "aac").params, b: "512k" } });
    const a = add(newEncoderData("audio"));
    const b = add(newEncoderData("audio"));
    link(p, PARAMS_PAD, a, PARAMS_PAD);
    const r = resolveEncoders(g);
    expect(r.nodes.find((x) => x.id === a)!.data).toMatchObject({ codec: "aac", params: { b: "512k" }, paramsId: p });
    expect((r.nodes.find((x) => x.id === b)!.data as ResolvedEncoderData).missingParams).toBe(true);
    expect(resolveEncoders(r)).toBe(r); // idempotent
    expect(paramsNodeOf(g, a)?.id).toBe(p);
    expect(encodersUsing(g, p).map((x) => x.id)).toEqual([a]);
  });

  it("one parameters node feeds five audio encodes", () => {
    const { g, add, link, toMux } = graph();
    const inp = add({ ...newInputData("five.mkv"), probe: FIVE_AUDIO });
    const base = newEncoderParamsData("audio", "aac");
    const p = add({ ...base, params: { ...base.params, b: "512k", ar: "48000", ac: "6" } });
    const mux = add(newMuxerData("out.mkv"));
    for (let i = 1; i <= 5; i++) {
      const e = add(newEncoderData("audio"));
      link(p, PARAMS_PAD, e, PARAMS_PAD);
      link(inp, `f${i}`, e, "in");
      toMux(e, mux);
    }
    const r = serialize(g);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const cmd = r.args.join(" ");
    for (let i = 0; i < 5; i++) expect(cmd).toContain(`-map 0:a:${i} -c:a:${i} aac -b:a:${i} 512k -ar:a:${i} 48000 -ac:a:${i} 6`);
  });

  it("subtitle encoders share parameters too", () => {
    const { g, add, link, toMux } = graph();
    const inp = add({ ...newInputData("five.mkv"), probe: FIVE_AUDIO });
    const p = add(newEncoderParamsData("subtitle", "mov_text"));
    const mux = add(newMuxerData("out.mp4"));
    for (const s of [6, 7]) {
      const e = add(newEncoderData("subtitle"));
      link(p, PARAMS_PAD, e, PARAMS_PAD);
      link(inp, `f${s}`, e, "in");
      toMux(e, mux);
    }
    const cmd = serialize(g).args.join(" ");
    expect(cmd).toContain("-map 0:s:0 -c:s:0 mov_text");
    expect(cmd).toContain("-map 0:s:1 -c:s:1 mov_text");
  });

  it("an encoder without parameters is an error and its stream is left out", () => {
    const { g, add, link, toMux } = graph();
    const inp = add({ ...newInputData("five.mkv"), probe: FIVE_AUDIO });
    const p = add(newEncoderParamsData("audio"));
    const ok = add(newEncoderData("audio"));
    const bad = add(newEncoderData("audio"));
    const mux = add(newMuxerData("out.mkv"));
    link(p, PARAMS_PAD, ok, PARAMS_PAD);
    link(inp, "f1", ok, "in");
    link(inp, "f2", bad, "in");
    toMux(bad, mux);
    toMux(ok, mux);
    const ser = serialize(g);
    const diags = validate(g, ser, negotiate(g));
    expect(diags.find((d) => d.nodeId === bad && d.severity === "error")?.message).toMatch(/no parameters/);
    // f1 is the first audio stream; the unencodable f2 (0:a:1) is left out
    expect(ser.args.join(" ")).toContain("-map 0:a:0 -c:a:0 aac");
    expect(ser.args.join(" ")).not.toContain("0:a:1");
  });

  it("quick fixes change the parameters node", () => {
    const { g, add, link, toMux } = graph();
    const inp = add({ ...newInputData("five.mkv"), probe: FIVE_AUDIO });
    const base = newEncoderParamsData("video", "libx265");
    const p = add({ ...base, params: { ...base.params, profile: "main10" } });
    const e = add(newEncoderData("video"));
    const mux = add(newMuxerData("out.mkv"));
    link(p, PARAMS_PAD, e, PARAMS_PAD);
    link(inp, "f0", e, "in");
    toMux(e, mux);
    const d = validate(g, serialize(g), negotiate(g)).find((x) => /10-bit/.test(x.message));
    expect(d?.nodeId).toBe(e);
    expect(d?.fix).toMatchObject({ label: "Use yuv420p10le", nodeId: p });
  });

  it("parameters pads only connect to encoders of the same media, on top", () => {
    const { g, add } = graph();
    const vp = add(newEncoderParamsData("video"));
    const ae = add(newEncoderData("audio"));
    const ve = add(newEncoderData("video"));
    expect(getPads(g.nodes.find((x) => x.id === ve)!).inputs.map((x) => `${x.id}:${x.type.domain}`)).toEqual(["params:params", "in:frames"]);
    expect(checkConnection(g, { source: vp, sourceHandle: PARAMS_PAD, target: ve, targetHandle: PARAMS_PAD }).ok).toBe(true);
    expect(checkConnection(g, { source: vp, sourceHandle: PARAMS_PAD, target: ae, targetHandle: PARAMS_PAD }).ok).toBe(false);
    expect(checkConnection(g, { source: vp, sourceHandle: PARAMS_PAD, target: ve, targetHandle: "in" }).ok).toBe(false);
  });
});
