// Pad layout for every node kind, plus factories for new node data.
import { describeFormat, formatFromStream } from "../../model/format";
import {
  MEDIA_LETTER,
  type EncoderMedia,
  type EncoderNodeData,
  type EncoderParamsNodeData,
  type FilterNodeData,
  type GEdge,
  type GNode,
  type InputNodeData,
  type Media,
  type MuxerNodeData,
  type NodeData,
  type PadDef,
  type PadType,
  type StreamInfo,
} from "../../model/types";
import { DEFAULT_CODEC, getEncoderSchema } from "./encoders";
import { FILTERS_BY_ID, defaultParams } from "./filters";
import { filterDefOf } from "./generic";

export interface NodePads {
  inputs: PadDef[];
  outputs: PadDef[];
}

/** Input pads: "f<index>" = decoded frames, "p<index>" = packets (stream copy). */
/** The pad that carries encoder settings (output of a parameters node, first input of an encoder). */
export const PARAMS_PAD = "params";

export const framesPadId = (streamIndex: number) => `f${streamIndex}`;
export const packetsPadId = (streamIndex: number) => `p${streamIndex}`;

export function parseInputPad(padId: string): { domain: "frames" | "packets"; streamIndex: number } | undefined {
  const m = /^([fp])(\d+)$/.exec(padId);
  if (!m) return undefined;
  return { domain: m[1] === "f" ? "frames" : "packets", streamIndex: Number(m[2]) };
}

const DECODABLE: Media[] = ["video", "audio", "subtitle"];

/** Type-relative index of a stream within its input file (0:v:1 = second video stream). */
export function typeRelativeIndex(streams: StreamInfo[], streamIndex: number): { media: Media; k: number; count: number } | undefined {
  const s = streams.find((x) => x.index === streamIndex);
  if (!s) return undefined;
  const same = streams.filter((x) => x.codec_type === s.codec_type);
  return { media: s.codec_type, k: same.findIndex((x) => x.index === streamIndex), count: same.length };
}

export function streamHint(s: StreamInfo): string {
  const fmt = s.codec_type === "video" || s.codec_type === "audio" ? describeFormat(formatFromStream(s)) : "";
  return [s.codec_name, fmt].filter(Boolean).join(" ");
}

function inputPads(d: InputNodeData): NodePads {
  const outputs: PadDef[] = [];
  const streams = d.probe?.streams ?? [];
  for (const s of streams) {
    const media = s.codec_type;
    if (!(media in MEDIA_LETTER)) continue;
    const rel = typeRelativeIndex(streams, s.index)!;
    const name = `${media} ${MEDIA_LETTER[media]}:${rel.k}`;
    const lang = s.tags?.language && s.tags.language !== "und" ? ` [${s.tags.language}]` : "";
    if (DECODABLE.includes(media)) {
      outputs.push({ id: framesPadId(s.index), label: `${name}${lang}`, hint: streamHint(s), type: { domain: "frames", media } });
    }
    outputs.push({ id: packetsPadId(s.index), label: `${name}${lang}`, icon: "packets", hint: streamHint(s) || "copy", type: { domain: "packets", media } });
  }
  return { inputs: [], outputs };
}

export type InputPadGroupId = "packets" | "subtitles" | "other";
export interface InputPadGroup {
  id: InputPadGroupId;
  title: string;
  pads: PadDef[];
}

const GROUP_TITLES: Record<InputPadGroupId, string> = {
  packets: "A/V Packets",
  subtitles: "Subtitles",
  other: "Data & attachments",
};

/** Which collapsible group an Input pad belongs to; undefined = always visible. */
export function inputPadGroup(pad: PadDef): InputPadGroupId | undefined {
  const { domain, media } = pad.type;
  if (media === "subtitle") return "subtitles";
  if (media === "video" || media === "audio") return domain === "packets" ? "packets" : undefined;
  return "other";
}

/**
 * Splits Input pads into always-visible rows and collapsible groups.
 * Connected pads are always visible (React Flow needs their handles mounted),
 * listed after the video/audio frames rows in stream order. Empty groups are dropped.
 */
export function groupInputPads(pads: PadDef[], connected: Set<string>): { main: PadDef[]; groups: InputPadGroup[] } {
  const base: PadDef[] = [];
  const promoted: PadDef[] = [];
  const buckets: Record<InputPadGroupId, PadDef[]> = { packets: [], subtitles: [], other: [] };
  for (const p of pads) {
    const g = inputPadGroup(p);
    if (!g) base.push(p);
    else if (connected.has(p.id)) promoted.push(p);
    else buckets[g].push(p);
  }
  const groups = (Object.keys(buckets) as InputPadGroupId[])
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({ id, title: GROUP_TITLES[id], pads: buckets[id] }));
  return { main: [...base, ...promoted], groups };
}

