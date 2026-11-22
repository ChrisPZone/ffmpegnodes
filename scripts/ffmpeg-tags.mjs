// FFmpeg release tags (n7.1, n8.0.1, ...) from the GitHub mirror, via git (no API rate limit).
import { execFileSync } from "node:child_process";

export const FFMPEG_REPO = "https://github.com/FFmpeg/FFmpeg";

/** "n8.0.1" → [8, 0, 1]; undefined for dev tags and anything else. */
export function releaseVersion(tag) {
  const m = /^n(\d+)\.(\d+)(?:\.(\d+))?$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

export function compareTags(a, b) {
  const va = releaseVersion(a) ?? [0, 0, 0];
  const vb = releaseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
  return 0;
}

/** The newest FFmpeg release tag. */
export function latestReleaseTag() {
  const out = execFileSync("git", ["ls-remote", "--tags", "--refs", `${FFMPEG_REPO}.git`], { encoding: "utf8" });
  const tags = out
    .split("\n")
    .map((l) => l.split("refs/tags/")[1]?.trim())
    .filter((t) => t && releaseVersion(t));
  if (!tags.length) throw new Error("no FFmpeg release tags found");
  return tags.sort(compareTags).at(-1);
}
