# ffmpeg Node GUI

A node editor for ffmpeg (Tauri 2 + React + React Flow). You build a graph, and the app turns it into one ffmpeg command and runs it.

```
Input ──frames──▶ [scale] ──▶ [Video Encoder] ──packets──┐
      ──frames──▶ [loudnorm] ▶ [Audio Encoder] ──packets──┼▶ [Output: out.mp4]
      ──packets (stream copy)────────────────────────────┘
```

- **Round pads = frames** (decoded): filters take them in and put them out, and encoders take them in.
- **Square pads = packets** (encoded): encoders put them out and the Output takes them in. Wiring an Input's packet pad straight to an Output gives you `-c copy`.
- Colors: video is yellow, audio is red, subtitles are blue. A connection is only allowed when the domain and media type match.

## Prerequisites

- Node 20+ and pnpm
- Rust (https://rustup.rs). On Windows you also need the MSVC build tools and WebView2. See https://tauri.app/start/prerequisites/
- `ffmpeg` and `ffprobe` on PATH, or set their paths in the app's ⚙ Settings

## Run

```bash
pnpm install
```

```bash
pnpm tauri dev
```

The command above starts the desktop app. To run only the UI in a browser (ffprobe and ffmpeg are mocked):

```bash
pnpm dev
```

```bash
pnpm test
```

## Layout

| Path | What |
|---|---|
| `src/serializer/` | graph → ffmpeg argv (filtergraph building, split insertion, chain joining, escaping) |
| `src/validation/` | connection rules, format negotiation along edges, codec/container compatibility, diagnostics + quick fixes |
| `src/nodes/defs/` | pad layout per node, filter definitions, encoder schemas |
| `src/nodes/ui/`, `src/inspector/`, `src/ui/` | React Flow nodes, inspector panel, canvas, dock, toolbar |
| `src/ipc/` | typed Tauri bridge + browser mock |
| `src-tauri/src/ffmpeg.rs` | spawns ffprobe/ffmpeg (argv only, never a shell), streams `-progress`, cancel |

## Milestones

- **M1 (this):** a working end-to-end slice with hand-written filters (scale, crop, fps, format, overlay, volume, loudnorm, aresample, amix) and encoder schemas (libx264, libx265, aac, libfdk_aac, libopus, subtitle encoders). Any other encoder gets generic options.
- **M2:** filter and encoder nodes generated from `ffmpeg -h filter=…` / `-h encoder=…`, presets, two-pass, value nodes.
- **M3:** batch "repeat zone", `tee` muxer, bitstream filters, chapters, bundled ffmpeg.
