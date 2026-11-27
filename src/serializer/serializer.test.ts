import { describe, expect, it } from "vitest";
import type { GEdge, GNode, Graph, NodeData, ProbeResult } from "../model/types";
import { newFilterData, newInputData, newMuxerData, normalizeMuxerSlots } from "../nodes/defs";
import { escapeFilterGraph, escapeOptionValue } from "./escape";
import { formatCommand } from "./shellQuote";
import { encoderArgs, serialize } from "./index";
import { encoderDefaults } from "../nodes/defs";
import { encoder, pushNode } from "../test/fixtures";

// ---------------------------------------------------------------- tiny graph DSL

const MKV_PROBE: ProbeResult = {
  format: { duration: "10.0", format_name: "matroska,webm" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 3840, height: 2160, pix_fmt: "yuv420p", avg_frame_rate: "24000/1001" },
    { index: 1, codec_type: "audio", codec_name: "eac3", sample_rate: "48000", channels: 6, channel_layout: "5.1" },
    { index: 2, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } },
  ],
};

class G {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  private n = 0;
  add<D extends NodeData>(data: D, id = `n${this.n++}`): string {
    pushNode(this.nodes, this.edges, id, data);
    return id;
  }
  input(path: string, probe: ProbeResult = MKV_PROBE) {
    return this.add({ ...newInputData(path), probe });
  }
  link(source: string, sourceHandle: string, target: string, targetHandle: string) {
    this.edges.push({ id: `e${this.edges.length}`, source, sourceHandle, target, targetHandle });
  }
  /** Connect to the muxer's spare slot and re-normalize slots like the editor does. */
  toMux(source: string, sourceHandle: string, mux: string) {
    const node = this.nodes.find((x) => x.id === mux)!;
    const d = node.data as ReturnType<typeof newMuxerData>;
    const spare = d.slots[d.slots.length - 1];
    this.link(source, sourceHandle, mux, spare.id);
    node.data = normalizeMuxerSlots(d, mux, this.edges) ?? d;
  }
  get graph(): Graph {
    return { nodes: this.nodes, edges: this.edges };
  }
}

const cmd = (g: G) => formatCommand("ffmpeg", serialize(g.graph).args, "posix");

