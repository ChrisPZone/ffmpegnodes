// Typed bridge to the Rust backend. Outside Tauri (plain `pnpm dev` in a browser) a mock
// backend answers instead, so the editor and serializer can be developed without Rust.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Capabilities, GpuInfo, LetterboxOptions, LetterboxResult, ProbeResult } from "../model/types";
import { mockBackend } from "./mock";

export interface Settings {
  ffmpegPath: string;
  ffprobePath: string;
  /** Canvas zoom per mouse-wheel notch, in percent (default 10). UI only. */
  zoomStep?: number;
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const opt = (s: string) => (s.trim() ? s.trim() : null);

export async function getCapabilities(s: Settings): Promise<Capabilities> {
  if (!isTauri()) return mockBackend.capabilities();
  return invoke<Capabilities>("get_capabilities", { ffmpegPath: opt(s.ffmpegPath) });
}

export async function probeFile(path: string, s: Settings): Promise<ProbeResult> {
  if (!isTauri()) return mockBackend.probe(path);
  return invoke<ProbeResult>("probe_file", { path, ffprobePath: opt(s.ffprobePath) });
}

/** NVIDIA GPUs in CUDA order, detected through an nvenc encoder of this ffmpeg build. */
export async function listGpus(encoder: string, s: Settings): Promise<GpuInfo[]> {
  if (!isTauri()) return mockBackend.gpus();
  return invoke<GpuInfo[]>("list_gpus", { ffmpegPath: opt(s.ffmpegPath), encoder });
}

/** Raw `ffmpeg -h filter=<name>` text (parsed by nodes/defs/generic). */
export async function filterHelp(name: string, s: Settings): Promise<string> {
  if (!isTauri()) return mockBackend.filterHelp(name);
  return invoke<string>("filter_help", { ffmpegPath: opt(s.ffmpegPath), name });
}

/** Black bars at the top/bottom of a video, measured on frames spread over the file. */
export async function detectLetterbox(
  req: { path: string; duration: number; width: number; height: number; options: LetterboxOptions },
  s: Settings,
): Promise<LetterboxResult> {
  if (!isTauri()) return mockBackend.letterbox(req.height);
  return invoke<LetterboxResult>("detect_letterbox", { ffmpegPath: opt(s.ffmpegPath), ...req });
}

export interface JobHandlers {
  onProgress: (values: Record<string, string>) => void;
  onLog: (line: string) => void;
  onDone: (success: boolean, code: number | null) => void;
}

/** Start ffmpeg; resolves once it is running. Handlers fire until onDone. */
export async function runJob(jobId: string, args: string[], s: Settings, h: JobHandlers): Promise<void> {
  if (!isTauri()) return mockBackend.run(jobId, args, h);
  const unlisten: UnlistenFn[] = [];
  const cleanup = () => unlisten.splice(0).forEach((u) => u());
  unlisten.push(
    await listen<{ jobId: string; values: Record<string, string> }>("job:progress", (e) => {
      if (e.payload.jobId === jobId) h.onProgress(e.payload.values);
    }),
    await listen<{ jobId: string; line: string }>("job:log", (e) => {
      if (e.payload.jobId === jobId) h.onLog(e.payload.line);
    }),
    await listen<{ jobId: string; success: boolean; code: number | null }>("job:done", (e) => {
      if (e.payload.jobId !== jobId) return;
      cleanup();
      h.onDone(e.payload.success, e.payload.code);
    }),
  );
  try {
    await invoke("run_job", { jobId, args, ffmpegPath: opt(s.ffmpegPath) });
  } catch (err) {
    cleanup();
    throw err;
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  if (!isTauri()) return mockBackend.cancel(jobId);
  await invoke("cancel_job", { jobId });
}

/**
 * Calls `allowClose` when the user closes the app window; the window stays open when it
 * resolves false. Outside Tauri the browser's own "leave page?" prompt is used.
 */
export async function guardWindowClose(allowClose: () => Promise<boolean>, busy: () => boolean): Promise<void> {
  if (!isTauri()) {
    window.addEventListener("beforeunload", (e) => {
      if (busy()) e.preventDefault();
    });
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().onCloseRequested(async (e) => {
    if (!(await allowClose())) e.preventDefault();
  });
}

type DialogFilter = { name: string; extensions: string[] };

export const MEDIA_FILTERS: DialogFilter[] = [
  { name: "Media", extensions: ["mkv", "mp4", "mov", "webm", "avi", "ts", "m2ts", "mxf", "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "srt", "ass", "vtt", "png", "jpg"] },
  { name: "All files", extensions: ["*"] },
];

export const PROJECT_FILTERS: DialogFilter[] = [{ name: "ffmpegnodes graph", extensions: ["json"] }];

export async function pickOpenFile(filters: DialogFilter[] = MEDIA_FILTERS): Promise<string | null> {
  if (!isTauri()) return window.prompt("Path to file (browser mode: probing is mocked)", "C:/videos/in.mkv");
  const r = await open({ multiple: false, directory: false, filters });
  return typeof r === "string" ? r : null;
}

/**
 * Yes/no question that really waits for the answer. Inside Tauri, window.confirm does not
 * block (it returns before the user answers), so the native dialog is used there.
 */
export async function confirmDialog(message: string, opts: { title?: string; okLabel?: string; cancelLabel?: string } = {}): Promise<boolean> {
  if (!isTauri()) return window.confirm(message);
  return ask(message, { title: opts.title ?? "ffmpegnodes", kind: "warning", okLabel: opts.okLabel ?? "OK", cancelLabel: opts.cancelLabel ?? "Cancel" });
}

/** Opens a web page (https only) in the system browser. */
export async function openExternal(url: string): Promise<void> {
  if (!/^https:\/\//.test(url)) return;
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await openUrl(url);
}

export async function pickSaveFile(defaultPath?: string, filters?: DialogFilter[]): Promise<string | null> {
  if (!isTauri()) return window.prompt("Save to path", defaultPath ?? "C:/videos/out.mp4");
  return (await save({ defaultPath, filters })) ?? null;
}

export async function readTextFile(path: string): Promise<string> {
  if (!isTauri()) return mockBackend.read(path);
  return invoke<string>("read_text_file", { path });
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  if (!isTauri()) return mockBackend.write(path, contents);
  await invoke("write_text_file", { path, contents });
}
