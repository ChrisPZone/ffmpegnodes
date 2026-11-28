// Graph-level checks beyond "does it serialize": availability, codec/container fit,
// profile vs pixel format, implicit conversions.
import { TEN_BIT_PIX_FMTS } from "../model/format";
import { encoderOnGpuFrames, gpuResidency, isGpuEncoder, transferInto } from "../model/hw";
import type { Capabilities, Diagnostic, GNode, GpuInfo, Graph, InputNodeData, MuxerNodeData, ResolvedEncoderData } from "../model/types";
import { resolveEncoders } from "../model/encoders";
import { letterboxDiagnostics, LETTERBOX_ID } from "../model/letterbox";
import { isSequencePattern, toFramePattern } from "../model/sequence";
import { encoderDefaults, getPads, nodeTitle } from "../nodes/defs";
import { filterDefOf } from "../nodes/defs/generic";
import { DEEP_IMAGE_PIX_FMT, EIGHT_BIT_IMAGE_FMTS, getEncoderSchema, isParamVisible, withDefaults } from "../nodes/defs/encoders";
import type { SerializeResult } from "../serializer";
import { checkCompat, checkImageCodec, extensionOf, IMAGE_EXT_CODEC, isMp4Family, resolveFormat } from "./compat";
import { conversionAt, type Negotiation } from "./negotiate";

/** Ids of every node fed, directly or not, by `id`. */
function downstream(g: Graph, id: string): Set<string> {
  const seen = new Set<string>();
  const todo = [id];
  while (todo.length) {
    const cur = todo.pop()!;
    for (const e of g.edges) if (e.source === cur && !seen.has(e.target)) (seen.add(e.target), todo.push(e.target));
  }
  return seen;
}

const norm = (p: string) => p.trim().replace(/\\/g, "/").toLowerCase();

