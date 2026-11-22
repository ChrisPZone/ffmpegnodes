// Lookup in the bundled filter docs (src/docs/filterDocs.json, made by `pnpm gen:filterdocs`).
// The JSON is about 1 MB, so it is loaded on first use, not at startup.
import type { DocOption, FilterDoc } from "./texi";

export interface FilterDocsFile {
  /** FFmpeg tag the docs were read from. */
  ffmpeg: string;
  filters: FilterDoc[];
}

export interface FilterDocs {
  ffmpeg: string;
  byName: Map<string, FilterDoc>;
  byAnchor: Map<string, FilterDoc>;
}

export function indexFilterDocs(file: FilterDocsFile): FilterDocs {
  const byName = new Map<string, FilterDoc>();
  const byAnchor = new Map<string, FilterDoc>();
  for (const f of file.filters) {
    byAnchor.set(f.anchor, f);
    for (const n of f.names) if (!byName.has(n)) byName.set(n, f);
  }
  return { ffmpeg: file.ffmpeg, byName, byAnchor };
}

let loading: Promise<FilterDocs> | undefined;

export function loadFilterDocs(): Promise<FilterDocs> {
  loading ??= import("./filterDocs.json?raw").then((m) => indexFilterDocs(JSON.parse(m.default) as FilterDocsFile));
  return loading;
}

/** "scale_cuda" → "scale": hardware variants usually take the software filter's options. */
const HW_SUFFIX = /_(cuda|npp|opencl|vulkan|vaapi|qsv|vt|amf|d3d11|d3d12)$/;

export function filterDoc(docs: FilterDocs, name: string): FilterDoc | undefined {
  return docs.byName.get(name);
}

export interface OptionDocHit {
  /** The section the text comes from (may be another filter's, see `borrowed`). */
  filter: FilterDoc;
  option: DocOption;
  /** Set when the text is another filter's ("same options as pad"). */
  borrowed?: string;
}

/** An option's docs; falls back to the filter it shares options with, then the software filter. */
export function optionDoc(docs: FilterDocs, filter: string, option: string): OptionDocHit | undefined {
  const own = docs.byName.get(filter);
  const find = (f: FilterDoc | undefined) => f?.options.find((o) => o.names.includes(option));
  const hit = find(own);
  if (own && hit) return { filter: own, option: hit };
  const candidates = [own?.sameAs ? docs.byAnchor.get(own.sameAs) ?? docs.byName.get(own.sameAs) : undefined, HW_SUFFIX.test(filter) ? docs.byName.get(filter.replace(HW_SUFFIX, "")) : undefined];
  for (const f of candidates) {
    const o = find(f);
    if (f && o) return { filter: f, option: o, borrowed: f.names.includes(filter) ? undefined : f.names[0] };
  }
  return undefined;
}

export const FILTER_DOCS_URL = "https://ffmpeg.org/ffmpeg-filters.html";

export const filterDocUrl = (f: FilterDoc) => `${FILTER_DOCS_URL}#${f.anchor}`;
