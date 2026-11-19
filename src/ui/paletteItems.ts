// Everything the palette and the quick-add popup can create, plus search and pad matching.
import type { Capabilities, EncoderMedia, NodeData, PadType } from "../model/types";
import { getPads, newEncoderData, newEncoderParamsData, newFilterData, newInputData, newMuxerData, padsCompatible } from "../nodes/defs";
import { FILTERS, type FilterCategory } from "../nodes/defs/filters";
import { ioMedia, newGenericFilterData, offerGeneric, parseIo } from "../nodes/defs/generic";

export type PaletteSpec =
  | { kind: "input" }
  | { kind: "filter"; defId: string }
  /** Any filter of the ffmpeg build, as a generic node. */
  | { kind: "generic"; name: string; io: string; description: string }
  | { kind: "encoder"; media: EncoderMedia }
  | { kind: "encparams"; media: EncoderMedia }
  | { kind: "muxer" };

export function createFromSpec(spec: PaletteSpec): NodeData {
  switch (spec.kind) {
    case "input":
      return newInputData();
    case "filter":
      return newFilterData(spec.defId);
    case "generic":
      return newGenericFilterData(spec);
    case "encoder":
      return newEncoderData(spec.media);
    case "encparams":
      return newEncoderParamsData(spec.media);
    case "muxer":
      return newMuxerData();
  }
}

export interface PaletteItem {
  key: string;
  label: string;
  /** Short grey text (the ffmpeg filter name). */
  hint?: string;
  /** Header colour; undefined for neutral nodes. */
  media?: "video" | "audio" | "subtitle";
  /** Section id this item is listed under. */
  section: string;
  keywords: string[];
  description: string;
  /** ffmpeg filter name, for the "missing in this build" check. */
  ffFilter?: string;
  spec: PaletteSpec;
}

export interface PaletteSection {
  id: string;
  title: string;
  /** Heading shown above a run of sections ("Video filters"). */
  heading?: string;
  items: PaletteItem[];
}

const VIDEO_CATEGORIES: FilterCategory[] = ["Geometry", "Time", "Color", "Cleanup", "Compose", "Utility", "GPU"];
const AUDIO_CATEGORIES: FilterCategory[] = ["Levels", "EQ", "Cleanup", "Time", "Channels"];
const CATEGORY_TITLES: Partial<Record<FilterCategory, string>> = { Channels: "Channels & mixing", Compose: "Compose & text", Color: "Color" };

const filterItems = (media: "video" | "audio"): PaletteItem[] =>
  FILTERS.filter((f) => (media === "video" ? f.media !== "audio" : f.media === "audio")).map((f) => ({
    key: `filter:${f.id}`,
    label: f.label,
    hint: f.ffName,
    media: f.media === "av" ? undefined : f.media,
    section: `${media}:${f.category}`,
    keywords: [...(f.keywords ?? []), f.category.toLowerCase(), media],
    description: f.description,
    ffFilter: f.ffName,
    spec: { kind: "filter", defId: f.id },
  }));

export const PALETTE_ITEMS: PaletteItem[] = [
  { key: "input", label: "Input file", hint: "demux + decode", section: "input", keywords: ["source", "open", "file", "demux", "decode"], description: "A media file to read.", spec: { kind: "input" } },
  ...filterItems("video"),
  ...filterItems("audio"),
  ...(["video", "audio", "subtitle"] as const).map<PaletteItem>((m) => ({
    key: `encoder:${m}`,
    label: `${m[0].toUpperCase()}${m.slice(1)} encoder`,
    media: m,
    section: "input",
    keywords: ["encode", "codec", "compress", m, ...(m === "video" ? ["x264", "x265", "h264", "hevc", "av1", "nvenc"] : m === "audio" ? ["aac", "opus", "mp3", "flac"] : ["srt", "mov_text"])],
    description: `Encode ${m} frames into packets, with the settings of the ${m} encoder parameters wired to its top pad. Comes with its own parameters node.`,
    spec: { kind: "encoder", media: m },
  })),
  ...(["video", "audio", "subtitle"] as const).map<PaletteItem>((m) => ({
    key: `encparams:${m}`,
    label: `${m[0].toUpperCase()}${m.slice(1)} encoder parameters`,
    hint: "settings",
    media: m,
    section: "input",
    keywords: ["parameters", "params", "settings", "preset", "shared", "codec", m],
    description: `Codec and options for ${m} encoders. Wire its output into any number of ${m} encoders to give them the same settings.`,
    spec: { kind: "encparams", media: m },
  })),
  { key: "muxer", label: "Output file", hint: "mux", section: "input", keywords: ["mux", "save", "container", "mp4", "mkv", "export"], description: "The file to write.", spec: { kind: "muxer" } },
];

