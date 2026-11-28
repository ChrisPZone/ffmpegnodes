# CLAUDE.md

ffmpegnodes: a Tauri 2 + React 19 + React Flow (@xyflow/react) node editor that serializes a graph into one ffmpeg command. State lives in a zustand store. The README covers features and layout.

## Commands

- `pnpm typecheck`: tsc. Note that `src/serializer/ffmpeg.e2e.test.ts` is excluded from tsconfig, so typecheck does not cover it.
- `pnpm test`: vitest unit tests.
- `FFMPEG_E2E=1 pnpm test`: also runs real ffmpeg/ffprobe end-to-end tests. Add `FFMPEG_E2E_NVENC=1` for the NVENC/CUDA ones; this machine has an NVIDIA GPU.
- `cargo test` in `src-tauri/`: Rust tests (process layer, letterbox detection).
- Browser preview: the `web` config in `.claude/launch.json` runs `pnpm dev` on port 1420. ffprobe, ffmpeg and letterbox detection are mocked there (`src/ipc/mock.ts`). In browser mode the file pickers and confirm use `window.prompt` / `window.confirm`.
- Desktop app: `pnpm tauri dev`.
- `pnpm gen:docs [tag]`: regenerates the bundled ffmpeg docs (default: the newest FFmpeg release). It refuses to write when the result looks broken; `-- --force` overrides.
  - `src/docs/filterDocs.json` comes from `doc/filters.texi`.
  - `src/docs/optionDocs.json` comes from `encoders.texi`, `codecs.texi` ("Codec Options"), `ffmpeg.texi` ("Options") and the `image2` section of `demuxers.texi`.
- Release:
  1. Run `pnpm release:prep X.Y.Z`. It sets the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, runs `cargo check` to update `Cargo.lock`, and regenerates the ffmpeg docs. Review the diff.
  2. Commit, push `main`, and push a tag `vX.Y.Z`.
  3. `.github/workflows/release.yml` builds Windows, macOS and Linux installers into a **draft** release.
  4. When it finishes, publish the draft with release notes: a "What's new" section, then the install notes exactly as written in `releaseBody` in `release.yml`.
  - `.github/workflows/test.yml` runs typecheck and the tests on pushes to `main`.
  - `.github/dependabot.yml` opens weekly update pull requests for npm, Cargo and GitHub Actions.
  - Contributor docs: `CONTRIBUTING.md`, `SECURITY.md`, the issue forms in `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md`. Keep `CONTRIBUTING.md` in line with the commands and conventions here.
  - `release.yml` fails when the bundled ffmpeg docs are from an older FFmpeg major/minor release than the newest one (`scripts/check-filter-docs.mjs`).

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
- **Image sequence outputs:** `.png` / `.tif` / `.dpx` / `.exr` / `.jpg` … resolve to the `image2` muxer (`EXT_FORMAT` in `src/validation/compat.ts`).
  - They carry video only, and the encoder must match the extension (`checkImageCodec`, `IMAGE_EXT_CODEC`).
  - The path needs a `%d` frame pattern unless the Output's `singleImage` is on (`-frames:v 1 -update 1`). The quick fix uses `toFramePattern` (`src/model/sequence.ts`). `startNumber` becomes `-start_number`.
  - Curated image encoders have `image: true` (`src/nodes/defs/encoders.ts`) and appear under "Image sequences" in the encoder picker. Their 8-bit vs deep formats are `EIGHT_BIT_IMAGE_FMTS` / `DEEP_IMAGE_PIX_FMT`.
- **Generic filters** (`defId: "generic"`) store their parsed `ffmpeg -h filter=` help in node data. Use `filterDefOf(d)` to get a `FilterDef` for any filter node.
- **Help popups** (`src/inspector/HelpPopover.tsx`) show the bundled ffmpeg docs. Both JSON files are loaded lazily on first use.
  - `src/docs/texi.ts` parses the texinfo files. It has no imports, so the generator script can run it with plain node.
  - Filters: `filterDocs.json`, looked up with `optionDoc` / `filterDoc` (`src/docs/filterDocs.ts`).
  - Encoder Parameters: `encoderOptionDoc` (`src/docs/optionDocs.ts`) tries the encoder's own section, then the generic codec options, then ffmpeg's options. `encoderParamDocRef(p)` gives the option: `doc.option` if set, else `flag`, none for UI-only params (`flag: ""`) or `doc: false`. `src/docs/optionDocs.test.ts` fails when an encoder param has no docs entry.
  - Input node: `INPUT_DOC_OPTIONS` (`src/docs/inputOptions.ts`) maps its settings to ffmpeg options, looked up with `cliOptionDoc`. Settings listed in `INPUT_DOC_DEMUXER` (the image sequence ones) look in that demuxer's section first. `-hwaccel_output_format` is not in the ffmpeg docs, so "Keep frames on GPU" has no popup.
  - `paramDocRef(def, p)` gives a param's ffmpeg filter and option: by default `ffName` and the param name, and none for `ui` params.
  - Set `doc: { option }` on a curated param whose name differs from the ffmpeg option, `doc: { whole: true }` to show the filter's whole section (e.g. the pan expression), or `doc: false` when no ffmpeg option is behind it. When an option has no entry, its popup offers the filter's section in a collapsible block. A test (`src/docs/filterDocs.test.ts`) fails when a curated param has no docs entry.
  - Links open in the system browser through `openExternal` (`tauri-plugin-opener`).
