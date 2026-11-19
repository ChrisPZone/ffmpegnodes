import type { GEdge, Graph } from "../model/types";
import { findPad, padsCompatible } from "../nodes/defs";

export interface ConnectionLike {
  source: string | null;
  sourceHandle?: string | null;
  target: string | null;
  targetHandle?: string | null;
}

/** Would adding source→target close a loop? (true if target already reaches source) */
export function createsCycle(edges: GEdge[], source: string, target: string): boolean {
  if (source === target) return true;
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.source === id) stack.push(e.target);
  }
  return false;
}

export function checkConnection(g: Graph, c: ConnectionLike): { ok: boolean; reason?: string } {
  if (!c.source || !c.target) return { ok: false };
  const src = g.nodes.find((n) => n.id === c.source);
  const dst = g.nodes.find((n) => n.id === c.target);
  const sp = findPad(src, c.sourceHandle, "source");
  const tp = findPad(dst, c.targetHandle, "target");
  if (!sp || !tp) return { ok: false, reason: "Unknown pad" };
  if (!padsCompatible(sp.type, tp.type)) {
    return { ok: false, reason: `Cannot connect ${sp.type.media} ${sp.type.domain} to ${tp.type.media} ${tp.type.domain}` };
  }
  if (createsCycle(g.edges, c.source, c.target)) return { ok: false, reason: "That would create a loop" };
  return { ok: true };
}
