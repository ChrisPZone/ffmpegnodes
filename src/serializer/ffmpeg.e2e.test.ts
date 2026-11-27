// Runs serializer output through the real ffmpeg and checks the result with ffprobe.
// Opt-in (needs ffmpeg/ffprobe with libx265 on PATH):  FFMPEG_E2E=1 pnpm test
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GEdge, GNode, Graph, MuxerNodeData, NodeData, ProbeResult } from "../model/types";
import { newFilterData, newInputData, newMuxerData, normalizeMuxerSlots } from "../nodes/defs";
import { genericDef, newGenericFilterData, offerGeneric, parseFilterHelp, parseIo } from "../nodes/defs/generic";
import { negotiate } from "../validation/negotiate";
import { validate } from "../validation/diagnostics";
import { serialize } from "./index";
import { detectSequence, inputDemuxArgs } from "../model/sequence";
import { encoder, pushNode } from "../test/fixtures";
import { buildRecodeGraph, defaultChoices, type WizardChoices } from "../wizard/build";
import { OutputInfoParser } from "../ui/jobInfo";

const ENABLED = !!process.env.FFMPEG_E2E;

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}):\n${r.stderr.slice(-2000)}`);
  return r.stdout;
}
const probe = (path: string) => JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path])) as ProbeResult;

class G {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  add(data: NodeData) {
    const id = `n${this.nodes.length}`;
    pushNode(this.nodes, this.edges, id, data);
    return id;
  }
  link(source: string, sourceHandle: string, target: string, targetHandle = "") {
    const t = this.nodes.find((n) => n.id === target)!;
    if (t.data.kind === "muxer") targetHandle = t.data.slots[t.data.slots.length - 1].id;
    this.edges.push({ id: `e${this.edges.length}`, source, sourceHandle, target, targetHandle });
    if (t.data.kind === "muxer") t.data = normalizeMuxerSlots(t.data, t.id, this.edges) ?? t.data;
  }
  get graph(): Graph {
    return { nodes: this.nodes, edges: this.edges };
  }
}

describe.skipIf(!ENABLED)("real ffmpeg", () => {
  let dir = "";
  let sample = "";
  let sampleProbe: ProbeResult;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ffmpegnodes-e2e-"));
    const srt = join(dir, "subs.srt");
    writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:00:01,500 --> 00:00:03,000\nWorld\n");
    sample = join(dir, "sample.mkv");
    run("ffmpeg", [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-i", srt,
      "-t", "3", "-map", "0", "-map", "1", "-map", "2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "srt", "-metadata:s:s:0", "language=eng",
      sample,
    ]);
    sampleProbe = probe(sample);
  }, 60_000);

  afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("encodes the design-doc pipeline: scale → x265 main10, loudnorm → aac 48k, srt → mov_text, mp4", () => {
    const g = new G();
    const inp = g.add({ ...newInputData(sample), probe: sampleProbe });
    const scale = g.add({ ...newFilterData("scale"), params: { w: "1920", h: "-2", flags: "" } });
    const fmt = g.add({ ...newFilterData("format"), params: { pix_fmts: "yuv420p10le" } });
    const loud = g.add(newFilterData("loudnorm"));
    const vbase = encoder("video", "libx265");
    const venc = g.add({ ...vbase, params: { ...vbase.params, crf: 30, preset: "ultrafast", profile: "main10", pix_fmt: "yuv420p10le" } });
    const abase = encoder("audio", "aac");
    const aenc = g.add({ ...abase, params: { ...abase.params, ar: "48000" } });
    const senc = g.add(encoder("subtitle", "mov_text"));
    const out = join(dir, "out.mp4");
    const mux = g.add(newMuxerData(out));
    g.link(inp, "f0", scale, "in");
    g.link(scale, "out", fmt, "in");
    g.link(fmt, "out", venc, "in");
    g.link(inp, "f1", loud, "in");
    g.link(loud, "out", aenc, "in");
    g.link(inp, "f2", senc, "in");
    g.link(venc, "out", mux);
    g.link(aenc, "out", mux);
    g.link(senc, "out", mux);
    const m = g.nodes.find((n) => n.id === mux)!.data as MuxerNodeData;
    m.slots[0].tag = "hvc1";
    m.slots[2].language = "eng";

    const ser = serialize(g.graph);
    const diags = validate(g.graph, ser, negotiate(g.graph));
    expect(diags.filter((d) => d.severity !== "info")).toEqual([]);
    run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);

    const p = probe(out);
    const [v, a, s] = p.streams;
    expect(v).toMatchObject({ codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, pix_fmt: "yuv420p10le", profile: "Main 10" });
    expect((v as unknown as { codec_tag_string: string }).codec_tag_string).toBe("hvc1");
    expect(a).toMatchObject({ codec_type: "audio", codec_name: "aac", sample_rate: "48000" });
    expect(s).toMatchObject({ codec_type: "subtitle", codec_name: "mov_text" });
    expect(s.tags?.language).toBe("eng");
  }, 120_000);

  // the recode wizard's graphs run as built
  const wizard = (name: string, patch: (c: WizardChoices) => void) => {
    let k = 0;
    const c = defaultChoices({ path: sample, probe: sampleProbe });
    c.output = join(dir, name);
    patch(c);
    const g = buildRecodeGraph({ path: sample, probe: sampleProbe }, c, (kind) => `${kind}-${k++}`);
    const ser = serialize(g);
    expect(validate(g, ser, negotiate(g)).filter((d) => d.severity === "error")).toEqual([]);
    run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);
    return probe(c.output).streams;
  };

  it("wizard: denoise + scale → x264, loudnorm → opus, copied subtitles in mkv", () => {
    const [v, a, s] = wizard("wizard.mkv", (c) => {
      c.video.denoise = c.video.scale = true;
      c.audio.codec = "libopus";
      c.audio.normalize = true;
    });
    expect(v).toMatchObject({ codec_name: "h264", width: 1920, height: 1080 });
    expect(a).toMatchObject({ codec_name: "opus", sample_rate: "48000" });
    expect(s).toMatchObject({ codec_name: "subrip" });
  }, 120_000);

  it.skipIf(!process.env.FFMPEG_E2E_NVENC)("wizard: GPU decode → Deinterlace (CUDA) → Denoise (CPU) → Scale (CUDA) → hevc_nvenc, audio copy, mov_text in mp4", () => {
    const [v, a, s] = wizard("wizard-gpu.mp4", (c) => {
      c.video.gpu = true;
      c.video.codec = "hevc_nvenc";
      c.video.deinterlace = true;
      c.video.denoise = true;
      c.video.scale = true;
      c.audio.codec = "copy";
    });
    expect(v).toMatchObject({ codec_name: "hevc", width: 1920, height: 1080 });
    expect(a).toMatchObject({ codec_name: "aac", sample_rate: "44100" });
    expect(s).toMatchObject({ codec_name: "mov_text" });
  }, 120_000);

  // NVIDIA only:  FFMPEG_E2E=1 FFMPEG_E2E_NVENC=1 pnpm test
  describe.skipIf(!process.env.FFMPEG_E2E_NVENC)("nvenc", () => {
    const cudaOpts = () => ({ ...newInputData("").options, hwaccel: "cuda" });

    it("cuda decode → scale_cuda p010le → hevc_nvenc main10 (CQ, spatial AQ, multipass), all on the GPU", () => {
      const g = new G();
      const inp = g.add({ ...newInputData(sample), probe: sampleProbe, options: cudaOpts() });
      const sc = g.add({ ...newFilterData("scale_cuda"), params: { w: "1920", h: "-2", format: "p010le", interp_algo: "" } });
      const base = encoder("video", "hevc_nvenc");
      const enc = g.add({ ...base, params: { ...base.params, profile: "main10", preset: "p5", spatial_aq: true, aq_strength: 10, multipass: "qres", b_ref_mode: "middle" } });
      const out = join(dir, "nvenc.mkv");
      const mux = g.add(newMuxerData(out));
      g.link(inp, "f0", sc, "in");
      g.link(sc, "out", enc, "in");
      g.link(enc, "out", mux);

      const ser = serialize(g.graph);
      expect(ser.args).toContain("-hwaccel_output_format");
      expect(validate(g.graph, ser, negotiate(g.graph)).filter((d) => d.severity === "error")).toEqual([]);
      run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);
      const [v] = probe(out).streams;
      expect(v).toMatchObject({ codec_name: "hevc", profile: "Main 10", width: 1920, height: 1080, pix_fmt: "yuv420p10le" });
    }, 120_000);

    const encode = (g: G, name: string) => {
      const ser = serialize(g.graph);
      expect(validate(g.graph, ser, negotiate(g.graph)).filter((d) => d.severity === "error")).toEqual([]);
      run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);
      return { fc: ser.args[ser.args.indexOf("-filter_complex") + 1], v: probe(join(dir, name)).streams[0] };
    };

    it("GPU → CPU → GPU: bwdif_cuda, CPU crop (download + upload), scale_cuda, transpose_cuda, pad_cuda → hevc_nvenc", () => {
      const g = new G();
      const inp = g.add({ ...newInputData(sample), probe: sampleProbe, options: cudaOpts() });
      const chain = [
        newFilterData("bwdif_cuda"),
        { ...newFilterData("crop"), params: { ...newFilterData("crop").params, w: "iw", h: "ih-80", x: "0", y: "40" } },
        { ...newFilterData("scale_cuda"), params: { w: "1920", h: "-2", format: "", interp_algo: "" } },
        { ...newFilterData("transpose_cuda"), params: { dir: "clock" } },
        { ...newFilterData("pad_cuda"), params: { ...newFilterData("pad_cuda").params, w: "1080", h: "1920" } },
      ];
      let from = inp;
      let pad = "f0";
      for (const d of chain) {
        const f = g.add(d);
        g.link(from, pad, f, "in");
        from = f;
        pad = "out";
      }
      const enc = g.add(encoder("video", "hevc_nvenc"));
      const mux = g.add(newMuxerData(join(dir, "gpu-mixed.mkv")));
      g.link(from, pad, enc, "in");
      g.link(enc, "out", mux);
      const { fc, v } = encode(g, "gpu-mixed.mkv");
      expect(fc).toContain("bwdif_cuda=mode=send_frame,hwdownload,format=nv12,crop=");
      expect(fc).toContain(",hwupload_cuda,scale_cuda=");
      // 1280×720 → crop 1280×640 → scale 1920×960 → rotate 960×1920 → pad 1080×1920
      expect(v).toMatchObject({ codec_name: "hevc", width: 1080, height: 1920 });
    }, 120_000);

    it("CPU decode → scale_cuda (upload) → libx264 (download)", () => {
      const g = new G();
      const inp = g.add({ ...newInputData(sample), probe: sampleProbe });
      const sc = g.add({ ...newFilterData("scale_cuda"), params: { w: "640", h: "-2", format: "", interp_algo: "" } });
      const enc = g.add(encoder("video", "libx264"));
      const mux = g.add(newMuxerData(join(dir, "upload-download.mkv")));
      g.link(inp, "f0", sc, "in");
      g.link(sc, "out", enc, "in");
      g.link(enc, "out", mux);
      const { fc, v } = encode(g, "upload-download.mkv");
      expect(fc).toBe("[0:v]hwupload_cuda,scale_cuda=640:-2,hwdownload,format=yuv420p[v]");
      expect(v).toMatchObject({ codec_name: "h264", width: 640, height: 360 });
    }, 120_000);

    it("av1_nvenc in constant-quality mode (skipped on GPUs without AV1 encoding)", (ctx) => {
      const g = new G();
      const inp = g.add({ ...newInputData(sample), probe: sampleProbe });
      const enc = g.add(encoder("video", "av1_nvenc"));
      const out = join(dir, "av1.mkv");
      const mux = g.add(newMuxerData(out));
      g.link(inp, "f0", enc, "in");
      g.link(enc, "out", mux);
      try {
        run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...serialize(g.graph).args]);
      } catch (e) {
        if (/No capable devices|not supported|unsupported/i.test(String(e))) ctx.skip();
        throw e;
      }
      expect(probe(out).streams[0].codec_name).toBe("av1");
    }, 120_000);
  });

  const filt = (id: string, params: Record<string, string | number | boolean> = {}) => {
    const base = newFilterData(id);
    return { ...base, params: { ...base.params, ...params } };
  };
  const x264 = () => {
    const b = encoder("video", "libx264");
    return { ...b, params: { ...b.params, preset: "ultrafast" } };
  };

  it("milestone-2 filters: trim + concat, cleanup, color, text, LUT and burned-in subtitles; audio dynamics and downmix", () => {
    const lut = join(dir, "identity.cube");
    writeFileSync(lut, "LUT_3D_SIZE 2\n" + [0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${r} ${g} ${b}`))).join("\n") + "\n");
    const srt = join(dir, "burn.srt");
    writeFileSync(srt, "1\n00:00:00,000 --> 00:00:02,000\nBurned, in: yes\n");

    const g = new G();
    const a = g.add({ ...newInputData(sample), probe: sampleProbe });
    const b = g.add({ ...newInputData(sample), probe: sampleProbe });
    const tva = g.add(filt("trim", { start: "0.5", duration: "1.5" }));
    const tvb = g.add(filt("trim", { duration: "1.5" }));
    const taa = g.add(filt("atrim", { start: "0.5", duration: "1.5" }));
    const tab = g.add(filt("atrim", { duration: "1.5" }));
    const cat = g.add(filt("concat"));
    // video chain after concat
    const chain = ["bwdif", "hqdn3d", "unsharp", "deband", "eq", "lut3d", "subtitles", "drawtext", "pad", "fade"].map((id) =>
      g.add(
        id === "lut3d"
          ? filt(id, { file: lut })
          : id === "subtitles"
            ? filt(id, { filename: srt })
            : id === "drawtext"
              ? filt(id, { text: "Time, 10:00 - it's ok", fontsize: "32" })
              : id === "pad"
                ? filt(id, { w: "1280", h: "800" })
                : id === "eq"
                  ? filt(id, { contrast: 1.1 })
                  : filt(id),
      ),
    );
    // audio chain after concat (sample audio is mono)
    const up = g.add(filt("aformat", { channel_layouts: "5.1" }));
    const achain = ["afade", "acompressor", "alimiter", "passfilter", "equalizer", "afftdn", "pan"].map((id) => g.add(filt(id)));
    const venc = g.add(x264());
    const aenc = g.add(encoder("audio", "aac"));
    const out = join(dir, "m2.mkv");
    const mux = g.add(newMuxerData(out));

    g.link(a, "f0", tva, "in");
    g.link(b, "f0", tvb, "in");
    g.link(a, "f1", taa, "in");
    g.link(b, "f1", tab, "in");
    g.link(tva, "out", cat, "s0v0");
    g.link(taa, "out", cat, "s0a0");
    g.link(tvb, "out", cat, "s1v0");
    g.link(tab, "out", cat, "s1a0");
    [cat, ...chain].forEach((id, i, all) => i && g.link(all[i - 1], i === 1 ? "v0" : "out", id, "in"));
    g.link(chain[chain.length - 1], "out", venc, "in");
    g.link(cat, "a0", up, "in");
    [up, ...achain].forEach((id, i, all) => i && g.link(all[i - 1], "out", id, "in"));
    g.link(achain[achain.length - 1], "out", aenc, "in");
    g.link(venc, "out", mux);
    g.link(aenc, "out", mux);

    const ser = serialize(g.graph);
    expect(validate(g.graph, ser, negotiate(g.graph)).filter((d) => d.severity === "error")).toEqual([]);
    run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);
    const p = probe(out);
    const [v, au] = p.streams;
    expect(v).toMatchObject({ codec_name: "h264", width: 1280, height: 800 });
    expect(au).toMatchObject({ codec_name: "aac", channels: 2 });
    expect(Number(p.format.duration)).toBeCloseTo(3, 0);
  }, 120_000);

  it("stack, transpose, speed + tempo, merge channels", () => {
    const g = new G();
    const inp = g.add({ ...newInputData(sample), probe: sampleProbe });
    const sc = g.add({ ...newFilterData("scale"), params: { w: "320", h: "180", flags: "" } });
    const tr = g.add(filt("transpose"));
    const st = g.add(filt("stack"));
    const sp = g.add(filt("speed", { factor: 2 }));
    const at = g.add(filt("atempo", { tempo: 2 }));
    const am = g.add(filt("amerge"));
    const venc = g.add(x264());
    const aenc = g.add(encoder("audio", "aac"));
    const out = join(dir, "stack.mkv");
    const mux = g.add(newMuxerData(out));
    g.link(inp, "f0", sc, "in");
    g.link(sc, "out", tr, "in");
    g.link(tr, "out", st, "in0");
    g.link(tr, "out", st, "in1");
    g.link(st, "out", sp, "in");
    g.link(sp, "out", venc, "in");
    g.link(inp, "f1", at, "in");
    g.link(at, "out", am, "in0");
    g.link(at, "out", am, "in1");
    g.link(am, "out", aenc, "in");
    g.link(venc, "out", mux);
    g.link(aenc, "out", mux);

    const ser = serialize(g.graph);
    run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);
    const p = probe(out);
    expect(p.streams[0]).toMatchObject({ width: 360, height: 320 });
    expect(p.streams[1]).toMatchObject({ channels: 2 });
    expect(Number(p.format.duration)).toBeCloseTo(1.5, 0);
  }, 120_000);

  it("parses -h for every filter of the build into consistent pads and options", () => {
    const rows = run("ffmpeg", ["-hide_banner", "-filters"])
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 3 && p[2].includes("->"))
      .map((p) => ({ name: p[1], io: p[2] }));
    expect(rows.length).toBeGreaterThan(300);
    const problems: string[] = [];
    let options = 0;
    for (const f of rows.filter(offerGeneric)) {
      const text = run("ffmpeg", ["-hide_banner", "-h", `filter=${f.name}`]);
      const help = parseFilterHelp(text);
      const def = genericDef({ name: f.name, io: f.io, description: "", help });
      options += help.options.length;
      const io = parseIo(f.io);
      // static pad counts from the help text must agree with the -filters io string
      for (const side of ["inputs", "outputs"] as const) {
        const a = io[side];
        const b = help[side];
        if (a.kind !== b.kind) problems.push(`${f.name} ${side}: io ${a.kind}, help ${b.kind}`);
        else if (a.kind === "static" && b.kind === "static" && a.pads.map((x) => x.media).join() !== b.pads.map((x) => x.media).join())
          problems.push(`${f.name} ${side}: io ${f.io}, help ${b.pads.map((x) => x.media).join()}`);
      }
      // every option line was understood: names are identifiers and enum defaults are listed
      for (const p of def.params) {
        if (!/^[\w-]+$/.test(p.name)) problems.push(`${f.name}: odd option name "${p.name}"`);
        if (p.type === "enum" && !p.options?.some((o) => o.value === p.default)) problems.push(`${f.name}.${p.name}: default not an option`);
      }
      const optLines = text.split(/\r?\n/).filter((l) => /^ {3}\S+\s+<\w+>/.test(l)).length;
      if (optLines && !help.options.length) problems.push(`${f.name}: ${optLines} option lines, none parsed`);
    }
    expect(problems).toEqual([]);
    expect(options).toBeGreaterThan(2000);
  }, 600_000);

  it("runs generic nodes: vignette and xstack on video, a sine source with aecho", () => {
    const help = (name: string) => parseFilterHelp(run("ffmpeg", ["-hide_banner", "-h", `filter=${name}`]));
    const gen = (name: string, io: string, params = {}) => ({ ...newGenericFilterData({ name, io, description: "" }), generic: { name, io, description: "", help: help(name) }, params });
    const g = new G();
    const inp = g.add({ ...newInputData(sample), probe: sampleProbe });
    const sc = g.add({ ...newFilterData("scale"), params: { w: "320", h: "180", flags: "" } });
    const vig = g.add(gen("vignette", "V->V", { angle: "PI/3", mode: "backward" }));
    const xs = g.add(gen("xstack", "N->V", { layout: "0_0|w0_0" }));
    const sine = g.add(gen("sine", "|->A", { frequency: 1000, duration: "2" }));
    const echo = g.add(gen("aecho", "A->A", { _raw: "in_gain=0.6:out_gain=0.3" }));
    const venc = g.add(x264());
    const aenc = g.add(encoder("audio", "aac"));
    const out = join(dir, "generic.mkv");
    const mux = g.add(newMuxerData(out));
    g.link(inp, "f0", sc, "in");
    g.link(sc, "out", vig, "in0");
    g.link(vig, "out0", xs, "in0");
    g.link(sc, "out", xs, "in1");
    g.link(xs, "out0", venc, "in");
    g.link(sine, "out0", echo, "in0");
    g.link(echo, "out0", aenc, "in");
    g.link(venc, "out", mux);
    g.link(aenc, "out", mux);

    const ser = serialize(g.graph);
    expect(ser.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const fc = ser.args[ser.args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("vignette=angle=PI/3:mode=backward");
    expect(fc).toContain("xstack=layout=0_0|w0_0");
    expect(fc).toContain("sine=frequency=1000:duration=2,aecho=in_gain=0.6:out_gain=0.3");
    run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);
    const p = probe(out);
    expect(p.streams[0]).toMatchObject({ width: 640, height: 180 });
    expect(p.streams[1]).toMatchObject({ codec_type: "audio" });
  }, 120_000);

  it("Remove letterbox crops the detected bars (letterbox.py output format)", () => {
    const boxed = join(dir, "boxed.mkv");
    run("ffmpeg", ["-hide_banner", "-y", "-i", sample, "-vf", "pad=1280:960:0:120:black", "-an", "-sn", "-c:v", "libx264", "-pix_fmt", "yuv420p", boxed]);
    const g = new G();
    const inp = g.add({ ...newInputData(boxed), probe: probe(boxed) });
    const lb = g.add(filt("letterbox", { top: 120, bottom: 120 }));
    const venc = g.add(x264());
    const out = join(dir, "unboxed.mkv");
    const mux = g.add(newMuxerData(out));
    g.link(inp, "f0", lb, "in");
    g.link(lb, "out", venc, "in");
    g.link(venc, "out", mux);
    const ser = serialize(g.graph);
    expect(ser.args.join(" ")).toContain("crop=iw:ih-240:0:120");
    run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);
    expect(probe(out).streams[0]).toMatchObject({ width: 1280, height: 720 });
  }, 120_000);

  it("stream-copies into mkv and splits one filter output into two encodes", () => {
    const g = new G();
    const inp = g.add({ ...newInputData(sample), probe: sampleProbe });
    const scale = g.add({ ...newFilterData("scale"), params: { w: "640", h: "-2", flags: "" } });
    const e1 = g.add(encoder("video", "libx264"));
    const b2 = encoder("video", "libx265");
    const e2 = g.add({ ...b2, params: { ...b2.params, preset: "ultrafast" } });
    const out = join(dir, "copy.mkv");
    const mux = g.add(newMuxerData(out));
    g.link(inp, "f0", scale, "in");
    g.link(scale, "out", e1, "in");
    g.link(scale, "out", e2, "in");
    g.link(e1, "out", mux);
    g.link(e2, "out", mux);
    g.link(inp, "p1", mux);
    g.link(inp, "p2", mux);

    const ser = serialize(g.graph);
    expect(ser.args.join(" ")).toContain("split=2");
    run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);
    const p = probe(out);
    expect(p.streams.map((s) => `${s.codec_type}:${s.codec_name}`)).toEqual(["video:h264", "video:hevc", "audio:aac", "subtitle:subrip"]);
    expect(p.streams[0].width).toBe(640);
  }, 120_000);

  it("reads an image sequence that starts at 1001, with audio and -shortest", () => {
    const seqDir = join(dir, "frames");
    mkdirSync(seqDir);
    run("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=60", "-frames:v", "30", "-start_number", "1001", join(seqDir, "shot_%04d.png")]);
    const wav = join(dir, "audio.wav");
    run("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", wav]);

    const seq = detectSequence("shot_1015.png", readdirSync(seqDir));
    expect(seq).toEqual({ pattern: "shot_%04d.png", first: 1001, last: 1030, count: 30, missing: [], missingCount: 0 });
    const pattern = join(seqDir, seq!.pattern);
    const options = { ...newInputData("").options, framerate: "60", start_number: String(seq!.first) };
    // without the start number, image2 only looks at 0..4 and finds nothing
    expect(() => probe(pattern)).toThrow();
    const seqProbe = JSON.parse(run("ffprobe", ["-v", "error", ...inputDemuxArgs(options), "-show_streams", "-show_format", "-of", "json", pattern])) as ProbeResult;
    expect(Number(seqProbe.format.duration)).toBeCloseTo(0.5, 2);

    const g = new G();
    const inp = g.add({ ...newInputData(pattern), probe: seqProbe, sequence: seq!, options });
    const aud = g.add({ ...newInputData(wav), probe: probe(wav) });
    const v = g.add(encoder("video", "libx264"));
    const a = g.add(encoder("audio", "aac"));
    const out = join(dir, "sequence.mp4");
    const mux = g.add({ ...newMuxerData(out), shortest: true });
    g.link(inp, "f0", v, "in");
    g.link(aud, "f0", a, "in");
    g.link(v, "out", mux);
    g.link(a, "out", mux);

    const ser = serialize(g.graph);
    expect(ser.args.slice(0, 6)).toEqual(["-framerate", "60", "-start_number", "1001", "-i", pattern]);
    expect(ser.args).toContain("-shortest");
    run("ffmpeg", ["-hide_banner", "-y", "-nostats", ...ser.args]);
    const p = probe(out);
    expect(p.streams.map((s) => `${s.codec_type}:${s.codec_name}`)).toEqual(["video:h264", "audio:aac"]);
    expect(p.streams[0].avg_frame_rate).toBe("60/1");
    expect(Number(p.format.duration)).toBeLessThan(1);
  }, 60_000);

  it("job popups read the output streams from real ffmpeg stderr", () => {
    const out = join(dir, "popup.mkv");
    const r = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-y", "-nostats", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=0.5", "-f", "lavfi", "-i", "sine=d=0.5:sample_rate=48000",
        "-c:v", "libx265", "-c:a", "flac", out],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const p = new OutputInfoParser();
    for (const l of r.stderr.split(/\r?\n/)) p.feed(l);
    expect(p.files).toEqual([{ index: 0, format: "matroska", path: out }]);
    expect(p.streams).toHaveLength(2);
    expect(p.streams[0]).toMatchObject({ media: "video", codec: "hevc", width: 320, height: 240, fps: "25" });
    expect(p.streams[1]).toMatchObject({ media: "audio", codec: "flac", sampleRate: 48000, channels: "mono" });
  });
});