export function getPads(node: GNode): NodePads {
  const d = node.data;
  switch (d.kind) {
    case "input":
      return inputPads(d);
    case "filter": {
      const def = filterDefOf(d);
      if (!def) return { inputs: [], outputs: [] };
      return { inputs: def.inputs(d.params), outputs: def.outputs(d.params) };
    }
    case "encparams":
      return { inputs: [], outputs: [{ id: PARAMS_PAD, label: "parameters", type: { domain: "params", media: d.media } }] };
    case "encoder":
      return {
        // parameters on top, then the frames to encode
        inputs: [
          { id: PARAMS_PAD, label: "parameters", type: { domain: "params", media: d.media } },
          { id: "in", label: "frames", type: { domain: "frames", media: d.media } },
        ],
        outputs: [{ id: "out", label: "packets", type: { domain: "packets", media: d.media } }],
      };
    case "muxer":
      return {
        inputs: d.slots.map((s, i) => ({ id: s.id, label: `stream ${i}`, type: { domain: "packets", media: "any" } })),
        outputs: [],
      };
  }
}

export function findPad(node: GNode | undefined, padId: string | null | undefined, side: "source" | "target"): PadDef | undefined {
  if (!node || !padId) return undefined;
  const pads = getPads(node);
  return (side === "source" ? pads.outputs : pads.inputs).find((p) => p.id === padId);
}

export function padsCompatible(src: PadType, dst: PadType): boolean {
  if (src.domain !== dst.domain) return false;
  return dst.media === "any" || src.media === "any" || src.media === dst.media;
}

/** Media of a node, used for header colour. */
export function nodeMedia(d: NodeData): Media | undefined {
  if (d.kind === "filter") {
    const m = filterDefOf(d)?.media;
    return m === "av" ? undefined : m;
  }
  if (d.kind === "encoder" || d.kind === "encparams") return d.media;
  return undefined;
}

export function nodeTitle(d: NodeData): string {
  switch (d.kind) {
    case "input":
      return "Input";
    case "filter":
      return filterDefOf(d)?.label ?? d.defId;
    case "encoder":
      return `${d.media[0].toUpperCase()}${d.media.slice(1)} Encoder`;
    case "encparams":
      return `${d.media[0].toUpperCase()}${d.media.slice(1)} Encoder Parameters`;
    case "muxer":
      return "Output";
  }
}

// ---------------------------------------------------------------- factories

export function newInputData(path = ""): InputNodeData {
  return { kind: "input", path, options: { ss: "", t: "", hwaccel: "", hwaccel_device: "", gpuFrames: "auto", threads: "", r: "" } };
}

export function newFilterData(defId: string): FilterNodeData {
  const def = FILTERS_BY_ID[defId];
  return { kind: "filter", defId, params: def ? defaultParams(def.params) : {} };
}

export function encoderDefaults(codec: string, media: EncoderMedia) {
  return defaultParams(getEncoderSchema(codec, media).params);
}

/** An encoder; its settings come from an encoder parameters node wired to its "params" pad. */
export function newEncoderData(media: EncoderMedia): EncoderNodeData {
  return { kind: "encoder", media };
}

export function newEncoderParamsData(media: EncoderMedia, codec = DEFAULT_CODEC[media]): EncoderParamsNodeData {
  return { kind: "encparams", media, codec, params: encoderDefaults(codec, media), extra: [] };
}

export function newMuxerData(path = ""): MuxerNodeData {
  return {
    kind: "muxer",
    path,
    format: "auto",
    faststart: true,
    metadata: [],
    slots: [{ id: "s0", language: "", title: "", disposition: "", tag: "" }],
    nextSlot: 1,
  };
}

/**
 * Keep muxer slots tidy: connected slots keep their order, unconnected ones are dropped,
 * and exactly one spare slot is appended. Returns undefined when nothing changed.
 */
export function normalizeMuxerSlots(d: MuxerNodeData, nodeId: string, edges: GEdge[]): MuxerNodeData | undefined {
  const connected = new Set(edges.filter((e) => e.target === nodeId).map((e) => e.targetHandle));
  const kept = d.slots.filter((s) => connected.has(s.id));
  let next = d.nextSlot;
  const slots = [...kept, { id: `s${next++}`, language: "", title: "", disposition: "", tag: "" }];
  const last = d.slots[d.slots.length - 1];
  const unchanged =
    d.slots.length === kept.length + 1 && kept.every((s, i) => s === d.slots[i]) && last && !connected.has(last.id);
  if (unchanged) return undefined;
  return { ...d, slots, nextSlot: next };
}
