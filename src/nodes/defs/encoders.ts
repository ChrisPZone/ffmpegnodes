// Encoder schemas for milestone 1. Unknown encoders fall back to a generic schema plus
// a free key/value table; milestone 2 generates schemas from `ffmpeg -h encoder=<name>`.
import type { EncoderMedia, ParamDef, ParamValues } from "../../model/types";

export interface EncoderParamDef extends ParamDef {
  /** ffmpeg option name without the dash; "" = UI-only (e.g. the rate-control mode). */
  flag: string;
  /** Emit even when equal to the default (quality knobs the user should always see in the command). */
  emitDefault?: boolean;
  /**
   * Where the help popup finds this param in the ffmpeg docs. Default: `flag` (none for UI-only
   * params). `false`: no help.
   */
  doc?: { option: string } | false;
}

/** The ffmpeg option a param's help comes from, if any. */
export function encoderParamDocRef(p: EncoderParamDef): string | undefined {
  if (p.doc === false) return undefined;
  return p.doc ? p.doc.option : p.flag || undefined;
}

export interface EncoderSchema {
  codec: string;
  media: EncoderMedia;
  label: string;
  /** libavcodec codec id produced (for container compatibility checks). */
  codecId: string;
  /** Hardware encoder: only offered when the user's ffmpeg has it. */
  hardware?: boolean;
  params: EncoderParamDef[];
  /** Additional derived options, e.g. CBR's minrate/maxrate. */
  derived?: (p: ParamValues) => [string, string][];
  /** One-line summary for the node face. */
  summary?: (p: ParamValues) => string;
}

const opt = (values: string[], auto = true) => [...(auto ? [{ value: "auto", label: "auto" }] : []), ...values.map((value) => ({ value }))];

const VIDEO_PIX_FMTS = ["yuv420p", "yuv420p10le", "yuv422p", "yuv422p10le", "yuv444p", "yuv444p10le", "nv12", "p010le"];

function x26xParams(kind: "x264" | "x265"): EncoderParamDef[] {
  const isX265 = kind === "x265";
  return [
    {
      name: "rc",
      flag: "",
      label: "Rate control",
      type: "enum",
      default: "crf",
      face: true,
      options: [
        { value: "crf", label: "CRF (constant quality)" },
        { value: "abr", label: "ABR / VBR (target bitrate)" },
        { value: "cbr", label: "CBR (constant bitrate)" },
      ],
    },
    {
      name: "crf",
      flag: "crf",
      label: "CRF",
      type: "float",
      default: isX265 ? 28 : 23,
      min: 0,
      max: 51,
      step: 1,
      emitDefault: true,
      face: true,
      description: "Lower = better quality, bigger file. ±6 roughly halves/doubles the size.",
      visibleIf: (p) => p.rc === "crf",
    },
    { name: "b", flag: "b", label: "Bitrate", type: "string", default: "5M", emitDefault: true, face: true, visibleIf: (p) => p.rc !== "crf" },
    { name: "maxrate", flag: "maxrate", label: "Max rate", type: "string", default: "", visibleIf: (p) => p.rc === "abr" },
    { name: "bufsize", flag: "bufsize", label: "Buffer size", type: "string", default: "", visibleIf: (p) => p.rc !== "crf" },
    {
      name: "preset",
      flag: "preset",
      label: "Preset",
      type: "enum",
      default: "medium",
      options: opt(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "placebo"], false),
    },
    {
      name: "tune",
      flag: "tune",
      label: "Tune",
      type: "enum",
      default: "",
      options: [
        { value: "", label: "none" },
        ...(isX265
          ? ["psnr", "ssim", "grain", "zerolatency", "fastdecode", "animation"]
          : ["film", "animation", "grain", "stillimage", "fastdecode", "zerolatency", "psnr", "ssim"]
        ).map((value) => ({ value })),
      ],
    },
    {
      name: "profile",
      flag: "profile",
      label: "Profile",
      type: "enum",
      default: "auto",
      options: opt(isX265 ? ["main", "main10", "mainstillpicture", "main422-10", "main444-8", "main444-10"] : ["baseline", "main", "high", "high10", "high422", "high444"]),
    },
    { name: "level", flag: "level", label: "Level", type: "string", default: "", description: "e.g. 4.1 (empty = auto)" },
    { name: "pix_fmt", flag: "pix_fmt", label: "Pixel format", type: "enum", default: "auto", options: opt(VIDEO_PIX_FMTS) },
    {
      name: "params",
      flag: `${kind}-params`,
      label: `-${kind}-params`,
      type: "string",
      default: "",
      description: "Raw encoder parameters, colon-separated (key=value:key=value).",
    },
  ];
}

