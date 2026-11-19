// Stream formats as they flow along "frames" edges (used for negotiation display and checks).
import type { StreamInfo } from "./types";

export interface VideoFormat {
  media: "video";
  width?: number;
  height?: number;
  /** Software pixel format (for GPU frames: the surface's sw_format). */
  pix_fmt?: string;
  fps?: number;
  /** Frames live in GPU memory. */
  hw?: "cuda";
}

export interface AudioFormat {
  media: "audio";
  sample_rate?: number;
  channels?: number;
  layout?: string;
}

export interface OtherFormat {
  media: "subtitle" | "data" | "attachment";
  codec?: string;
}

export type StreamFormat = VideoFormat | AudioFormat | OtherFormat;

export function parseRate(r?: string): number | undefined {
  if (!r) return undefined;
  const [n, d] = r.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return undefined;
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : undefined;
}

export function formatFromStream(s: StreamInfo): StreamFormat {
  switch (s.codec_type) {
    case "video":
      return {
        media: "video",
        width: s.width,
        height: s.height,
        pix_fmt: s.pix_fmt,
        fps: parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate),
      };
    case "audio":
      return {
        media: "audio",
        sample_rate: s.sample_rate ? Number(s.sample_rate) : undefined,
        channels: s.channels,
        layout: s.channel_layout,
      };
    default:
      return { media: s.codec_type, codec: s.codec_name };
  }
}

export function describeFormat(f?: StreamFormat): string {
  if (!f) return "";
  if (f.media === "video") {
    const parts: string[] = [];
    if (f.width && f.height) parts.push(`${f.width}×${f.height}`);
    else if (f.width || f.height) parts.push(`${f.width ?? "?"}×${f.height ?? "?"}`);
    if (f.pix_fmt) parts.push(f.pix_fmt);
    if (f.fps) parts.push(`${f.fps}fps`);
    if (f.hw) parts.push(`· GPU (${f.hw})`);
    return parts.join(" ");
  }
  if (f.media === "audio") {
    const parts: string[] = [];
    if (f.sample_rate) parts.push(`${f.sample_rate / 1000} kHz`);
    if (f.layout) parts.push(f.layout);
    else if (f.channels) parts.push(`${f.channels}ch`);
    return parts.join(" ");
  }
  return f.codec ?? "";
}

/** Surface format NVDEC hands out for a given software pixel format. */
/** Formats CUDA frames can hold (hwupload_cuda accepts these as they are). */
const CUDA_SW_FORMATS = new Set(["nv12", "yuv420p", "yuv444p", "p010le", "p016le", "yuv444p16le", "bgr0", "rgb0", "0rgb", "0bgr", "bgra", "rgba"]);

/** Pixel format to upload a system-memory frame as: unchanged when CUDA can hold it, else the closest one. */
export function cudaUploadFormat(pix_fmt?: string): string | undefined {
  if (!pix_fmt || CUDA_SW_FORMATS.has(pix_fmt)) return pix_fmt;
  const deep = /p1[0-6](le|be)$|^p01[06]/.test(pix_fmt);
  if (/^(yuv|yuvj|gbr)444/.test(pix_fmt)) return deep ? "yuv444p16le" : "yuv444p";
  return deep ? "p010le" : "nv12";
}

export function cudaSurfaceFormat(pix_fmt?: string): string | undefined {
  if (!pix_fmt) return undefined;
  if (/^yuv420p$|^yuvj420p$|^nv12$/.test(pix_fmt)) return "nv12";
  if (/^yuv420p1[02](le|be)$|^p010/.test(pix_fmt)) return "p010le";
  if (/^yuv444p$|^yuvj444p$/.test(pix_fmt)) return "yuv444p";
  if (/^yuv444p1[02](le|be)$/.test(pix_fmt)) return "yuv444p16le";
  return pix_fmt;
}

export const TEN_BIT_PIX_FMTS = /(10|12)(le|be)$|^p010|^p210|^p410|^x2rgb10|^gbrp1[02]/;
