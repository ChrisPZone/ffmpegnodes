// Recode wizard: turns a probed input file and a few choices into a complete, wired graph.
import { ENCODERS } from "../nodes/defs/encoders";
import {
  framesPadId,
  newEncoderData,
  newEncoderParamsData,
  newFilterData,
  newInputData,
  newMuxerData,
  normalizeMuxerSlots,
  packetsPadId,
  PARAMS_PAD,
} from "../nodes/defs";
import type { Capabilities, EncoderMedia, GEdge, GNode, Graph, MuxerNodeData, NodeData, ProbeResult, StreamInfo } from "../model/types";

export const COPY = "copy";

export interface WizardChoices {
  video: { streams: number[]; codec: string; gpu: boolean; deinterlace: boolean; letterbox: boolean; denoise: boolean; deband: boolean; scale: boolean };
  audio: { streams: number[]; codec: string; downmix: boolean; normalize: boolean; resample: boolean };
  subtitles: { copy: boolean };
  output: string;
}

export interface WizardSource {
  path: string;
  probe: ProbeResult;
}

const isCoverArt = (s: StreamInfo) => s.disposition?.attached_pic === 1;
export const videoStreams = (p: ProbeResult) => p.streams.filter((s) => s.codec_type === "video");
export const audioStreams = (p: ProbeResult) => p.streams.filter((s) => s.codec_type === "audio");
export const subtitleStreams = (p: ProbeResult) => p.streams.filter((s) => s.codec_type === "subtitle");

const TEXT_SUBS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);
export const isTextSubtitle = (s: StreamInfo) => TEXT_SUBS.has(s.codec_name ?? "");
/** Containers that only take mov_text subtitles: text subtitles are converted, bitmap ones left out. */
export const needsMovText = (output: string) => /\.(mp4|m4v|mov)$/i.test(output.trim());

export const hasNvenc = (caps?: Capabilities) => !!caps?.encoders.some((e) => /_nvenc$/.test(e.name));

/** Encoders offered in the wizard: those of this ffmpeg build (all known ones when caps are missing); only nvenc with GPU on. */
export function codecChoices(media: EncoderMedia, caps: Capabilities | undefined, gpu = false) {
  return ENCODERS.filter(
    (e) => e.media === media && (!caps || caps.encoders.some((c) => c.name === e.codec)) && (!gpu || e.hardware),
  ).map((e) => ({ value: e.codec, label: e.label }));
}

export function defaultOutputPath(input: string): string {
  const m = /^(.*[\\/])?([^\\/]*?)(\.[^.\\/]*)?$/.exec(input.trim());
  return `${m?.[1] ?? ""}${m?.[2] || "output"}-recode.mkv`;
}

export function defaultChoices(src: WizardSource, caps?: Capabilities): WizardChoices {
  const v = videoStreams(src.probe).find((s) => !isCoverArt(s));
  const a = audioStreams(src.probe)[0];
  const interlaced = !!v && /^(tt|bb|tb|bt)$/.test(v.field_order ?? "");
  const vCodecs = codecChoices("video", caps).map((c) => c.value);
  const aCodecs = codecChoices("audio", caps).map((c) => c.value);
  return {
    video: {
      streams: v ? [v.index] : [],
      codec: vCodecs.includes("libx264") ? "libx264" : (vCodecs[0] ?? COPY),
      gpu: false,
      deinterlace: interlaced,
      letterbox: false,
      denoise: false,
      deband: false,
      scale: false,
    },
    audio: { streams: a ? [a.index] : [], codec: aCodecs.includes("aac") ? "aac" : (aCodecs[0] ?? COPY), downmix: false, normalize: false, resample: false },
    subtitles: { copy: subtitleStreams(src.probe).length > 0 },
    output: defaultOutputPath(src.path),
  };
}

/** Filters without a CUDA version: with GPU on, frames are copied off the GPU for them and back. */
export const cpuVideoFilters = (v: WizardChoices["video"]) => v.letterbox || v.denoise || v.deband;

/** Filter def ids chained for one stream, left to right. */
export function videoChain(v: WizardChoices["video"]): string[] {
  if (v.codec === COPY) return [];
  const chain: string[] = [];
  if (v.deinterlace) chain.push(v.gpu ? "bwdif_cuda" : "bwdif");
  if (v.letterbox) chain.push("letterbox");
  if (v.denoise) chain.push("hqdn3d");
  if (v.deband) chain.push("deband");
  if (v.scale) chain.push(v.gpu ? "scale_cuda" : "scale");
  return chain;
}

export function audioChain(a: WizardChoices["audio"], channels?: number): string[] {
  if (a.codec === COPY) return [];
  const chain: string[] = [];
  if (a.downmix && (channels === undefined || channels > 2)) chain.push("pan");
  if (a.normalize) chain.push("loudnorm");
  else if (a.resample) chain.push("aresample");
  return chain;
}

// ---------------------------------------------------------------- layout

export const LAYOUT = {
  inputX: 0,
  filterX: 330,
  filterStep: 250,
  /** Gap between the filter column (or the Input when there are no filters) and the parameters column. */
  paramsGap: 330,
  encoderGap: 290,
  outputGap: 290,
  rowH: { video: 190, audio: 170, subtitle: 150 } as Record<EncoderMedia, number>,
  /** Each media group starts with a band for its parameters node, so frames wires pass beneath it. */
  paramsBand: 140,
  inputH: (streams: number) => 90 + 26 * streams,
  outputH: (slots: number) => 70 + 26 * slots,
};

