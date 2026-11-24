// Regenerates the bundled ffmpeg docs for the help popups from FFmpeg's texinfo sources:
//   src/docs/filterDocs.json  filters.texi
//   src/docs/optionDocs.json  encoders.texi, codecs.texi ("Codec Options"), ffmpeg.texi ("Options")
//
//   pnpm gen:docs              newest FFmpeg release
//   pnpm gen:docs n8.0         a given tag or commit
//   pnpm gen:docs -- --force   write even when the sanity checks fail
//
// Runs with plain node (type stripping); src/docs/texi.ts has no imports for that reason.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEncodersTexi, parseFiltersTexi, parseOptionChapter, type DocOption, type FilterDoc } from "../src/docs/texi.ts";
import { latestReleaseTag } from "./ffmpeg-tags.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILTERS_OUT = join(root, "src", "docs", "filterDocs.json");
const OPTIONS_OUT = join(root, "src", "docs", "optionDocs.json");
/** Filters, encoders and options the app relies on; their docs must parse. */
const REQUIRED_FILTERS = ["scale", "crop", "pad", "eq", "overlay", "drawtext", "volume", "loudnorm"];
const REQUIRED_ENCODERS = ["libx264", "libx265", "h264_nvenc", "aac", "libopus"];
const REQUIRED_CODEC = ["b", "maxrate", "bufsize", "threads", "g"];
const REQUIRED_CLI = ["ss", "t", "r", "hwaccel", "hwaccel_device", "pix_fmt", "ar", "ac"];
const MIN_FILTERS = 400;

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const ref: string = argv.find((a) => !a.startsWith("--")) ?? latestReleaseTag();

async function texi(name: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/FFmpeg/FFmpeg/${ref}/doc/${name}`;
  console.log(`Reading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const [filtersTexi, encodersTexi, codecsTexi, ffmpegTexi] = await Promise.all(["filters.texi", "encoders.texi", "codecs.texi", "ffmpeg.texi"].map(texi));
const filters = parseFiltersTexi(filtersTexi);
const encoders = parseEncodersTexi(encodersTexi);
const codec = parseOptionChapter(codecsTexi, /^Codec Options$/);
const cli = parseOptionChapter(ffmpegTexi, /^Options$/, true);

// ---------------------------------------------------------------- sanity checks

const names = (fs: FilterDoc[]) => new Set(fs.flatMap((f) => f.names));
const has = (opts: DocOption[], n: string) => opts.some((o) => o.names.includes(n));
const now = names(filters);
const problems: string[] = [];
if (now.size < MIN_FILTERS) problems.push(`only ${now.size} filters parsed (expected at least ${MIN_FILTERS})`);
for (const r of REQUIRED_FILTERS) if (!filters.find((x) => x.names.includes(r))?.options.length) problems.push(`filter ${r}: no options parsed`);
for (const r of REQUIRED_ENCODERS) if (!encoders.find((x) => x.names.includes(r))?.options.length) problems.push(`encoder ${r}: no options parsed`);
for (const r of REQUIRED_CODEC) if (!has(codec, r)) problems.push(`codec option ${r} missing`);
for (const r of REQUIRED_CLI) if (!has(cli, r)) problems.push(`ffmpeg option -${r} missing`);

let before: Set<string> = new Set();
let beforeRef = "";
if (existsSync(FILTERS_OUT)) {
  const prev = JSON.parse(readFileSync(FILTERS_OUT, "utf8")) as { ffmpeg: string; filters: FilterDoc[] };
  before = names(prev.filters);
  beforeRef = prev.ffmpeg;
  const lost = [...before].filter((n) => !now.has(n));
  if (lost.length > before.size * 0.05) problems.push(`${lost.length} of ${before.size} filters disappeared`);
}

const added = [...now].filter((n) => before.size && !before.has(n));
const removed = [...before].filter((n) => !now.has(n));
const optionCount = filters.reduce((s, f) => s + f.options.length, 0);
console.log(`FFmpeg ${ref}${beforeRef && beforeRef !== ref ? ` (was ${beforeRef})` : ""}: ${now.size} filters in ${filters.length} sections, ${optionCount} options`);
if (added.length) console.log(`  added filters: ${added.join(" ")}`);
if (removed.length) console.log(`  removed filters: ${removed.join(" ")}`);
console.log(`  ${encoders.length} encoder sections, ${codec.length} codec options, ${cli.length} ffmpeg options`);

if (problems.length) {
  for (const p of problems) console.error(`  problem: ${p}`);
  if (!force) {
    console.error("Not written. Fix the parser, or pass --force.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------- write

/** One entry per line keeps diffs readable; LF line endings on every platform. */
const lines = (xs: unknown[]) => `[\n${xs.map((x) => JSON.stringify(x)).join(",\n")}\n]`;
function write(path: string, text: string) {
  writeFileSync(path, Buffer.from(text, "utf8"));
  console.log(`Wrote ${path.slice(root.length + 1)} (${Math.round(text.length / 1024)} KB)`);
}
write(FILTERS_OUT, `{"ffmpeg":${JSON.stringify(ref)},"filters":${lines(filters)}}\n`);
write(OPTIONS_OUT, `{"ffmpeg":${JSON.stringify(ref)},\n"encoders":${lines(encoders)},\n"codec":${lines(codec)},\n"cli":${lines(cli)}}\n`);
