// Pure helpers for the job popups: progress values, time left, and the output stream
// details ffmpeg prints to stderr ("Output #0, mp4, to 'x':" / "  Stream #0:0: Video: ...").

export type OutMedia = "video" | "audio" | "subtitle" | "data" | "attachment";

export interface OutStreamInfo {
  /** Output file index (#N) and stream index within it (#N:M). */
  output: number;
  index: number;
  media: OutMedia;
  codec: string;
  profile?: string;
  pixFmt?: string;
  width?: number;
  height?: number;
  fps?: string;
  sampleRate?: number;
  channels?: string;
  bitrate?: string;
}

export interface OutFileInfo {
  index: number;
  format: string;
  path: string;
}

export interface ProgressInfo {
  /** Seconds of output written. */
  outTime?: number;
  /** 0..1, NaN when the duration is unknown. */
  progress: number;
  speed?: string;
  /** Speed as a number (3.1 for "3.1x"). */
  speedX?: number;
  fps?: string;
  bitrate?: string;
  totalSize?: number;
  frame?: number;
  dupFrames?: number;
  dropFrames?: number;
}

const num = (v: string | undefined) => {
  if (v === undefined || v === "N/A" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** One `-progress pipe:1` block → display values. */
export function parseProgress(v: Record<string, string>, duration?: number): ProgressInfo {
  const us = num(v.out_time_us) ?? num(v.out_time_ms); // out_time_ms is microseconds too (ffmpeg quirk)
  const outTime = us !== undefined && us >= 0 ? us / 1e6 : undefined;
  const speedX = v.speed && v.speed !== "N/A" ? num(v.speed.replace(/x$/, "").trim()) : undefined;
  const fps = num(v.fps);
  return {
    outTime,
    progress: duration && outTime !== undefined ? Math.min(1, Math.max(0, outTime / duration)) : NaN,
    speed: speedX !== undefined ? `${speedX < 10 ? speedX.toFixed(2) : speedX.toFixed(1)}x` : undefined,
    speedX,
    fps: fps !== undefined ? (fps < 100 ? fps.toFixed(1) : fps.toFixed(0)) : undefined,
    bitrate: v.bitrate && v.bitrate !== "N/A" ? v.bitrate.trim().replace("kbits/s", " kb/s") : undefined,
    totalSize: num(v.total_size),
    frame: num(v.frame),
    dupFrames: num(v.dup_frames),
    dropFrames: num(v.drop_frames),
  };
}

/**
 * Seconds left. Uses ffmpeg's speed when known, else the average rate so far.
 * Undefined when there is nothing to estimate from.
 */
export function timeLeft(duration: number | undefined, outTime: number | undefined, speedX: number | undefined, elapsedSec: number): number | undefined {
  if (!duration || outTime === undefined) return undefined;
  const remaining = Math.max(0, duration - outTime);
  if (speedX && speedX > 0) return remaining / speedX;
  if (outTime > 0 && elapsedSec > 0) return remaining * (elapsedSec / outTime);
  return undefined;
}

/** Splits on commas that are not inside (...) or [...]. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const DISPOSITIONS = new Set([
  "default", "dub", "original", "comment", "lyrics", "karaoke", "forced", "hearing impaired", "visual impaired",
  "clean effects", "attached pic", "timed thumbnails", "captions", "descriptions", "metadata", "dependent", "still image", "non-diegetic", "multilayer",
]);

const STREAM_RE = /^\s+Stream #(\d+):(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Subtitle|Data|Attachment): (.*)$/;
const OUTPUT_RE = /^Output #(\d+), ([^,]+), to '(.*)':\s*$/;

/** Parses the body of one stream line ("hevc (Main) (hev1 / 0x...), yuv420p(tv), 1920x1080 [SAR..], 30 fps, ..."). */
export function parseStreamDetails(output: number, index: number, media: OutMedia, body: string): OutStreamInfo {
  const parts = splitTop(body);
  const head = parts[0] ?? "";
  const codec = head.split(/\s/)[0] || "?";
  // "(Main)" is a profile; "(hev1 / 0x31766568)" is the codec tag and is skipped
  // "(default)", "(forced)" ... at the end of the line are stream flags (dispositions), not profiles
  const profile = [...head.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).find((p) => !p.includes("/") && !/^\[/.test(p) && !DISPOSITIONS.has(p));
  const s: OutStreamInfo = { output, index, media, codec, profile };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^(\d+)x(\d+)/))) {
      s.width = Number(m[1]);
      s.height = Number(m[2]);
    } else if ((m = p.match(/^([\d.]+k?) fps$/))) s.fps = m[1];
    else if ((m = p.match(/^(\d+) Hz$/))) {
      s.sampleRate = Number(m[1]);
      // the channel layout follows the sample rate ("48000 Hz, 5.1(side), fltp")
      if (parts[i + 1] && !/kb\/s$/.test(parts[i + 1])) s.channels = parts[++i];
    } else if ((m = p.match(/^(\d+) kb\/s/))) s.bitrate = `${m[1]} kb/s`;
    else if (i === 1 && media === "video") s.pixFmt = p.replace(/\(.*\)$/, "");
  }
  return s;
}

/** Feeds stderr lines; collects the output files and their streams as ffmpeg prints them. */
export class OutputInfoParser {
  files: OutFileInfo[] = [];
  streams: OutStreamInfo[] = [];
  private inOutput = false;

  /** True when the line added something. */
  feed(line: string): boolean {
    const o = line.match(OUTPUT_RE);
    if (o) {
      this.inOutput = true;
      const index = Number(o[1]);
      if (!this.files.some((f) => f.index === index)) this.files.push({ index, format: o[2].trim(), path: o[3] });
      return true;
    }
    // any other top-level line ends the "Output #N" block
    if (!/^\s/.test(line)) {
      this.inOutput = false;
      return false;
    }
    if (!this.inOutput) return false;
    const m = line.match(STREAM_RE);
    if (!m) return false;
    const output = Number(m[1]);
    const index = Number(m[2]);
    if (this.streams.some((x) => x.output === output && x.index === index)) return false;
    this.streams.push(parseStreamDetails(output, index, m[3].toLowerCase() as OutMedia, m[4]));
    return true;
  }
}

/** Short one-line description of an output stream ("hevc Main · 1920×1080 · 30 fps · yuv420p"). */
export function describeStream(s: OutStreamInfo): string[] {
  const parts = [s.profile ? `${s.codec} ${s.profile}` : s.codec];
  if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
  if (s.fps) parts.push(`${s.fps} fps`);
  if (s.pixFmt) parts.push(s.pixFmt);
  if (s.sampleRate) parts.push(`${s.sampleRate % 1000 === 0 ? s.sampleRate / 1000 : (s.sampleRate / 1000).toFixed(1)} kHz`);
  if (s.channels) parts.push(s.channels);
  if (s.bitrate) parts.push(s.bitrate);
  return parts;
}

/** 83.4 → "1:23", 3723 → "1:02:03". */
export function fmtDuration(s?: number): string {
  if (s === undefined || !Number.isFinite(s)) return "–";
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function fmtBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : v.toFixed(0)} ${units[i]}`;
}

/** "C:\videos\out.mp4" → { name: "out.mp4", dir: "C:\videos" }. */
export function splitPath(p: string): { name: string; dir: string } {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? { name: p, dir: "" } : { name: p.slice(i + 1), dir: p.slice(0, i) };
}
