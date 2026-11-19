// Core data model shared by the editor, serializer and validator.

export type Media = "video" | "audio" | "subtitle" | "data" | "attachment";
/** frames = decoded (what filters consume/produce); packets = encoded (what encoders produce, muxers consume). */
export type Domain = "frames" | "packets" | "params";

export interface PadType {
  domain: Domain;
  /** "any" is only used by muxer slots, which accept packets of every media type. */
  media: Media | "any";
}

export interface PadDef {
  id: string;
  label: string;
  type: PadType;
  /** Short format hint shown next to the pad (e.g. "h264 1920×1080"). */
  hint?: string;
  /** Small icon next to the label; "packets" marks an Input's stream-copy pads. */
  icon?: "packets";
}

export type ParamValue = string | number | boolean;
export type ParamValues = Record<string, ParamValue>;

/** "file" is a path string with a Browse… button; filters escape it for the filtergraph. */
export type ParamType = "int" | "float" | "string" | "bool" | "enum" | "file";

export interface ParamDef {
  name: string;
  label?: string;
  type: ParamType;
  default: ParamValue;
  options?: { value: string; label?: string }[];
  min?: number;
  max?: number;
  step?: number;
  description?: string;
  /** Hidden (and not serialized) unless this returns true. */
  visibleIf?: (values: ParamValues) => boolean;
  /** Shown on the node face, not only in the inspector. */
  face?: boolean;
  /** For type "file": open-dialog filters. */
  fileFilters?: { name: string; extensions: string[] }[];
  /** Placeholder text for string/file inputs. */
  placeholder?: string;
}

export interface KeyValue {
  key: string;
  value: string;
}

// ---------------------------------------------------------------- ffprobe

