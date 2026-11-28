import { describe, expect, it } from "vitest";
import type { EncoderParamsNodeData, GEdge, GNode, MuxerNodeData, ProbeResult } from "../model/types";
import { newEncoderData, newEncoderParamsData, newFilterData, newInputData, newMuxerData, normalizeMuxerSlots, PARAMS_PAD } from "../nodes/defs";
import { serialize } from "../serializer";
import { duplicateNodes, nextFreePath } from "./duplicate";

const PROBE: ProbeResult = {
  format: { duration: "10" },
  streams: [
    { index: 0, codec_type: "audio", codec_name: "ac3", sample_rate: "48000", channels: 6, channel_layout: "5.1" },
    { index: 1, codec_type: "audio", codec_name: "ac3", sample_rate: "48000", channels: 2, channel_layout: "stereo" },
  ],
};

let k = 0;
const newId = (kind: string) => `${kind}-copy${k++}`;
const node = (id: string, data: GNode["data"], x = 0): GNode => ({ id, position: { x, y: 0 }, data });
const paramsWire = (p: string, e: string): GEdge => ({ id: `${p}>${e}`, source: p, sourceHandle: PARAMS_PAD, target: e, targetHandle: PARAMS_PAD });

describe("duplicating nodes", () => {
  it("deep-copies a parameters node into an independent, unconnected one", () => {
    const p = { ...newEncoderParamsData("audio", "aac"), extra: [{ key: "cutoff", value: "18000" }] };
    p.params = { ...p.params, b: "256k", ar: "48000" };
    const nodes = [node("p", p, 100), node("enc", newEncoderData("audio"))];
    const edges = [paramsWire("p", "enc")];
    const r = duplicateNodes(nodes, edges, ["p"], { newId });
    const c = r.nodes[0];
    expect(c.id).not.toBe("p");
    expect(c.position).toEqual({ x: 140, y: 40 });
    expect(c.data).toEqual(p);
    expect(r.edges).toEqual([]); // its encoders stay with the original
    const cd = c.data as EncoderParamsNodeData;
    cd.params.b = "96k";
    cd.extra[0].value = "1";
    expect(p.params.b).toBe("256k");
    expect(p.extra[0].value).toBe("18000");
  });

  it("an encoder copy keeps sharing the parameters node, but not its frames", () => {
    const nodes = [node("in", { ...newInputData("a.mkv"), probe: PROBE }), node("p", newEncoderParamsData("audio")), node("enc", newEncoderData("audio"))];
    const edges: GEdge[] = [paramsWire("p", "enc"), { id: "f", source: "in", sourceHandle: "f0", target: "enc", targetHandle: "in" }];
    const r = duplicateNodes(nodes, edges, ["enc"], { newId });
    expect(r.edges.map((x) => `${x.source}.${x.sourceHandle}>${x.targetHandle}`)).toEqual(["p.params>params"]);
  });

  it("copies wires inside the selection, and incoming wires on request", () => {
    const nodes = [node("in", { ...newInputData("a.mkv"), probe: PROBE }), node("vol", newFilterData("volume")), node("enc", newEncoderData("audio"))];
    const edges: GEdge[] = [
      { id: "e1", source: "in", sourceHandle: "f0", target: "vol", targetHandle: "in" },
      { id: "e2", source: "vol", sourceHandle: "out", target: "enc", targetHandle: "in" },
    ];
    const plain = duplicateNodes(nodes, edges, ["vol", "enc"], { newId });
    const [v, e] = plain.newIds;
    expect(plain.edges.map((x) => `${x.source}>${x.target}`)).toEqual([`${v}>${e}`]);
    const fed = duplicateNodes(nodes, edges, ["vol", "enc"], { newId, withInputs: true });
    expect(fed.edges.map((x) => `${x.source}.${x.sourceHandle}>${x.targetHandle}`)).toEqual(["in.f0>in", `${fed.newIds[0]}.out>in`]);
  });

  it("gives Output copies a free file name and drops transient state", () => {
    expect(nextFreePath("C:/v/out.mp4", new Set(["C:/v/out.mp4"]))).toBe("C:/v/out-2.mp4");
    expect(nextFreePath("C:/v/out.mp4", new Set(["C:/v/out.mp4", "C:/v/out-2.mp4"]))).toBe("C:/v/out-3.mp4");
    expect(nextFreePath("C:/v/out-2.mp4", new Set(["C:/v/out-2.mp4"]))).toBe("C:/v/out-3.mp4");
    expect(nextFreePath("C:/v.dir/out", new Set())).toBe("C:/v.dir/out-2");
    expect(nextFreePath("C:/v/frames_%05d.png", new Set())).toBe("C:/v/frames-2_%05d.png");
    expect(nextFreePath("C:/v/frames-2_%05d.png", new Set())).toBe("C:/v/frames-3_%05d.png");
    const nodes = [node("m", newMuxerData("C:/v/out.mp4")), node("in", { ...newInputData("a.mkv"), probing: true })];
    const r = duplicateNodes(nodes, [], ["m", "in"], { newId });
    expect((r.nodes[0].data as MuxerNodeData).path).toBe("C:/v/out-2.mp4");
    expect(r.nodes[1].data).not.toHaveProperty("probing");
    expect(duplicateNodes([...nodes, ...r.nodes], [], ["m"], { newId }).nodes[0].data).toMatchObject({ path: "C:/v/out-3.mp4" });
  });

  it("serializes an encoder and its duplicate for two streams with the same settings", () => {
    const p = newEncoderParamsData("audio", "aac");
    p.params = { ...p.params, b: "256k" };
    const nodes: GNode[] = [node("in", { ...newInputData("a.mkv"), probe: PROBE }), node("p", p), node("enc", newEncoderData("audio")), node("mux", newMuxerData("out.mkv"))];
    const edges: GEdge[] = [paramsWire("p", "enc"), { id: "e1", source: "in", sourceHandle: "f0", target: "enc", targetHandle: "in" }];
    const dup = duplicateNodes(nodes, edges, ["enc"], { newId });
    nodes.push(...dup.nodes);
    edges.push(...dup.edges, { id: "e2", source: "in", sourceHandle: "f1", target: dup.newIds[0], targetHandle: "in" });
    for (const src of ["enc", dup.newIds[0]]) {
      const m = nodes.find((n) => n.id === "mux")!;
      const d = m.data as MuxerNodeData;
      edges.push({ id: `m-${src}`, source: src, sourceHandle: "out", target: "mux", targetHandle: d.slots[d.slots.length - 1].id });
      m.data = normalizeMuxerSlots(d, "mux", edges) ?? d;
    }
    const r = serialize({ nodes, edges });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const cmd = r.args.join(" ");
    expect(cmd).toContain("-map 0:a:0 -c:a:0 aac -b:a:0 256k");
    expect(cmd).toContain("-map 0:a:1 -c:a:1 aac -b:a:1 256k");
  });
});
