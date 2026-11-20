# CLAUDE.md

ffmpegnodes: a Tauri 2 + React 19 + React Flow (@xyflow/react) node editor that serializes a graph into one ffmpeg command. State lives in a zustand store. The README covers features and layout.

## Commands

- `pnpm typecheck`: tsc. Note that `src/serializer/ffmpeg.e2e.test.ts` is excluded from tsconfig, so typecheck does not cover it.
- `pnpm test`: vitest unit tests.
- `FFMPEG_E2E=1 pnpm test`: also runs real ffmpeg/ffprobe end-to-end tests. Add `FFMPEG_E2E_NVENC=1` for the NVENC/CUDA ones; this machine has an NVIDIA GPU.
- `cargo test` in `src-tauri/`: Rust tests (process layer, letterbox detection).
- Browser preview: the `web` config in `.claude/launch.json` runs `pnpm dev` on port 1420. ffprobe, ffmpeg and letterbox detection are mocked there (`src/ipc/mock.ts`). In browser mode the file pickers and confirm use `window.prompt` / `window.confirm`.
- Desktop app: `pnpm tauri dev`.
- Release:
  1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then run `cargo check` to update `Cargo.lock`.
  2. Commit, push `main`, and push a tag `vX.Y.Z`.
  3. `.github/workflows/release.yml` builds Windows, macOS and Linux installers into a **draft** release.
  4. When it finishes, publish the draft with release notes: a "What's new" section, then the install notes exactly as written in `releaseBody` in `release.yml`.
  - `.github/workflows/test.yml` runs typecheck and the tests on pushes to `main`.

## Architecture rules

- **Pad domains** are `frames`, `packets` and `params` (`src/model/types.ts`).
  - Pads connect only when domain and media are equal (`padsCompatible`).
  - Input pads are `f{streamIndex}` for frames and `p{streamIndex}` for packets.
  - Curated filters use `in` / `out`.
  - Encoders have the `params` pad first, then `in`, and output `out`.
- **Encoder settings live on encoder parameters nodes** (`kind: "encparams"`). Encoder nodes hold only `media`.
  - `resolveEncoders(g)` in `src/model/encoders.ts` copies the wired settings into each encoder. It runs at the start of `serialize`, `negotiate`, `validate` and `gpuResidency`, and it is idempotent.
  - Code that needs an encoder's codec or params should use the resolved graph or `resolveEncoder`.
  - An encoder without parameters is an error, and its stream is left out of the command.
  - Quick fixes for encoder settings must target `paramsId`, not the encoder.
- **Muxer slots** always end with one spare slot. After adding or removing wires to an Output, call `normalizeMuxerSlots`.
- **Generic filters** (`defId: "generic"`) store their parsed `ffmpeg -h filter=` help in node data. Use `filterDefOf(d)` to get a `FilterDef` for any filter node.
- **Pure logic stays out of React:** serializer, validation, the wizard builder (`src/wizard/build.ts`) and duplicate (`src/store/duplicate.ts`) take plain `Graph` objects, so they can be unit-tested.
- **Rust runs ffmpeg/ffprobe with argument lists, never through a shell** (`src-tauri/src/ffmpeg.rs`).
- **Jobs:** several can run at once.
  - The store holds `jobs: JobState[]`; `startRun` / `cancelRun(id)` are in `src/ui/run.ts`.
  - Rust keys jobs by id (`run_job` / `cancel_job`). Cancel sends `q` so ffmpeg finalizes the file, and kills it after 3 s.
  - Each job's popup is in `src/ui/JobPanels.tsx`.
  - Pure parsing lives in `src/ui/jobInfo.ts`: `parseProgress` reads `-progress pipe:1` blocks, and `OutputInfoParser` reads the stderr `Output #N` / `Stream #N:M` lines.
  - A job snapshots its inputs, outputs and devices when it starts.
- **Devices** (GPU/CPU per stage and stream): `jobDevices(graph, ser)` in `src/model/devices.ts` derives them from the rules in `src/model/hw.ts`.
  - An unset CUDA device is GPU 0; nvenc without `gpu` is "auto".
  - Per-stream devices follow `ser.outputs[k].streams`, which is in `-map` order (ffmpeg's `#file:index`).
- **Canvas wheel zoom** is the app's own, not React Flow's (`zoomOnScroll` is off).
  - The math is in `src/ui/wheelZoom.ts` and the handler is in `Canvas.tsx`.
  - The step per notch is `settings.zoomStep`. Change it with `setZoomStep`, because `setSettings` also reloads ffmpeg capabilities.

## Conventions

- **Tests that need an encoder:** use `encoder(media, codec)` and `pushNode(nodes, edges, id, data)` from `src/test/fixtures.ts`. `pushNode` splits an inline-settings encoder into an encoder plus a wired parameters node.
- **Project files:** saved with `app: "ffmpegnodes"`. `parseProject` must keep accepting the legacy `"ffmpeg-node-gui"`.
- **localStorage keys:** use `storageKey(name)` / `readStored` from `src/store/storage.ts`, which gives the `ffmpegnodes.` prefix and falls back to old `ffng.` keys.
- **Naming:** the project name is always `ffmpegnodes`; no other spellings.
- **UI text:** short and plain. Media colours are video yellow, audio red, subtitle blue. Parameter pads and wires use darker shades of those (`--params-*` tokens in `src/styles.css`).
- **After changing UI code,** check it in the browser preview and keep the console free of errors.
- **Line endings:** keep each file's existing line endings; some files are CRLF and some are LF. Scripts that rewrite files on Windows must read and write bytes, not text mode, which turns LF into CRLF.
- **Keep this file current:** when a change adds or alters an architecture rule, a convention or a workflow, update CLAUDE.md in the same commit.
