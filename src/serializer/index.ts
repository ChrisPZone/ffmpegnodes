// Graph → ffmpeg argv. Pure and deterministic: same graph, same command.
import {
  MEDIA_LETTER,
  type Diagnostic,
  type ResolvedEncoderData,
  type GEdge,
  type GNode,
  type Graph,
  type InputNodeData,
  type Media,
  type MuxerNodeData,
  type ParamValue,
} from "../model/types";
import { resolveEncoders } from "../model/encoders";
import { encoderOnGpuFrames, gpuResidency, transferInto, uploadDevice } from "../model/hw";
import { cudaUploadFormat } from "../model/format";
import { negotiate } from "../validation/negotiate";
import { getEncoderSchema, isParamVisible, withDefaults } from "../nodes/defs/encoders";
import { findPad, getPads, parseInputPad, typeRelativeIndex } from "../nodes/defs";
import { isMp4Family, needsExplicitFormat, resolveFormat } from "../validation/compat";
import { FilterGraphBuilder, type FrameSource, type Label } from "./filtergraph";

export interface StreamJob {
  muxerId: string;
  slotId: string;
  edgeId: string;
  media: Media;
  /** Type-relative output index within its muxer (v:0, a:1 ...). */
  outIndex: number;
  source:
    | { kind: "copy"; inputId: string; streamIndex: number }
    | { kind: "encode"; encoderId: string; frames?: FrameSource };
}

export interface SerializeResult {
  args: string[];
  diagnostics: Diagnostic[];
  jobs: StreamJob[];
  inputOrder: string[];
  outputs: { nodeId: string; path: string }[];
  /** Expected output duration in seconds, for progress display. */
  durationSec?: number;
}

type Arg = string | Label;

const val = (v: ParamValue) => (typeof v === "boolean" ? (v ? "1" : "0") : String(v));

export function inputStreamSpec(input: GNode<InputNodeData>, inputIdx: number, streamIndex: number): string | undefined {
  const streams = input.data.probe?.streams;
  if (!streams) return undefined;
  const rel = typeRelativeIndex(streams, streamIndex);
  if (!rel) return undefined;
  const letter = MEDIA_LETTER[rel.media];
  return rel.count === 1 ? `${inputIdx}:${letter}` : `${inputIdx}:${letter}:${rel.k}`;
}

export function encoderArgs(d: ResolvedEncoderData, spec: string, opts: { gpuFrames?: boolean } = {}): string[] {
  const schema = getEncoderSchema(d.codec, d.media);
  const out = [`-c:${spec}`, d.codec];
  const params = withDefaults(schema, d.params);
  for (const p of schema.params) {
    if (!p.flag || !isParamVisible(p, params)) continue;
    // nvenc encodes on the device its GPU frames live on; -gpu would be ignored
    if (p.name === "gpu" && opts.gpuFrames) continue;
    const v = params[p.name];
    const s = val(v);
    if (s === "" || s === "auto") continue;
    if (v === p.default && !p.emitDefault) continue;
    out.push(`-${p.flag}:${spec}`, s);
  }
  for (const [flag, v] of schema.derived?.(params) ?? []) out.push(`-${flag}:${spec}`, v);
  for (const kv of d.extra) {
    const k = kv.key.trim().replace(/^-+/, "");
    if (!k) continue;
    out.push(`-${k}:${spec}`, kv.value);
  }
  return out;
}

