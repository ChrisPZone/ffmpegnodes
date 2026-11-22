// Regenerates src/docs/filterDocs.json from FFmpeg's doc/filters.texi.
//
//   pnpm gen:filterdocs            newest FFmpeg release
//   pnpm gen:filterdocs n8.0       a given tag or commit
//   pnpm gen:filterdocs -- --force  write even when the sanity checks fail
//
// Runs with plain node (type stripping); src/docs/texi.ts has no imports for that reason.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFiltersTexi, type FilterDoc } from "../src/docs/texi.ts";
import { latestReleaseTag } from "./ffmpeg-tags.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "src", "docs", "filterDocs.json");
/** Filters the app relies on; their docs must parse with options. */
const REQUIRED = ["scale", "crop", "pad", "eq", "overlay", "drawtext", "volume", "loudnorm"];
const MIN_FILTERS = 400;

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const ref: string = argv.find((a) => !a.startsWith("--")) ?? latestReleaseTag();

const url = `https://raw.githubusercontent.com/FFmpeg/FFmpeg/${ref}/doc/filters.texi`;
console.log(`Reading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
const filters = parseFiltersTexi(await res.text());

const names = (fs: FilterDoc[]) => new Set(fs.flatMap((f) => f.names));
const now = names(filters);
const problems: string[] = [];
if (now.size < MIN_FILTERS) problems.push(`only ${now.size} filters parsed (expected at least ${MIN_FILTERS})`);
for (const r of REQUIRED) {
  const f = filters.find((x) => x.names.includes(r));
  if (!f?.options.length) problems.push(`${r}: no options parsed`);
}

let before: Set<string> = new Set();
let beforeRef = "";
if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, "utf8")) as { ffmpeg: string; filters: FilterDoc[] };
  before = names(prev.filters);
  beforeRef = prev.ffmpeg;
  const lost = [...before].filter((n) => !now.has(n));
  if (lost.length > before.size * 0.05) problems.push(`${lost.length} of ${before.size} filters disappeared`);
}

const added = [...now].filter((n) => before.size && !before.has(n));
const removed = [...before].filter((n) => !now.has(n));
const optionCount = filters.reduce((s, f) => s + f.options.length, 0);
console.log(`FFmpeg ${ref}${beforeRef && beforeRef !== ref ? ` (was ${beforeRef})` : ""}: ${now.size} filters in ${filters.length} sections, ${optionCount} options`);
if (added.length) console.log(`  added: ${added.join(" ")}`);
if (removed.length) console.log(`  removed: ${removed.join(" ")}`);

if (problems.length) {
  for (const p of problems) console.error(`  problem: ${p}`);
  if (!force) {
    console.error("Not written. Fix the parser, or pass --force.");
    process.exit(1);
  }
}

// one filter per line keeps diffs readable; LF line endings on every platform
const text = `{"ffmpeg":${JSON.stringify(ref)},"filters":[\n${filters.map((f) => JSON.stringify(f)).join(",\n")}\n]}\n`;
writeFileSync(OUT, Buffer.from(text, "utf8"));
console.log(`Wrote ${OUT.slice(root.length + 1)} (${Math.round(text.length / 1024)} KB)`);
