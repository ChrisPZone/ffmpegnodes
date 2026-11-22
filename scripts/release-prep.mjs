// Prepares a release: sets the version everywhere, updates Cargo.lock and regenerates the
// bundled filter docs from the newest FFmpeg release.
//
//   pnpm release:prep 0.10.0
//
// Then commit, push main and push the tag vX.Y.Z (see CLAUDE.md).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: pnpm release:prep X.Y.Z");
  process.exit(1);
}

/** Replaces the first match in a file, byte-safe (keeps line endings). */
function setVersion(rel, re) {
  const path = join(root, rel);
  const text = readFileSync(path).toString("utf8");
  if (!re.test(text)) throw new Error(`${rel}: version not found`);
  writeFileSync(path, Buffer.from(text.replace(re, (_m, a, _v, b) => `${a}${version}${b}`), "utf8"));
  console.log(`${rel}: ${version}`);
}

setVersion("package.json", /("version":\s*")([^"]+)(")/);
setVersion("src-tauri/tauri.conf.json", /("version":\s*")([^"]+)(")/);
setVersion("src-tauri/Cargo.toml", /(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/);

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
console.log("cargo check (updates Cargo.lock)");
run("cargo", ["check", "--quiet"], join(root, "src-tauri"));
run(process.execPath, [join(root, "scripts", "gen-filter-docs.ts")]);

console.log(`\nNext: review the changes, commit, push main, then: git tag v${version} && git push origin v${version}`);
