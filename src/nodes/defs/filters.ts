// Hand-written definitions for the common filters. The long tail will come from a generic
// filter node generated from `ffmpeg -filters` / `ffmpeg -h filter=<name>`.
import type { AudioFormat, StreamFormat, VideoFormat } from "../../model/format";
import type { PadDef, ParamDef, ParamValues } from "../../model/types";
import { escapeFilterGraph, escapeOptionValue } from "../../serializer/escape";

export interface FilterParamDef extends ParamDef {
  /** Emitted without "key=" in declaration order (until the first empty positional). */
  positional?: boolean;
  /** Emit even when equal to the default. */
  always?: boolean;
  /** UI-only: drives `build`, never emitted as an option. */
  ui?: boolean;
  /**
   * Where the help popup finds this param in the ffmpeg docs. Default: the def's `ffName` and
   * the param's name (none for `ui` params). `false`: no ffmpeg option behind it.
   */
  doc?: { filter?: string; option: string } | false;
}

/** The ffmpeg filter and option a param's help comes from, if any. */
export function paramDocRef(def: Pick<FilterDef, "ffName">, p: FilterParamDef): { filter: string; option: string } | undefined {
  if (p.doc === false) return undefined;
  if (p.doc) return { filter: p.doc.filter ?? def.ffName, option: p.doc.option };
  return p.ui ? undefined : { filter: def.ffName, option: p.name };
}

export type FilterCategory =
  | "Geometry"
  | "Time"
  | "Color"
  | "Cleanup"
  | "Compose"
  | "Utility"
  | "GPU"
  | "Levels"
  | "EQ"
  | "Channels";

export interface FilterDef {
  id: string;
  /** The ffmpeg filter name (used for the availability check). */
  ffName: string;
  label: string;
  /** "av" = has both video and audio pads (concat). */
  media: "video" | "audio" | "av";
  category: FilterCategory;
  /** Extra search terms ("deinterlace", "letterbox", ...). */
  keywords?: string[];
  description: string;
  params: FilterParamDef[];
  inputs: (p: ParamValues) => PadDef[];
  outputs: (p: ParamValues) => PadDef[];
  /** Runs on the GPU: needs GPU-resident input frames and keeps them there. */
  gpu?: "cuda";
  /** Output formats from input formats; undefined entries mean "unknown". */
  transform?: (ins: (StreamFormat | undefined)[], p: ParamValues) => (StreamFormat | undefined)[];
  /**
   * Custom filter text (a short chain, or a filter name chosen by a param). `args(name, only)`
   * renders this def's (non-ui, visible) params under `name`, optionally only the listed ones.
   * `p` has defaults filled in.
   */
  build?: (p: ParamValues, args: (ffName: string, only?: string[]) => string) => string;
}

const vIn = (id = "in", label = "in"): PadDef => ({ id, label, type: { domain: "frames", media: "video" } });
const vOut = (id = "out", label = "out"): PadDef => ({ id, label, type: { domain: "frames", media: "video" } });
const aIn = (id = "in", label = "in"): PadDef => ({ id, label, type: { domain: "frames", media: "audio" } });
const aOut = (id = "out", label = "out"): PadDef => ({ id, label, type: { domain: "frames", media: "audio" } });

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || dflt));
const opts = (...vs: (string | [string, string])[]) => vs.map((v) => (typeof v === "string" ? { value: v } : { value: v[0], label: v[1] }));
/** Option value escaped for both filtergraph levels (for hand-built filter text). */
const esc = (v: string) => escapeFilterGraph(escapeOptionValue(v));

const asVideo = (f?: StreamFormat): VideoFormat => (f?.media === "video" ? f : { media: "video" });
const asAudio = (f?: StreamFormat): AudioFormat => (f?.media === "audio" ? f : { media: "audio" });

/** scale's -1/-n semantics: keep aspect ratio, rounded to a multiple of n. */
function scaleDim(target: number | undefined, other: number | undefined, inSelf?: number, inOther?: number) {
  if (target === undefined) return undefined;
  if (target > 0) return target;
  if (other === undefined || other <= 0 || !inSelf || !inOther) return undefined;
  const n = Math.abs(target) || 1;
  return Math.round((inSelf * other) / inOther / n) * n;
}

/** atempo is best kept within 0.5–2 per instance; chain instances for larger factors. */
export function atempoChain(factor: number): number[] {
  if (!Number.isFinite(factor) || factor <= 0) return [1];
  const out: number[] = [];
  let f = factor;
  while (f > 2) (out.push(2), (f /= 2));
  while (f < 0.5) (out.push(0.5), (f /= 0.5));
  out.push(Math.round(f * 10000) / 10000);
  return out;
}

const PIX_FMTS = ["yuv420p", "yuv420p10le", "yuv422p", "yuv422p10le", "yuv444p", "yuv444p10le", "nv12", "p010le", "rgb24", "gray"];
const COLOR_SPACES = opts(["bt709", "BT.709 (HD)"], ["bt601-6-625", "BT.601 PAL"], ["bt601-6-525", "BT.601 NTSC"], ["bt2020", "BT.2020"], ["smpte240m", "SMPTE 240M"]);
const FADE_CURVES = opts(["tri", "linear"], ["qsin", "quarter sine"], ["hsin", "half sine"], ["esin", "exponential sine"], ["log", "logarithmic"], ["exp", "exponential"], ["par", "parabola"], ["cub", "cubic"]);
const XFADE = ["fade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight", "wipeup", "wipedown", "slideleft", "slideright", "slideup", "slidedown", "circleopen", "circleclose", "radial", "smoothleft", "smoothright", "pixelize", "hblur", "distance"];

const PAN_PRESETS: Record<string, { text: string; channels?: number }> = {
  stereo: { text: "aformat=channel_layouts=stereo", channels: 2 },
  mono: { text: "aformat=channel_layouts=mono", channels: 1 },
  left: { text: "pan=mono|c0=c0", channels: 1 },
  right: { text: "pan=mono|c0=c1", channels: 1 },
  swap: { text: "pan=stereo|c0=c1|c1=c0", channels: 2 },
};