export interface StreamInfo {
  index: number;
  codec_type: Media;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  /** ffprobe field order: progressive, tt, bb, tb, bt. */
  field_order?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  duration?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

export interface ProbeResult {
  streams: StreamInfo[];
  format: { filename?: string; format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> };
}

// ---------------------------------------------------------------- node data

export interface InputOptions {
  ss: string;
  t: string;
  hwaccel: string;
  /** -hwaccel_device: GPU index for cuda/d3d11va, device path for vaapi. "" = default. */
  hwaccel_device: string;
  /** cuda only: "auto" keeps decoded frames in GPU memory when every consumer can take them. */
  gpuFrames: "auto" | "off";
  threads: string;
  r: string;
}

export interface InputNodeData {
  kind: "input";
  path: string;
  probe?: ProbeResult;
  probeError?: string;
  probing?: boolean;
  options: InputOptions;
  /** Node-face UI state: which collapsible pad groups are open. Ignored by serializer/validation. */
  ui?: { packets?: boolean; subtitles?: boolean; other?: boolean };
  [k: string]: unknown;
}

export interface FilterNodeData {
  kind: "filter";
  defId: string;
  params: ParamValues;
  /** Only for defId "generic": which ffmpeg filter, and its parsed `-h filter=` text. */
  generic?: GenericFilterSpec;
  /** Only for defId "letterbox": state of the bar detection. */
  letterbox?: LetterboxState;
  [k: string]: unknown;
}

// ---------------------------------------------------------------- generic filters

export type PadMedia = "video" | "audio";

/** Pads of one side in `ffmpeg -h filter=X`. */
export type HelpPads = { kind: "static"; pads: { name: string; media: PadMedia }[] } | { kind: "dynamic" } | { kind: "none" };

export interface HelpOption {
  name: string;
  /** ffmpeg option type: int, int64, float, double, boolean, string, flags, duration, color, ... */
  type: string;
  description: string;
  default?: string;
  min?: number;
  max?: number;
  /** Named constants (enum values for int options, bits for flags). */
  consts: { name: string; value: string; description: string }[];
  /** Short names with the same meaning ("a" for "angle"). */
  aliases: string[];
}

export interface FilterHelp {
  description: string;
  inputs: HelpPads;
  outputs: HelpPads;
  options: HelpOption[];
  /** Supports the generic `enable` timeline option. */
  timeline: boolean;
}

export interface GenericFilterSpec {
  name: string;
  /** From `ffmpeg -filters`, e.g. "VV->V". */
  io: string;
  description: string;
  help?: FilterHelp;
  error?: string;
}

/** What the last letterbox detection ran on, and how it went. */
export interface LetterboxState {
  running?: boolean;
  error?: string;
  /** Input file and frame height the bars were measured on. */
  path?: string;
  height?: number;
  usable?: number;
  sampled?: number;
  warning?: string;
}

export interface LetterboxResult {
  top: number;
  bottom: number;
  height: number;
  usable: number;
  sampled: number;
  warning?: string | null;
}

export interface LetterboxOptions {
  samples: number;
  startFrac: number;
  endFrac: number;
  blackLevel: number;
  rowContentFrac: number;
  darkFrameMean: number;
}

export type EncoderMedia = "video" | "audio" | "subtitle";

/** Codec and options of an encode; held by an encoder parameters node. */
export interface EncoderSettings {
  codec: string;
  params: ParamValues;
  /** Free-form extra options, emitted as -key:spec value. */
  extra: KeyValue[];
}

/** Settings shared by every encoder wired to its "parameters" output. */
export interface EncoderParamsNodeData extends EncoderSettings {
  kind: "encparams";
  media: EncoderMedia;
  [k: string]: unknown;
}

/** Encodes frames into packets with the settings from its "parameters" input. */
export interface EncoderNodeData {
  kind: "encoder";
  media: EncoderMedia;
  [k: string]: unknown;
}

/** An encoder with the settings of its parameters node (see resolveEncoders in model/encoders). */
export interface ResolvedEncoderData extends EncoderNodeData, EncoderSettings {
  paramsId?: string;
  /** No parameters node is connected (codec/params are then the media defaults). */
  missingParams?: boolean;
}

export interface MuxSlot {
  id: string;
  language: string;
  title: string;
  /** "", "default", "forced", "default+forced", "0" (clear) */
  disposition: string;
  tag: string;
}

export interface MuxerNodeData {
  kind: "muxer";
  path: string;
  /** "auto" = infer from extension, otherwise an ffmpeg muxer name. */
  format: string;
  faststart: boolean;
  metadata: KeyValue[];
  /** Ordered input slots; order = output stream order. Always ends with one unconnected spare. */
  slots: MuxSlot[];
  nextSlot: number;
  [k: string]: unknown;
}

export type NodeData = InputNodeData | FilterNodeData | EncoderParamsNodeData | EncoderNodeData | MuxerNodeData;
export type NodeKind = NodeData["kind"];

/** Minimal graph shape: structurally compatible with React Flow nodes/edges. */
export interface GNode<D extends NodeData = NodeData> {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: D;
}

export interface GEdge {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

export const PROJECT_VERSION = 1;

export interface ProjectFile extends Graph {
  version: number;
  /** "ffmpeg-node-gui" in files saved before the rename. */
  app: "ffmpegnodes" | "ffmpeg-node-gui";
}

// ---------------------------------------------------------------- capabilities

export interface Capabilities {
  version: string;
  /** codec = libavcodec codec id produced, from "(codec x)" in `ffmpeg -encoders`. */
  encoders: { name: string; media: EncoderMedia; codec: string; description: string }[];
  muxers: { name: string; description: string }[];
  filters: { name: string; io: string; description: string }[];
}

/** A CUDA device as listed by nvenc's `-gpu list` (CUDA order = -hwaccel_device / -gpu numbering). */
export interface GpuInfo {
  index: number;
  name: string;
}

// ---------------------------------------------------------------- diagnostics

export type Severity = "error" | "warning" | "info";

export interface QuickFix {
  label: string;
  nodeId: string;
  /** Shallow patch merged into node.data. */
  patch: Record<string, unknown>;
}

export interface Diagnostic {
  severity: Severity;
  message: string;
  nodeId?: string;
  edgeId?: string;
  fix?: QuickFix;
}

export const MEDIA_LETTER: Record<Media, string> = {
  video: "v",
  audio: "a",
  subtitle: "s",
  data: "d",
  attachment: "t",
};