export function validate(graph: Graph, ser: SerializeResult, neg: Negotiation, caps?: Capabilities, gpus?: GpuInfo[]): Diagnostic[] {
  const g = resolveEncoders(graph);
  const out: Diagnostic[] = [...ser.diagnostics];
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const inEdge = (id: string, pad: string) => g.edges.find((e) => e.target === id && e.targetHandle === pad);

  const residency = gpuResidency(g);
  const gpuIndexes = gpus?.map((x) => String(x.index));

  for (const n of g.nodes) {
    const d = n.data;
    if (d.kind === "input") {
      if (d.probeError) out.push({ severity: "error", nodeId: n.id, message: d.probeError });
      const r = residency.get(n.id);
      if (r?.blocker && d.options.gpuFrames !== "off") {
        out.push({
          severity: "info",
          nodeId: n.id,
          message: `Decoded frames are copied to system memory because ${r.blocker.label} (${r.blocker.reason}) uses them.${
            r.blocker.reason === "CPU filter" ? " Use GPU filters such as Scale (CUDA) to keep them on the GPU." : ""
          }`,
        });
      }
      if (d.sequence?.missingCount && isSequencePattern(d.path)) {
        const first = d.sequence.missing[0];
        out.push({ severity: "warning", nodeId: n.id, message: `${d.sequence.missingCount} frames of the sequence are missing. ffmpeg stops reading at the first gap (frame ${first}).` });
      }
      if (d.options.loop.trim() === "1" && !d.options.t.trim()) {
        const reach = downstream(g, n.id);
        const outs = g.nodes.filter((m) => m.data.kind === "muxer" && reach.has(m.id));
        if (!outs.length || outs.some((m) => !(m.data as MuxerNodeData).shortest)) {
          out.push({ severity: "warning", nodeId: n.id, message: "Loop repeats the images forever. Set a duration (-t), or turn on \"End with shortest stream\" on the Output." });
        }
      }
      const dev = d.options.hwaccel_device?.trim();
      if (d.options.hwaccel === "cuda" && dev && gpuIndexes && !gpuIndexes.includes(dev)) {
        out.push({ severity: "warning", nodeId: n.id, message: `GPU ${dev} was not found (available: ${gpuIndexes.join(", ") || "none"}).` });
      }
    }
    if (d.kind === "filter" && filterDefOf(d)) {
      const def = filterDefOf(d)!;
      if (caps && caps.filters.length && !caps.filters.some((f) => f.name === def.ffName)) {
        out.push({ severity: "error", nodeId: n.id, message: `Filter "${def.ffName}" is not available in this ffmpeg build.` });
      }
    }
    if (d.kind === "filter" && d.defId === LETTERBOX_ID) {
      const e = g.edges.find((x) => x.target === n.id);
      const f = e ? neg.padFormat(e.source, e.sourceHandle ?? "") : undefined;
      out.push(...letterboxDiagnostics(g, n as GNode<typeof d>, f?.media === "video" ? f.height : undefined));
    }
    if (d.kind === "filter" && d.generic?.error) {
      out.push({ severity: "warning", nodeId: n.id, message: `Could not read the options of "${d.generic.name}" (${d.generic.error}). Only "Extra options" can be set.` });
    }
    if (d.kind === "filter" && filterDefOf(d)) {
      // frames that change between system and GPU memory in front of this filter
      for (const e of g.edges.filter((x) => x.target === n.id)) {
        const t = transferInto(g, residency, n, { nodeId: e.source, padId: e.sourceHandle ?? "" });
        if (t === "download") {
          out.push({ severity: "info", nodeId: n.id, edgeId: e.id, message: `${nodeTitle(d)} runs on the CPU: frames are copied from the GPU to system memory here (hwdownload).` });
        } else if (t === "upload") {
          const src = nodes.get(e.source);
          const inp = src?.data.kind === "input" ? (src as GNode<InputNodeData>) : undefined;
          const fix =
            inp && inp.data.options.hwaccel !== "cuda"
              ? { label: "Decode with cuda", nodeId: inp.id, patch: { options: { ...inp.data.options, hwaccel: "cuda", gpuFrames: "auto" } } }
              : inp && inp.data.options.gpuFrames === "off"
                ? { label: "Keep frames on GPU", nodeId: inp.id, patch: { options: { ...inp.data.options, gpuFrames: "auto" } } }
                : undefined;
          const blocker = inp ? residency.get(inp.id)?.blocker : undefined;
          out.push({
            severity: "info",
            nodeId: n.id,
            edgeId: e.id,
            message:
              inp && inp.data.options.hwaccel === "cuda" && blocker
                ? `Frames are uploaded to the GPU here (hwupload_cuda): ${blocker.label} (${blocker.reason}) makes the Input decode into system memory.`
                : inp
                  ? `Frames are uploaded to the GPU here (hwupload_cuda). Decoding with cuda would keep them on the GPU from the start.`
                  : `Frames are uploaded to the GPU here (hwupload_cuda), after ${src ? nodeTitle(src.data) : "a CPU node"}.`,
            fix,
          });
        }
      }
    }
    if (d.kind === "encoder" && !(d as ResolvedEncoderData).missingParams && isGpuEncoder((d as ResolvedEncoderData).codec)) {
      const gpu = String((d as ResolvedEncoderData).params.gpu ?? "").trim();
      if (gpu && gpuIndexes && !gpuIndexes.includes(gpu) && !encoderOnGpuFrames(g, residency, n.id)) {
        out.push({ severity: "warning", nodeId: n.id, message: `GPU ${gpu} was not found (available: ${gpuIndexes.join(", ") || "none"}).` });
      }
    }
    if (d.kind === "filter") {
      const outs = getPads(n).outputs;
      if (!g.edges.some((e) => e.source === n.id && outs.some((p) => p.id === e.sourceHandle))) {
        out.push({ severity: "warning", nodeId: n.id, message: "Filter output is not used." });
      }
    }
    if (d.kind === "encoder") {
      checkEncoder(n as GNode<ResolvedEncoderData>, out, caps, (pad) => {
        const e = inEdge(n.id, pad);
        return e ? neg.padFormat(e.source, e.sourceHandle ?? "") : undefined;
      });
      if (!g.edges.some((e) => e.source === n.id)) out.push({ severity: "warning", nodeId: n.id, message: "Encoder output is not connected to an Output." });
    }
  }

  // container compatibility per output stream
  for (const j of ser.jobs) {
    const m = nodes.get(j.muxerId) as GNode<MuxerNodeData>;
    const fmt = resolveFormat(m.data);
    let codecId: string | undefined;
    if (j.source.kind === "copy") {
      const inp = nodes.get(j.source.inputId) as GNode<InputNodeData>;
      const idx = j.source.streamIndex;
      codecId = inp.data.probe?.streams.find((s) => s.index === idx)?.codec_name;
    } else {
      const enc = nodes.get(j.source.encoderId) as GNode<ResolvedEncoderData>;
      // ffmpeg's own "(codec x)" beats our name-based guess for encoders without a schema
      codecId = caps?.encoders.find((e) => e.name === enc.data.codec)?.codec ?? getEncoderSchema(enc.data.codec, enc.data.media).codecId;
    }
    const c = checkCompat(fmt, j.media, codecId);
    if (c.level !== "ok") out.push({ severity: c.level, nodeId: m.id, edgeId: j.edgeId, message: c.message! });
    if (fmt === "image2" && j.media === "video") {
      const ic = checkImageCodec(m.data.path, codecId);
      if (ic.level !== "ok") {
        const want = IMAGE_EXT_CODEC[extensionOf(m.data.path)];
        const encName = want === "webp" ? "libwebp" : want;
        const enc = j.source.kind === "encode" ? (nodes.get(j.source.encoderId) as GNode<ResolvedEncoderData>) : undefined;
        out.push({
          severity: "error",
          nodeId: m.id,
          edgeId: j.edgeId,
          message: ic.message!,
          // the codec lives on the parameters node
          fix: enc?.data.paramsId ? { label: `Use ${encName}`, nodeId: enc.data.paramsId, patch: { codec: encName, params: encoderDefaults(encName, "video") } } : undefined,
        });
      }
    }

    const slotIdx = m.data.slots.findIndex((s) => s.id === j.slotId);
    const slot = m.data.slots[slotIdx];
    if (codecId === "hevc" && isMp4Family(fmt) && slot.tag.trim() !== "hvc1") {
      const slots = m.data.slots.map((s, i) => (i === slotIdx ? { ...s, tag: "hvc1" } : s));
      out.push({
        severity: "warning",
        nodeId: m.id,
        edgeId: j.edgeId,
        message: `H.265 in ${fmt?.toUpperCase()} needs -tag:v hvc1 to play on Apple devices.`,
        fix: { label: "Set tag hvc1", nodeId: m.id, patch: { slots } },
      });
    }
    if (j.source.kind === "copy" && !fmt && m.data.path.trim()) {
      out.push({ severity: "warning", nodeId: m.id, message: "Unknown file extension; choose a container format." });
    }
  }

  // image sequences need a frame number in the file name (or a single image)
  for (const o of ser.outputs) {
    const m = nodes.get(o.nodeId) as GNode<MuxerNodeData>;
    if (resolveFormat(m.data) !== "image2" || m.data.singleImage || !o.path || isSequencePattern(o.path)) continue;
    out.push({
      severity: "error",
      nodeId: m.id,
      message: 'An image sequence needs a frame number in the file name, e.g. frames_%05d.png (or turn on "Single image").',
      fix: { label: "Number the frames", nodeId: m.id, patch: { path: toFramePattern(m.data.path.trim()) } },
    });
  }

  // file name collisions
  const outPaths = new Map<string, string>();
  for (const o of ser.outputs) {
    const p = norm(o.path);
    if (!p) continue;
    if (outPaths.has(p)) out.push({ severity: "error", nodeId: o.nodeId, message: `Two outputs write to ${o.path}.` });
    outPaths.set(p, o.nodeId);
    for (const id of ser.inputOrder) {
      const inp = nodes.get(id) as GNode<InputNodeData>;
      if (norm(inp.data.path) === p) out.push({ severity: "error", nodeId: o.nodeId, message: "Output would overwrite one of its inputs." });
    }
  }
  return dedupe(out);
}

