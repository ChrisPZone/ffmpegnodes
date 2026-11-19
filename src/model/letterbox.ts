// Helpers for the "Remove letterbox" node: where its frames come from, the detection
// options from its params, and its diagnostics.
import { parseInputPad } from "../nodes/defs";
import type { Diagnostic, FilterNodeData, GNode, Graph, InputNodeData, LetterboxOptions, ParamValues, StreamInfo } from "./types";

export const LETTERBOX_ID = "letterbox";

export interface LetterboxSource {
  input: GNode<InputNodeData>;
  stream?: StreamInfo;
  /** Filters between the Input and this node (their geometry may differ from the file's). */
  hops: number;
}

/** Follows the node's video input back to an Input node and its stream. */
export function letterboxSource(g: Graph, nodeId: string): LetterboxSource | undefined {
  let id = nodeId;
  for (let hops = 0; hops < 200; hops++) {
    const e = g.edges.find((x) => x.target === id);
    if (!e) return undefined;
    const src = g.nodes.find((x) => x.id === e.source);
    if (!src) return undefined;
    if (src.data.kind === "input") {
      const pad = parseInputPad(e.sourceHandle ?? "");
      const stream = src.data.probe?.streams.find((s) => s.index === pad?.streamIndex);
      return { input: src as GNode<InputNodeData>, stream, hops };
    }
    id = src.id;
  }
  return undefined;
}

const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function letterboxOptions(p: ParamValues): LetterboxOptions {
  return {
    samples: Math.max(1, Math.round(n(p.samples, 9))),
    startFrac: n(p.startPct, 10) / 100,
    endFrac: n(p.endPct, 90) / 100,
    blackLevel: Math.max(0, Math.min(255, Math.round(n(p.blackLevel, 10)))),
    rowContentFrac: n(p.rowContentPct, 5) / 100,
    darkFrameMean: n(p.darkMean, 30),
  };
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Problems of one Remove-letterbox node. `inHeight` is the negotiated height of its input. */
export function letterboxDiagnostics(g: Graph, node: GNode<FilterNodeData>, inHeight: number | undefined): Diagnostic[] {
  const out: Diagnostic[] = [];
  const d = node.data;
  const st = d.letterbox;
  const src = letterboxSource(g, node.id);
  const top = n(d.params.top, 0);
  const bottom = n(d.params.bottom, 0);
  if (st?.error) out.push({ severity: "warning", nodeId: node.id, message: `Letterbox detection failed: ${st.error}` });
  else if (!st?.path && !st?.running && top === 0 && bottom === 0) {
    out.push({ severity: "info", nodeId: node.id, message: src ? "Bars not detected yet: press Detect." : "Connect a video stream from an Input to detect the bars." });
  }
  if (st?.path && src && src.input.data.path.trim() && st.path !== src.input.data.path.trim()) {
    out.push({ severity: "warning", nodeId: node.id, message: `Bars were detected on ${base(st.path)}, but the Input is now ${base(src.input.data.path)}. Detect again.` });
  }
  if (st?.height && inHeight && st.height !== inHeight) {
    out.push({
      severity: "warning",
      nodeId: node.id,
      message: `Bars were measured on ${st.height}-line frames, but this node receives ${inHeight}. Put it directly after the Input, or adjust the values.`,
    });
  }
  if (inHeight && top + bottom >= inHeight) out.push({ severity: "error", nodeId: node.id, message: `Top + bottom (${top + bottom} px) leave no picture of the ${inHeight}-line frame.` });
  if (top % 2 || bottom % 2) out.push({ severity: "warning", nodeId: node.id, message: "Odd bar heights: most encoders need even sizes for 4:2:0 video." });
  return out;
}