export const FILTERS: FilterDef[] = [
  // ------------------------------------------------------------ video: geometry
  {
    id: "scale",
    ffName: "scale",
    label: "Scale",
    media: "video",
    category: "Geometry",
    keywords: ["resize", "resolution", "downscale", "upscale"],
    description: "Resize video. -1 keeps the aspect ratio, -2 also keeps the size even.",
    params: [
      { name: "w", label: "Width", type: "string", default: "1920", positional: true, face: true },
      { name: "h", label: "Height", type: "string", default: "-2", positional: true, face: true },
      {
        name: "flags",
        label: "Algorithm",
        type: "enum",
        default: "",
        options: [{ value: "", label: "default (bicubic)" }, ...opts("bilinear", "bicubic", "lanczos", "spline", "neighbor")],
      },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const f = asVideo(i);
      const w = num(p.w);
      const h = num(p.h);
      return [{ ...f, width: scaleDim(w, h, f.width, f.height), height: scaleDim(h, w, f.height, f.width) }];
    },
  },
  {
    id: "crop",
    ffName: "crop",
    label: "Crop",
    media: "video",
    category: "Geometry",
    keywords: ["cut", "trim edges", "region"],
    description: "Crop to w×h at x,y (defaults to centered). Expressions like in_w-100 are allowed.",
    params: [
      { name: "w", label: "Width", type: "string", default: "in_w", positional: true, face: true },
      { name: "h", label: "Height", type: "string", default: "in_h", positional: true, face: true },
      { name: "x", label: "X", type: "string", default: "", positional: true },
      { name: "y", label: "Y", type: "string", default: "", positional: true },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const f = asVideo(i);
      const w = p.w === "in_w" ? f.width : num(p.w);
      const h = p.h === "in_h" ? f.height : num(p.h);
      return [{ ...f, width: w, height: h }];
    },
  },
  {
    id: "letterbox",
    ffName: "crop",
    label: "Remove letterbox",
    media: "video",
    category: "Geometry",
    keywords: ["letterbox", "black bars", "autocrop", "cropdetect", "detect", "crop"],
    description: "Detects black bars at the top and bottom (from frames spread over the file) and crops them away.",
    params: [
      { name: "top", label: "Top bar (px)", type: "int", default: 0, min: 0, face: true, doc: false },
      { name: "bottom", label: "Bottom bar (px)", type: "int", default: 0, min: 0, face: true, doc: false },
      { name: "samples", label: "Frames to sample", type: "int", default: 9, min: 1, max: 50, ui: true, description: "Detection: how many frames to grab." },
      { name: "startPct", label: "From (%)", type: "float", default: 10, min: 0, max: 100, step: 1, ui: true, description: "Detection: skip intros and logos before this point." },
      { name: "endPct", label: "To (%)", type: "float", default: 90, min: 0, max: 100, step: 1, ui: true, description: "Detection: skip credits after this point." },
      { name: "blackLevel", label: "Black level", type: "int", default: 10, min: 0, max: 255, ui: true, description: "Detection: gray value (0–255) up to which a pixel counts as black." },
      { name: "rowContentPct", label: "Row content (%)", type: "float", default: 5, min: 0, max: 100, step: 0.5, ui: true, description: "Detection: a row is picture when more than this share of its pixels is brighter than the black level." },
      { name: "darkMean", label: "Dark frame mean", type: "float", default: 30, min: 0, max: 255, step: 1, ui: true, description: "Detection: frames whose picture is darker than this on average (fades, night scenes) are skipped." },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    build: (p) => {
      const top = Math.max(0, Math.round(Number(p.top) || 0));
      const total = top + Math.max(0, Math.round(Number(p.bottom) || 0));
      return `crop=iw:${total ? `ih-${total}` : "ih"}:0:${top}`;
    },
    transform: ([i], p) => {
      const f = asVideo(i);
      const h = f.height === undefined ? undefined : f.height - (Number(p.top) || 0) - (Number(p.bottom) || 0);
      return [{ ...f, height: h }];
    },
  },
  {
    id: "transpose",
    ffName: "transpose",
    label: "Rotate 90°",
    media: "video",
    category: "Geometry",
    keywords: ["transpose", "rotate", "portrait", "orientation"],
    description: "Rotate by 90° (optionally flipped). Width and height are swapped.",
    params: [
      {
        name: "dir",
        label: "Direction",
        type: "enum",
        default: "clock",
        always: true,
        face: true,
        options: opts(["clock", "90° clockwise"], ["cclock", "90° counter-clockwise"], ["clock_flip", "90° clockwise + flip"], ["cclock_flip", "90° counter-clockwise + flip"]),
      },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i]) => {
      const f = asVideo(i);
      return [{ ...f, width: f.height, height: f.width }];
    },
  },
  {
    id: "flip",
    ffName: "hflip",
    label: "Flip / Mirror",
    media: "video",
    category: "Geometry",
    keywords: ["mirror", "hflip", "vflip", "upside down"],
    description: "Mirror horizontally (hflip), vertically (vflip) or both (= rotate 180°).",
    params: [
      {
        name: "dir",
        label: "Direction",
        type: "enum",
        default: "h",
        ui: true,
        face: true,
        options: opts(["h", "horizontal"], ["v", "vertical"], ["both", "both (rotate 180°)"]),
      },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    build: (p) => (p.dir === "v" ? "vflip" : p.dir === "both" ? "hflip,vflip" : "hflip"),
  },
  {
    id: "pad",
    ffName: "pad",
    label: "Pad / Letterbox",
    media: "video",
    category: "Geometry",
    keywords: ["letterbox", "pillarbox", "border", "black bars", "canvas"],
    description: "Place the video on a larger canvas (centered by default), e.g. 4:3 inside 1920×1080.",
    params: [
      { name: "w", label: "Width", type: "string", default: "1920", always: true, face: true },
      { name: "h", label: "Height", type: "string", default: "1080", always: true, face: true },
      { name: "x", label: "X", type: "string", default: "(ow-iw)/2", always: true },
      { name: "y", label: "Y", type: "string", default: "(oh-ih)/2", always: true },
      { name: "color", label: "Color", type: "string", default: "black" },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const f = asVideo(i);
      return [{ ...f, width: p.w === "iw" ? f.width : num(p.w), height: p.h === "ih" ? f.height : num(p.h) }];
    },
  },
  {
    id: "setsar",
    ffName: "setsar",
    label: "Set aspect ratio",
    media: "video",
    category: "Geometry",
    keywords: ["sar", "dar", "aspect", "anamorphic", "pixel aspect"],
    description: "Set the pixel (SAR) or display (DAR) aspect ratio flag without resizing.",
    params: [
      { name: "mode", label: "Set", type: "enum", default: "sar", ui: true, options: opts(["sar", "pixel aspect (SAR)"], ["dar", "display aspect (DAR)"]) },
      { name: "r", label: "Ratio", type: "string", default: "1", positional: true, face: true, description: "e.g. 1, 16/9, 4/3" },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    build: (p, args) => args(p.mode === "dar" ? "setdar" : "setsar"),
  },
  // ------------------------------------------------------------ video: time
  {
    id: "fps",
    ffName: "fps",
    label: "Frame rate",
    media: "video",
    category: "Time",
    keywords: ["framerate", "fps", "cfr"],
    description: "Convert to a constant frame rate by dropping/duplicating frames.",
    params: [{ name: "fps", label: "FPS", type: "string", default: "30", positional: true, face: true }],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const s = String(p.fps);
      const [n, d] = s.split("/").map(Number);
      const fps = d ? n / d : num(s);
      return [{ ...asVideo(i), fps: fps && Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : undefined }];
    },
  },
  {
    id: "trim",
    ffName: "trim",
    label: "Trim",
    media: "video",
    category: "Time",
    keywords: ["cut", "clip", "segment", "start", "end"],
    description: "Keep only a section (times in seconds or hh:mm:ss). Timestamps are reset to start at 0.",
    params: [
      { name: "start", label: "Start", type: "string", default: "", face: true, placeholder: "0" },
      { name: "duration", label: "Duration", type: "string", default: "", face: true, placeholder: "to end" },
      { name: "end", label: "End", type: "string", default: "", placeholder: "or end time" },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    build: (_p, args) => `${args("trim")},setpts=PTS-STARTPTS`,
  },
  {
    id: "speed",
    ffName: "setpts",
    label: "Speed",
    media: "video",
    category: "Time",
    keywords: ["setpts", "fast forward", "slow motion", "timelapse", "tempo"],
    description: "Play faster (2 = double speed) or slower (0.5) by retiming frames. Use Tempo for the audio.",
    params: [{ name: "factor", label: "Speed factor", type: "float", default: 2, min: 0.1, max: 10, step: 0.05, ui: true, face: true }],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    build: (p) => {
      const f = num(p.factor);
      return f && f > 0 && f !== 1 ? `setpts=PTS/${f}` : "setpts=PTS";
    },
  },
  {
    id: "fade",
    ffName: "fade",
    label: "Fade",
    media: "video",
    category: "Time",
    keywords: ["fade in", "fade out", "black", "transition"],
    description: "Fade in from / out to a color, starting at the given second.",
    params: [
      { name: "type", label: "Type", type: "enum", default: "in", always: true, face: true, options: opts(["in", "fade in"], ["out", "fade out"]) },
      { name: "start_time", label: "Start (s)", type: "string", default: "0", always: true },
      { name: "duration", label: "Duration (s)", type: "string", default: "1", always: true, face: true },
      { name: "color", label: "Color", type: "string", default: "black" },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
  },
  {
    id: "concat",
    ffName: "concat",
    label: "Concat",
    media: "av",
    category: "Time",
    keywords: ["join", "append", "merge clips", "sequence"],
    description: "Play segments one after another. All segments need the same resolution and channel layout.",
    params: [
      { name: "n", label: "Segments", type: "int", default: 2, min: 2, max: 16, always: true, face: true },
      { name: "v", label: "Video streams", type: "int", default: 1, min: 0, max: 2, always: true },
      { name: "a", label: "Audio streams", type: "int", default: 1, min: 0, max: 4, always: true },
    ],
    inputs: (p) => {
      const n = clampInt(p.n, 2, 16, 2);
      const v = clampInt(p.v, 0, 2, 0);
      const a = clampInt(p.a, 0, 4, 0);
      const pads: PadDef[] = [];
      for (let s = 0; s < n; s++) {
        for (let j = 0; j < v; j++) pads.push(vIn(`s${s}v${j}`, `seg ${s + 1} video${v > 1 ? ` ${j + 1}` : ""}`));
        for (let j = 0; j < a; j++) pads.push(aIn(`s${s}a${j}`, `seg ${s + 1} audio${a > 1 ? ` ${j + 1}` : ""}`));
      }
      return pads;
    },
    outputs: (p) => {
      const v = clampInt(p.v, 0, 2, 0);
      const a = clampInt(p.a, 0, 4, 0);
      return [
        ...Array.from({ length: v }, (_, j) => vOut(`v${j}`, v > 1 ? `video ${j + 1}` : "video")),
        ...Array.from({ length: a }, (_, j) => aOut(`a${j}`, a > 1 ? `audio ${j + 1}` : "audio")),
      ];
    },
    // the first segment's formats (ffmpeg requires the others to match)
    transform: (ins, p) => {
      const v = clampInt(p.v, 0, 2, 0);
      const a = clampInt(p.a, 0, 4, 0);
      return ins.slice(0, v + a);
    },
  },
  {
    id: "xfade",
    ffName: "xfade",
    label: "Crossfade",
    media: "video",
    category: "Time",
    keywords: ["transition", "dissolve", "wipe", "xfade"],
    description: "Transition from the first clip into the second, starting at Offset seconds of the first. Both need the same size and frame rate.",
    params: [
      { name: "transition", label: "Transition", type: "enum", default: "fade", always: true, face: true, options: opts(...XFADE) },
      { name: "duration", label: "Duration (s)", type: "string", default: "1", always: true },
      { name: "offset", label: "Offset (s)", type: "string", default: "5", always: true, face: true },
    ],
    inputs: () => [vIn("a", "from"), vIn("b", "to")],
    outputs: () => [vOut()],
    transform: ([a]) => [asVideo(a)],
  },
  // ------------------------------------------------------------ video: color
  {
    id: "format",
    ffName: "format",
    label: "Pixel format",
    media: "video",
    category: "Color",
    keywords: ["pix_fmt", "10-bit", "chroma", "convert"],
    description: "Convert to an explicit pixel format (e.g. yuv420p10le before a 10-bit encoder).",
    params: [{ name: "pix_fmts", label: "Pixel format", type: "enum", default: "yuv420p", positional: true, face: true, options: opts(...PIX_FMTS) }],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => [{ ...asVideo(i), pix_fmt: String(p.pix_fmts) }],
  },
  {
    id: "eq",
    ffName: "eq",
    label: "Brightness / Contrast",
    media: "video",
    category: "Color",
    keywords: ["eq", "saturation", "gamma", "color correction", "grade"],
    description: "Adjust brightness, contrast, saturation and gamma.",
    params: [
      { name: "brightness", label: "Brightness", type: "float", default: 0, min: -1, max: 1, step: 0.01, face: true },
      { name: "contrast", label: "Contrast", type: "float", default: 1, min: 0, max: 3, step: 0.01, face: true },
      { name: "saturation", label: "Saturation", type: "float", default: 1, min: 0, max: 3, step: 0.01 },
      { name: "gamma", label: "Gamma", type: "float", default: 1, min: 0.1, max: 4, step: 0.01 },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
  },
  {
    id: "lut3d",
    ffName: "lut3d",
    label: "LUT (3D)",
    media: "video",
    category: "Color",
    keywords: ["cube", "lut", "look", "grade", "log"],
    description: "Apply a 3D LUT file (.cube, .3dl, .dat, .m3d, .csp).",
    params: [
      { name: "file", label: "LUT file", type: "file", default: "", face: true, fileFilters: [{ name: "3D LUT", extensions: ["cube", "3dl", "dat", "m3d", "csp"] }] },
      { name: "interp", label: "Interpolation", type: "enum", default: "tetrahedral", options: opts("nearest", "trilinear", "tetrahedral", "pyramid", "prism") },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
  },
  {
    id: "colorspace",
    ffName: "colorspace",
    label: "Color space",
    media: "video",
    category: "Color",
    keywords: ["bt709", "bt601", "bt2020", "matrix", "primaries", "colour"],
    description: "Convert color matrix, primaries and transfer (e.g. SD BT.601 → HD BT.709). Set Input if the source isn't tagged.",
    params: [
      { name: "all", label: "Output", type: "enum", default: "bt709", always: true, face: true, options: COLOR_SPACES },
      { name: "iall", label: "Input", type: "enum", default: "", options: [{ value: "", label: "from stream tags" }, ...COLOR_SPACES] },
      {
        name: "format",
        label: "Pixel format",
        type: "enum",
        default: "",
        options: [{ value: "", label: "keep" }, ...opts("yuv420p", "yuv420p10", "yuv422p", "yuv422p10", "yuv444p", "yuv444p10")],
      },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const f = asVideo(i);
      const fmt = String(p.format ?? "");
      return [{ ...f, pix_fmt: fmt ? (/10$/.test(fmt) ? `${fmt}le` : fmt) : f.pix_fmt }];
    },
  },
  // ------------------------------------------------------------ video: cleanup
  {
    id: "bwdif",
    ffName: "bwdif",
    label: "Deinterlace",
    media: "video",
    category: "Cleanup",
    keywords: ["bwdif", "yadif", "interlaced", "combing", "fields"],
    description: "Deinterlace (bwdif). One frame per frame, or one per field (double frame rate, smoother motion).",
    params: [
      {
        name: "mode",
        label: "Output",
        type: "enum",
        default: "send_frame",
        always: true,
        face: true,
        options: opts(["send_frame", "frame per frame"], ["send_field", "frame per field (2× fps)"]),
      },
      { name: "parity", label: "Field order", type: "enum", default: "auto", options: opts("auto", ["tff", "top field first"], ["bff", "bottom field first"]) },
      { name: "deint", label: "Frames", type: "enum", default: "all", options: opts(["all", "all"], ["interlaced", "only marked interlaced"]) },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const f = asVideo(i);
      return [p.mode === "send_field" && f.fps ? { ...f, fps: f.fps * 2 } : f];
    },
  },
  {
    id: "hqdn3d",
    ffName: "hqdn3d",
    label: "Denoise",
    media: "video",
    category: "Cleanup",
    keywords: ["hqdn3d", "noise", "grain", "clean"],
    description: "Spatial + temporal denoiser (hqdn3d). Fast; strong settings smear fine detail.",
    params: [
      {
        name: "strength",
        label: "Strength",
        type: "enum",
        default: "medium",
        ui: true,
        face: true,
        options: opts("light", "medium", "strong", "custom"),
      },
      { name: "luma_spatial", label: "Luma spatial", type: "float", default: 4, min: 0, max: 20, step: 0.5, always: true, visibleIf: (v) => v.strength === "custom" },
      { name: "chroma_spatial", label: "Chroma spatial", type: "float", default: 3, min: 0, max: 20, step: 0.5, always: true, visibleIf: (v) => v.strength === "custom" },
      { name: "luma_tmp", label: "Luma temporal", type: "float", default: 6, min: 0, max: 30, step: 0.5, always: true, visibleIf: (v) => v.strength === "custom" },
      { name: "chroma_tmp", label: "Chroma temporal", type: "float", default: 4.5, min: 0, max: 30, step: 0.5, always: true, visibleIf: (v) => v.strength === "custom" },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    build: (p, args) => {
      const presets: Record<string, string> = { light: "2:1.5:3:2.25", medium: "4:3:6:4.5", strong: "8:6:12:9" };
      const preset = presets[String(p.strength)];
      return preset ? `hqdn3d=${escapeFilterGraph(preset)}` : args("hqdn3d");
    },
  },
  {
    id: "unsharp",
    ffName: "unsharp",
    label: "Sharpen",
    media: "video",
    category: "Cleanup",
    keywords: ["unsharp", "sharpness", "blur", "detail"],
    description: "Unsharp mask. Positive amount sharpens, negative blurs.",
    params: [
      { name: "amount", label: "Amount", type: "float", default: 1, min: -2, max: 5, step: 0.1, ui: true, face: true, doc: { option: "luma_amount" } },
      { name: "size", label: "Radius", type: "enum", default: "5", ui: true, options: opts(["3", "small (3×3)"], ["5", "medium (5×5)"], ["7", "large (7×7)"], ["9", "very large (9×9)"]), doc: { option: "luma_msize_x" } },
      { name: "chroma", label: "Also chroma", type: "bool", default: false, ui: true },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    build: (p) => {
      const s = String(p.size);
      const a = Number(p.amount);
      const chroma = p.chroma ? `:chroma_msize_x=${s}:chroma_msize_y=${s}:chroma_amount=${a}` : "";
      return `unsharp=luma_msize_x=${s}:luma_msize_y=${s}:luma_amount=${a}${chroma}`;
    },
  },
  {
    id: "deband",
    ffName: "deband",
    label: "Deband",
    media: "video",
    category: "Cleanup",
    keywords: ["banding", "gradient", "posterization"],
    description: "Remove banding in smooth gradients (sky, dark scenes). Useful before 8-bit encodes of 10-bit sources.",
    params: [
      { name: "threshold", label: "Threshold", type: "float", default: 0.02, min: 0.003, max: 0.5, step: 0.001, ui: true, face: true, doc: { option: "1thr" } },
      { name: "range", label: "Range (px)", type: "int", default: 16, min: 1, max: 64, ui: true, doc: { option: "range" } },
      { name: "blur", label: "Blur", type: "bool", default: true, ui: true, doc: { option: "blur" } },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    build: (p) => {
      const t = Number(p.threshold);
      const parts = [`1thr=${t}`, `2thr=${t}`, `3thr=${t}`, `4thr=${t}`, `range=${Number(p.range)}`];
      if (p.blur === false) parts.push("blur=0");
      return `deband=${parts.join(":")}`;
    },
  },
  // ------------------------------------------------------------ video: compose
  {
    id: "overlay",
    ffName: "overlay",
    label: "Overlay",
    media: "video",
    category: "Compose",
    keywords: ["watermark", "logo", "picture in picture", "pip"],
    description: "Draw the second input on top of the first at x,y.",
    params: [
      { name: "x", label: "X", type: "string", default: "0", positional: true, face: true },
      { name: "y", label: "Y", type: "string", default: "0", positional: true, face: true },
    ],
    inputs: () => [vIn("main", "main"), vIn("overlay", "overlay")],
    outputs: () => [vOut()],
    transform: ([main]) => [asVideo(main)],
  },
  {
    id: "stack",
    ffName: "hstack",
    label: "Stack",
    media: "video",
    category: "Compose",
    keywords: ["hstack", "vstack", "side by side", "split screen", "compare", "grid"],
    description: "Place videos side by side or on top of each other. Side by side needs equal heights; stacked needs equal widths.",
    params: [
      { name: "dir", label: "Direction", type: "enum", default: "h", ui: true, face: true, options: opts(["h", "side by side"], ["v", "on top of each other"]) },
      { name: "inputs", label: "Inputs", type: "int", default: 2, min: 2, max: 8, always: true, face: true },
      { name: "shortest", label: "End with shortest", type: "bool", default: false },
    ],
    inputs: (p) => Array.from({ length: clampInt(p.inputs, 2, 8, 2) }, (_, i) => vIn(`in${i}`, `in ${i + 1}`)),
    outputs: () => [vOut()],
    build: (p, args) => args(p.dir === "v" ? "vstack" : "hstack"),
    transform: (ins, p) => {
      const fs = ins.map(asVideo);
      const sum = (k: "width" | "height") => (fs.every((f) => f[k]) ? fs.reduce((s, f) => s + f[k]!, 0) : undefined);
      return [p.dir === "v" ? { ...fs[0], height: sum("height") } : { ...fs[0], width: sum("width") }];
    },
  },
  {
    id: "drawtext",
    ffName: "drawtext",
    label: "Text",
    media: "video",
    category: "Compose",
    keywords: ["drawtext", "title", "caption", "watermark", "timecode", "label"],
    description: "Draw text. %{pts\\:hms} shows the timestamp. Without a font file the system default font is used (needs fontconfig).",
    params: [
      { name: "text", label: "Text", type: "string", default: "Hello", always: true, face: true },
      { name: "fontfile", label: "Font file", type: "file", default: "", placeholder: "system default", fileFilters: [{ name: "Fonts", extensions: ["ttf", "otf", "ttc"] }] },
      { name: "fontsize", label: "Size", type: "string", default: "48", always: true },
      { name: "fontcolor", label: "Color", type: "string", default: "white", always: true },
      { name: "x", label: "X", type: "string", default: "(w-text_w)/2", always: true },
      { name: "y", label: "Y", type: "string", default: "h-text_h-40", always: true },
      { name: "borderw", label: "Outline (px)", type: "int", default: 0, min: 0, max: 20 },
      { name: "box", label: "Background box", type: "bool", default: false },
      { name: "boxcolor", label: "Box color", type: "string", default: "black@0.5", always: true, visibleIf: (v) => v.box === true },
      { name: "boxborderw", label: "Box padding", type: "string", default: "10", always: true, visibleIf: (v) => v.box === true },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
  },
  {
    id: "subtitles",
    ffName: "subtitles",
    label: "Burn in subtitles",
    media: "video",
    category: "Compose",
    keywords: ["hardsub", "srt", "ass", "captions", "burn"],
    description: "Render a subtitle file (or a subtitle stream of a media file) into the picture (needs libass).",
    params: [
      { name: "filename", label: "Subtitle file", type: "file", default: "", face: true, fileFilters: [{ name: "Subtitles", extensions: ["srt", "ass", "ssa", "vtt", "mkv", "mp4"] }] },
      { name: "si", label: "Stream index", type: "int", default: -1, min: -1, max: 99, description: "Subtitle stream inside a media file; -1 = first" },
      { name: "force_style", label: "Style override", type: "string", default: "", placeholder: "FontSize=24,Outline=2" },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
  },
  // ------------------------------------------------------------ video: utility
  {
    id: "thumbnail",
    ffName: "thumbnail",
    label: "Pick thumbnail",
    media: "video",
    category: "Utility",
    keywords: ["poster", "preview", "frame", "still", "representative"],
    description: "Pick the most representative frame of every N frames. Combine with -frames:v 1 for a poster image.",
    params: [{ name: "n", label: "Batch size", type: "int", default: 100, min: 2, max: 1000, face: true }],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
  },
  // ------------------------------------------------------------ video: GPU
  {
    id: "scale_cuda",
    ffName: "scale_cuda",
    label: "Scale (CUDA)",
    media: "video",
    category: "GPU",
    keywords: ["resize", "nvidia", "gpu", "cuda", "p010"],
    gpu: "cuda",
    description:
      "Resize and/or convert the pixel format on an NVIDIA GPU. Needs an Input with HW decode = cuda; frames stay in GPU memory for nvenc.",
    params: [
      { name: "w", label: "Width", type: "string", default: "1920", positional: true, face: true },
      { name: "h", label: "Height", type: "string", default: "-2", positional: true, face: true },
      {
        name: "format",
        label: "Pixel format",
        type: "enum",
        default: "",
        options: [{ value: "", label: "keep" }, ...opts("nv12", "yuv420p", ["p010le", "p010le (10-bit)"], "yuv444p")],
      },
      {
        name: "interp_algo",
        label: "Algorithm",
        type: "enum",
        default: "",
        options: [{ value: "", label: "default (bilinear)" }, ...opts("nearest", "bilinear", "bicubic", "lanczos")],
      },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const f = asVideo(i);
      const w = num(p.w);
      const h = num(p.h);
      return [
        {
          ...f,
          width: scaleDim(w, h, f.width, f.height),
          height: scaleDim(h, w, f.height, f.width),
          pix_fmt: p.format ? String(p.format) : f.pix_fmt,
          hw: "cuda",
        },
      ];
    },
  },
  {
    id: "bwdif_cuda",
    ffName: "bwdif_cuda",
    label: "Deinterlace (CUDA)",
    media: "video",
    category: "GPU",
    keywords: ["bwdif", "yadif", "interlaced", "combing", "fields", "nvidia", "gpu", "cuda"],
    gpu: "cuda",
    description: "Deinterlace (bwdif) on an NVIDIA GPU. One frame per frame, or one per field (double frame rate).",
    params: [
      {
        name: "mode",
        label: "Output",
        type: "enum",
        default: "send_frame",
        always: true,
        face: true,
        options: opts(["send_frame", "frame per frame"], ["send_field", "frame per field (2× fps)"]),
      },
      { name: "parity", label: "Field order", type: "enum", default: "auto", options: opts("auto", ["tff", "top field first"], ["bff", "bottom field first"]) },
      { name: "deint", label: "Frames", type: "enum", default: "all", options: opts(["all", "all"], ["interlaced", "only marked interlaced"]) },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const f = asVideo(i);
      return [{ ...f, fps: p.mode === "send_field" && f.fps ? f.fps * 2 : f.fps, hw: "cuda" }];
    },
  },
  {
    id: "transpose_cuda",
    ffName: "transpose_cuda",
    label: "Rotate / Flip (CUDA)",
    media: "video",
    category: "GPU",
    keywords: ["transpose", "rotate", "portrait", "orientation", "flip", "mirror", "180", "nvidia", "gpu", "cuda"],
    gpu: "cuda",
    description: "Rotate by 90° or 180°, or mirror, on an NVIDIA GPU. 90° turns swap width and height.",
    params: [
      {
        name: "dir",
        label: "Direction",
        type: "enum",
        default: "clock",
        always: true,
        face: true,
        options: opts(
          ["clock", "90° clockwise"],
          ["cclock", "90° counter-clockwise"],
          ["reversal", "180°"],
          ["hflip", "mirror horizontally"],
          ["vflip", "mirror vertically"],
          ["clock_flip", "90° clockwise + flip"],
          ["cclock_flip", "90° counter-clockwise + flip"],
        ),
      },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const f = asVideo(i);
      const turn = !["reversal", "hflip", "vflip"].includes(String(p.dir));
      return [{ ...f, width: turn ? f.height : f.width, height: turn ? f.width : f.height, hw: "cuda" }];
    },
  },
  {
    id: "pad_cuda",
    ffName: "pad_cuda",
    label: "Pad (CUDA)",
    media: "video",
    category: "GPU",
    keywords: ["letterbox", "pillarbox", "border", "black bars", "canvas", "pad", "nvidia", "gpu", "cuda"],
    gpu: "cuda",
    description: "Place the video on a larger canvas (centered by default) on an NVIDIA GPU, e.g. 4:3 inside 1920×1080.",
    params: [
      { name: "w", label: "Width", type: "string", default: "1920", always: true, face: true },
      { name: "h", label: "Height", type: "string", default: "1080", always: true, face: true },
      { name: "x", label: "X", type: "string", default: "(ow-iw)/2", always: true },
      { name: "y", label: "Y", type: "string", default: "(oh-ih)/2", always: true },
      { name: "color", label: "Color", type: "string", default: "black" },
    ],
    inputs: () => [vIn()],
    outputs: () => [vOut()],
    transform: ([i], p) => {
      const f = asVideo(i);
      return [{ ...f, width: p.w === "iw" ? f.width : num(p.w), height: p.h === "ih" ? f.height : num(p.h), hw: "cuda" }];
    },
  },
  // ------------------------------------------------------------ audio: levels
  {
    id: "volume",
    ffName: "volume",
    label: "Volume",
    media: "audio",
    category: "Levels",
    keywords: ["gain", "louder", "quieter", "db"],
    description: "Change loudness. Accepts a factor (0.5) or decibels (-6dB).",
    params: [{ name: "volume", label: "Volume", type: "string", default: "1.0", positional: true, face: true }],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i]) => [asAudio(i)],
  },
  {
    id: "loudnorm",
    ffName: "loudnorm",
    label: "Loudness normalize",
    media: "audio",
    category: "Levels",
    keywords: ["ebu r128", "lufs", "normalize", "broadcast"],
    description: "EBU R128 loudness normalization. Note: outputs 192 kHz; set a sample rate on the encoder.",
    params: [
      { name: "I", label: "Integrated (LUFS)", type: "float", default: -24, min: -70, max: -5, step: 0.5, face: true },
      { name: "TP", label: "True peak (dBTP)", type: "float", default: -2, min: -9, max: 0, step: 0.1 },
      { name: "LRA", label: "Loudness range", type: "float", default: 7, min: 1, max: 50, step: 0.5 },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i]) => [{ ...asAudio(i), sample_rate: 192000 }],
  },
  {
    id: "dynaudnorm",
    ffName: "dynaudnorm",
    label: "Dynamic normalize",
    media: "audio",
    category: "Levels",
    keywords: ["normalize", "leveler", "dialog", "quiet parts"],
    description: "Evens out loud and quiet passages over time (single pass, no lookahead file needed).",
    params: [
      { name: "framelen", label: "Frame length (ms)", type: "int", default: 500, min: 10, max: 8000, step: 10 },
      { name: "maxgain", label: "Max gain", type: "float", default: 10, min: 1, max: 100, step: 0.5, face: true },
      { name: "peak", label: "Target peak", type: "float", default: 0.95, min: 0, max: 1, step: 0.01 },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i]) => [asAudio(i)],
  },
  {
    id: "acompressor",
    ffName: "acompressor",
    label: "Compressor",
    media: "audio",
    category: "Levels",
    keywords: ["dynamics", "compress", "punch", "dialog"],
    description: "Reduce dynamic range above the threshold. Values accept dB (e.g. -18dB).",
    params: [
      { name: "threshold", label: "Threshold", type: "string", default: "-18dB", always: true, face: true },
      { name: "ratio", label: "Ratio", type: "float", default: 2, min: 1, max: 20, step: 0.5, face: true },
      { name: "attack", label: "Attack (ms)", type: "float", default: 20, min: 0.01, max: 2000, step: 1 },
      { name: "release", label: "Release (ms)", type: "float", default: 250, min: 0.01, max: 9000, step: 10 },
      { name: "makeup", label: "Makeup gain", type: "string", default: "0dB" },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i]) => [asAudio(i)],
  },
  {
    id: "alimiter",
    ffName: "alimiter",
    label: "Limiter",
    media: "audio",
    category: "Levels",
    keywords: ["peak", "clipping", "brickwall", "ceiling"],
    description: "Brickwall limiter: keeps peaks below the limit.",
    params: [
      { name: "limit", label: "Limit", type: "string", default: "-1dB", always: true, face: true },
      { name: "release", label: "Release (ms)", type: "float", default: 50, min: 1, max: 8000, step: 1 },
      { name: "level", label: "Auto level (normalize to 0 dB)", type: "bool", default: false, always: true },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i]) => [asAudio(i)],
  },
  // ------------------------------------------------------------ audio: EQ & cleanup
  {
    id: "passfilter",
    ffName: "highpass",
    label: "High-pass / Low-pass",
    media: "audio",
    category: "EQ",
    keywords: ["highpass", "lowpass", "rumble", "hiss", "cut", "filter"],
    description: "Remove frequencies below (high-pass, e.g. 80 Hz rumble) or above (low-pass) the cutoff.",
    params: [
      { name: "type", label: "Type", type: "enum", default: "highpass", ui: true, face: true, options: opts(["highpass", "high-pass (cut lows)"], ["lowpass", "low-pass (cut highs)"]) },
      { name: "frequency", label: "Cutoff (Hz)", type: "float", default: 80, min: 10, max: 20000, step: 10, always: true, face: true },
      { name: "poles", label: "Slope", type: "enum", default: "2", options: opts(["1", "6 dB/oct"], ["2", "12 dB/oct"]) },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    build: (p, args) => args(p.type === "lowpass" ? "lowpass" : "highpass"),
    transform: ([i]) => [asAudio(i)],
  },
  {
    id: "equalizer",
    ffName: "equalizer",
    label: "EQ band",
    media: "audio",
    category: "EQ",
    keywords: ["equalizer", "boost", "cut", "peak", "parametric"],
    description: "Boost or cut one frequency band (peaking EQ). Chain several for a parametric EQ.",
    params: [
      { name: "frequency", label: "Frequency (Hz)", type: "float", default: 1000, min: 20, max: 20000, step: 10, always: true, face: true },
      { name: "t", label: "Width unit", type: "enum", default: "q", options: opts(["q", "Q factor"], ["o", "octaves"], ["h", "Hz"]) },
      { name: "w", label: "Width", type: "float", default: 1, min: 0.1, max: 10, step: 0.1, always: true },
      { name: "gain", label: "Gain (dB)", type: "float", default: 3, min: -30, max: 30, step: 0.5, always: true, face: true },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i]) => [asAudio(i)],
  },
  {
    id: "afftdn",
    ffName: "afftdn",
    label: "Denoise",
    media: "audio",
    category: "Cleanup",
    keywords: ["noise", "hiss", "hum", "clean", "fft"],
    description: "FFT noise reduction for steady background noise (hiss, fans).",
    params: [
      { name: "noise_reduction", label: "Reduction (dB)", type: "float", default: 12, min: 0.01, max: 97, step: 0.5, face: true },
      { name: "noise_floor", label: "Noise floor (dB)", type: "float", default: -50, min: -80, max: -20, step: 1 },
      { name: "track_noise", label: "Track noise", type: "bool", default: false },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i]) => [asAudio(i)],
  },
  // ------------------------------------------------------------ audio: time
  {
    id: "atrim",
    ffName: "atrim",
    label: "Trim",
    media: "audio",
    category: "Time",
    keywords: ["cut", "clip", "segment", "start", "end"],
    description: "Keep only a section (seconds or hh:mm:ss). Timestamps are reset to start at 0.",
    params: [
      { name: "start", label: "Start", type: "string", default: "", face: true, placeholder: "0" },
      { name: "duration", label: "Duration", type: "string", default: "", face: true, placeholder: "to end" },
      { name: "end", label: "End", type: "string", default: "", placeholder: "or end time" },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    build: (_p, args) => `${args("atrim")},asetpts=PTS-STARTPTS`,
    transform: ([i]) => [asAudio(i)],
  },
  {
    id: "afade",
    ffName: "afade",
    label: "Fade",
    media: "audio",
    category: "Time",
    keywords: ["fade in", "fade out", "transition"],
    description: "Fade audio in or out, starting at the given second.",
    params: [
      { name: "type", label: "Type", type: "enum", default: "in", always: true, face: true, options: opts(["in", "fade in"], ["out", "fade out"]) },
      { name: "start_time", label: "Start (s)", type: "string", default: "0", always: true },
      { name: "duration", label: "Duration (s)", type: "string", default: "1", always: true, face: true },
      { name: "curve", label: "Curve", type: "enum", default: "tri", options: FADE_CURVES },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i]) => [asAudio(i)],
  },
  {
    id: "acrossfade",
    ffName: "acrossfade",
    label: "Crossfade",
    media: "audio",
    category: "Time",
    keywords: ["transition", "blend", "join"],
    description: "Join two clips, fading the end of the first into the start of the second.",
    params: [
      { name: "d", label: "Duration (s)", type: "string", default: "1", always: true, face: true },
      { name: "c1", label: "Fade-out curve", type: "enum", default: "tri", options: FADE_CURVES, doc: { option: "curve1" } },
      { name: "c2", label: "Fade-in curve", type: "enum", default: "tri", options: FADE_CURVES, doc: { option: "curve2" } },
    ],
    inputs: () => [aIn("a", "from"), aIn("b", "to")],
    outputs: () => [aOut()],
    transform: ([a]) => [asAudio(a)],
  },
  {
    id: "atempo",
    ffName: "atempo",
    label: "Tempo",
    media: "audio",
    category: "Time",
    keywords: ["speed", "faster", "slower", "pitch", "timestretch"],
    description: "Change speed without changing pitch (pair with Speed for video). Large factors are chained automatically.",
    params: [{ name: "tempo", label: "Speed factor", type: "float", default: 2, min: 0.1, max: 10, step: 0.05, ui: true, face: true }],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    build: (p) => atempoChain(Number(p.tempo)).map((f) => `atempo=${f}`).join(","),
    transform: ([i]) => [asAudio(i)],
  },
  {
    id: "adelay",
    ffName: "adelay",
    label: "Delay",
    media: "audio",
    category: "Time",
    keywords: ["sync", "offset", "lip sync", "shift"],
    description: "Delay all channels by the given milliseconds (fix audio that is ahead of the video).",
    params: [{ name: "ms", label: "Delay (ms)", type: "int", default: 500, min: 0, max: 10000, step: 10, ui: true, face: true, doc: { option: "delays" } }],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    build: (p) => `adelay=delays=${Math.max(0, Math.round(Number(p.ms) || 0))}:all=1`,
    transform: ([i]) => [asAudio(i)],
  },
  {
    id: "apad",
    ffName: "apad",
    label: "Pad with silence",
    media: "audio",
    category: "Time",
    keywords: ["silence", "extend", "length", "shortest"],
    description: "Append silence. With no target length it pads forever: use it together with Output → shortest.",
    params: [
      { name: "mode", label: "Mode", type: "enum", default: "pad", ui: true, face: true, options: opts(["pad", "add duration"], ["whole", "pad up to total length"]) },
      { name: "pad_dur", label: "Silence (s)", type: "string", default: "1", always: true, visibleIf: (v) => v.mode !== "whole" },
      { name: "whole_dur", label: "Total length (s)", type: "string", default: "", placeholder: "forever", visibleIf: (v) => v.mode === "whole" },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i]) => [asAudio(i)],
  },
  // ------------------------------------------------------------ audio: channels & mixing
  {
    id: "pan",
    ffName: "pan",
    label: "Channels / Downmix",
    media: "audio",
    category: "Channels",
    keywords: ["downmix", "5.1", "stereo", "mono", "pan", "swap", "left", "right"],
    description: "Downmix surround to stereo/mono, take one channel, swap L/R, or write a custom pan expression.",
    params: [
      {
        name: "preset",
        label: "Action",
        type: "enum",
        default: "stereo",
        ui: true,
        face: true,
        options: opts(["stereo", "downmix to stereo"], ["mono", "downmix to mono"], ["left", "left channel only (mono)"], ["right", "right channel only (mono)"], ["swap", "swap left/right"], ["custom", "custom pan…"]),
      },
      { name: "expr", label: "Pan expression", type: "string", default: "stereo|c0=c0|c1=c1", ui: true, visibleIf: (v) => v.preset === "custom" },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    build: (p) => PAN_PRESETS[String(p.preset)]?.text ?? `pan=${esc(String(p.expr))}`,
    transform: ([i], p) => {
      const ch = PAN_PRESETS[String(p.preset)]?.channels;
      return [{ ...asAudio(i), channels: ch ?? asAudio(i).channels }];
    },
  },
  {
    id: "amerge",
    ffName: "amerge",
    label: "Merge channels",
    media: "audio",
    category: "Channels",
    keywords: ["combine", "multichannel", "stereo from mono", "join channels"],
    description: "Combine several inputs into one multichannel stream (e.g. two mono tracks → stereo).",
    params: [{ name: "inputs", label: "Inputs", type: "int", default: 2, min: 2, max: 8, always: true, face: true }],
    inputs: (p) => Array.from({ length: clampInt(p.inputs, 2, 8, 2) }, (_, i) => aIn(`in${i}`, `in ${i + 1}`)),
    outputs: () => [aOut()],
    transform: (ins) => {
      const fs = ins.map(asAudio);
      const ch = fs.every((f) => f.channels) ? fs.reduce((s, f) => s + f.channels!, 0) : undefined;
      return [{ ...fs[0], channels: ch }];
    },
  },
  {
    id: "amix",
    ffName: "amix",
    label: "Mix",
    media: "audio",
    category: "Channels",
    keywords: ["combine", "blend", "music", "voiceover", "sum"],
    description: "Mix several audio inputs into one.",
    params: [
      { name: "inputs", label: "Inputs", type: "int", default: 2, min: 2, max: 16, always: true, face: true },
      { name: "duration", label: "Duration", type: "enum", default: "longest", options: opts("longest", "shortest", "first") },
      { name: "weights", label: "Weights", type: "string", default: "", placeholder: "e.g. 1 0.3" },
      { name: "normalize", label: "Normalize", type: "bool", default: true },
    ],
    inputs: (p) => Array.from({ length: clampInt(p.inputs, 2, 16, 2) }, (_, i) => aIn(`in${i}`, `in ${i + 1}`)),
    outputs: () => [aOut()],
    transform: (ins) => [asAudio(ins.find(Boolean))],
  },
  {
    id: "aformat",
    ffName: "aformat",
    label: "Audio format",
    media: "audio",
    category: "Channels",
    keywords: ["channel layout", "sample format", "sample rate", "convert"],
    description: "Force channel layout, sample format and/or sample rate (ffmpeg converts automatically).",
    params: [
      { name: "channel_layouts", label: "Channel layout", type: "enum", default: "", options: [{ value: "", label: "keep" }, ...opts("mono", "stereo", "5.1", "7.1")] },
      { name: "sample_fmts", label: "Sample format", type: "enum", default: "", options: [{ value: "", label: "keep" }, ...opts("s16", "s32", "flt", "fltp", "s16p")] },
      { name: "sample_rates", label: "Sample rate", type: "enum", default: "", options: [{ value: "", label: "keep" }, ...opts("44100", "48000", "96000")] },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i], p) => {
      const f = asAudio(i);
      const layoutCh: Record<string, number> = { mono: 1, stereo: 2, "5.1": 6, "7.1": 8 };
      return [{ ...f, channels: layoutCh[String(p.channel_layouts)] ?? f.channels, sample_rate: num(p.sample_rates) ?? f.sample_rate }];
    },
  },
  {
    id: "aresample",
    ffName: "aresample",
    label: "Resample",
    media: "audio",
    category: "Channels",
    keywords: ["sample rate", "48k", "44.1k", "sync", "drift"],
    description: "Resample audio to a new sample rate. Sync drift stretches/squeezes audio to follow timestamps.",
    params: [
      {
        name: "sample_rate",
        label: "Sample rate",
        type: "enum",
        default: "48000",
        positional: true,
        face: true,
        options: opts("8000", "16000", "22050", "32000", "44100", "48000", "96000"),
        // resampler options are in the ffmpeg-resampler manual, not in filters.texi
        doc: false,
      },
      { name: "async", label: "Fix sync drift", type: "bool", default: false, doc: false },
    ],
    inputs: () => [aIn()],
    outputs: () => [aOut()],
    transform: ([i], p) => [{ ...asAudio(i), sample_rate: num(p.sample_rate) }],
  },
];

export const FILTERS_BY_ID: Record<string, FilterDef> = Object.fromEntries(FILTERS.map((f) => [f.id, f]));

export function defaultParams(params: ParamDef[]): ParamValues {
  return Object.fromEntries(params.map((p) => [p.name, p.default]));
}