function checkEncoder(
  n: GNode<ResolvedEncoderData>,
  out: Diagnostic[],
  caps: Capabilities | undefined,
  incoming: (pad: string) => ReturnType<Negotiation["padFormat"]>,
) {
  const d = n.data;
  if (d.missingParams) {
    const m = `${d.media[0].toUpperCase()}${d.media.slice(1)}`;
    out.push({ severity: "error", nodeId: n.id, message: `${m} encoder has no parameters: connect ${m} Encoder Parameters to its parameters pad.` });
    return;
  }
  // settings live on the parameters node: quick fixes patch that node
  const target = d.paramsId ?? n.id;
  if (caps && caps.encoders.length && !caps.encoders.some((e) => e.name === d.codec)) {
    out.push({ severity: "error", nodeId: n.id, message: `Encoder "${d.codec}" is not available in this ffmpeg build.` });
  }
  // options the chosen mode depends on (e.g. Bitrate in CBR) must not be empty
  const schema = getEncoderSchema(d.codec, d.media);
  const values = withDefaults(schema, d.params);
  for (const p of schema.params) {
    if (p.emitDefault && isParamVisible(p, values) && String(values[p.name]).trim() === "" && p.default !== "") {
      out.push({
        severity: "warning",
        nodeId: n.id,
        message: `${p.label ?? p.name} is empty; ffmpeg will use the encoder's default.`,
        fix: { label: `Use ${p.default}`, nodeId: target, patch: { params: { ...d.params, [p.name]: p.default } } },
      });
    }
  }
  const fmt = incoming("in");
  if (d.media === "video") {
    const profile = String(d.params.profile ?? "auto");
    const explicit = d.params.pix_fmt && d.params.pix_fmt !== "auto" ? String(d.params.pix_fmt) : undefined;
    const effective = explicit ?? (fmt?.media === "video" ? fmt.pix_fmt : undefined);
    if (/10/.test(profile) && effective && !TEN_BIT_PIX_FMTS.test(effective) && d.params.highbitdepth !== true) {
      const onGpu = !explicit && fmt?.media === "video" && !!fmt.hw;
      out.push({
        severity: "error",
        nodeId: n.id,
        message: onGpu
          ? `Profile ${profile} needs 10-bit frames, but the GPU delivers ${effective}. Set Scale (CUDA) to format p010le or enable "10-bit from 8-bit input".`
          : `Profile ${profile} needs a 10-bit pixel format, but the encoder gets ${effective}.`,
        // an explicit pix_fmt would force GPU frames back into system memory, so only offer it off-GPU
        fix: onGpu
          ? "highbitdepth" in d.params
            ? { label: "10-bit from 8-bit input", nodeId: target, patch: { params: { ...d.params, highbitdepth: true } } }
            : undefined
          : { label: "Use yuv420p10le", nodeId: target, patch: { params: { ...d.params, pix_fmt: "yuv420p10le" } } },
      });
    }
  }
  const conv = conversionAt(fmt, d);
  if (schema.image && d.media === "video") {
    const src = fmt?.media === "video" ? fmt.pix_fmt : undefined;
    const set = d.params.pix_fmt && d.params.pix_fmt !== "auto" ? String(d.params.pix_fmt) : undefined;
    // auto keeps the depth (ffmpeg picks rgb48 / gbrp10 for 10-bit input); an explicit 8-bit format drops it
    if (src && TEN_BIT_PIX_FMTS.test(src) && d.codec === "mjpeg") {
      out.push({ severity: "warning", nodeId: n.id, message: `The source is ${src}, but JPEG keeps only 8 bits per channel. Use PNG, TIFF or DPX to keep the depth.` });
    } else if (src && TEN_BIT_PIX_FMTS.test(src) && set && EIGHT_BIT_IMAGE_FMTS.has(set)) {
      const deep = DEEP_IMAGE_PIX_FMT[d.codec];
      out.push({
        severity: "warning",
        nodeId: n.id,
        message: `The source is ${src} but ${set} keeps only 8 bits per channel; smooth gradients may band.`,
        fix: deep ? { label: `Use ${deep}`, nodeId: target, patch: { params: { ...d.params, pix_fmt: deep } } } : undefined,
      });
    }
    if (conv) {
      // YUV video becomes RGB images: expected, but the colour matrix decides how it looks
      out.push({
        severity: "info",
        nodeId: n.id,
        message: `Frames are converted for the images (${conv}). Untagged video is read as BT.601; if colours look off, set the input colour matrix with Scale.`,
      });
    }
    return;
  }
  if (conv) {
    // -ar/-ac on the encoder is the intended friendly path for audio (shown on the edge);
    // a silent pixel-format conversion is worth a warning.
    out.push({
      severity: d.media === "video" ? "warning" : "info",
      nodeId: n.id,
      message:
        d.media === "video"
          ? `ffmpeg will convert implicitly (${conv}). Add a Pixel format filter before the encoder to make it explicit.`
          : `ffmpeg resamples before encoding (${conv}).`,
    });
  }
  if (d.media === "audio" && fmt?.media === "audio" && (fmt.sample_rate ?? 0) > 96000 && (!d.params.ar || d.params.ar === "auto")) {
    out.push({
      severity: "warning",
      nodeId: n.id,
      message: `Incoming audio is ${fmt.sample_rate! / 1000} kHz (loudnorm upsamples to 192 kHz). Set a sample rate.`,
      fix: { label: "Set 48 kHz", nodeId: target, patch: { params: { ...d.params, ar: "48000" } } },
    });
  }
}

function dedupe(ds: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return ds.filter((d) => {
    const k = `${d.severity}|${d.nodeId}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
