import { useConnection, type NodeProps } from "@xyflow/react";
import { useEffect, type ReactNode } from "react";
import { PARAMS_PAD, resolveEncoder } from "../../model/encoders";
import type { EncoderNodeData, EncoderParamsNodeData, EncoderSettings, FilterNodeData, InputNodeData, Media, MuxerNodeData, PadDef } from "../../model/types";
import { useGraph, type AppNode } from "../../store/graph";
import { resolveFormat } from "../../validation/compat";
import { findPad, getPads, groupInputPads, nodeMedia, nodeTitle, type InputPadGroupId } from "../defs";
import { getEncoderSchema, withDefaults } from "../defs/encoders";
import { defaultParams } from "../defs/filters";
import { filterDefOf } from "../defs/generic";
import { letterboxSource, LETTERBOX_ID } from "../../model/letterbox";
import type { GNode } from "../../model/types";
import { NodeShell, PadGroup, PadRow } from "./NodeShell";

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

function InputNode({ id, data, selected }: NodeProps<AppNode>) {
  const d = data as InputNodeData;
  const pads = getPads({ id, position: { x: 0, y: 0 }, data: d });
  const dur = Number(d.probe?.format.duration);
  // narrow selectors: re-render only when this node's connections or a reverse drag change
  const connectedKey = useGraph((s) =>
    s.edges
      .filter((e) => e.source === id)
      .map((e) => e.sourceHandle ?? "")
      .join(","),
  );
  const reverseDrag = useConnection((c) => c.inProgress && c.fromHandle?.type === "target");
  const updateData = useGraph((s) => s.updateData);
  const { main, groups } = groupInputPads(pads.outputs, new Set(connectedKey.split(",")));
  const isOpen = (g: InputPadGroupId) => !!d.ui?.[g] || reverseDrag;
  const rendered = [...main, ...groups.flatMap((g) => (isOpen(g.id) ? g.pads : []))];
  const toggle = (g: InputPadGroupId) =>
    updateData(id, (nd) => (nd.kind === "input" ? { ...nd, ui: { ...nd.ui, [g]: !nd.ui?.[g] } } : nd));
  const outputContent = (
    <>
      {main.map((p) => (
        <PadRow key={p.id} pad={p} side="out" />
      ))}
      {groups.map((g) => (
        <PadGroup key={g.id} title={g.title} pads={g.pads} open={isOpen(g.id)} onToggle={() => toggle(g.id)} />
      ))}
    </>
  );
  return (
    <NodeShell
      id={id}
      title="Input"
      subtitle={d.path ? basename(d.path) : undefined}
      selected={selected}
      inputs={[]}
      outputs={rendered}
      outputContent={outputContent}
      layoutKey={groups.map((g) => `${g.id}:${isOpen(g.id)}`).join(",")}
    >
      {!d.path && <div className="muted">Pick a file in the inspector →</div>}
      {d.probing && <div className="muted">Probing…</div>}
      {d.probeError && <div className="error-text">{d.probeError}</div>}
      {d.probe && (
        <div className="muted small">
          {d.probe.format.format_name}
          {Number.isFinite(dur) ? ` · ${dur.toFixed(1)} s` : ""}
          {d.options.ss || d.options.t ? ` · trim ${d.options.ss || "0"}+${d.options.t || "∞"}` : ""}
        </div>
      )}
    </NodeShell>
  );
}

function FilterNode({ id, data, selected }: NodeProps<AppNode>) {
  const d = data as FilterNodeData;
  const def = filterDefOf(d);
  const pads = getPads({ id, position: { x: 0, y: 0 }, data: d });
  const loadFilterHelp = useGraph((s) => s.loadFilterHelp);
  const needsHelp = !!d.generic && !d.generic.help && !d.generic.error;
  useEffect(() => {
    if (needsHelp) void loadFilterHelp(id);
  }, [needsHelp, id, loadFilterHelp]);
  // Remove letterbox: detect once by itself when first connected to a probed video stream
  const isLb = d.defId === LETTERBOX_ID;
  const lbReady = useGraph(
    (s) => isLb && !d.letterbox && !d.params.top && !d.params.bottom && !!letterboxSource({ nodes: s.nodes as GNode[], edges: s.edges }, id)?.stream?.height,
  );
  const detectLetterbox = useGraph((s) => s.detectLetterbox);
  useEffect(() => {
    if (lbReady) void detectLetterbox(id);
  }, [lbReady, id, detectLetterbox]);
  const visible = (p: NonNullable<typeof def>["params"][number]) => !p.visibleIf || p.visibleIf({ ...defaultParams(def!.params), ...d.params });
  // generic nodes show the options that differ from ffmpeg's defaults
  const face = d.generic
    ? (def?.params.filter((p) => !p.ui && d.params[p.name] !== undefined && d.params[p.name] !== p.default).slice(0, 5) ?? [])
    : (def?.params.filter((p) => p.face && visible(p)) ?? []);
  const shown = (p: (typeof face)[number]) => {
    const v = String(d.params[p.name] ?? p.default);
    if (p.type === "file") return v ? basename(v) : "—";
    if (p.type === "bool") return v === "true" ? "on" : "off";
    return p.options?.find((o) => o.value === v)?.label ?? (v === "" ? "—" : v);
  };
  return (
    <NodeShell id={id} title={nodeTitle(d)} subtitle={isLb ? (d.letterbox?.running ? "detecting…" : "crop") : d.generic ? (d.generic.help ? "ffmpeg filter" : d.generic.error ? "options unavailable" : "reading options…") : def?.ffName} media={nodeMedia(d)} selected={selected} inputs={pads.inputs} outputs={pads.outputs}>
      {face.length > 0 && (
        <div className="face">
          {face.map((p) => (
            <div key={p.name} className="face-row">
              <span>{p.label ?? p.name}</span>
              <b>{shown(p)}</b>
            </div>
          ))}
        </div>
      )}
    </NodeShell>
  );
}

