// Generic filter node: any filter of the user's ffmpeg build. Pads come from the `-filters`
// io string ("VV->V", "N->A", "|->V") until `ffmpeg -h filter=<name>` has been read; options
// come from that help text. The parsed help is stored in the node so projects stay self-contained.
import type { FilterHelp, FilterNodeData, GenericFilterSpec, HelpOption, HelpPads, PadDef, PadMedia, ParamValues } from "../../model/types";

export type { FilterHelp, GenericFilterSpec, HelpOption, HelpPads, PadMedia };
import { FILTERS, FILTERS_BY_ID, type FilterDef, type FilterParamDef } from "./filters";

export const GENERIC_ID = "generic";

// ---------------------------------------------------------------- help parsing

const OPTION_RE = /^ {3}(\S+)\s+<([\w]+)>\s+([.A-Z]{6,})\s?(.*)$/;
// flags constants have no value column
const CONST_RE = /^ {5}(\S+)\s+(?:(\S+)\s+)?([.A-Z]{6,})\s?(.*)$/;
const PAD_RE = /^\s+#\d+: (.*) \((\w+)\)\s*$/;

/** "(from 0 to INT_MAX)" bounds; unbounded/huge values are dropped. */
function bound(s: string): number | undefined {
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? n : undefined;
}

