// Where a job's work runs (GPU n / CPU / other hardware), per stage and per output stream.
// Read from the graph with the same rules the serializer uses (model/hw.ts): ffmpeg does not
// report which device it picked at normal log level.
import { parseInputPad } from "../nodes/defs";
import { filterDefOf } from "../nodes/defs/generic";
import type { SerializeResult, StreamJob } from "../serializer";
import { resolveEncoders } from "./encoders";
import { encoderOnGpuFrames, gpuResidency, isGpuEncoder, uploadDevice, upstreamInput } from "./hw";
import type { GNode, GpuInfo, Graph, InputNodeData, ResolvedEncoderData } from "./types";

export type Device =
  /** NVIDIA GPU; index "" = not set (driver picks). */
  | { kind: "gpu"; index: string }
  | { kind: "cpu" }
  /** Other hardware API (d3d11va, qsv, amf, vaapi ...). */
  | { kind: "hw"; api: string }
  | { kind: "copy" };

export interface JobDevices {
  decode: Device[];
  filters: Device[];
  encode: Device[];
  /** Per output file, per ffmpeg stream index (#file:index). */
  streams: Device[][];
}

const CPU: Device = { kind: "cpu" };
/** A CUDA device that is not set is device 0 (ffmpeg's CUDA default; only nvenc's -gpu can mean "any"). */
const cudaIndex = (dev: string | undefined) => dev?.trim() || "0";
const OTHER_HW_ENCODER = /_(qsv|amf|vaapi|videotoolbox|mf|v4l2m2m|vulkan|d3d12va)$/;

export const deviceKey = (d: Device) => (d.kind === "gpu" ? `gpu:${d.index}` : d.kind === "hw" ? `hw:${d.api}` : d.kind);

function unique(list: Device[]): Device[] {
  const seen = new Map<string, Device>();
  for (const d of list) if (!seen.has(deviceKey(d))) seen.set(deviceKey(d), d);
  // GPUs first, then other hardware, CPU last
  const rank = (d: Device) => ({ gpu: 0, hw: 1, cpu: 2, copy: 3 })[d.kind];
  return [...seen.values()].sort((a, b) => rank(a) - rank(b) || deviceKey(a).localeCompare(deviceKey(b)));
}

export function jobDevices(graph: Graph, ser: SerializeResult): JobDevices {
  const g = resolveEncoders(graph);
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const res = gpuResidency(g);

  // ---- decoding: per input that is decoded (has a frames wire), video vs other streams
  const decode: Device[] = [];
  for (const id of ser.inputOrder) {
    const n = nodes.get(id) as GNode<InputNodeData> | undefined;
    if (!n) continue;
    const types = new Map((n.data.probe?.streams ?? []).map((s) => [s.index, s.codec_type]));
    for (const e of g.edges) {
      if (e.source !== id) continue;
      const p = parseInputPad(e.sourceHandle ?? "");
      if (p?.domain !== "frames") continue;
      const type = types.get(p.streamIndex);
      // hardware decoding is for video only; unknown streams (no probe) count as video
      if (type && type !== "video") decode.push(CPU);
      else decode.push(inputDecoder(n.data));
    }
  }

  // ---- filters that are part of the command
  const filters: Device[] = [];
  for (const n of g.nodes) {
    if (n.data.kind !== "filter" || !g.edges.some((e) => e.source === n.id)) continue;
    filters.push(filterDefOf(n.data)?.gpu ? { kind: "gpu", index: cudaIndex(uploadDevice(g, n.id)) } : CPU);
  }

  // ---- encoders, per mapped output stream
  const streamDevice = (j: StreamJob): Device => {
    if (j.source.kind === "copy") return { kind: "copy" };
    const enc = nodes.get(j.source.encoderId);
    if (enc?.data.kind !== "encoder") return CPU;
    const codec = (enc.data as ResolvedEncoderData).codec ?? "";
    if (isGpuEncoder(codec)) {
      // nvenc on GPU frames runs on the device the frames are on; -gpu is ignored then
      if (encoderOnGpuFrames(g, res, enc.id)) return { kind: "gpu", index: cudaIndex(upstreamInput(g, enc.id)?.data.options.hwaccel_device) };
      return { kind: "gpu", index: String((enc.data as ResolvedEncoderData).params?.gpu ?? "").trim() };
    }
    const hw = OTHER_HW_ENCODER.exec(codec);
    return hw ? { kind: "hw", api: hw[1] } : CPU;
  };
  const streams = ser.outputs.map((o) => o.streams.map(streamDevice));

  return {
    decode: unique(decode),
    filters: unique(filters),
    encode: unique(streams.flat().filter((d) => d.kind !== "copy")),
    streams,
  };
}

function inputDecoder(d: InputNodeData): Device {
  const api = d.options.hwaccel.trim();
  if (api === "cuda") return { kind: "gpu", index: cudaIndex(d.options.hwaccel_device) };
  if (api && api !== "none") return { kind: "hw", api };
  return CPU;
}

/** "NVIDIA GeForce RTX 4090" → "RTX 4090". */
export const shortGpuName = (name: string) => name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "").trim();

/**
 * Short label: "GPU 0 · RTX 4090", "GPU (auto)", "HW (d3d11va)", "CPU", "copy".
 * A GPU without an index is shown as the only GPU when exactly one is known.
 */
export function deviceLabel(d: Device, gpus?: GpuInfo[], opts: { names?: boolean } = {}): string {
  if (d.kind === "cpu") return "CPU";
  if (d.kind === "copy") return "copy";
  if (d.kind === "hw") return `HW (${d.api})`;
  let index = d.index;
  if (!index && gpus?.length === 1) index = String(gpus[0].index);
  if (!index) return "GPU (auto)";
  const name = opts.names !== false ? gpus?.find((x) => String(x.index) === index)?.name : undefined;
  return name ? `GPU ${index} · ${shortGpuName(name)}` : `GPU ${index}`;
}

/** Used stages with their devices, in pipeline order. */
export function deviceStages(d: JobDevices): [string, Device[]][] {
  return ([["Decode", d.decode], ["Filters", d.filters], ["Encode", d.encode]] as [string, Device[]][]).filter(([, list]) => list.length > 0);
}

/** One line for tooltips: "Decode GPU 0 + CPU · Encode GPU 0". */
export const deviceSummary = (d: JobDevices, gpus?: GpuInfo[]) =>
  deviceStages(d)
    .map(([stage, list]) => `${stage} ${list.map((x) => deviceLabel(x, gpus, { names: false })).join(" + ")}`)
    .join(" · ");

export const usesNvidiaGpu = (d: JobDevices) => [...d.decode, ...d.filters, ...d.encode].some((x) => x.kind === "gpu");