/** nvenc's device selection; the inspector renders it as a GPU picker. "" = any (driver default). */
export const NVENC_GPU_PARAM: EncoderParamDef = {
  name: "gpu",
  flag: "gpu",
  label: "GPU",
  type: "string",
  default: "",
  face: true,
  description: "Which NVIDIA GPU encodes. Ignored when the frames already live on a GPU.",
};

/** NVIDIA NVENC options (names/ranges as in `ffmpeg -h encoder=hevc_nvenc`). */
function nvencParams(kind: "h264" | "hevc" | "av1"): EncoderParamDef[] {
  const cqMax = kind === "av1" ? 63 : 51;
  const params: EncoderParamDef[] = [
    {
      name: "nv_rc",
      flag: "",
      label: "Rate control",
      type: "enum",
      default: "cq",
      face: true,
      options: [
        { value: "cq", label: "Constant quality (VBR + CQ)" },
        { value: "vbr", label: "VBR (target bitrate)" },
        { value: "cbr", label: "CBR (constant bitrate)" },
        { value: "constqp", label: "Constant QP" },
      ],
      doc: { option: "rc" },
    },
    {
      name: "cq",
      flag: "cq",
      label: "CQ",
      type: "float",
      default: kind === "h264" ? 23 : kind === "hevc" ? 26 : 32,
      min: 1,
      max: cqMax,
      step: 1,
      emitDefault: true,
      face: true,
      description: `Target quality 1–${cqMax}; lower = better quality, bigger file.`,
      visibleIf: (p) => p.nv_rc === "cq",
    },
    { name: "b", flag: "b", label: "Bitrate", type: "string", default: "5M", emitDefault: true, face: true, visibleIf: (p) => p.nv_rc === "vbr" || p.nv_rc === "cbr" },
    { name: "maxrate", flag: "maxrate", label: "Max rate", type: "string", default: "", visibleIf: (p) => p.nv_rc === "vbr" || p.nv_rc === "cq" },
    { name: "bufsize", flag: "bufsize", label: "Buffer size", type: "string", default: "", visibleIf: (p) => p.nv_rc !== "constqp" },
    {
      name: "qp",
      flag: "qp",
      label: "QP",
      type: "int",
      default: 23,
      min: 0,
      max: kind === "av1" ? 255 : 51,
      emitDefault: true,
      face: true,
      visibleIf: (p) => p.nv_rc === "constqp",
    },
    {
      name: "preset",
      flag: "preset",
      label: "Preset",
      type: "enum",
      default: "p4",
      face: true,
      options: [
        { value: "p1", label: "p1 (fastest)" },
        { value: "p2", label: "p2" },
        { value: "p3", label: "p3" },
        { value: "p4", label: "p4 (default)" },
        { value: "p5", label: "p5" },
        { value: "p6", label: "p6" },
        { value: "p7", label: "p7 (slowest, best)" },
      ],
    },
    {
      name: "tune",
      flag: "tune",
      label: "Tune",
      type: "enum",
      default: "hq",
      options: [
        { value: "hq", label: "hq (high quality)" },
        ...(kind !== "h264" ? [{ value: "uhq", label: "uhq (ultra high quality, recent drivers)" }] : []),
        { value: "ll", label: "ll (low latency)" },
        { value: "ull", label: "ull (ultra low latency)" },
        { value: "lossless" },
      ],
    },
    {
      name: "multipass",
      flag: "multipass",
      label: "Multipass",
      type: "enum",
      default: "disabled",
      options: [
        { value: "disabled", label: "single pass" },
        { value: "qres", label: "2-pass (¼ resolution first pass)" },
        { value: "fullres", label: "2-pass (full resolution)" },
      ],
    },
    { name: "spatial_aq", flag: "spatial-aq", label: "Spatial AQ", type: "bool", default: false, description: "Adaptive quantization within a frame (helps flat areas)." },
    {
      name: "aq_strength",
      flag: "aq-strength",
      label: "AQ strength",
      type: "int",
      default: 8,
      min: 1,
      max: 15,
      description: "1 (low) – 15 (aggressive)",
      visibleIf: (p) => p.spatial_aq === true,
    },
    { name: "temporal_aq", flag: "temporal-aq", label: "Temporal AQ", type: "bool", default: false, description: "Adaptive quantization across frames." },
    { name: "bf", flag: "bf", label: "B-frames", type: "string", default: "", description: "Number of B-frames (empty = encoder default)" },
    {
      name: "b_ref_mode",
      flag: "b_ref_mode",
      label: "B-frame references",
      type: "enum",
      default: "auto",
      options: [{ value: "auto" }, { value: "disabled" }, { value: "each" }, { value: "middle" }],
    },
    { name: "rc_lookahead", flag: "rc-lookahead", label: "Lookahead frames", type: "int", default: 0, min: 0, max: 250, description: "0 = off" },
  ];
  if (kind === "h264") {
    params.push({ name: "profile", flag: "profile", label: "Profile", type: "enum", default: "auto", options: opt(["baseline", "main", "high", "high10", "high422", "high444p"]) });
  } else if (kind === "hevc") {
    params.push(
      { name: "profile", flag: "profile", label: "Profile", type: "enum", default: "auto", options: opt(["main", "main10", "rext"]) },
      { name: "tier", flag: "tier", label: "Tier", type: "enum", default: "auto", options: opt(["main", "high"]) },
    );
  } else {
    params.push({ name: "tier", flag: "tier", label: "Tier", type: "enum", default: "auto", options: opt(["0", "1"]) });
  }
  params.push({ name: "level", flag: "level", label: "Level", type: "string", default: "", description: "empty = auto" });
  if (kind !== "h264") {
    params.push({ name: "highbitdepth", flag: "highbitdepth", label: "10-bit from 8-bit input", type: "bool", default: false });
  }
  params.push({ name: "pix_fmt", flag: "pix_fmt", label: "Pixel format", type: "enum", default: "auto", options: opt(VIDEO_PIX_FMTS) }, NVENC_GPU_PARAM);
  return params;
}

