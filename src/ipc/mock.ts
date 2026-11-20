// Browser-only stand-in for the Rust backend. Probes are invented from the file extension.
import type { Capabilities, ProbeResult, StreamInfo } from "../model/types";
import { FILTERS } from "../nodes/defs/filters";
import type { JobHandlers } from "./ffmpeg";
import { MOCK_FILTER_HELP, MOCK_FILTERS } from "./mockFilterHelp";

const CAPS: Capabilities = {
  version: "ffmpeg version mock (browser mode — run inside Tauri for the real thing)",
  encoders: [
    ...[["libx264", "h264"], ["libx265", "hevc"], ["libsvtav1", "av1"], ["libvpx-vp9", "vp9"], ["h264_nvenc", "h264"], ["hevc_nvenc", "hevc"], ["prores_ks", "prores"], ["gif", "gif"]].map(([name, codec]) => ({ name, codec, media: "video" as const, description: name })),
    ...[["aac", "aac"], ["libopus", "opus"], ["libmp3lame", "mp3"], ["flac", "flac"], ["ac3", "ac3"], ["pcm_s16le", "pcm_s16le"]].map(([name, codec]) => ({ name, codec, media: "audio" as const, description: name })),
    ...[["mov_text", "mov_text"], ["srt", "subrip"], ["ass", "ass"], ["webvtt", "webvtt"]].map(([name, codec]) => ({ name, codec, media: "subtitle" as const, description: name })),
  ],
  muxers: ["mp4", "mov", "matroska", "webm", "mpegts", "mp3", "flac", "wav", "ogg", "adts", "srt", "gif"].map((name) => ({ name, description: name })),
  filters: [
    ...FILTERS.map((f) => ({ name: f.ffName, io: f.media === "audio" ? "A->A" : "V->V", description: f.description })),
    ...MOCK_FILTERS.filter((m) => !FILTERS.some((f) => f.ffName === m.name)),
  ],
};

const video = (index: number): StreamInfo => ({
  index,
  codec_type: "video",
  codec_name: "h264",
  profile: "High",
  width: 1920,
  height: 1080,
  pix_fmt: "yuv420p",
  avg_frame_rate: "30000/1001",
  r_frame_rate: "30000/1001",
});
const audio = (index: number, lang = "eng"): StreamInfo => ({
  index,
  codec_type: "audio",
  codec_name: "aac",
  sample_rate: "48000",
  channels: 2,
  channel_layout: "stereo",
  tags: { language: lang },
});

function fakeProbe(path: string): ProbeResult {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  let streams: StreamInfo[];
  if (["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus"].includes(ext)) streams = [audio(0)];
  else if (["png", "jpg", "jpeg"].includes(ext)) streams = [{ index: 0, codec_type: "video", codec_name: ext === "png" ? "png" : "mjpeg", width: 400, height: 200, pix_fmt: "rgba" }];
  else if (["srt", "ass", "vtt"].includes(ext)) streams = [{ index: 0, codec_type: "subtitle", codec_name: ext === "srt" ? "subrip" : ext }];
  else if (ext === "mkv") streams = [video(0), audio(1, "eng"), audio(2, "ger"), { index: 3, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } }];
  else streams = [video(0), audio(1)];
  return { streams, format: { filename: path, format_name: ext, duration: "12.000000" } };
}

const files = new Map<string, string>();
const timers = new Map<string, { timer: ReturnType<typeof setInterval>; h: JobHandlers }>();