function splitDescription(raw: string): { description: string; default?: string; min?: number; max?: number } {
  let text = raw.trim();
  let dflt: string | undefined;
  const q = /\s*\(default "(.*)"\)\s*$/.exec(text);
  const u = q ? undefined : /\s*\(default ([^"]*?)\)\s*$/.exec(text);
  if (q || u) {
    dflt = (q ?? u)![1];
    text = text.slice(0, (q ?? u)!.index);
  }
  let min: number | undefined;
  let max: number | undefined;
  const r = /\s*\(from (\S+) to (\S+?)\)\s*$/.exec(text);
  if (r) {
    min = bound(r[1]);
    max = bound(r[2]);
    text = text.slice(0, r.index);
  }
  return { description: text.trim(), default: dflt, min, max };
}

/** Parses `ffmpeg -h filter=<name>`. Options of every AVOptions section, first occurrence wins. */
export function parseFilterHelp(text: string): FilterHelp {
  const lines = text.split(/\r?\n/);
  const help: FilterHelp = { description: "", inputs: { kind: "none" }, outputs: { kind: "none" }, options: [], timeline: false };
  let side: "inputs" | "outputs" | undefined;
  let inOptions = false;
  let current: HelpOption | undefined;
  const seen = new Set<string>();
  for (const line of lines) {
    if (/^Filter \S+/.test(line)) continue;
    if (/support for timeline through the 'enable' option/.test(line)) {
      help.timeline = true;
      continue;
    }
    if (/AVOptions:\s*$/.test(line)) {
      inOptions = true;
      side = undefined;
      current = undefined;
      continue;
    }
    if (!inOptions) {
      const t = line.trim();
      if (t === "Inputs:" || t === "Outputs:") {
        side = t === "Inputs:" ? "inputs" : "outputs";
        help[side] = { kind: "static", pads: [] };
        continue;
      }
      if (side) {
        const pad = PAD_RE.exec(line);
        const pads = help[side];
        if (pad && pads.kind === "static") {
          pads.pads.push({ name: pad[1], media: pad[2] === "audio" ? "audio" : "video" });
          continue;
        }
        if (/^dynamic\b/.test(t)) help[side] = { kind: "dynamic" };
        else if (/^none\b/.test(t)) help[side] = { kind: "none" };
        continue;
      }
      if (t && !help.description && !/threading supported|^Exiting/.test(t)) help.description = t;
      continue;
    }
    const o = OPTION_RE.exec(line);
    if (o) {
      const [, name, type, , rest] = o;
      const d = splitDescription(rest);
      const prev = help.options[help.options.length - 1];
      if (prev && d.description && prev.type === type && prev.description === d.description && prev.default === d.default) {
        // alias line ("a" after "angle")
        if (!seen.has(name)) prev.aliases.push(name);
        seen.add(name);
        current = undefined; // its constants repeat the main option's
        continue;
      }
      if (seen.has(name)) {
        current = undefined; // repeated in a later section (framesync after overlay)
        continue;
      }
      seen.add(name);
      current = { name, type, description: d.description, default: d.default, min: d.min, max: d.max, consts: [], aliases: [] };
      help.options.push(current);
      continue;
    }
    const c = CONST_RE.exec(line);
    if (c && current) {
      current.consts.push({ name: c[1], value: c[2] ?? "", description: c[4].trim() });
      continue;
    }
    if (line.trim() === "") current = undefined;
  }
  return help;
}

// ---------------------------------------------------------------- io string

/** "VV->V" → per-side pad media; "N" = dynamic, "|" = none. */
export function parseIo(io: string): { inputs: HelpPads; outputs: HelpPads } {
  const [a = "", b = ""] = io.split("->");
  const side = (s: string): HelpPads => {
    if (s === "|" || s === "") return { kind: "none" };
    if (s.includes("N")) return { kind: "dynamic" };
    return { kind: "static", pads: [...s].map((ch) => ({ name: "default", media: ch === "A" ? "audio" : "video" })) };
  };
  return { inputs: side(a), outputs: side(b) };
}

const isSink = (io: string) => io.endsWith("->|");

/** Curated nodes cover these; the generic versions are left out of the palette. setpts and pan stay (expressions). */
const CURATED = new Set([...FILTERS.map((f) => f.ffName), "vflip", "setdar", "lowpass", "vstack"].filter((n) => n !== "setpts" && n !== "pan"));
/** Hardware filters need devices and hw frames the generic node cannot set up. */
const HW_RE = /(_cuda|_npp|_vaapi|_qsv|_opencl|_vulkan|_videotoolbox|_amf|_d3d11|_d3d12)$|^hw(upload|download|map)$/;

/** Filters offered as generic nodes. */
export function offerGeneric(f: { name: string; io: string }): boolean {
  return !isSink(f.io) && !CURATED.has(f.name) && !HW_RE.test(f.name);
}

/** Media a generic filter mostly produces (palette colour / grouping). */
export function ioMedia(io: string): PadMedia | undefined {
  const out = io.split("->")[1] ?? "";
  if (out.includes("V")) return "video";
  if (out.includes("A")) return "audio";
  const inp = io.split("->")[0] ?? "";
  if (inp.includes("V")) return "video";
  if (inp.includes("A")) return "audio";
  return undefined;
}

// ---------------------------------------------------------------- FilterDef from a spec

const COUNT_INPUTS = ["inputs", "nb_inputs"];
const COUNT_OUTPUTS = ["outputs", "nb_outputs"];
/** UI-only params of the generic node. */
export const RAW_PARAM = "_raw";

function toParam(o: HelpOption): FilterParamDef {
  const base = { name: o.name, label: o.name, description: [o.description, o.aliases.length ? `Alias: ${o.aliases.join(", ")}.` : ""].filter(Boolean).join(" ") };
  const dflt = o.default ?? "";
  const numeric = ["int", "int64", "uint", "uint64", "float", "double"].includes(o.type);
  if ((o.type === "boolean" || o.type === "bool") && (dflt === "true" || dflt === "false")) {
    return { ...base, type: "bool", default: dflt === "true" };
  }
  if (o.type === "boolean" || o.type === "bool") {
    return { ...base, type: "enum", default: dflt, options: [{ value: dflt, label: dflt || "default" }, { value: "true" }, { value: "false" }].filter((x, i, a) => a.findIndex((y) => y.value === x.value) === i) };
  }
  if (numeric && o.consts.length) {
    // the default is printed as a constant name, or as a number matching one
    const named = o.consts.find((c) => c.name === dflt) ?? o.consts.find((c) => c.value === dflt);
    const value = named?.name ?? dflt;
    const options = o.consts.map((c) => ({ value: c.name, label: c.description ? `${c.name} — ${c.description}` : c.name }));
    if (!options.some((x) => x.value === value)) options.unshift({ value, label: value || "default" });
    return { ...base, type: "enum", default: value, options };
  }
  if (o.type === "flags") {
    const names = o.consts.map((c) => c.name);
    return {
      ...base,
      type: "string",
      default: dflt === "0" ? "" : dflt,
      placeholder: names.length ? names.slice(0, 4).join("+") : undefined,
      description: [base.description, names.length ? `Flags (join with +): ${names.join(", ")}.` : ""].filter(Boolean).join(" "),
    };
  }
  if (numeric) {
    const n = Number(dflt);
    if (dflt !== "" && Number.isFinite(n)) {
      const span = o.min !== undefined && o.max !== undefined ? o.max - o.min : Infinity;
      const ranged = span <= 10000;
      const isInt = o.type.includes("int");
      return {
        ...base,
        type: isInt ? "int" : "float",
        default: n,
        min: ranged ? o.min : undefined,
        max: ranged ? o.max : undefined,
        step: isInt ? 1 : span <= 2 ? 0.01 : undefined,
        description: [base.description, !ranged && (o.min !== undefined || o.max !== undefined) ? `Range ${o.min ?? "…"} to ${o.max ?? "…"}.` : ""].filter(Boolean).join(" "),
      };
    }
  }
  return { ...base, type: "string", default: dflt, placeholder: o.type !== "string" ? `<${o.type}>` : undefined };
}

const pad = (dir: "in" | "out", i: number, name: string, media: PadMedia): PadDef => ({
  id: `${dir}${i}`,
  label: name === "default" ? (dir === "in" ? "in" : "out") : name,
  type: { domain: "frames", media },
});

const clampCount = (v: unknown) => Math.max(1, Math.min(16, Math.round(Number(v)) || 2));

const cache = new WeakMap<GenericFilterSpec, FilterDef>();

/** The FilterDef of a generic node (memoized per spec object). */
export function genericDef(spec: GenericFilterSpec): FilterDef {
  const hit = cache.get(spec);
  if (hit) return hit;
  const io = parseIo(spec.io);
  const help = spec.help;
  const sides = { inputs: help?.inputs ?? io.inputs, outputs: help?.outputs ?? io.outputs };
  // a help text without "Inputs:" (very old ffmpeg) falls back to the io string
  if (help && help.inputs.kind === "none" && io.inputs.kind !== "none") sides.inputs = io.inputs;
  if (help && help.outputs.kind === "none" && io.outputs.kind !== "none") sides.outputs = io.outputs;
  const options = (help?.options ?? []).map(toParam);
  const names = new Set(options.map((o) => o.name));

  const staticMedia = (s: HelpPads) => (s.kind === "static" ? s.pads[0]?.media : undefined);
  const ui: FilterParamDef[] = [];
  const dynamic = (dir: "in" | "out", s: HelpPads, other: HelpPads, countNames: string[]) => {
    if (s.kind !== "dynamic") return undefined;
    const countOpt = countNames.find((n) => names.has(n));
    const countParam = countOpt ?? `_n${dir}`;
    if (!countOpt) {
      ui.push({ name: countParam, label: `${dir === "in" ? "Input" : "Output"} pads`, type: "int", default: 2, min: 1, max: 16, ui: true, description: "How many pads to show. Must match what the filter's options produce." });
    }
    const mediaParam = `_m${dir}`;
    const guess: PadMedia = staticMedia(other) ?? ioMedia(spec.io) ?? "video";
    ui.push({ name: mediaParam, label: `${dir === "in" ? "Input" : "Output"} pad media`, type: "enum", default: guess, options: [{ value: "video" }, { value: "audio" }], ui: true });
    return (p: ParamValues) =>
      Array.from({ length: clampCount(p[countParam]) }, (_, i) => pad(dir, i, `${dir} ${i}`, p[mediaParam] === "audio" ? "audio" : "video"));
  };
  const staticPads = (dir: "in" | "out", s: HelpPads) => (s.kind === "static" ? s.pads.map((x, i) => pad(dir, i, x.name, x.media)) : []);
  const dynIn = dynamic("in", sides.inputs, sides.outputs, COUNT_INPUTS);
  const dynOut = dynamic("out", sides.outputs, sides.inputs, COUNT_OUTPUTS);
  const withDefaults = (p: ParamValues) => ({ ...Object.fromEntries([...ui, ...options].map((x) => [x.name, x.default])), ...p });
  const inputs = (p: ParamValues) => (dynIn ? dynIn(withDefaults(p)) : staticPads("in", sides.inputs));
  const outputs = (p: ParamValues) => (dynOut ? dynOut(withDefaults(p)) : staticPads("out", sides.outputs));

  const params: FilterParamDef[] = [
    ...options,
    ...(help?.timeline ? [{ name: "enable", label: "enable", type: "string" as const, default: "", placeholder: "between(t,5,10)", description: "Timeline: apply only while this expression is non-zero." }] : []),
    ...ui,
    { name: RAW_PARAM, label: "Extra options", type: "string", default: "", ui: true, placeholder: "key=value:key2=value2", description: "Appended to the filter's options as written (filtergraph syntax, no extra escaping)." },
  ];
  const medias = new Set([...inputs({}), ...outputs({})].map((x) => x.type.media));
  const def: FilterDef = {
    id: GENERIC_ID,
    ffName: spec.name,
    label: spec.name,
    media: medias.size > 1 ? "av" : medias.has("audio") ? "audio" : "video",
    category: "Utility",
    description: help?.description || spec.description,
    params,
    inputs,
    outputs,
    // formats are unknown: keep only the media of each output
    transform: (_ins, p) => outputs(p).map((o) => (o.type.media === "audio" ? { media: "audio" } : { media: "video" })),
    build: (p, args) => {
      const text = args(spec.name);
      const raw = String(p[RAW_PARAM] ?? "").trim();
      if (!raw) return text;
      return text.includes("=") ? `${text}:${raw}` : `${text}=${raw}`;
    },
  };
  cache.set(spec, def);
  return def;
}

/** The definition behind any filter node: curated, or generated for a generic node. */
export function filterDefOf(d: FilterNodeData): FilterDef | undefined {
  if (d.defId === GENERIC_ID) return d.generic ? genericDef(d.generic as GenericFilterSpec) : undefined;
  return FILTERS_BY_ID[d.defId];
}

export function newGenericFilterData(spec: { name: string; io: string; description: string }): FilterNodeData {
  return { kind: "filter", defId: GENERIC_ID, params: {}, generic: { name: spec.name, io: spec.io, description: spec.description } };
}