const nvencDerived = (p: ParamValues): [string, string][] => {
  const mode = String(p.nv_rc ?? "cq");
  if (mode === "cq") return [["rc", "vbr"], ["b", "0"]];
  return [["rc", mode]];
};

const nvencSummary = (p: ParamValues) => {
  const mode = String(p.nv_rc ?? "cq");
  const rate = mode === "cq" ? `CQ ${p.cq}` : mode === "constqp" ? `QP ${p.qp}` : `${mode.toUpperCase()} ${p.b}`;
  return `${rate} · ${p.preset ?? "p4"}`;
};

const rateSummary = (p: ParamValues) => (p.rc === "crf" ? `CRF ${p.crf}` : `${String(p.rc).toUpperCase()} ${p.b}`);
const cbrDerived = (p: ParamValues): [string, string][] => (p.rc === "cbr" && p.b ? [["minrate", String(p.b)], ["maxrate", String(p.b)]] : []);

const audioCommon = (bitrate: string, rates: string[]): EncoderParamDef[] => [
  { name: "b", flag: "b", label: "Bitrate", type: "string", default: bitrate, emitDefault: true, face: true },
  { name: "ar", flag: "ar", label: "Sample rate", type: "enum", default: "auto", options: opt(rates) },
  {
    name: "ac",
    flag: "ac",
    label: "Channels",
    type: "enum",
    default: "auto",
    options: [{ value: "auto" }, { value: "1", label: "1 (mono)" }, { value: "2", label: "2 (stereo)" }, { value: "6", label: "6 (5.1)" }, { value: "8", label: "8 (7.1)" }],
  },
];