/** codec + quality/bitrate rows shared by encoder and parameters nodes. */
function SettingsFace({ s, extra }: { s: EncoderSettings & { media: EncoderNodeData["media"] }; extra?: ReactNode }) {
  const schema = getEncoderSchema(s.codec, s.media);
  const summary = schema.summary?.(withDefaults(schema, s.params));
  return (
    <div className="face">
      <div className="face-row">
        <span>codec</span>
        <b>{s.codec}</b>
      </div>
      {summary && (
        <div className="face-row">
          <span>{s.media === "video" ? "quality" : "bitrate"}</span>
          <b>{summary}</b>
        </div>
      )}
      {extra}
    </div>
  );
}

function EncoderParamsNode({ id, data, selected }: NodeProps<AppNode>) {
  const d = data as EncoderParamsNodeData;
  const pads = getPads({ id, position: { x: 0, y: 0 }, data: d });
  const users = useGraph((s) => s.edges.filter((e) => e.source === id && e.sourceHandle === PARAMS_PAD).length);
  return (
    <NodeShell id={id} title={nodeTitle(d)} media={d.media} selected={selected} inputs={pads.inputs} outputs={pads.outputs}>
      <SettingsFace
        s={d}
        extra={
          <div className="face-row">
            <span>used by</span>
            <b>{users ? `${users} encoder${users > 1 ? "s" : ""}` : "—"}</b>
          </div>
        }
      />
    </NodeShell>
  );
}

function EncoderNode({ id, data, selected }: NodeProps<AppNode>) {
  const d = data as EncoderNodeData;
  const pads = getPads({ id, position: { x: 0, y: 0 }, data: d });
  // the settings live on the parameters node wired to the top pad
  const params = useGraph((s) => {
    const e = s.edges.find((x) => x.target === id && x.targetHandle === PARAMS_PAD);
    const n = e && s.nodes.find((x) => x.id === e.source);
    return n?.data.kind === "encparams" ? (n.data as EncoderParamsNodeData) : undefined;
  });
  return (
    <NodeShell id={id} title={nodeTitle(d)} media={d.media} selected={selected} inputs={pads.inputs} outputs={pads.outputs}>
      {params && params.media === d.media ? (
        <SettingsFace s={params} />
      ) : (
        <div className="face">
          <div className="face-row error-text">no parameters connected</div>
        </div>
      )}
    </NodeShell>
  );
}

function MuxerNode({ id, data, selected }: NodeProps<AppNode>) {
  const d = data as MuxerNodeData;
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const counters: Partial<Record<Media, number>> = {};
  const labels = new Map<string, { label: string; media?: Media }>();
  for (const slot of d.slots) {
    const e = edges.find((x) => x.target === id && x.targetHandle === slot.id);
    if (!e) {
      labels.set(slot.id, { label: "+ connect stream" });
      continue;
    }
    const src = nodes.find((n) => n.id === e.source);
    const pad = findPad(src, e.sourceHandle, "source");
    const media = pad?.type.media === "any" ? undefined : pad?.type.media;
    const k = media ? (counters[media] = (counters[media] ?? -1) + 1) : 0;
    const what =
      src?.data.kind === "encoder"
        ? resolveEncoder({ nodes: nodes as GNode[], edges }, src as GNode<EncoderNodeData>).codec
        : src?.data.kind === "input"
          ? "copy"
          : "?";
    labels.set(slot.id, { label: `${media ?? "?"} ${k} · ${what}${slot.language ? ` [${slot.language}]` : ""}`, media });
  }
  const inputs: PadDef[] = getPads({ id, position: { x: 0, y: 0 }, data: d }).inputs.map((p) => ({ ...p, label: labels.get(p.id)?.label ?? p.label }));
  const fmt = resolveFormat(d);
  return (
    <NodeShell
      id={id}
      title="Output"
      subtitle={d.path ? basename(d.path) : undefined}
      selected={selected}
      inputs={inputs}
      outputs={[]}
      inputMedia={(p) => labels.get(p.id)?.media}
    >
      <div className="muted small">{fmt ? `container: ${fmt}` : d.path ? "unknown container" : "Set a file name in the inspector →"}</div>
    </NodeShell>
  );
}

export const nodeTypes = { "ff-input": InputNode, "ff-filter": FilterNode, "ff-encparams": EncoderParamsNode, "ff-encoder": EncoderNode, "ff-muxer": MuxerNode };
