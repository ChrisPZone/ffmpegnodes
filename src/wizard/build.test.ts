import { describe, expect, it } from "vitest";
import type { Capabilities, EncoderParamsNodeData, FilterNodeData, GNode, Graph, InputNodeData, ProbeResult } from "../model/types";
import { serialize } from "../serializer";
import { validate } from "../validation/diagnostics";
import { negotiate } from "../validation/negotiate";
import { PARAMS_PAD } from "../nodes/defs";
import { buildRecodeGraph, codecChoices, COPY, defaultChoices, defaultOutputPath, LAYOUT, type WizardChoices } from "./build";

const PROBE: ProbeResult = {
  format: { duration: "60" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "25/1", field_order: "progressive" },
    { index: 1, codec_type: "audio", codec_name: "ac3", sample_rate: "48000", channels: 6, channel_layout: "5.1", tags: { language: "eng" } },
    { index: 2, codec_type: "audio", codec_name: "ac3", sample_rate: "48000", channels: 2, channel_layout: "stereo", tags: { language: "ger" } },
    { index: 3, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, channel_layout: "stereo" },
    { index: 4, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } },
    { index: 5, codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle" },
    { index: 6, codec_type: "video", codec_name: "mjpeg", width: 600, height: 600, disposition: { attached_pic: 1 } },
  ],
};
const SRC = { path: "C:/v/movie.mkv", probe: PROBE };
const CAPS: Capabilities = {
  version: "",
  muxers: [],
  filters: [],
  encoders: ["libx264", "libx265", "hevc_nvenc", "h264_nvenc", "aac", "libopus", "mov_text"].map((name) => ({
    name,
    media: /nvenc|x26/.test(name) ? "video" : name === "mov_text" ? "subtitle" : "audio",
    codec: name,
    description: "",
  })),
};

let k = 0;
const newId = (kind: string) => `${kind}-${k++}`;
const choices = (patch: (c: WizardChoices) => void = () => {}) => {
  const c = defaultChoices(SRC, CAPS);
  patch(c);
  return c;
};
const ofKind = (g: Graph, kind: string) => g.nodes.filter((n) => n.data.kind === kind);
const filters = (g: Graph) => ofKind(g, "filter").map((n) => (n.data as FilterNodeData).defId);
const check = (g: Graph) => {
  const ser = serialize(g);
  expect(validate(g, ser, negotiate(g)).filter((d) => d.severity === "error")).toEqual([]);
  return ser.args.join(" ");
};

describe("recode wizard: defaults", () => {
  it("ticks only the first video stream (not cover art) and the first audio stream", () => {
    const c = defaultChoices(SRC, CAPS);
    expect(c.video).toMatchObject({ streams: [0], codec: "libx264", gpu: false, deinterlace: false });
    expect(c.audio).toMatchObject({ streams: [1], codec: "aac" });
    expect(c.subtitles.copy).toBe(true);
    expect(c.output).toBe("C:/v/movie-recode.mkv");
    const cover = { ...PROBE, streams: [PROBE.streams[6], { ...PROBE.streams[0], index: 7, field_order: "tt" }] };
    expect(defaultChoices({ path: "x.mkv", probe: cover }, CAPS).video).toMatchObject({ streams: [7], deinterlace: true });
  });

  it("offers this build's encoders, only nvenc with GPU on", () => {
    expect(codecChoices("video", CAPS).map((c) => c.value)).toEqual(["libx264", "libx265", "h264_nvenc", "hevc_nvenc"]);
    expect(codecChoices("video", CAPS, true).map((c) => c.value)).toEqual(["h264_nvenc", "hevc_nvenc"]);
    expect(codecChoices("audio", CAPS).map((c) => c.value)).toEqual(["aac", "libopus"]);
    expect(defaultOutputPath("D:\\a.b\\clip.final.mp4")).toBe("D:\\a.b\\clip.final-recode.mkv");
    expect(defaultOutputPath("noext")).toBe("noext-recode.mkv");
  });
});

