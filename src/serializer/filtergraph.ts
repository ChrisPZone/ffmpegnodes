// Builds the -filter_complex string from the filter nodes upstream of encoders.
//
// Every frames output pad gets a label. A pad consumed more than once is fanned out with
// split/asplit, an unconsumed one is terminated with nullsink, and linear chains are joined
// with "," instead of labels so the result reads like hand-written ffmpeg.
import type { Diagnostic, FilterNodeData, GEdge, GNode, ParamValue } from "../model/types";
import { type FilterDef } from "../nodes/defs/filters";
import { filterDefOf } from "../nodes/defs/generic";
import { escapeFilterGraph, escapeOptionValue } from "./escape";

export interface Label {
  id: number;
  /** Media of the stream on this label (for naming and split vs asplit). */
  media: "video" | "audio";
  /** Set when an encoder consumes this label through -map. */
  final?: boolean;
  name?: string;
}

export type StreamRef = { kind: "input"; spec: string } | { kind: "label"; label: Label };

interface Stmt {
  inputs: StreamRef[];
  text: string;
  outputs: Label[];
}

export interface FrameSource {
  nodeId: string;
  padId: string;
}

const key = (nodeId: string, padId: string) => `${nodeId}|${padId}`;

function renderValue(v: ParamValue): string {
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

/** ffmpeg reads "C:/x" fine and backslashes would need doubling on top of the ':' escape. */
const filePath = (v: string) => v.replace(/\\/g, "/");

/**
 * "name=a:b:key=value" with both escaping levels applied. `ffName` and `only` let a
 * def's `build` render its params under another filter name or a subset of them.
 */
export function filterArgs(def: FilterDef, params: Record<string, ParamValue>, ffName = def.ffName, only?: string[]): string {
  const parts: string[] = [];
  let positionalOpen = true;
  const values = { ...Object.fromEntries(def.params.map((p) => [p.name, p.default])), ...params };
  for (const p of def.params) {
    if (p.ui || (only && !only.includes(p.name))) continue;
    if (p.visibleIf && !p.visibleIf(values)) continue;
    const raw = params[p.name] ?? p.default;
    const value = p.type === "file" ? filePath(renderValue(raw)) : renderValue(raw);
    const isDefault = raw === p.default;
    if (p.positional && positionalOpen) {
      if (value === "") {
        positionalOpen = false;
        continue;
      }
      parts.push(escapeOptionValue(value));
      continue;
    }
    if (value === "" || (isDefault && !p.always)) continue;
    parts.push(`${p.name}=${escapeOptionValue(value)}`);
  }
  const args = escapeFilterGraph(parts.join(":"));
  return args ? `${ffName}=${args}` : ffName;
}

/** The filter text a node contributes: one filter, or a short chain via `def.build`. */
export function filterText(def: FilterDef, params: Record<string, ParamValue>): string {
  if (!def.build) return filterArgs(def, params);
  const values = { ...Object.fromEntries(def.params.map((p) => [p.name, p.default])), ...params };
  return def.build(values, (ffName, only) => filterArgs(def, params, ffName, only));
}

export class FilterGraphBuilder {
  private stmts: Stmt[] = [];
  private nextLabel = 0;
  private pools = new Map<string, Label[]>();
  private emitted = new Set<string>();
  private visiting = new Set<string>();
  private uses = new Map<string, number>();

  constructor(
    private nodes: Map<string, GNode>,
    private edges: GEdge[],
    /** Resolves an Input-node frames pad to an ffmpeg input stream spec ("0:v"). */
    private inputSpec: (src: FrameSource) => string | undefined,
    private diagnostics: Diagnostic[],
    /** Filter text to put between a frames source and a consumer (GPU upload/download), if any. */
    private transfer: (consumerId: string, src: FrameSource) => string | undefined = () => undefined,
  ) {}

  /** Pass a stream through `text` first (e.g. hwupload_cuda); returns the new stream. */
  wrap(r: StreamRef, text: string, media: "video" | "audio" = "video"): StreamRef {
    const l = this.label(media);
    this.stmts.push({ inputs: [r], text, outputs: [l] });
    return { kind: "label", label: l };
  }

  private incoming(nodeId: string, padId: string): GEdge | undefined {
    return this.edges.find((e) => e.target === nodeId && e.targetHandle === padId);
  }

  private filterNode(id: string): GNode<FilterNodeData> | undefined {
    const n = this.nodes.get(id);
    return n?.data.kind === "filter" ? (n as GNode<FilterNodeData>) : undefined;
  }

  /**
   * Count consumers of each filter output pad. `sinks` are the frames sources of every
   * encode (an encoder feeding two outputs counts twice: each output is its own encode).
   */
  plan(sinks: FrameSource[]) {
    const live = new Set<string>();
    const stack = sinks.map((s) => s.nodeId);
    while (stack.length) {
      const id = stack.pop()!;
      const f = this.filterNode(id);
      if (!f || live.has(id)) continue;
      live.add(id);
      for (const e of this.edges) if (e.target === id) stack.push(e.source);
    }
    const bump = (k: string) => this.uses.set(k, (this.uses.get(k) ?? 0) + 1);
    for (const id of live) {
      for (const e of this.edges) {
        if (e.target === id && this.filterNode(e.source)) bump(key(e.source, e.sourceHandle ?? ""));
      }
    }
    for (const s of sinks) if (this.filterNode(s.nodeId)) bump(key(s.nodeId, s.padId));
  }

  /** Stream reference for a frames source; emits upstream filters on first use. */
  ref(src: FrameSource): StreamRef | undefined {
    const node = this.nodes.get(src.nodeId);
    if (!node) return undefined;
    if (node.data.kind === "input") {
      const spec = this.inputSpec(src);
      return spec ? { kind: "input", spec } : undefined;
    }
    if (node.data.kind !== "filter") return undefined;
    if (!this.emitFilter(node as GNode<FilterNodeData>)) return undefined;
    const label = this.pools.get(key(src.nodeId, src.padId))?.shift();
    if (!label) {
      this.diagnostics.push({ severity: "error", nodeId: src.nodeId, message: `Internal: no free label for pad ${src.padId}.` });
      return undefined;
    }
    return { kind: "label", label };
  }

  private emitFilter(node: GNode<FilterNodeData>): boolean {
    if (this.emitted.has(node.id)) return true;
    if (this.visiting.has(node.id)) {
      this.diagnostics.push({ severity: "error", nodeId: node.id, message: "The graph contains a cycle." });
      return false;
    }
    const def = filterDefOf(node.data);
    if (!def) {
      this.diagnostics.push({ severity: "error", nodeId: node.id, message: `Unknown filter "${node.data.defId}".` });
      return false;
    }
    this.visiting.add(node.id);
    const inputs: StreamRef[] = [];
    let ok = true;
    for (const pad of def.inputs(node.data.params)) {
      const e = this.incoming(node.id, pad.id);
      if (!e) {
        this.diagnostics.push({ severity: "error", nodeId: node.id, message: `${def.label}: input "${pad.label}" is not connected.` });
        ok = false;
        continue;
      }
      const src = { nodeId: e.source, padId: e.sourceHandle ?? "" };
      const r = this.ref(src);
      if (!r) ok = false;
      else {
        const t = this.transfer(node.id, src);
        inputs.push(t ? this.wrap(r, t) : r);
      }
    }
    this.visiting.delete(node.id);
    if (!ok) return false;

    const outLabels: Label[] = [];
    const after: Stmt[] = [];
    for (const pad of def.outputs(node.data.params)) {
      const media = pad.type.media === "audio" ? "audio" : "video";
      const l = this.label(media);
      outLabels.push(l);
      const n = this.uses.get(key(node.id, pad.id)) ?? 0;
      if (n === 0) {
        after.push({ inputs: [{ kind: "label", label: l }], text: media === "audio" ? "anullsink" : "nullsink", outputs: [] });
        this.pools.set(key(node.id, pad.id), []);
      } else if (n === 1) {
        this.pools.set(key(node.id, pad.id), [l]);
      } else {
        const outs = Array.from({ length: n }, () => this.label(media));
        after.push({ inputs: [{ kind: "label", label: l }], text: `${media === "audio" ? "asplit" : "split"}=${n}`, outputs: outs });
        this.pools.set(key(node.id, pad.id), [...outs]);
      }
    }
    this.stmts.push({ inputs, text: filterText(def, node.data.params), outputs: outLabels }, ...after);
    this.emitted.add(node.id);
    return true;
  }

  private label(media: "video" | "audio"): Label {
    return { id: this.nextLabel++, media };
  }

  /** Join A,B when A's only output is B's only input; then name labels. */
  build(): string {
    const stmts = [...this.stmts];
    let merged = true;
    while (merged) {
      merged = false;
      for (const a of stmts) {
        if (a.outputs.length !== 1 || a.outputs[0].final) continue;
        const l = a.outputs[0];
        const b = stmts.find((s) => s !== a && s.inputs.length === 1 && s.inputs[0].kind === "label" && s.inputs[0].label === l);
        if (!b) continue;
        b.inputs = a.inputs;
        b.text = `${a.text},${b.text}`;
        stmts.splice(stmts.indexOf(a), 1);
        merged = true;
        break;
      }
    }
    const finals = stmts.flatMap((s) => s.outputs).filter((l) => l.final);
    for (const media of ["video", "audio"] as const) {
      const ofMedia = finals.filter((l) => l.media === media);
      const letter = media === "video" ? "v" : "a";
      ofMedia.forEach((l, i) => (l.name = ofMedia.length === 1 ? letter : `${letter}${i}`));
    }
    let t = 0;
    for (const s of stmts) for (const l of [...s.outputs, ...s.inputs.flatMap((r) => (r.kind === "label" ? [r.label] : []))]) {
      if (!l.name) l.name = `t${t++}`;
    }
    const ref = (r: StreamRef) => `[${r.kind === "input" ? r.spec : r.label.name}]`;
    return stmts.map((s) => `${s.inputs.map(ref).join("")}${s.text}${s.outputs.map((l) => `[${l.name}]`).join("")}`).join(";");
  }

  get empty() {
    return this.stmts.length === 0;
  }
}
