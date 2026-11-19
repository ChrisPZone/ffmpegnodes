# CLAUDE.md

ffmpegnodes: a Tauri 2 + React 19 + React Flow (@xyflow/react) node editor that serializes a graph into one ffmpeg command. State lives in a zustand store. The README covers features and layout.

## Commands

- `pnpm typecheck`: tsc. Note that `src/serializer/ffmpeg.e2e.test.ts` is excluded from tsconfig, so typecheck does not cover it.
- `pnpm test`: vitest unit tests.
- `FFMPEG_E2E=1 pnpm test`: also runs real ffmpeg/ffprobe end-to-end tests. Add `FFMPEG_E2E_NVENC=1` for the NVENC/CUDA ones; this machine has an NVIDIA GPU.
- `cargo test` in `src-tauri/`: Rust tests (process layer, letterbox detection).
- Browser preview: the `web` config in `.claude/launch.json` runs `pnpm dev` on port 1420. ffprobe, ffmpeg and letterbox detection are mocked there (`src/ipc/mock.ts`). In browser mode the file pickers and confirm use `window.prompt` / `window.confirm`.
- Desktop app: `pnpm tauri dev`.

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

## Conventions

- **Tests that need an encoder:** use `encoder(media, codec)` and `pushNode(nodes, edges, id, data)` from `src/test/fixtures.ts`. `pushNode` splits an inline-settings encoder into an encoder plus a wired parameters node.
- **Project files:** saved with `app: "ffmpegnodes"`. `parseProject` must keep accepting the legacy `"ffmpeg-node-gui"`.
- **localStorage keys:** use `storageKey(name)` / `readStored` from `src/store/storage.ts`, which gives the `ffmpegnodes.` prefix and falls back to old `ffng.` keys.
- **Naming:** the project name is always `ffmpegnodes`; no other spellings.
- **UI text:** short and plain. Media colours are video yellow, audio red, subtitle blue. Parameter pads and wires use darker shades of those (`--params-*` tokens in `src/styles.css`).
- **After changing UI code,** check it in the browser preview and keep the console free of errors.