describe("recode wizard: generated graph", () => {
  it("builds filters, shared parameters, encoders and copied subtitles", () => {
    const g = buildRecodeGraph(SRC, choices((c) => {
      c.video.letterbox = true;
      c.video.scale = true;
      c.audio.streams = [1, 2, 3];
      c.audio.downmix = true;
    }), newId);
    expect(ofKind(g, "input")).toHaveLength(1);
    expect(ofKind(g, "muxer")).toHaveLength(1);
    expect(ofKind(g, "encparams").map((n) => (n.data as EncoderParamsNodeData).codec)).toEqual(["libx264", "aac"]);
    const encs = ofKind(g, "encoder");
    expect(encs).toHaveLength(4);
    for (const e of encs) expect(g.edges.some((x) => x.target === e.id && x.targetHandle === PARAMS_PAD)).toBe(true);
    // downmix only where there are more than 2 channels
    expect(filters(g)).toEqual(["letterbox", "scale", "pan"]);
    const cmd = check({ ...g, nodes: g.nodes.map((n) => ((n.data as FilterNodeData).defId === "letterbox" ? { ...n, data: { ...n.data, params: { ...(n.data as FilterNodeData).params, top: 140, bottom: 140 } } } as GNode : n)) });
    expect(cmd).toContain("crop=iw:ih-280:0:140,scale=1920:-2");
    for (const i of [0, 1, 2]) expect(cmd).toContain(`-c:a:${i} aac`);
    expect(cmd).toContain("-map 0:s:0 -c:s:0 copy");
    expect(cmd).toContain("-map 0:s:1 -c:s:1 copy");
    expect(cmd).not.toContain("0:v:1"); // cover art not selected
  });

  it("copies streams whose codec is Copy, and leaves out deselected streams", () => {
    const g = buildRecodeGraph(SRC, choices((c) => {
      c.video.codec = COPY;
      c.video.scale = true;
      c.audio.streams = [2];
      c.subtitles.copy = false;
    }), newId);
    expect(filters(g)).toEqual([]);
    expect(ofKind(g, "encparams").map((n) => n.data.media)).toEqual(["audio"]);
    const cmd = check(g);
    expect(cmd).toContain("-map 0:v:0 -c:v:0 copy");
    expect(cmd).toContain("-map 0:a:1 -c:a:0 aac");
    expect(cmd).not.toContain("0:s:");
  });

  it("keeps GPU frames through Scale (CUDA) into nvenc", () => {
    const g = buildRecodeGraph(SRC, choices((c) => {
      c.video.gpu = true;
      c.video.codec = "hevc_nvenc";
      c.video.scale = true;
    }), newId);
    expect(filters(g)).toEqual(["scale_cuda"]);
    expect((ofKind(g, "input")[0].data as InputNodeData).options.hwaccel).toBe("cuda");
    const cmd = check(g);
    expect(cmd).toContain("-hwaccel cuda -hwaccel_output_format cuda");
    expect(cmd).not.toContain("hwdownload");
  });

  it("with GPU on, moves frames off the GPU only for the CPU filters", () => {
    const g = buildRecodeGraph(SRC, choices((c) => {
      c.video.gpu = true;
      c.video.codec = "hevc_nvenc";
      c.video.deinterlace = true;
      c.video.denoise = true;
      c.video.scale = true;
    }), newId);
    expect(filters(g)).toEqual(["bwdif_cuda", "hqdn3d", "scale_cuda"]);
    const cmd = check(g);
    expect(cmd).toContain("-hwaccel cuda -hwaccel_output_format cuda");
    expect(cmd).toMatch(/bwdif_cuda=mode=send_frame,hwdownload,format=nv12,hqdn3d=[^,]+,hwupload_cuda,scale_cuda=1920:-2/);
  });

  it("normalizing loudness sets 48 kHz on the audio parameters", () => {
    const g = buildRecodeGraph(SRC, choices((c) => {
      c.audio.normalize = true;
      c.audio.resample = true;
    }), newId);
    expect(filters(g)).toEqual(["loudnorm"]);
    expect(check(g)).toContain("-ar:a:0 48000");
  });

  it("converts text subtitles to mov_text for MP4 and leaves bitmap ones out", () => {
    const g = buildRecodeGraph(SRC, choices((c) => (c.output = "C:/v/out.mp4")), newId);
    expect(ofKind(g, "encparams").map((n) => (n.data as EncoderParamsNodeData).codec)).toEqual(["libx264", "aac", "mov_text"]);
    const cmd = check(g);
    expect(cmd).toContain("-map 0:s:0 -c:s:0 mov_text");
    expect(cmd).not.toContain("0:s:1");
  });
});

describe("recode wizard: layout", () => {
  it("places five columns left to right, encoders on their rows and chains ending together", () => {
    const g = buildRecodeGraph(SRC, choices((c) => {
      c.video.deinterlace = c.video.denoise = c.video.scale = true;
      c.audio.streams = [1, 2];
      c.audio.normalize = true;
    }), newId);
    const x = (kind: string) => ofKind(g, kind).map((n) => n.position.x);
    const fx = x("filter");
    expect(Math.max(...x("input"))).toBeLessThan(Math.min(...fx));
    expect(Math.max(...fx)).toBeLessThan(Math.min(...x("encparams")));
    expect(Math.max(...x("encparams"))).toBeLessThan(Math.min(...x("encoder")));
    expect(Math.max(...x("encoder"))).toBeLessThan(Math.min(...x("muxer")));
    // each encoder is on the row of the last filter feeding it, and all chains end at one x
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const lastFilters = ofKind(g, "encoder").map((e) => byId.get(g.edges.find((x) => x.target === e.id && x.targetHandle === "in")!.source)!);
    expect(new Set(lastFilters.map((f) => f.position.x)).size).toBe(1);
    for (const e of ofKind(g, "encoder")) {
      const f = byId.get(g.edges.find((x) => x.target === e.id && x.targetHandle === "in")!.source)!;
      expect(f.position.y).toBe(e.position.y);
    }
    const { paramsBand: b, rowH } = LAYOUT;
    expect(ofKind(g, "encoder").map((n) => n.position.y)).toEqual([b, b + rowH.video + b, b + rowH.video + b + rowH.audio]);
    // parameters nodes sit above their rows, clear of the frames wires
    expect(ofKind(g, "encparams").map((n) => n.position.y)).toEqual([0, b + rowH.video]);
  });
});
