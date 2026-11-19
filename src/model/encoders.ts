// Encoders get their settings from an encoder parameters node wired to their "params" pad.
// resolveEncoders() copies those settings into each encoder so the serializer and the
// validators can keep treating an encoder as "codec + params + extra".
import { DEFAULT_CODEC, getEncoderSchema } from "../nodes/defs/encoders";
import type { EncoderNodeData, EncoderParamsNodeData, GEdge, GNode, Graph, ResolvedEncoderData } from "./types";
import { defaultParams } from "../nodes/defs/filters";
import { PARAMS_PAD } from "../nodes/defs";

export { PARAMS_PAD };

/** The parameters node wired to an encoder, if any. */
export function paramsNodeOf(g: Graph, encoderId: string): GNode<EncoderParamsNodeData> | undefined {
  const e = g.edges.find((x) => x.target === encoderId && x.targetHandle === PARAMS_PAD);
  const n = e && g.nodes.find((x) => x.id === e.source);
  return n?.data.kind === "encparams" ? (n as GNode<EncoderParamsNodeData>) : undefined;
}

/** Encoders that take their settings from this parameters node. */
export function encodersUsing(g: { nodes: GNode[]; edges: GEdge[] }, paramsId: string): GNode<EncoderNodeData>[] {
  const ids = new Set(g.edges.filter((e) => e.source === paramsId && e.sourceHandle === PARAMS_PAD).map((e) => e.target));
  return g.nodes.filter((n) => ids.has(n.id) && n.data.kind === "encoder") as GNode<EncoderNodeData>[];
}

/** One encoder's data with the settings of its parameters node. */
export function resolveEncoder(g: Graph, n: GNode<EncoderNodeData>): ResolvedEncoderData {
  const p = paramsNodeOf(g, n.id);
  const base = { kind: "encoder" as const, media: n.data.media };
  if (p && p.data.media === n.data.media) {
    return { ...base, codec: p.data.codec, params: p.data.params, extra: p.data.extra, paramsId: p.id };
  }
  const codec = DEFAULT_CODEC[n.data.media];
  return { ...base, codec, params: defaultParams(getEncoderSchema(codec, n.data.media).params), extra: [], missingParams: true };
}

const RESOLVED = new WeakSet<Graph>();

/** The graph with every encoder's settings filled in from its parameters node (idempotent). */
export function resolveEncoders<G extends Graph>(g: G): G {
  if (RESOLVED.has(g)) return g;
  let changed = false;
  const nodes = g.nodes.map((n) => {
    if (n.data.kind !== "encoder") return n;
    changed = true;
    return { ...n, data: resolveEncoder(g, n as GNode<EncoderNodeData>) };
  });
  const out = changed ? ({ ...g, nodes } as G) : g;
  RESOLVED.add(out);
  return out;
}

/** Settings of an encoder in a graph that went through resolveEncoders. */
export const encoderSettings = (n: GNode): ResolvedEncoderData => n.data as ResolvedEncoderData;
