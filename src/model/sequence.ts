// Numbered image sequences (shot_1001.exr …) and the demuxer options an Input passes
// before `-i`. Pure functions: the Inspector lists the folder and calls detectSequence.
import type { InputOptions, SequenceInfo } from "./types";

export type { SequenceInfo };

/** Image formats offered as sequences when a numbered file is picked. */
export const IMAGE_SEQ_EXTS = ["png", "jpg", "jpeg", "tif", "tiff", "dpx", "exr", "bmp", "webp", "tga"];

const MAX_MISSING_LISTED = 20;

/** Splits a path into folder (with its trailing separator) and file name. Accepts / and \. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export const extOf = (path: string) => {
  const { name } = splitPath(path);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export const isImageFile = (path: string) => IMAGE_SEQ_EXTS.includes(extOf(path));

/** True when the file name holds an image2 number placeholder (%d, %04d), not just %%. */
export function isSequencePattern(path: string): boolean {
  return /(^|[^%])(%%)*%0?\d*d/.test(splitPath(path).name);
}

/** The last run of digits in the name, before the extension. */
export function numberedName(name: string): { prefix: string; digits: string; suffix: string } | null {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const m = /^(.*?)(\d+)(\D*)$/.exec(stem);
  if (!m) return null;
  return { prefix: m[1], digits: m[2], suffix: m[3] + name.slice(stem.length) };
}

/**
 * Finds the sequence that `fileName` belongs to among `entries` (the file names in its
 * folder). Null when the name has no number or fewer than two files match.
 */
export function detectSequence(fileName: string, entries: readonly string[]): SequenceInfo | null {
  const picked = numberedName(fileName);
  if (!picked) return null;
  const { prefix, suffix } = picked;
  const width = picked.digits.length;
  const candidates: string[] = [];
  for (const e of entries) {
    if (e.length <= prefix.length + suffix.length || !e.startsWith(prefix) || !e.endsWith(suffix)) continue;
    const digits = e.slice(prefix.length, e.length - suffix.length);
    if (/^\d+$/.test(digits)) candidates.push(digits);
  }
  if (!candidates.includes(picked.digits)) candidates.push(picked.digits);

  // Zero padded (%04d) when a match of the picked width has a leading zero, or all share it.
  const padded = width > 1 && (candidates.some((d) => d.length === width && d[0] === "0") || candidates.every((d) => d.length === width));
  const kept = padded
    ? candidates.filter((d) => d.length === width || (d.length > width && d[0] !== "0"))
    : candidates.filter((d) => d[0] !== "0" || d === "0");
  if (kept.length < 2) return null;

  const nums = [...new Set(kept.map(Number))].sort((a, b) => a - b);
  const missing: number[] = [];
  let missingCount = 0;
  for (let i = 1; i < nums.length; i++) {
    for (let n = nums[i - 1] + 1; n < nums[i]; n++) {
      missingCount++;
      if (missing.length >= MAX_MISSING_LISTED) {
        missingCount += nums[i] - n - 1;
        break;
      }
      missing.push(n);
    }
  }
  const esc = (s: string) => s.replace(/%/g, "%%");
  return {
    pattern: `${esc(prefix)}${padded ? `%0${width}d` : "%d"}${esc(suffix)}`,
    first: nums[0],
    last: nums[nums.length - 1],
    count: nums.length,
    missing,
    missingCount,
  };
}

/** Like detectSequence, for a typed pattern (`shot_%04d.exr`): finds a file it names first. */
export function sequenceFromPattern(pattern: string, entries: readonly string[]): SequenceInfo | null {
  const m = /^((?:[^%]|%%)*)%(?:0(\d+))?d((?:[^%]|%%)*)$/.exec(pattern);
  if (!m) return null;
  const un = (s: string) => s.replace(/%%/g, "%");
  const prefix = un(m[1]);
  const suffix = un(m[3]);
  const width = m[2] ? Number(m[2]) : 0;
  const hit = entries.find((e) => {
    if (e.length <= prefix.length + suffix.length || !e.startsWith(prefix) || !e.endsWith(suffix)) return false;
    const digits = e.slice(prefix.length, e.length - suffix.length);
    return /^\d+$/.test(digits) && (width ? digits.length === width : digits[0] !== "0" || digits === "0");
  });
  return hit ? detectSequence(hit, entries) : null;
}

/**
 * Image sequence (image2 demuxer) options of an Input, in command order. The serializer puts
 * them before `-i`, and the same list goes to ffprobe and letterbox detection so all three
 * read the same frames.
 */
export function inputDemuxArgs(o: Partial<InputOptions>): string[] {
  const args: string[] = [];
  const add = (flag: string, v: string | undefined) => {
    if (v?.trim()) args.push(flag, v.trim());
  };
  add("-framerate", o.framerate);
  add("-start_number", o.start_number);
  add("-start_number_range", o.start_number_range);
  add("-pattern_type", o.pattern_type);
  add("-loop", o.loop);
  return args;
}