export const mockBackend = {
  async capabilities() {
    return CAPS;
  },
  async gpus() {
    return [
      { index: 0, name: "NVIDIA GeForce RTX 4090 (mock)" },
      { index: 1, name: "NVIDIA RTX A2000 (mock)" },
    ];
  },
  async letterbox(height: number) {
    await new Promise((r) => setTimeout(r, 600));
    const bar = Math.round((height * 0.13) / 2) * 2; // 1080 → 140
    return { top: bar, bottom: bar, height, usable: 8, sampled: 9, warning: null };
  },
  async filterHelp(name: string) {
    await new Promise((r) => setTimeout(r, 150));
    const text = MOCK_FILTER_HELP[name];
    if (text) return text;
    const f = CAPS.filters.find((x) => x.name === name);
    if (!f) throw new Error(`This ffmpeg has no filter named '${name}' (mock)`);
    // browser mode only knows a few help texts: pads from the io string, no options
    return `Filter ${name}\n  ${f.description}\n`;
  },
  async probe(path: string) {
    await new Promise((r) => setTimeout(r, 150));
    if (!path.includes(".")) throw new Error(`${path}: No such file or directory (mock)`);
    return fakeProbe(path);
  },
  async run(jobId: string, args: string[], h: JobHandlers) {
    h.onLog(`[mock] ffmpeg ${args.join(" ")}`);
    for (const line of mockOutputLog(args)) h.onLog(line);
    let t = 0;
    let frame = 0;
    const timer = setInterval(() => {
      const speed = 1.1 + Math.random() * 0.3;
      t = Math.min(12, t + 0.25 * speed);
      frame = Math.round(t * 25);
      const end = t >= 12;
      h.onProgress({
        frame: String(frame),
        fps: (25 * speed).toFixed(2),
        bitrate: `${(2400 + Math.random() * 400).toFixed(1)}kbits/s`,
        total_size: String(Math.round(t * 330_000)),
        out_time_us: String(Math.round(t * 1e6)),
        dup_frames: "0",
        drop_frames: "0",
        speed: `${speed.toFixed(2)}x`,
        progress: end ? "end" : "continue",
      });
      if (end) {
        clearInterval(timer);
        timers.delete(jobId);
        h.onLog("[mock] done");
        h.onDone(true, 0);
      }
    }, 250);
    timers.set(jobId, { timer, h });
  },
  async cancel(jobId: string) {
    const t = timers.get(jobId);
    if (!t) return;
    clearInterval(t.timer);
    timers.delete(jobId);
    t.h.onLog("[mock] stopped with q");
    // like the real "q": ffmpeg finalizes the file and exits normally
    t.h.onDone(true, 0);
  },
  async read(path: string) {
    const v = files.get(path) ?? localStorage.getItem(`mockfile:${path}`);
    if (v == null) throw new Error(`${path}: not found (mock)`);
    return v;
  },
  async write(path: string, contents: string) {
    files.set(path, contents);
    try {
      localStorage.setItem(`mockfile:${path}`, contents);
    } catch {
      /* storage unavailable */
    }
  },
};

/** Fake "Output #0 ... Stream #0:0: Video: ..." stderr lines, from the -c:v / -c:a options and the last argument. */
function mockOutputLog(args: string[]): string[] {
  const codecOf = (enc: string) => (enc === "copy" ? "h264" : CAPS.encoders.find((e) => e.name === enc)?.codec ?? enc);
  const out = args[args.length - 1] ?? "out.mp4";
  const ext = out.split(".").pop() ?? "mp4";
  const lines = [`Output #0, ${ext === "mkv" ? "matroska" : ext}, to '${out}':`, "  Metadata:", "    encoder         : Lavf-mock"];
  let i = 0;
  for (let k = 0; k < args.length - 1; k++) {
    const a = args[k];
    if (/^-c:v(:|$)/.test(a)) lines.push(`  Stream #0:${i++}: Video: ${codecOf(args[k + 1])} (Main), yuv420p10le(tv, progressive), 1920x1080 [SAR 1:1 DAR 16:9], q=2-31, 25 fps, 1k tbn`);
    else if (/^-c:a(:|$)/.test(a)) lines.push(`  Stream #0:${i++}: Audio: ${codecOf(args[k + 1])}, 48000 Hz, stereo, fltp, 192 kb/s`);
    else if (/^-c:s(:|$)/.test(a)) lines.push(`  Stream #0:${i++}(eng): Subtitle: ${codecOf(args[k + 1])}`);
  }
  lines.push("Press [q] to stop, [?] for help");
  return lines;
}
