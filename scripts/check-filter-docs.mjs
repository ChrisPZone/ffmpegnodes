// Release check: fails when the bundled filter docs are from an older FFmpeg major/minor
// release than the newest one. Fix with `pnpm release:prep X.Y.Z` (or `pnpm gen:filterdocs`).
import { readFileSync } from "node:fs";
import { latestReleaseTag, releaseVersion } from "./ffmpeg-tags.mjs";

const { ffmpeg } = JSON.parse(readFileSync(new URL("../src/docs/filterDocs.json", import.meta.url), "utf8"));
const latest = latestReleaseTag();
const have = releaseVersion(ffmpeg);
const want = releaseVersion(latest);
const older = have && want && (have[0] < want[0] || (have[0] === want[0] && have[1] < want[1]));
console.log(`Filter docs: FFmpeg ${ffmpeg}; newest FFmpeg release: ${latest}`);
if (older) {
  console.error(`::error::The bundled filter docs are from FFmpeg ${ffmpeg}, but ${latest} is out. Run pnpm gen:filterdocs, commit, and tag again.`);
  process.exit(1);
}
