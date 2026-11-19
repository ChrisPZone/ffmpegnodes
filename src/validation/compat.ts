// Container knowledge: extension → muxer, and which codecs each container can carry.
import type { Media, MuxerNodeData } from "../model/types";

export const EXT_FORMAT: Record<string, string> = {
  mp4: "mp4",
  m4v: "mp4",
  m4a: "ipod",
  mov: "mov",
  mkv: "matroska",
  mka: "matroska",
  webm: "webm",
  ts: "mpegts",
  m2ts: "mpegts",
  avi: "avi",
  mp3: "mp3",
  flac: "flac",
  wav: "wav",
  ogg: "ogg",
  opus: "opus",
  aac: "adts",
  srt: "srt",
  vtt: "webvtt",
  ass: "ass",
  gif: "gif",
  mxf: "mxf",
};

export const COMMON_FORMATS = ["mp4", "mov", "matroska", "webm", "mpegts", "avi", "mp3", "flac", "wav", "ogg", "opus", "adts", "srt", "webvtt", "gif"];

export function extensionOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  return m ? m[1].toLowerCase() : "";
}

/** The muxer ffmpeg will use: explicit choice, else inferred from the file extension. */
export function resolveFormat(d: Pick<MuxerNodeData, "format" | "path">): string | undefined {
  if (d.format && d.format !== "auto") return d.format;
  return EXT_FORMAT[extensionOf(d.path)];
}

export function needsExplicitFormat(d: Pick<MuxerNodeData, "format" | "path">): boolean {
  return !!d.format && d.format !== "auto" && EXT_FORMAT[extensionOf(d.path)] !== d.format;
}

export const isMp4Family = (fmt?: string) => fmt === "mp4" || fmt === "mov" || fmt === "ipod";

type Rule = { ok: string[]; warn?: Record<string, string> };
type Table = Partial<Record<Media, Rule>> & { only?: Media[] };

const MP4: Table = {
  video: { ok: ["h264", "hevc", "av1", "mpeg4", "mjpeg", "vp9"], warn: { vp9: "VP9 in MP4 plays in browsers but many hardware players and editors reject it; prefer WebM or MKV." } },
  audio: { ok: ["aac", "mp3", "ac3", "eac3", "alac", "opus", "flac"], warn: { opus: "Opus in MP4 has limited player support (Apple devices before 2021 can't play it).", flac: "FLAC in MP4 has limited player support." } },
  subtitle: { ok: ["mov_text"] },
};

const TABLES: Record<string, Table> = {
  mp4: MP4,
  ipod: { audio: { ok: ["aac", "alac"] }, only: ["audio"] },
  mov: {
    video: { ok: ["h264", "hevc", "prores", "mjpeg", "mpeg4", "av1", "dnxhd"] },
    audio: { ok: ["aac", "alac", "mp3", "ac3", "eac3", "pcm_s16le", "pcm_s24le", "pcm_f32le", "opus", "flac"] },
    subtitle: { ok: ["mov_text"] },
  },
  webm: { video: { ok: ["vp8", "vp9", "av1"] }, audio: { ok: ["opus", "vorbis"] }, subtitle: { ok: ["webvtt"] }, only: ["video", "audio", "subtitle"] },
  mp3: { audio: { ok: ["mp3"] }, only: ["audio", "video"] },
  flac: { audio: { ok: ["flac"] }, only: ["audio", "video"] },
  adts: { audio: { ok: ["aac"] }, only: ["audio"] },
  opus: { audio: { ok: ["opus"] }, only: ["audio"] },
  srt: { subtitle: { ok: ["subrip"] }, only: ["subtitle"] },
  webvtt: { subtitle: { ok: ["webvtt"] }, only: ["subtitle"] },
  gif: { video: { ok: ["gif"] }, only: ["video"] },
  mpegts: { subtitle: { ok: ["dvb_subtitle", "dvb_teletext"] } },
};

export interface CompatResult {
  level: "ok" | "warning" | "error";
  message?: string;
}

/** Can `codecId` of `media` go into container `fmt`? Unknown containers/codecs pass. */
export function checkCompat(fmt: string | undefined, media: Media, codecId: string | undefined): CompatResult {
  if (!fmt) return { level: "ok" };
  const t = TABLES[fmt];
  if (!t) return { level: "ok" };
  if (t.only && !t.only.includes(media)) return { level: "error", message: `${fmt} cannot carry ${media} streams.` };
  const rule = t[media];
  if (!rule || !codecId) return { level: "ok" };
  if (rule.warn?.[codecId]) return { level: "warning", message: rule.warn[codecId] };
  if (!rule.ok.includes(codecId)) {
    return { level: "error", message: `${fmt} does not support ${media} codec "${codecId}" (supported: ${rule.ok.join(", ")}).` };
  }
  return { level: "ok" };
}