describe("serializer", () => {
  it("reproduces the design-doc example (filters → encoders → mp4)", () => {
    const g = new G();
    const inp = g.input("in.mkv");
    const scale = g.add({ ...newFilterData("scale"), params: { w: "1920", h: "-2", flags: "" } });
    const loud = g.add(newFilterData("loudnorm"));
    const venc = g.add({
      ...encoder("video", "libx265"),
      params: { ...encoder("video", "libx265").params, crf: 22, preset: "slow", profile: "main10", pix_fmt: "yuv420p10le" },
    });
    const aenc = g.add({ ...encoder("audio", "aac"), params: { ...encoder("audio", "aac").params, ar: "48000" } });
    const mux = g.add(newMuxerData("out.mp4"));
    g.link(inp, "f0", scale, "in");
    g.link(scale, "out", venc, "in");
    g.link(inp, "f1", loud, "in");
    g.link(loud, "out", aenc, "in");
    g.toMux(venc, "out", mux);
    g.toMux(aenc, "out", mux);
    const muxNode = g.nodes.find((n) => n.id === mux)!;
    (muxNode.data as ReturnType<typeof newMuxerData>).slots[0].tag = "hvc1";

    // Same as the doc, except every encoder option carries its stream specifier.
    expect(cmd(g)).toBe(
      'ffmpeg -i in.mkv -filter_complex "[0:v]scale=1920:-2[v];[0:a]loudnorm[a]" ' +
        '-map "[v]" -c:v:0 libx265 -crf:v:0 22 -preset:v:0 slow -profile:v:0 main10 -pix_fmt:v:0 yuv420p10le -tag:v:0 hvc1 ' +
        '-map "[a]" -c:a:0 aac -b:a:0 192k -ar:a:0 48000 ' +
        "-movflags +faststart out.mp4",
    );
    expect(serialize(g.graph).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("stream-copies packets wired straight from the input", () => {
    const g = new G();
    const inp = g.input("in.mkv");
    const mux = g.add(newMuxerData("out.mkv"));
    g.toMux(inp, "p0", mux);
    g.toMux(inp, "p2", mux);
    expect(serialize(g.graph).args).toEqual(["-i", "in.mkv", "-map", "0:v", "-c:v:0", "copy", "-map", "0:s", "-c:s:0", "copy", "out.mkv"]);
  });

  it("maps an input directly when an encoder has no filters in front of it", () => {
    const g = new G();
    const inp = g.input("in.mkv");
    const enc = g.add(encoder("audio", "libopus"));
    const mux = g.add(newMuxerData("out.webm"));
    g.link(inp, "f1", enc, "in");
    g.toMux(enc, "out", mux);
    expect(serialize(g.graph).args).toEqual(["-i", "in.mkv", "-map", "0:a", "-c:a:0", "libopus", "-b:a:0", "128k", "out.webm"]);
  });

  it("joins linear chains with commas", () => {
    const g = new G();
    const inp = g.input("in.mkv");
    const a = g.add(newFilterData("scale"));
    const b = g.add({ ...newFilterData("fps"), params: { fps: "25" } });
    const c = g.add({ ...newFilterData("format"), params: { pix_fmts: "yuv420p10le" } });
    const enc = g.add(encoder("video", "libx264"));
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", a, "in");
    g.link(a, "out", b, "in");
    g.link(b, "out", c, "in");
    g.link(c, "out", enc, "in");
    g.toMux(enc, "out", mux);
    const args = serialize(g.graph).args;
    expect(args[args.indexOf("-filter_complex") + 1]).toBe("[0:v]scale=1920:-2,fps=25,format=yuv420p10le[v]");
  });

  it("inserts split when one filter output feeds several consumers", () => {
    const g = new G();
    const inp = g.input("in.mkv");
    const scale = g.add(newFilterData("scale"));
    const e1 = g.add(encoder("video", "libx264"));
    const e2 = g.add(encoder("video", "libx265"));
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", scale, "in");
    g.link(scale, "out", e1, "in");
    g.link(scale, "out", e2, "in");
    g.toMux(e1, "out", mux);
    g.toMux(e2, "out", mux);
    const r = serialize(g.graph);
    expect(r.args[r.args.indexOf("-filter_complex") + 1]).toBe("[0:v]scale=1920:-2,split=2[v0][v1]");
    expect(r.args.join(" ")).toContain("-map [v0] -c:v:0 libx264");
    expect(r.args.join(" ")).toContain("-map [v1] -c:v:1 libx265");
  });

  it("encodes a shared encoder once per output, splitting upstream", () => {
    const g = new G();
    const inp = g.input("in.mkv");
    const vol = g.add({ ...newFilterData("volume"), params: { volume: "0.5" } });
    const enc = g.add(encoder("audio", "aac"));
    const m1 = g.add(newMuxerData("a.m4a"));
    const m2 = g.add(newMuxerData("b.mkv"));
    g.link(inp, "f1", vol, "in");
    g.link(vol, "out", enc, "in");
    g.toMux(enc, "out", m1);
    g.toMux(enc, "out", m2);
    const r = serialize(g.graph);
    expect(r.args[r.args.indexOf("-filter_complex") + 1]).toBe("[0:a]volume=0.5,asplit=2[a0][a1]");
    expect(r.args.slice(r.args.indexOf("-filter_complex") + 2)).toEqual([
      "-map", "[a0]", "-c:a:0", "aac", "-b:a:0", "192k", "-movflags", "+faststart", "a.m4a",
      "-map", "[a1]", "-c:a:0", "aac", "-b:a:0", "192k", "b.mkv",
    ]);
    expect(r.diagnostics.some((d) => d.severity === "info" && d.nodeId === enc)).toBe(true);
  });

  it("handles multi-input filters and multiple inputs", () => {
    const g = new G();
    const bg = g.input("bg.mkv");
    const logo = g.input("logo.png", {
      format: { format_name: "png_pipe" },
      streams: [{ index: 0, codec_type: "video", codec_name: "png", width: 200, height: 100, pix_fmt: "rgba" }],
    });
    const ov = g.add({ ...newFilterData("overlay"), params: { x: "W-w-10", y: "10" } });
    const enc = g.add(encoder("video", "libx264"));
    const mux = g.add(newMuxerData("o.mp4"));
    g.link(bg, "f0", ov, "main");
    g.link(logo, "f0", ov, "overlay");
    g.link(ov, "out", enc, "in");
    g.toMux(enc, "out", mux);
    g.toMux(bg, "p1", mux);
    const r = serialize(g.graph);
    expect(r.args).toEqual([
      "-i", "bg.mkv", "-i", "logo.png",
      "-filter_complex", "[0:v][1:v]overlay=W-w-10:10[v]",
      "-map", "[v]", "-c:v:0", "libx264", "-crf:v:0", "23",
      "-map", "0:a", "-c:a:0", "copy",
      "-movflags", "+faststart", "o.mp4",
    ]);
  });

  it("uses type-relative specifiers when a file has several streams of a type", () => {
    const g = new G();
    const inp = g.input("multi.mkv", {
      format: {},
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264" },
        { index: 1, codec_type: "audio", codec_name: "aac" },
        { index: 2, codec_type: "audio", codec_name: "ac3" },
      ],
    });
    const mux = g.add(newMuxerData("o.mkv"));
    g.toMux(inp, "p2", mux);
    expect(serialize(g.graph).args).toContain("0:a:1");
  });

  it("emits input options before -i and per-stream metadata", () => {
    const g = new G();
    const inp = g.add({ ...newInputData("in.mkv"), probe: MKV_PROBE, options: { ...newInputData("").options, ss: "00:01:00", t: "30" } });
    const mux = g.add(newMuxerData("out.mkv"));
    g.toMux(inp, "p1", mux);
    const d = g.nodes.find((n) => n.id === mux)!.data as ReturnType<typeof newMuxerData>;
    Object.assign(d.slots[0], { language: "ger", title: "Deutsch 5.1", disposition: "default" });
    const r = serialize(g.graph);
    expect(r.args).toEqual([
      "-ss", "00:01:00", "-t", "30", "-i", "in.mkv",
      "-map", "0:a", "-c:a:0", "copy",
      "-metadata:s:a:0", "language=ger", "-metadata:s:a:0", "title=Deutsch 5.1", "-disposition:a:0", "default",
      "out.mkv",
    ]);
    expect(r.durationSec).toBe(30);
  });

  it("emits image sequence options before -i", () => {
    const g = new G();
    const probe: ProbeResult = { streams: [{ index: 0, codec_type: "video", codec_name: "exr", width: 64, height: 64 }], format: { duration: "4.000000" } };
    const seq = { framerate: "60", start_number: "1001", pattern_type: "sequence" };
    const inp = g.add({ ...newInputData("C:/r/shot_%04d.exr"), probe, options: { ...newInputData("").options, ...seq } });
    const mux = g.add({ ...newMuxerData("out.mkv"), shortest: true });
    g.toMux(inp, "p0", mux);
    const r = serialize(g.graph);
    expect(r.args.slice(-2)).toEqual(["-shortest", "out.mkv"]);
    expect(r.args.slice(0, r.args.indexOf("-i") + 2)).toEqual([
      "-framerate", "60", "-start_number", "1001", "-pattern_type", "sequence", "-i", "C:/r/shot_%04d.exr",
    ]);
    expect(r.durationSec).toBe(4);
  });

  it("reports unconnected filter inputs and missing outputs", () => {
    const g = new G();
    const ov = g.add(newFilterData("overlay"));
    const enc = g.add(encoder("video"));
    const mux = g.add(newMuxerData("o.mp4"));
    g.link(ov, "out", enc, "in");
    g.toMux(enc, "out", mux);
    const errs = serialize(g.graph).diagnostics.filter((d) => d.severity === "error");
    expect(errs.map((e) => e.message).join("\n")).toMatch(/not connected/);
  });

  it("adds -f only when the format differs from the extension", () => {
    const g = new G();
    const inp = g.input("in.mkv");
    const mux = g.add({ ...newMuxerData("out.bin"), format: "matroska" });
    g.toMux(inp, "p0", mux);
    expect(serialize(g.graph).args.slice(-3)).toEqual(["-f", "matroska", "out.bin"]);
  });

  it("emits CBR as bitrate with matching min/max rate", () => {
    const g = new G();
    const inp = g.input("in.mkv");
    const base = encoder("video", "libx264");
    const enc = g.add({ ...base, params: { ...base.params, rc: "cbr", b: "6M", bufsize: "12M" } });
    const mux = g.add(newMuxerData("o.ts"));
    g.link(inp, "f0", enc, "in");
    g.toMux(enc, "out", mux);
    expect(serialize(g.graph).args.join(" ")).toBe(
      "-i in.mkv -map 0:v -c:v:0 libx264 -b:v:0 6M -bufsize:v:0 12M -minrate:v:0 6M -maxrate:v:0 6M o.ts",
    );
  });
});

describe("GPU pipeline", () => {
  const cudaInput = (g: G, extra: Partial<ReturnType<typeof newInputData>["options"]> = {}) =>
    g.add({ ...newInputData("in.mkv"), probe: MKV_PROBE, options: { ...newInputData("").options, hwaccel: "cuda", ...extra } });
  const nvenc = (g: G, gpu = "") => {
    const base = encoder("video", "hevc_nvenc");
    return g.add({ ...base, params: { ...base.params, gpu } });
  };

  it("keeps frames on the GPU for decode → nvenc and drops -gpu", () => {
    const g = new G();
    const inp = cudaInput(g, { hwaccel_device: "1" });
    const enc = nvenc(g, "0");
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", enc, "in");
    g.toMux(enc, "out", mux);
    expect(serialize(g.graph).args).toEqual([
      "-hwaccel", "cuda", "-hwaccel_device", "1", "-hwaccel_output_format", "cuda", "-i", "in.mkv",
      "-map", "0:v", "-c:v:0", "hevc_nvenc", "-cq:v:0", "26", "-rc:v:0", "vbr", "-b:v:0", "0", "o.mkv",
    ]);
  });

  it("decodes to system memory when a CPU filter is in the path, and keeps -gpu", () => {
    const g = new G();
    const inp = cudaInput(g);
    const scale = g.add(newFilterData("scale"));
    const enc = nvenc(g, "1");
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", scale, "in");
    g.link(scale, "out", enc, "in");
    g.toMux(enc, "out", mux);
    const args = serialize(g.graph).args;
    expect(args).not.toContain("-hwaccel_output_format");
    expect(args.join(" ")).toContain("-c:v:0 hevc_nvenc -cq:v:0 26 -gpu:v:0 1");
  });

  it("stays on the GPU through scale_cuda", () => {
    const g = new G();
    const inp = cudaInput(g);
    const sc = g.add({ ...newFilterData("scale_cuda"), params: { w: "1920", h: "-2", format: "p010le", interp_algo: "" } });
    const enc = nvenc(g);
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", sc, "in");
    g.link(sc, "out", enc, "in");
    g.toMux(enc, "out", mux);
    const args = serialize(g.graph).args;
    expect(args.slice(0, 6)).toEqual(["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-i", "in.mkv"]);
    expect(args[args.indexOf("-filter_complex") + 1]).toBe("[0:v]scale_cuda=1920:-2:format=p010le[v]");
  });

  const chain = (input: (g: G) => string, defs: (string | ReturnType<typeof newFilterData>)[], codec = "hevc_nvenc") => {
    const g = new G();
    let from = input(g);
    let pad = "f0";
    for (const d of defs) {
      const f = g.add(typeof d === "string" ? newFilterData(d) : d);
      g.link(from, pad, f, "in");
      from = f;
      pad = "out";
    }
    const enc = g.add(encoder("video", codec));
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(from, pad, enc, "in");
    g.toMux(enc, "out", mux);
    const args = serialize(g.graph).args;
    return { args, fc: args[args.indexOf("-filter_complex") + 1] };
  };
  const crop = { ...newFilterData("crop"), params: { ...newFilterData("crop").params, w: "iw", h: "ih-280", x: "0", y: "140" } };

  it("uploads CPU frames in front of a CUDA filter", () => {
    const { args, fc } = chain((g) => cudaInput(g), [crop, "scale_cuda"]);
    expect(args).not.toContain("-hwaccel_output_format"); // crop needs the decoded frames in system memory
    expect(fc).toBe("[0:v]crop=iw:ih-280:0:140,hwupload_cuda,scale_cuda=1920:-2[v]");
  });

  it("uploads to the Input's GPU and converts formats CUDA can't hold", () => {
    const tenBit = (g: G) =>
      g.add({
        ...newInputData("in.mkv"),
        probe: { ...MKV_PROBE, streams: MKV_PROBE.streams.map((s) => (s.codec_type === "video" ? { ...s, pix_fmt: "yuv420p10le" } : s)) },
        options: { ...newInputData("").options, hwaccel: "cuda", hwaccel_device: "1" },
      });
    expect(chain(tenBit, [crop, "scale_cuda"]).fc).toContain(",format=p010le,hwupload_cuda=device=1,scale_cuda");
    // CPU decode: CUDA filters still work, frames are uploaded once
    expect(chain((g) => g.input("in.mkv"), ["scale_cuda"]).fc).toBe("[0:v]hwupload_cuda,scale_cuda=1920:-2[v]");
  });

  it("downloads GPU frames in front of a CPU filter or a CPU encoder", () => {
    const { args, fc } = chain((g) => cudaInput(g), ["scale_cuda", crop]);
    expect(args).toContain("-hwaccel_output_format");
    expect(fc).toBe("[0:v]scale_cuda=1920:-2,hwdownload,format=nv12,crop=iw:ih-280:0:140[v]");
    expect(chain((g) => cudaInput(g), [{ ...newFilterData("scale_cuda"), params: { w: "1280", h: "-2", format: "p010le", interp_algo: "" } }], "libx265").fc).toBe(
      "[0:v]scale_cuda=1280:-2:format=p010le,hwdownload,format=p010le[v]",
    );
  });

  const nvencArgs = (codec: string, params: Record<string, string | number | boolean>) => {
    const g = new G();
    const inp = g.input("in.mkv");
    const base = encoder("video", codec);
    const enc = g.add({ ...base, params: { ...base.params, ...params } });
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", enc, "in");
    g.toMux(enc, "out", mux);
    const args = serialize(g.graph).args;
    return args.slice(args.indexOf("-c:v:0"), -1).join(" ");
  };

  it("emits nvenc constant quality as -rc vbr -cq N -b 0", () => {
    expect(nvencArgs("hevc_nvenc", {})).toBe("-c:v:0 hevc_nvenc -cq:v:0 26 -rc:v:0 vbr -b:v:0 0");
  });

  it("emits nvenc CBR with AQ, multipass and B-frame references", () => {
    expect(
      nvencArgs("hevc_nvenc", { nv_rc: "cbr", b: "8M", preset: "p6", spatial_aq: true, aq_strength: 12, temporal_aq: true, multipass: "fullres", b_ref_mode: "middle" }),
    ).toBe(
      "-c:v:0 hevc_nvenc -b:v:0 8M -preset:v:0 p6 -multipass:v:0 fullres -spatial-aq:v:0 1 -aq-strength:v:0 12 -temporal-aq:v:0 1 -b_ref_mode:v:0 middle -rc:v:0 cbr",
    );
  });

  it("emits nvenc constant QP and hides unrelated rate options", () => {
    expect(nvencArgs("av1_nvenc", { nv_rc: "constqp", qp: 30, b: "9M" })).toBe("-c:v:0 av1_nvenc -qp:v:0 30 -rc:v:0 constqp");
  });

  it("respects Keep frames on GPU = off", () => {
    const g = new G();
    const inp = cudaInput(g, { gpuFrames: "off" });
    const enc = nvenc(g);
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", enc, "in");
    g.toMux(enc, "out", mux);
    expect(serialize(g.graph).args).not.toContain("-hwaccel_output_format");
  });
});

describe("escaping", () => {
  it("escapes option values and the filtergraph level", () => {
    expect(escapeOptionValue("a:b'c")).toBe("a\\:b\\'c");
    expect(escapeFilterGraph("min(iw,1920)")).toBe("min(iw\\,1920)");
    // option-level backslashes are doubled by the graph level
    expect(escapeFilterGraph(escapeOptionValue("10:30"))).toBe("10\\\\:30");
  });

  it("escapes expressions in filter params", () => {
    const g = new G();
    const inp = g.input("in.mkv");
    const s = g.add({ ...newFilterData("scale"), params: { w: "min(iw,1280)", h: "-2", flags: "lanczos" } });
    const enc = g.add(encoder("video"));
    const mux = g.add(newMuxerData("o.mkv"));
    g.link(inp, "f0", s, "in");
    g.link(s, "out", enc, "in");
    g.toMux(enc, "out", mux);
    const r = serialize(g.graph);
    expect(r.args[r.args.indexOf("-filter_complex") + 1]).toBe("[0:v]scale=min(iw\\,1280):-2:flags=lanczos[v]");
  });
});

describe("libsvtav1 (AV1 on the CPU)", () => {
  const args = (params: Record<string, string | number | boolean>) =>
    encoderArgs({ kind: "encoder", media: "video", codec: "libsvtav1", params: { ...encoderDefaults("libsvtav1", "video"), ...params }, extra: [] } as never, "v:0").join(" ");

  it("emits CRF and preset by default", () => {
    expect(args({})).toBe("-c:v:0 libsvtav1 -crf:v:0 32 -preset:v:0 6");
  });

  it("uses a target bitrate in VBR mode", () => {
    expect(args({ rc: "vbr", b: "4M", maxrate: "8M" })).toBe("-c:v:0 libsvtav1 -b:v:0 4M -preset:v:0 6");
  });

  it("joins tune, film grain and raw parameters into one -svtav1-params", () => {
    expect(args({ tune: "0", film_grain: 8, params: "enable-overlays=1", pix_fmt: "yuv420p10le", g: "240" })).toBe(
      "-c:v:0 libsvtav1 -crf:v:0 32 -preset:v:0 6 -g:v:0 240 -pix_fmt:v:0 yuv420p10le -svtav1-params:v:0 tune=0:film-grain=8:enable-overlays=1",
    );
  });
});

describe("libvpx-vp9 and prores_ks", () => {
  const args = (codec: string, params: Record<string, string | number | boolean>) =>
    encoderArgs({ kind: "encoder", media: "video", codec, params: { ...encoderDefaults(codec, "video"), ...params }, extra: [] } as never, "v:0").join(" ");

  it("VP9 constant quality adds -b:v 0", () => {
    expect(args("libvpx-vp9", {})).toBe("-c:v:0 libvpx-vp9 -crf:v:0 31 -cpu-used:v:0 2 -row-mt:v:0 1 -b:v:0 0");
  });

  it("VP9 constrained quality keeps the bitrate as a cap", () => {
    expect(args("libvpx-vp9", { rc: "cq", b: "5M", deadline: "best" })).toBe("-c:v:0 libvpx-vp9 -crf:v:0 31 -b:v:0 5M -deadline:v:0 best -cpu-used:v:0 2 -row-mt:v:0 1");
  });

  it("ProRes picks the pixel format for the profile", () => {
    expect(args("prores_ks", {})).toBe("-c:v:0 prores_ks -profile:v:0 hq -pix_fmt:v:0 yuv422p10le");
    expect(args("prores_ks", { profile: "4444", apple_vendor: true })).toBe("-c:v:0 prores_ks -profile:v:0 4444 -pix_fmt:v:0 yuv444p10le -vendor:v:0 apl0");
    expect(args("prores_ks", { profile: "4444", pix_fmt: "yuva444p10le" })).toBe("-c:v:0 prores_ks -profile:v:0 4444 -pix_fmt:v:0 yuva444p10le");
  });
});

describe("audio presets", () => {
  const args = (codec: string, params: Record<string, string | number | boolean> = {}) =>
    encoderArgs({ kind: "encoder", media: "audio", codec, params: { ...encoderDefaults(codec, "audio"), ...params }, extra: [] } as never, "a:0").join(" ");

  it("AC-3 and E-AC-3 always state the bitrate", () => {
    expect(args("ac3", { ac: "6" })).toBe("-c:a:0 ac3 -b:a:0 448k -ac:a:0 6");
    expect(args("eac3", { dialnorm: -27 })).toBe("-c:a:0 eac3 -b:a:0 640k -dialnorm:a:0 -27");
  });

  it("MP3 uses VBR quality or a constant bitrate", () => {
    expect(args("libmp3lame")).toBe("-c:a:0 libmp3lame -q:a:0 2");
    expect(args("libmp3lame", { rc: "cbr" })).toBe("-c:a:0 libmp3lame -b:a:0 320k");
  });

  it("FLAC and ALAC set the bit depth through the sample format", () => {
    expect(args("flac")).toBe("-c:a:0 flac");
    expect(args("flac", { depth: "24", compression_level: 8 })).toBe("-c:a:0 flac -compression_level:a:0 8 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24");
    expect(args("alac", { depth: "16" })).toBe("-c:a:0 alac -sample_fmt:a:0 s16p");
  });

  it("PCM needs only the codec", () => {
    expect(args("pcm_s24le", { ar: "48000" })).toBe("-c:a:0 pcm_s24le -ar:a:0 48000");
  });
});