export const ENCODERS: EncoderSchema[] = [
  { codec: "libx264", media: "video", label: "H.264 (libx264)", codecId: "h264", params: x26xParams("x264"), derived: cbrDerived, summary: rateSummary },
  { codec: "libx265", media: "video", label: "H.265 / HEVC (libx265)", codecId: "hevc", params: x26xParams("x265"), derived: cbrDerived, summary: rateSummary },
  ...(["h264", "hevc", "av1"] as const).map(
    (kind): EncoderSchema => ({
      codec: `${kind}_nvenc`,
      media: "video",
      label: `${kind === "h264" ? "H.264" : kind === "hevc" ? "H.265 / HEVC" : "AV1"} (NVIDIA NVENC)`,
      codecId: kind,
      hardware: true,
      params: nvencParams(kind),
      derived: nvencDerived,
      summary: nvencSummary,
    }),
  ),
  {
    codec: "aac",
    media: "audio",
    label: "AAC (native, LC only)",
    codecId: "aac",
    params: [
      ...audioCommon("192k", ["22050", "32000", "44100", "48000", "96000"]),
      { name: "profile", flag: "profile", label: "Profile", type: "enum", default: "auto", options: opt(["aac_low", "mpeg2_aac_low", "aac_ltp"]) },
    ],
    summary: (p) => String(p.b),
  },
  {
    codec: "libfdk_aac",
    media: "audio",
    label: "AAC (libfdk_aac, HE-AAC)",
    codecId: "aac",
    params: [
      ...audioCommon("128k", ["22050", "32000", "44100", "48000"]),
      { name: "profile", flag: "profile", label: "Profile", type: "enum", default: "auto", options: opt(["aac_low", "aac_he", "aac_he_v2", "aac_ld", "aac_eld"]) },
    ],
    summary: (p) => String(p.b),
  },
  {
    codec: "libopus",
    media: "audio",
    label: "Opus (libopus)",
    codecId: "opus",
    params: [
      ...audioCommon("128k", ["8000", "12000", "16000", "24000", "48000"]),
      { name: "vbr", flag: "vbr", label: "VBR", type: "enum", default: "on", options: opt(["on", "off", "constrained"], false) },
      { name: "application", flag: "application", label: "Application", type: "enum", default: "audio", options: opt(["audio", "voip", "lowdelay"], false) },
      { name: "compression_level", flag: "compression_level", label: "Compression level", type: "int", default: 10, min: 0, max: 10 },
    ],
    summary: (p) => String(p.b),
  },
  { codec: "mov_text", media: "subtitle", label: "mov_text (MP4/MOV text)", codecId: "mov_text", params: [] },
  { codec: "srt", media: "subtitle", label: "SubRip (srt)", codecId: "subrip", params: [] },
  { codec: "ass", media: "subtitle", label: "ASS/SSA", codecId: "ass", params: [] },
  { codec: "webvtt", media: "subtitle", label: "WebVTT", codecId: "webvtt", params: [] },
];

const GENERIC: Record<EncoderMedia, EncoderParamDef[]> = {
  video: [
    { name: "b", flag: "b", label: "Bitrate", type: "string", default: "", face: true, description: "empty = encoder default" },
    { name: "pix_fmt", flag: "pix_fmt", label: "Pixel format", type: "enum", default: "auto", options: opt(VIDEO_PIX_FMTS) },
  ],
  audio: audioCommon("", ["22050", "32000", "44100", "48000", "96000"]),
  subtitle: [],
};

export const DEFAULT_CODEC: Record<EncoderMedia, string> = { video: "libx264", audio: "aac", subtitle: "mov_text" };

const SCHEMAS = Object.fromEntries(ENCODERS.map((e) => [e.codec, e]));

/** Guess the libavcodec codec id for encoders we have no schema for (hevc_nvenc → hevc, libvpx-vp9 → vp9). */
export function guessCodecId(codec: string): string {
  const c = codec.toLowerCase();
  if (/(^|_)(hevc|h265|x265)/.test(c)) return "hevc";
  if (/(^|_)(h264|x264|avc)/.test(c)) return "h264";
  if (c.includes("av1") || c.includes("aom") || c.includes("rav1e")) return "av1";
  if (c.includes("vp9")) return "vp9";
  if (c.includes("vp8") || c === "libvpx") return "vp8";
  if (c.includes("prores")) return "prores";
  if (c.includes("opus")) return "opus";
  if (c.includes("vorbis")) return "vorbis";
  if (c.includes("mp3")) return "mp3";
  if (c.includes("flac")) return "flac";
  if (c.includes("aac")) return "aac";
  if (c === "subrip") return "subrip";
  return c.replace(/^lib/, "").replace(/_(nvenc|qsv|amf|vaapi|videotoolbox|mf|v4l2m2m)$/, "");
}

const genericSchemas = new Map<string, EncoderSchema>();

export function getEncoderSchema(codec: string, media: EncoderMedia): EncoderSchema {
  const known = SCHEMAS[codec];
  if (known) return known;
  const key = `${media}|${codec}`;
  let s = genericSchemas.get(key);
  if (!s) {
    s = {
      codec,
      media,
      label: codec,
      codecId: guessCodecId(codec),
      params: media === "video" && /_nvenc$/.test(codec) ? [...GENERIC.video, NVENC_GPU_PARAM] : GENERIC[media],
      summary: (p) => (p.b ? String(p.b) : ""),
    };
    genericSchemas.set(key, s);
  }
  return s;
}

/** Params with schema defaults filled in (projects saved before a param existed lack it). */
export function withDefaults(schema: EncoderSchema, params: ParamValues): ParamValues {
  return { ...Object.fromEntries(schema.params.map((p) => [p.name, p.default])), ...params };
}

export function isParamVisible(p: ParamDef, values: ParamValues): boolean {
  return !p.visibleIf || p.visibleIf(values);
}
