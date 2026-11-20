import { describe, expect, it } from "vitest";
import { newFilterData, newInputData, newMuxerData, normalizeMuxerSlots } from "../nodes/defs";
import { serialize } from "../serializer";
import { encoder, pushNode } from "../test/fixtures";
import { deviceLabel, jobDevices, shortGpuName } from "./devices";
import type { GEdge, GNode, Graph, NodeData, ProbeResult } from "./types";

const PROBE: ProbeResult = {
  format: { duration: "10.0", format_name: "matroska,webm" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "24000/1001" },
    { index: 1, codec_type: "audio", codec_name: "eac3", sample_rate: "48000", channels: 6, channel_layout: "5.1" },
    { index: 2, codec_type: "subtitle", codec_name: "subrip" },
  ],
};

class G {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  private n = 0;
  add(data: NodeData) {
    const id = `n${this.n++}`;
    pushNode(this.nodes, this.edges, id, data);
    return id;
  }
  input(options: Partial<ReturnType<typeof newInputData>["options"]> = {}) {
    return this.add({ ...newInputData("in.mkv"), probe: PROBE, options: { ...newInputData("").options, ...options } });
  }
  nvenc(gpu = "") {
    const base = encoder("video", "hevc_nvenc");
    return this.add({ ...base, params: { ...base.params, gpu } });
  }
  link(source: string, sourceHandle: string, target: string, targetHandle = "in") {
    this.edges.push({ id: `e${this.edges.length}`, source, sourceHandle, target, targetHandle });
  }
  toMux(source: string, sourceHandle: string, mux: string) {
    const node = this.nodes.find((x) => x.id === mux)!;
    const d = node.data as ReturnType<typeof newMuxerData>;
    this.link(source, sourceHandle, mux, d.slots[d.slots.length - 1].id);
    node.data = normalizeMuxerSlots(d, mux, this.edges) ?? d;
  }
  get graph(): Graph {
    return { nodes: this.nodes, edges: this.edges };
  }
  devices() {
    return jobDevices(this.graph, serialize(this.graph));
  }
}

describe("jobDevices", () => {
  it("CPU only, with copied subtitles", () => {
    const g = new G();
    const inp = g.input();
    const v = g.add(encoder("video", "libx265"));
    const a = g.add(encoder("audio", "aac"));
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", v);
    g.link(inp, "f1", a);
    g.toMux(v, "out", mux);
    g.toMux(a, "out", mux);
    g.toMux(inp, "p2", mux);
    const d = g.devices();
    expect(d.decode).toEqual([{ kind: "cpu" }]);
    expect(d.filters).toEqual([]);
    expect(d.encode).toEqual([{ kind: "cpu" }]);
    expect(d.streams).toEqual([[{ kind: "cpu" }, { kind: "cpu" }, { kind: "copy" }]]);
  });

  it("cuda decode on GPU 1 feeding nvenc: everything on GPU 1, audio on the CPU", () => {
    const g = new G();
    const inp = g.input({ hwaccel: "cuda", hwaccel_device: "1" });
    const sc = g.add(newFilterData("scale_cuda"));
    const v = g.nvenc("0"); // -gpu is ignored on GPU frames
    const a = g.add(encoder("audio", "aac"));
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", sc);
    g.link(sc, "out", v);
    g.link(inp, "f1", a);
    g.toMux(v, "out", mux);
    g.toMux(a, "out", mux);
    const d = g.devices();
    expect(d.decode).toEqual([{ kind: "gpu", index: "1" }, { kind: "cpu" }]);
    expect(d.filters).toEqual([{ kind: "gpu", index: "1" }]);
    expect(d.streams[0]).toEqual([{ kind: "gpu", index: "1" }, { kind: "cpu" }]);
  });

  it("an unset CUDA device is GPU 0; nvenc on CPU frames without a GPU is auto", () => {
    const g = new G();
    const inp = g.input({ hwaccel: "cuda" });
    const v = g.nvenc();
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", v);
    g.toMux(v, "out", mux);
    expect(g.devices()).toMatchObject({ decode: [{ kind: "gpu", index: "0" }], encode: [{ kind: "gpu", index: "0" }] });

    const h = new G();
    const i2 = h.input();
    const v2 = h.nvenc();
    const m2 = h.add(newMuxerData("o.mkv"));
    h.link(i2, "f0", v2);
    h.toMux(v2, "out", m2);
    expect(h.devices().encode).toEqual([{ kind: "gpu", index: "" }]);
  });

  it("CPU decode and filter, nvenc on the GPU picked in its parameters", () => {
    const g = new G();
    const inp = g.input();
    const dn = g.add(newFilterData("hqdn3d"));
    const v = g.nvenc("1");
    const mux = g.add(newMuxerData("o.mp4"));
    g.link(inp, "f0", dn);
    g.link(dn, "out", v);
    g.toMux(v, "out", mux);
    const d = g.devices();
    expect(d.decode).toEqual([{ kind: "cpu" }]);
    expect(d.filters).toEqual([{ kind: "cpu" }]);
    expect(d.encode).toEqual([{ kind: "gpu", index: "1" }]);
  });

  it("numbers streams per output in -map order", () => {
    const g = new G();
    const inp = g.input();
    const v = g.nvenc();
    const m1 = g.add(newMuxerData("a.mkv"));
    const m2 = g.add(newMuxerData("b.mka"));
    g.link(inp, "f0", v);
    g.toMux(v, "out", m1);
    g.toMux(inp, "p1", m1);
    g.toMux(inp, "p1", m2);
    const d = g.devices();
    expect(d.streams).toEqual([[{ kind: "gpu", index: "" }, { kind: "copy" }], [{ kind: "copy" }]]);
  });
});

describe("deviceLabel", () => {
  const gpus = [{ index: 0, name: "NVIDIA GeForce RTX 4090" }];
  it("labels devices", () => {
    expect(deviceLabel({ kind: "gpu", index: "0" }, gpus)).toBe("GPU 0 · RTX 4090");
    expect(deviceLabel({ kind: "gpu", index: "" }, gpus)).toBe("GPU 0 · RTX 4090");
    expect(deviceLabel({ kind: "gpu", index: "" }, [...gpus, { index: 1, name: "NVIDIA RTX A2000 12GB" }])).toBe("GPU (auto)");
    expect(deviceLabel({ kind: "gpu", index: "1" })).toBe("GPU 1");
    expect(deviceLabel({ kind: "gpu", index: "0" }, gpus, { names: false })).toBe("GPU 0");
    expect(deviceLabel({ kind: "hw", api: "d3d11va" })).toBe("HW (d3d11va)");
    expect(deviceLabel({ kind: "cpu" })).toBe("CPU");
    expect(shortGpuName("NVIDIA RTX A2000 12GB")).toBe("RTX A2000 12GB");
  });
});
