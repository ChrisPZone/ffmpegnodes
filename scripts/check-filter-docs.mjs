// Release check: fails when the bundled ffmpeg docs (filterDocs.json, optionDocs.json) are from
// an older FFmpeg major/minor release than the newest one. Fix with `pnpm release:prep X.Y.Z`
// (or `pnpm gen:docs`).
import { readFileSync } from "node:fs";
import { latestReleaseTag, releaseVersion } from "./ffmpeg-tags.mjs";

const latest = latestReleaseTag();
const want = releaseVersion(latest);
let failed = false;
for (const file of ["filterDocs.json", "optionDocs.json"]) {
  const { ffmpeg } = JSON.parse(readFileSync(new URL(`../src/docs/${file}`, import.meta.url), "utf8"));
  const have = releaseVersion(ffmpeg);
  const older = have && want && (have[0] < want[0] || (have[0] === want[0] && have[1] < want[1]));
  console.log(`${file}: FFmpeg ${ffmpeg}; newest FFmpeg release: ${latest}`);
  if (older) {
    console.error(`::error::${file} is from FFmpeg ${ffmpeg}, but ${latest} is out. Run pnpm gen:docs, commit, and tag again.`);
    failed = true;
  }
}
if (failed) process.exit(1);