- **Pure logic stays out of React:** serializer, validation, the wizard builder (`src/wizard/build.ts`) and duplicate (`src/store/duplicate.ts`) take plain `Graph` objects, so they can be unit-tested.
- **Rust runs ffmpeg/ffprobe with argument lists, never through a shell** (`src-tauri/src/ffmpeg.rs`).
- **Jobs:** several can run at once.
  - The store holds `jobs: JobState[]`; `startRun` / `cancelRun(id)` are in `src/ui/run.ts`.
  - Rust keys jobs by id (`run_job` / `cancel_job`). Cancel sends `q` so ffmpeg finalizes the file, and kills it after 3 s.
  - Job ids must be unique across windows, because all windows share the Rust job table.
  - Each job's popup is in `src/ui/JobPanels.tsx`.
  - Pure parsing lives in `src/ui/jobInfo.ts`: `parseProgress` reads `-progress pipe:1` blocks, and `OutputInfoParser` reads the stderr `Output #N` / `Stream #N:M` lines.
  - A job snapshots its inputs, outputs and devices when it starts.
- **Image sequence inputs:** `src/model/sequence.ts` holds the pure logic.
  - `detectSequence` / `sequenceFromPattern` find the pattern, range and missing frames from a folder listing (Rust `list_dir`). The Inspector offers "Use sequence" for a numbered image file and stores the result in the Input's `sequence`.
  - `inputDemuxArgs(options)` is the one list of image2 options (`-framerate`, `-start_number`, …). The serializer puts it before `-i`, and `probeInput` and letterbox detection pass the same list to ffprobe/ffmpeg, so they read the same frames. Add new demuxer options there, not in one caller.
  - The EXR decoder's `-apply_trc` was removed from FFmpeg, so it is not offered.
- **Devices** (GPU/CPU per stage and stream): `jobDevices(graph, ser)` in `src/model/devices.ts` derives them from the rules in `src/model/hw.ts`.
  - An unset CUDA device is GPU 0; nvenc without `gpu` is "auto".
  - Per-stream devices follow `ser.outputs[k].streams`, which is in `-map` order (ffmpeg's `#file:index`).
- **Canvas wheel zoom** is the app's own, not React Flow's (`zoomOnScroll` is off).
  - The math is in `src/ui/wheelZoom.ts` and the handler is in `Canvas.tsx`.
  - The step per notch is `settings.zoomStep`. Change it with `setZoomStep`, because `setSettings` also reloads ffmpeg capabilities.

## Conventions

- **Tests that need an encoder:** use `encoder(media, codec)` and `pushNode(nodes, edges, id, data)` from `src/test/fixtures.ts`. `pushNode` splits an inline-settings encoder into an encoder plus a wired parameters node.
- **Project files:** saved with `app: "ffmpegnodes"`. `parseProject` must keep accepting the legacy `"ffmpeg-node-gui"`.
- **Windows:** "New window" (`openNewWindow`, `src/ipc/ffmpeg.ts`) opens a Tauri window labelled `win-*`, which the capability file must list.
  - Each window has its own store.
  - The main window autosaves to localStorage. Windows opened with `?window=new` autosave to their own sessionStorage (`autosaveStore` in `src/store/graph.ts`). Settings stay shared.
- **localStorage keys:** use `storageKey(name)` / `readStored` from `src/store/storage.ts`, which gives the `ffmpegnodes.` prefix and falls back to old `ffng.` keys.
- **License:** the project is MIT (`LICENSE`). The bundled ffmpeg docs stay LGPL-2.1-or-later as FFmpeg text. Keep `THIRD_PARTY_NOTICES.md` current when bundling other third-party material, and never ship ffmpeg binaries without revisiting it.
- **Naming:** the project name is always `ffmpegnodes`; no other spellings.
- **UI text:** short and plain. Media colours are video yellow, audio red, subtitle blue. Parameter pads and wires use darker shades of those (`--params-*` tokens in `src/styles.css`).
- **After changing UI code,** check it in the browser preview and keep the console free of errors.
- **Line endings:** all text files are LF, enforced by `.gitattributes` (`eol=lf`) and `.editorconfig`. Scripts that rewrite files on Windows must read and write bytes, not text mode, which turns LF into CRLF. The normalization commit is listed in `.git-blame-ignore-revs`.
- **Keep this file current:** when a change adds or alters an architecture rule, a convention or a workflow, update CLAUDE.md in the same commit.