interface Row {
  media: EncoderMedia;
  stream: StreamInfo;
  chain: string[];
  y: number;
}

export function buildRecodeGraph(src: WizardSource, ch: WizardChoices, newId: (kind: string) => string): Graph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const add = (data: NodeData, x: number, y: number) => {
    const id = newId(data.kind);
    nodes.push({ id, position: { x, y }, data });
    return id;
  };
  const link = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
    edges.push({ id: `e-${source}.${sourceHandle}-${target}.${targetHandle}`, source, sourceHandle, target, targetHandle });

  const byIndex = new Map(src.probe.streams.map((s) => [s.index, s]));
  const pick = (ids: number[]) => ids.map((i) => byIndex.get(i)).filter((s): s is StreamInfo => !!s);
  const vSel = pick(ch.video.streams);
  const aSel = pick(ch.audio.streams);
  const sAll = ch.subtitles.copy ? subtitleStreams(src.probe) : [];
  const movText = needsMovText(ch.output);
  const sEnc = movText ? sAll.filter(isTextSubtitle) : [];
  const sCopy = movText ? [] : sAll;

  // rows: one per encoded stream, video then audio then subtitles
  const rows: Row[] = [];
  const paramsY = new Map<EncoderMedia, number>();
  let y = 0;
  const addRows = (media: EncoderMedia, streams: StreamInfo[], chain: (s: StreamInfo) => string[]) => {
    if (!streams.length) return;
    paramsY.set(media, y);
    y += LAYOUT.paramsBand;
    for (const stream of streams) {
      rows.push({ media, stream, chain: chain(stream), y });
      y += LAYOUT.rowH[media];
    }
  };
  if (ch.video.codec !== COPY) addRows("video", vSel, () => videoChain(ch.video));
  if (ch.audio.codec !== COPY) addRows("audio", aSel, (s) => audioChain(ch.audio, s.channels));
  addRows("subtitle", sEnc, () => []);
  const totalH = Math.max(y, 160);

  const maxChain = Math.max(0, ...rows.map((r) => r.chain.length));
  const filtersEnd = maxChain ? LAYOUT.filterX + (maxChain - 1) * LAYOUT.filterStep : LAYOUT.inputX;
  const paramsX = filtersEnd + LAYOUT.paramsGap;
  const encX = paramsX + LAYOUT.encoderGap;
  const outX = encX + LAYOUT.outputGap;

  // Input, with GPU decoding when asked for
  const input = newInputData(src.path);
  input.probe = src.probe;
  const gpu = ch.video.gpu && ch.video.codec !== COPY && vSel.length > 0;
  if (gpu) input.options = { ...input.options, hwaccel: "cuda", gpuFrames: "auto" };
  const inId = add(input, LAYOUT.inputX, Math.round(totalH / 2 - LAYOUT.inputH(src.probe.streams.length) / 2));

  // one parameters node per encoded media, in the band above its rows
  const params = new Map<EncoderMedia, string>();
  for (const media of ["video", "audio", "subtitle"] as const) {
    const mine = rows.filter((r) => r.media === media);
    if (!mine.length) continue;
    const codec = media === "video" ? ch.video.codec : media === "audio" ? ch.audio.codec : "mov_text";
    const data = newEncoderParamsData(media, codec);
    if (media === "audio" && ch.audio.normalize) data.params = { ...data.params, ar: "48000" };
    params.set(media, add(data, paramsX, paramsY.get(media)!));
  }

  // muxer; slots are appended in stream order
  const muxId = newId("muxer");
  let mux: MuxerNodeData = newMuxerData(ch.output);
  const toMux = (source: string, sourceHandle: string) => {
    link(source, sourceHandle, muxId, mux.slots[mux.slots.length - 1].id);
    mux = normalizeMuxerSlots(mux, muxId, edges) ?? mux;
  };

  const encoded = new Map<number, string>();
  for (const r of rows) {
    let from = inId;
    let pad = framesPadId(r.stream.index);
    r.chain.forEach((defId, k) => {
      const x = LAYOUT.filterX + (maxChain - r.chain.length + k) * LAYOUT.filterStep;
      const f = add(newFilterData(defId), x, r.y);
      link(from, pad, f, "in");
      from = f;
      pad = "out";
    });
    const enc = add(newEncoderData(r.media), encX, r.y);
    link(params.get(r.media)!, PARAMS_PAD, enc, PARAMS_PAD);
    link(from, pad, enc, "in");
    encoded.set(r.stream.index, enc);
  }

  // Output slots: video, audio, subtitles; each either encoded or copied
  const order = [...vSel, ...aSel, ...sEnc, ...sCopy];
  for (const s of order) {
    const enc = encoded.get(s.index);
    if (enc) toMux(enc, "out");
    else toMux(inId, packetsPadId(s.index));
  }
  nodes.push({ id: muxId, position: { x: outX, y: Math.round(totalH / 2 - LAYOUT.outputH(order.length) / 2) }, data: mux });
  return { nodes, edges };
}
