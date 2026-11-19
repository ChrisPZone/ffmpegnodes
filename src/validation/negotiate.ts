// Propagate stream formats along frames edges so the UI can show what each edge carries and
// where ffmpeg would silently insert a conversion.
import { cudaSurfaceFormat, cudaUploadFormat, describeFormat, formatFromStream, type StreamFormat } from "../model/format";
import { gpuResidency } from "../model/hw";
import type { GEdge, GNode, Graph, ResolvedEncoderData } from "../model/types";
import { resolveEncoders } from "../model/encoders";
import { getPads, parseInputPad } from "../nodes/defs";
import { filterDefOf } from "../nodes/defs/generic";

export interface EdgeInfo {
  label: string;
  /** Text describing an implicit conversion at the encoder ("yuv420p → yuv420p10le"). */
  conversion?: string;
}

export interface Negotiation {
  padFormat: (nodeId: string, padId: string) => StreamFormat | undefined;
  edges: Map<string, EdgeInfo>;
}

export function encoderTargetFormat(d: ResolvedEncoderData): Partial<StreamFormat> {
  if (d.media === "video") return { media: "video", pix_fmt: d.params.pix_fmt && d.params.pix_fmt !== "auto" ? String(d.params.pix_fmt) : undefined };
  if (d.media === "audio") {
    const ar = d.params.ar && d.params.ar !== "auto" ? Number(d.params.ar) : undefined;
    const ac = d.params.ac && d.params.ac !== "auto" ? Number(d.params.ac) : undefined;
    return { media: "audio", sample_rate: ar, channels: ac };
  }
  return {};
}

export function conversionAt(incoming: StreamFormat | undefined, d: ResolvedEncoderData): string | undefined {
  const want = encoderTargetFormat(d);
  if (!incoming) return undefined;
  const parts: string[] = [];
  if (incoming.media === "video" && want.media === "video" && !incoming.hw && want.pix_fmt && incoming.pix_fmt && incoming.pix_fmt !== want.pix_fmt) {
    parts.push(`${incoming.pix_fmt} → ${want.pix_fmt}`);
  }
  if (incoming.media === "audio" && want.media === "audio") {
    if (want.sample_rate && incoming.sample_rate && want.sample_rate !== incoming.sample_rate) {
      parts.push(`${incoming.sample_rate / 1000} → ${want.sample_rate / 1000} kHz`);
    }
    if (want.channels && incoming.channels && want.channels !== incoming.channels) parts.push(`${incoming.channels} → ${want.channels} ch`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

export function negotiate(graph: Graph): Negotiation {
  const g = resolveEncoders(graph);
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const memo = new Map<string, StreamFormat | undefined>();
  const residency = gpuResidency(g);
  const inEdge = (nodeId: string, padId: string): GEdge | undefined => g.edges.find((e) => e.target === nodeId && e.targetHandle === padId);

  const padFormat = (nodeId: string, padId: string, depth = 0): StreamFormat | undefined => {
    const k = `${nodeId}|${padId}`;
    if (memo.has(k)) return memo.get(k);
    memo.set(k, undefined); // cycle guard
    const n: GNode | undefined = nodes.get(nodeId);
    let result: StreamFormat | undefined;
    if (n && depth < 200) {
      if (n.data.kind === "input") {
        const p = parseInputPad(padId);
        const s = p && n.data.probe?.streams.find((x) => x.index === p.streamIndex);
        if (s && p?.domain === "frames") {
          result = formatFromStream(s);
          if (result.media === "video" && residency.get(n.id)?.resident) {
            result = { ...result, pix_fmt: cudaSurfaceFormat(result.pix_fmt), hw: "cuda" };
          }
        }
      } else if (n.data.kind === "filter") {
        const def = filterDefOf(n.data);
        if (def) {
          const ins = def.inputs(n.data.params).map((pad) => {
            const e = inEdge(n.id, pad.id);
            const f = e ? padFormat(e.source, e.sourceHandle ?? "", depth + 1) : undefined;
            if (f?.media !== "video") return f;
            // the serializer uploads CPU frames in front of a CUDA filter and downloads GPU frames in front of a CPU one
            if (def.gpu && !f.hw) return { ...f, pix_fmt: cudaUploadFormat(f.pix_fmt), hw: "cuda" as const };
            if (!def.gpu && f.hw) return { ...f, hw: undefined };
            return f;
          });
          const outs = def.transform ? def.transform(ins, n.data.params) : ins.slice(0, 1);
          const idx = def.outputs(n.data.params).findIndex((p) => p.id === padId);
          result = outs[idx];
        }
      }
    }
    memo.set(k, result);
    return result;
  };

  const edges = new Map<string, EdgeInfo>();
  for (const e of g.edges) {
    const src = nodes.get(e.source);
    if (!src) continue;
    const pad = getPads(src).outputs.find((p) => p.id === e.sourceHandle);
    if (!pad || pad.type.domain !== "frames") continue;
    const f = padFormat(e.source, e.sourceHandle ?? "");
    const tgt = nodes.get(e.target);
    const conversion = tgt?.data.kind === "encoder" && !(tgt.data as ResolvedEncoderData).missingParams ? conversionAt(f, tgt.data as ResolvedEncoderData) : undefined;
    edges.set(e.id, { label: describeFormat(f), conversion });
  }
  return { padFormat: (a, b) => padFormat(a, b), edges };
}
