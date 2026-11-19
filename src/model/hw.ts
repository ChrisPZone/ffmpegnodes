// Hardware pipeline analysis: decides per Input whether decoded frames can stay in GPU
// memory (-hwaccel_output_format cuda), and where frames have to move between system and GPU
// memory (hwupload_cuda before a CUDA filter, hwdownload before a CPU filter or encoder).
// Single source of truth for serializer, negotiation, diagnostics and inspector.
//
// Where frames live: an Input's frames are on the GPU when it is resident; every CUDA filter
// outputs GPU frames (CPU frames are uploaded in front of it); every other filter outputs
// system-memory frames (GPU frames are downloaded in front of it).
import { getPads, nodeTitle, PARAMS_PAD, parseInputPad } from "../nodes/defs";
import { filterDefOf } from "../nodes/defs/generic";
import type { GNode, Graph, InputNodeData, ResolvedEncoderData } from "./types";
import { resolveEncoders } from "./encoders";

export const isGpuEncoder = (codec: string) => /_nvenc$/.test(codec);

export interface Residency {
  /** Emit -hwaccel_output_format cuda for this input. */
  resident: boolean;
  /** Why frames can't stay on the GPU (first CPU consumer found). */
  blocker?: { nodeId: string; label: string; reason: string };
  /** GPU consumers reached (encoder codecs / filter names), for the inspector explanation. */
  consumers: string[];
}

function isCudaInput(d: InputNodeData) {
  return d.options.hwaccel.trim() === "cuda";
}

/** Can this node take GPU frames as they are: a CUDA filter, or nvenc without an explicit pixel format. */
function gpuConsumer(t: GNode): { ok: true; name: string } | { ok: false; blocker: Residency["blocker"] } {
  if (t.data.kind === "encoder") {
    const ed = t.data as ResolvedEncoderData;
    if (!isGpuEncoder(ed.codec)) return { ok: false, blocker: { nodeId: t.id, label: ed.codec, reason: "CPU encoder" } };
    if (ed.params.pix_fmt && ed.params.pix_fmt !== "auto") {
      return { ok: false, blocker: { nodeId: t.id, label: ed.codec, reason: `explicit pixel format ${ed.params.pix_fmt}` } };
    }
    return { ok: true, name: ed.codec };
  }
  if (t.data.kind === "filter") {
    const def = filterDefOf(t.data);
    if (!def?.gpu) return { ok: false, blocker: { nodeId: t.id, label: nodeTitle(t.data), reason: "CPU filter" } };
    return { ok: true, name: def.ffName };
  }
  return { ok: true, name: "" };
}

/**
 * Per cuda Input: can its decoded video frames stay on the GPU? They can when every node the
 * Input's video goes to directly takes GPU frames; later CPU filters get a download instead.
 * Inputs without hwaccel cuda are absent.
 */
export function gpuResidency(graph: Graph): Map<string, Residency> {
  const g = resolveEncoders(graph);
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Residency>();

  for (const n of g.nodes) {
    if (n.data.kind !== "input" || !isCudaInput(n.data)) continue;
    const d = n.data;
    const res: Residency = { resident: false, consumers: [] };
    out.set(n.id, res);

    const videoStreams = new Set((d.probe?.streams ?? []).filter((s) => s.codec_type === "video").map((s) => s.index));
    const starts = g.edges.filter((e) => {
      if (e.source !== n.id) return false;
      const p = parseInputPad(e.sourceHandle ?? "");
      // without a probe we can't tell stream types; frames pads of unknown streams count as video
      return p?.domain === "frames" && (!d.probe || videoStreams.has(p.streamIndex));
    });
    if (starts.length === 0) continue;

    let ok = true;
    for (const e of starts) {
      const t = nodes.get(e.target);
      if (!t) continue;
      const c = gpuConsumer(t);
      if (c.ok) {
        if (c.name) res.consumers.push(c.name);
      } else if (ok) {
        ok = false;
        res.blocker = c.blocker;
      }
    }
    // the GPU nodes further down that the frames reach without leaving the GPU, for the explanation
    const seen = new Set<string>();
    const follow = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const t = nodes.get(id);
      if (t?.data.kind !== "filter" || !filterDefOf(t.data)?.gpu) return;
      const outs = getPads(t).outputs.map((p) => p.id);
      for (const e of g.edges.filter((x) => x.source === id && outs.includes(x.sourceHandle ?? ""))) {
        const n2 = nodes.get(e.target);
        const c = n2 && gpuConsumer(n2);
        if (c?.ok && c.name) res.consumers.push(c.name);
        follow(e.target);
      }
    };
    if (ok) for (const e of starts) follow(e.target);
    res.consumers = [...new Set(res.consumers)];
    res.resident = ok && d.options.gpuFrames !== "off";
  }
  return out;
}

