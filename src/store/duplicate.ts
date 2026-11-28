// Duplicating nodes: deep copies of their data, offset on the canvas, with the wires
// between the duplicated nodes (and optionally the wires feeding them) copied too.
import type { GEdge, GNode, NodeData } from "../model/types";
import { PARAMS_PAD } from "../nodes/defs";

export const DUPLICATE_OFFSET = 40;

/**
 * "C:/v/out.mp4" → "C:/v/out-2.mp4" (next number not in `taken`). An image sequence keeps its
 * frame number at the end: "frames_%05d.png" → "frames-2_%05d.png".
 */
export function nextFreePath(path: string, taken: Set<string>): string {
  if (!path.trim()) return path;
  const m = /^(.*?)(?:-(\d+))?([_. -]?%0?\d*d[^/\\]*)$/.exec(path) ?? /^(.*?)(?:-(\d+))?(\.[^./\\]*)?$/.exec(path)!;
  const stem = m[1];
  const ext = m[3] ?? "";
  for (let i = Math.max(2, Number(m[2] ?? 1) + 1); ; i++) {
    const p = `${stem}-${i}${ext}`;
    if (!taken.has(p)) return p;
  }
}

/** Deep copy without state that belongs to a running operation of the original. */
function cloneData(d: NodeData): NodeData {
  const c = structuredClone(d);
  if (c.kind === "input") delete c.probing;
  if (c.kind === "filter") {
    if (c.letterbox?.running) c.letterbox = { ...c.letterbox, running: undefined };
    // a failed option read is retried for the copy
    if (c.generic && !c.generic.help) delete c.generic.error;
  }
  return c;
}

export function duplicateNodes<N extends GNode, E extends GEdge>(
  nodes: N[],
  edges: E[],
  ids: string[],
  opts: { withInputs?: boolean; newId: (kind: string) => string },
): { nodes: N[]; edges: GEdge[]; newIds: string[] } {
  const chosen = nodes.filter((n) => ids.includes(n.id));
  const map = new Map<string, string>();
  const taken = new Set(nodes.flatMap((n) => (n.data.kind === "muxer" ? [n.data.path] : [])));
  const clones = chosen.map((n) => {
    const id = opts.newId(n.data.kind);
    map.set(n.id, id);
    const data = cloneData(n.data);
    if (data.kind === "muxer") {
      data.path = nextFreePath(data.path, taken);
      taken.add(data.path);
    }
    return { ...n, id, data, position: { x: n.position.x + DUPLICATE_OFFSET, y: n.position.y + DUPLICATE_OFFSET } } as N;
  });
  const newEdges: GEdge[] = [];
  for (const e of edges) {
    const t = map.get(e.target);
    if (!t) continue;
    // encoders keep sharing their parameters node: that wire is always copied
    const s = map.get(e.source) ?? (opts.withInputs || e.targetHandle === PARAMS_PAD ? e.source : undefined);
    if (!s) continue;
    newEdges.push({ id: `e-${s}.${e.sourceHandle}-${t}.${e.targetHandle}`, source: s, sourceHandle: e.sourceHandle, target: t, targetHandle: e.targetHandle });
  }
  return { nodes: clones, edges: newEdges, newIds: clones.map((c) => c.id) };
}