export function serialize(input: Graph): SerializeResult {
  const graph = resolveEncoders(input);
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const residency = gpuResidency(graph);
  const edges = graph.edges;
  const incoming = (nodeId: string, padId: string): GEdge | undefined =>
    edges.find((e) => e.target === nodeId && e.targetHandle === padId);

  const muxers = graph.nodes.filter((n): n is GNode<MuxerNodeData> => n.data.kind === "muxer");
  if (muxers.length === 0) {
    diagnostics.push({ severity: "info", message: "Add an Output node to produce a command." });
  }

  // ---- 1. resolve what feeds every muxer slot
  const jobs: StreamJob[] = [];
  for (const m of muxers) {
    const counters: Partial<Record<Media, number>> = {};
    for (const slot of m.data.slots) {
      const e = incoming(m.id, slot.id);
      if (!e) continue;
      const src = nodes.get(e.source);
      const pad = findPad(src, e.sourceHandle, "source");
      if (!src || !pad) {
        diagnostics.push({ severity: "error", nodeId: m.id, edgeId: e.id, message: "Connection to a missing pad." });
        continue;
      }
      const media = pad.type.media as Media;
      const outIndex = (counters[media] = (counters[media] ?? -1) + 1);
      const base = { muxerId: m.id, slotId: slot.id, edgeId: e.id, media, outIndex };
      if (src.data.kind === "input" && pad.type.domain === "packets") {
        jobs.push({ ...base, source: { kind: "copy", inputId: src.id, streamIndex: parseInputPad(pad.id)!.streamIndex } });
      } else if (src.data.kind === "encoder" && (src.data as ResolvedEncoderData).missingParams) {
        // reported by validate(); the stream can not be encoded without settings
        counters[media]!--;
        continue;
      } else if (src.data.kind === "encoder") {
        const fe = incoming(src.id, "in");
        if (!fe) diagnostics.push({ severity: "error", nodeId: src.id, message: "Encoder has no frames input." });
        jobs.push({
          ...base,
          source: { kind: "encode", encoderId: src.id, frames: fe ? { nodeId: fe.source, padId: fe.sourceHandle ?? "" } : undefined },
        });
      } else {
        diagnostics.push({ severity: "error", nodeId: m.id, edgeId: e.id, message: "Outputs accept packets from an Encoder or an Input (stream copy)." });
      }
    }
  }

  // ---- 2. input order: first use while walking outputs in order
  const inputOrder: string[] = [];
  const useInput = (id: string) => {
    if (!inputOrder.includes(id)) inputOrder.push(id);
  };
  const walk = (src: FrameSource | undefined, seen = new Set<string>()) => {
    if (!src || seen.has(src.nodeId)) return;
    seen.add(src.nodeId);
    const n = nodes.get(src.nodeId);
    if (!n) return;
    if (n.data.kind === "input") return useInput(n.id);
    if (n.data.kind !== "filter") return;
    const ins = edges.filter((e) => e.target === n.id);
    const order = getPads(n).inputs.map((p) => p.id);
    ins.sort((a, b) => order.indexOf(a.targetHandle ?? "") - order.indexOf(b.targetHandle ?? ""));
    for (const e of ins) walk({ nodeId: e.source, padId: e.sourceHandle ?? "" }, seen);
  };
  for (const j of jobs) {
    if (j.source.kind === "copy") useInput(j.source.inputId);
    else walk(j.source.frames);
  }

  const inputIdx = new Map(inputOrder.map((id, i) => [id, i]));
  for (const id of inputOrder) {
    const n = nodes.get(id) as GNode<InputNodeData>;
    if (!n.data.path.trim()) {
      diagnostics.push({ severity: "error", nodeId: id, message: "Input has no file." });
    } else if (!n.data.probe) {
      diagnostics.push({ severity: "error", nodeId: id, message: n.data.probeError ?? "Input has not been probed yet." });
    }
  }

  const specOf = (inputId: string, streamIndex: number) => {
    const n = nodes.get(inputId) as GNode<InputNodeData> | undefined;
    const idx = inputIdx.get(inputId);
    if (!n || idx === undefined) return undefined;
    const spec = inputStreamSpec(n, idx, streamIndex);
    if (!spec && n.data.probe) {
      diagnostics.push({ severity: "error", nodeId: inputId, message: `Stream #${streamIndex} no longer exists in this file.` });
    }
    return spec;
  };

  // ---- 3. filtergraph
  // frames move between system and GPU memory where a CUDA node meets a CPU one
  const neg = negotiate(graph);
  const transfer = (consumerId: string, src: FrameSource): string | undefined => {
    const consumer = nodes.get(consumerId);
    const t = consumer && transferInto(graph, residency, consumer, src);
    if (!t) return undefined;
    const f = neg.padFormat(src.nodeId, src.padId);
    const pix = f?.media === "video" ? f.pix_fmt : undefined;
    if (t === "download") return `hwdownload,format=${pix ?? "nv12"}`;
    const up = cudaUploadFormat(pix);
    const dev = uploadDevice(graph, consumerId);
    return `${up && up !== pix ? `format=${up},` : ""}hwupload_cuda${dev ? `=device=${dev}` : ""}`;
  };
  const fg = new FilterGraphBuilder(
    nodes,
    edges,
    (src) => {
      const p = parseInputPad(src.padId);
      return p ? specOf(src.nodeId, p.streamIndex) : undefined;
    },
    diagnostics,
    transfer,
  );
  const sinks = jobs.flatMap((j) => (j.source.kind === "encode" && j.source.frames ? [j.source.frames] : []));
  fg.plan(sinks);

  // ---- 4. per-output args
  const outArgs: Arg[] = [];
  const outputs: SerializeResult["outputs"] = [];
  for (const m of muxers) {
    const mine = jobs.filter((j) => j.muxerId === m.id);
    if (mine.length === 0) {
      diagnostics.push({ severity: "error", nodeId: m.id, message: "Output has no streams connected." });
      continue;
    }
    if (!m.data.path.trim()) {
      diagnostics.push({ severity: "error", nodeId: m.id, message: "Output has no file name." });
    }
    for (const j of mine) {
      const spec = `${MEDIA_LETTER[j.media]}:${j.outIndex}`;
      if (j.source.kind === "copy") {
        const s = specOf(j.source.inputId, j.source.streamIndex);
        if (!s) continue;
        outArgs.push("-map", s, `-c:${spec}`, "copy");
      } else {
        const enc = nodes.get(j.source.encoderId) as GNode<ResolvedEncoderData>;
        let r = j.source.frames ? fg.ref(j.source.frames) : undefined;
        if (!r) continue;
        const t = j.source.frames && transfer(enc.id, j.source.frames);
        if (t) r = fg.wrap(r, t);
        if (r.kind === "input") outArgs.push("-map", r.spec);
        else {
          r.label.final = true;
          outArgs.push("-map", r.label);
        }
        outArgs.push(...encoderArgs(enc.data, spec, { gpuFrames: encoderOnGpuFrames(graph, residency, enc.id) }));
      }
      const slot = m.data.slots.find((s) => s.id === j.slotId)!;
      if (slot.tag.trim()) outArgs.push(`-tag:${spec}`, slot.tag.trim());
      if (slot.language.trim()) outArgs.push(`-metadata:s:${spec}`, `language=${slot.language.trim()}`);
      if (slot.title.trim()) outArgs.push(`-metadata:s:${spec}`, `title=${slot.title.trim()}`);
      if (slot.disposition) outArgs.push(`-disposition:${spec}`, slot.disposition);
    }
    const fmt = resolveFormat(m.data);
    if (needsExplicitFormat(m.data)) outArgs.push("-f", m.data.format);
    if (m.data.faststart && isMp4Family(fmt)) outArgs.push("-movflags", "+faststart");
    for (const kv of m.data.metadata) {
      if (kv.key.trim()) outArgs.push("-metadata", `${kv.key.trim()}=${kv.value}`);
    }
    outArgs.push(m.data.path.trim());
    outputs.push({ nodeId: m.id, path: m.data.path.trim() });
    if (mine.filter((j) => j.source.kind === "encode").length > 0) {
      const encoders = mine.flatMap((j) => (j.source.kind === "encode" ? [j.source.encoderId] : []));
      const shared = encoders.filter((id) => jobs.some((o) => o.muxerId !== m.id && o.source.kind === "encode" && o.source.encoderId === id));
      for (const id of new Set(shared)) {
        diagnostics.push({ severity: "info", nodeId: id, message: "This encoder feeds several outputs; it is encoded once per output." });
      }
    }
  }

  // ---- 5. assemble: inputs, filtergraph, outputs
  const args: string[] = [];
  let durationSec: number | undefined;
  for (const id of inputOrder) {
    const n = nodes.get(id) as GNode<InputNodeData>;
    const o = n.data.options;
    if (o.hwaccel.trim()) {
      args.push("-hwaccel", o.hwaccel.trim());
      if (o.hwaccel_device?.trim()) args.push("-hwaccel_device", o.hwaccel_device.trim());
      if (residency.get(id)?.resident) args.push("-hwaccel_output_format", "cuda");
    }
    if (o.threads.trim()) args.push("-threads", o.threads.trim());
    if (o.r.trim()) args.push("-r", o.r.trim());
    if (o.ss.trim()) args.push("-ss", o.ss.trim());
    if (o.t.trim()) args.push("-t", o.t.trim());
    args.push("-i", n.data.path.trim());
    const total = Number(n.data.probe?.format.duration);
    const dur = o.t.trim() ? parseTime(o.t) : Number.isFinite(total) ? total - (parseTime(o.ss) ?? 0) : undefined;
    if (dur !== undefined && dur > 0) durationSec = Math.max(durationSec ?? 0, dur);
  }
  if (!fg.empty) args.push("-filter_complex", fg.build());
  args.push(...outArgs.map((a) => (typeof a === "string" ? a : `[${a.name}]`)));

  return { args, diagnostics, jobs, inputOrder, outputs, durationSec };
}

/** "90", "1:30", "00:01:30.5" → seconds. */
export function parseTime(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const parts = t.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