/** Are the frames on (nodeId, output padId) in GPU memory? */
export function framesOnGpu(g: Graph, res: Map<string, Residency>, nodeId: string, padId: string, depth = 0): boolean {
  const n: GNode | undefined = g.nodes.find((x) => x.id === nodeId);
  if (!n || depth > 200) return false;
  if (n.data.kind === "input") {
    const p = parseInputPad(padId);
    if (p?.domain !== "frames" || !res.get(n.id)?.resident) return false;
    // only video is decoded into GPU memory
    const s = n.data.probe?.streams.find((x) => x.index === p.streamIndex);
    return !s || s.codec_type === "video";
  }
  // CUDA filters always output GPU frames: CPU frames are uploaded in front of them
  if (n.data.kind === "filter") return !!filterDefOf(n.data)?.gpu;
  return false;
}

/**
 * Memory transfer needed where frames from `src` enter `consumer`: "upload" in front of a CUDA
 * filter that gets system-memory frames, "download" in front of a CPU filter or encoder (or
 * nvenc with an explicit pixel format) that gets GPU frames.
 */
export function transferInto(g: Graph, res: Map<string, Residency>, consumer: GNode, src: { nodeId: string; padId: string }): "upload" | "download" | undefined {
  const onGpu = framesOnGpu(g, res, src.nodeId, src.padId);
  if (consumer.data.kind === "filter") {
    const def = filterDefOf(consumer.data);
    if (def?.gpu) return onGpu ? undefined : "upload";
    return onGpu ? "download" : undefined;
  }
  if (consumer.data.kind === "encoder") return onGpu && !gpuConsumer(consumer).ok ? "download" : undefined;
  return undefined;
}

/** Does this encoder receive GPU frames (so -gpu is ignored and must not be emitted)? */
export function encoderOnGpuFrames(g: Graph, res: Map<string, Residency>, encoderId: string): boolean {
  const e = g.edges.find((x) => x.target === encoderId && x.targetHandle === "in");
  const enc = g.nodes.find((x) => x.id === encoderId);
  return !!e && !!enc && framesOnGpu(g, res, e.source, e.sourceHandle ?? "") && gpuConsumer(enc).ok;
}

/** CUDA device for an upload in front of `nodeId`: the GPU of the cuda Input upstream, if one is set. */
export function uploadDevice(g: Graph, nodeId: string): string {
  const inp = upstreamInput(g, nodeId);
  return inp && isCudaInput(inp.data) ? inp.data.options.hwaccel_device.trim() : "";
}

/** The cuda Input upstream of a node's frames input, if any (for "follows the Input's GPU"). */
export function upstreamInput(g: Graph, nodeId: string, depth = 0): GNode<InputNodeData> | undefined {
  if (depth > 200) return undefined;
  // follow the frames, not an encoder parameters wire
  const e = g.edges.find((x) => x.target === nodeId && x.targetHandle !== PARAMS_PAD);
  if (!e) return undefined;
  const src = g.nodes.find((x) => x.id === e.source);
  if (!src) return undefined;
  if (src.data.kind === "input") return src as GNode<InputNodeData>;
  return upstreamInput(g, src.id, depth + 1);
}
