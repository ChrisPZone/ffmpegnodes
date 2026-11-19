// Test fixtures: an encoder "with settings" that graph helpers turn into an encoder plus
// its parameters node, so tests can keep writing { ...encoder("video", "libx265"), params: {...} }.
import { newEncoderParamsData, PARAMS_PAD } from "../nodes/defs";
import { DEFAULT_CODEC } from "../nodes/defs/encoders";
import type { EncoderMedia, EncoderNodeData, EncoderSettings, GEdge, GNode, NodeData } from "../model/types";

export type EncoderFixture = EncoderNodeData & EncoderSettings;

export function encoder(media: EncoderMedia, codec = DEFAULT_CODEC[media]): EncoderFixture {
  const p = newEncoderParamsData(media, codec);
  return { kind: "encoder", media, codec: p.codec, params: p.params, extra: p.extra };
}

/** Id of the parameters node created for encoder `id` by pushNode. */
export const paramsIdOf = (id: string) => `${id}.params`;

/**
 * Adds `data` as node `id`. An encoder fixture is split into the encoder and a parameters
 * node (id `<id>.params`) wired to its parameters pad.
 */
export function pushNode(nodes: GNode[], edges: GEdge[], id: string, data: NodeData) {
  const position = { x: 0, y: 0 };
  if (data.kind === "encoder" && typeof data.codec === "string") {
    const { codec, params, extra, ...rest } = data as EncoderFixture;
    nodes.push({ id, position, data: rest as EncoderNodeData });
    const pid = paramsIdOf(id);
    nodes.push({ id: pid, position, data: { kind: "encparams", media: data.media, codec, params, extra } });
    edges.push({ id: `${pid}>${id}`, source: pid, sourceHandle: PARAMS_PAD, target: id, targetHandle: PARAMS_PAD });
    return;
  }
  nodes.push({ id, position, data });
}
