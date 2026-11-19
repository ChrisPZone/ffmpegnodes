// Everything computed from the graph (command, formats, diagnostics), computed once per change.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Diagnostic, Graph } from "../model/types";
import { serialize, type SerializeResult } from "../serializer";
import { useGraph } from "../store/graph";
import { validate } from "../validation/diagnostics";
import { negotiate, type Negotiation } from "../validation/negotiate";

export interface Derived {
  graph: Graph;
  ser: SerializeResult;
  neg: Negotiation;
  diagnostics: Diagnostic[];
  errors: number;
  byNode: Map<string, Diagnostic[]>;
  byEdge: Map<string, Diagnostic[]>;
}

const Ctx = createContext<Derived | null>(null);

export function DerivedProvider({ children }: { children: ReactNode }) {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const caps = useGraph((s) => s.caps);
  const gpus = useGraph((s) => s.gpus);
  const value = useMemo<Derived>(() => {
    const graph: Graph = { nodes, edges };
    const ser = serialize(graph);
    const neg = negotiate(graph);
    const diagnostics = validate(graph, ser, neg, caps, gpus);
    const byNode = new Map<string, Diagnostic[]>();
    const byEdge = new Map<string, Diagnostic[]>();
    for (const d of diagnostics) {
      if (d.nodeId) byNode.set(d.nodeId, [...(byNode.get(d.nodeId) ?? []), d]);
      if (d.edgeId) byEdge.set(d.edgeId, [...(byEdge.get(d.edgeId) ?? []), d]);
    }
    return { graph, ser, neg, diagnostics, errors: diagnostics.filter((d) => d.severity === "error").length, byNode, byEdge };
  }, [nodes, edges, caps, gpus]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDerived(): Derived {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDerived outside DerivedProvider");
  return v;
}

/** Arguments actually passed to ffmpeg when running (progress on stdout, overwrite without asking). */
export const RUN_PREFIX = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"];