/** Every filter of this ffmpeg build that has no curated node, as generic items. */
export function genericItems(caps?: Capabilities): PaletteItem[] {
  return (caps?.filters ?? [])
    .filter(offerGeneric)
    .map((f) => {
      const media = ioMedia(f.io);
      const source = parseIo(f.io).inputs.kind === "none";
      return {
        key: `ff:${f.name}`,
        label: f.name,
        hint: f.io,
        media,
        section: source ? "ff:source" : media === "audio" ? "ff:audio" : "ff:video",
        keywords: ["ffmpeg", ...(source ? ["source", "generate"] : [])],
        description: `${f.description}

Generic node: options are read from your ffmpeg.`,
        spec: { kind: "generic" as const, name: f.name, io: f.io, description: f.description },
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Curated items first (they win ties in search), then the build's other filters. */
export function allPaletteItems(caps?: Capabilities): PaletteItem[] {
  return [...PALETTE_ITEMS, ...genericItems(caps)];
}

export function paletteSections(items: PaletteItem[] = PALETTE_ITEMS): PaletteSection[] {
  const of = (id: string) => items.filter((i) => i.section === id);
  const cats = (media: "video" | "audio", list: FilterCategory[], heading: string) =>
    list.map((c, i) => ({ id: `${media}:${c}`, title: CATEGORY_TITLES[c] ?? c, heading: i === 0 ? heading : undefined, items: of(`${media}:${c}`) }));
  return [
    { id: "input", title: "Input / Output", items: of("input") },
    ...cats("video", VIDEO_CATEGORIES, "Video filters"),
    ...cats("audio", AUDIO_CATEGORIES, "Audio filters"),
    ...[
      { id: "ff:video", title: "Video", items: of("ff:video") },
      { id: "ff:audio", title: "Audio", items: of("ff:audio") },
      { id: "ff:source", title: "Sources (generate)", items: of("ff:source") },
    ]
      .filter((s) => s.items.length > 0)
      .map((s, i) => (i === 0 ? { ...s, heading: "All ffmpeg filters" } : s)),
  ].filter((s) => s.items.length > 0);
}

/** Sections open until the user toggles them. */
export const DEFAULT_OPEN = new Set(["input", "video:Geometry", "audio:Levels"]);

// ---------------------------------------------------------------- search

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

/** Best match tier of one query token in an item (higher is better, 0 = no match). */
function tokenScore(it: PaletteItem, tok: string): number {
  const label = it.label.toLowerCase();
  if (label.startsWith(tok)) return 100;
  if (words(label).some((w) => w.startsWith(tok))) return 80;
  if (label.includes(tok)) return 60;
  if (it.keywords.some((k) => k.toLowerCase().startsWith(tok) || words(k).some((w) => w.startsWith(tok)))) return 50;
  if (it.hint?.toLowerCase().includes(tok)) return 40;
  if (it.keywords.some((k) => k.toLowerCase().includes(tok))) return 30;
  if (it.description.toLowerCase().includes(tok)) return 10;
  return 0;
}

/** Items matching every token of `query`, best first (stable for ties). Empty query → all. */
export function matchItems(query: string, items: PaletteItem[] = PALETTE_ITEMS): PaletteItem[] {
  const toks = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return items;
  return items
    .map((it, i) => {
      let score = 0;
      for (const t of toks) {
        const s = tokenScore(it, t);
        if (!s) return undefined;
        score += s;
      }
      return { it, i, score };
    })
    .filter((x): x is { it: PaletteItem; i: number; score: number } => !!x)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.it);
}

// ---------------------------------------------------------------- wire-drop matching

/** The pad a wire was dragged from: an output ("source") or an input ("target") pad. */
export interface DragFrom {
  type: PadType;
  side: "source" | "target";
}

/** The pad of a freshly created node that `from` can connect to, if any. */
export function matchingPad(spec: PaletteSpec, from: DragFrom): string | undefined {
  const pads = getPads({ id: "new", position: { x: 0, y: 0 }, data: createFromSpec(spec) });
  if (from.side === "source") return pads.inputs.find((p) => padsCompatible(from.type, p.type))?.id;
  return pads.outputs.find((p) => padsCompatible(p.type, from.type))?.id;
}
