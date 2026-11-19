import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import { useEffect, type ReactNode } from "react";
import type { Media, PadDef } from "../../model/types";
import { useDerived } from "../../ui/derived";

export function padClass(pad: PadDef, mediaOverride?: Media) {
  const media = mediaOverride ?? pad.type.media;
  return `pad pad-${pad.type.domain} media-${media}`;
}

export function PadRow({ pad, side, media, extra }: { pad: PadDef; side: "in" | "out"; media?: Media; extra?: ReactNode }) {
  return (
    <div className={`pad-row ${side}`} title={`${pad.icon === "packets" ? "packets (stream copy)" : pad.type.domain} · ${media ?? pad.type.media}`}>
      <Handle
        type={side === "in" ? "target" : "source"}
        position={side === "in" ? Position.Left : Position.Right}
        id={pad.id}
        className={padClass(pad, media)}
      />
      <span className="pad-label">{pad.label}</span>
      {pad.icon === "packets" && <PacketsIcon />}
      {pad.hint && <span className="pad-hint">{pad.hint}</span>}
      {extra}
    </div>
  );
}

/** A small parcel: encoded packets, passed on without decoding. */
function PacketsIcon() {
  return (
    <svg className="pad-icon" viewBox="0 0 12 12" aria-label="packets" role="img">
      <path d="M6 1.2 10.5 3.5v5L6 10.8 1.5 8.5v-5Z M1.5 3.5 6 5.8l4.5-2.3 M6 5.8v5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

/** Collapsible group of output pad rows (accordion inside a node). */
export function PadGroup({ title, pads, open, onToggle }: { title: string; pads: PadDef[]; open: boolean; onToggle: () => void }) {
  const medias = [...new Set(pads.map((p) => p.type.media))];
  return (
    <div className={`pad-group ${open ? "open" : ""}`}>
      <button type="button" className="pad-group-header nodrag nopan" onClick={onToggle} aria-expanded={open}>
        <span className="pad-group-caret">{open ? "▾" : "▸"}</span>
        <span className="pad-group-title">{title}</span>
        <span className="pad-group-count">{pads.length}</span>
        <span className="pad-group-dots">
          {medias.map((m) => (
            <span key={m} className={`pad-group-dot media-${m}`} />
          ))}
        </span>
      </button>
      {open && pads.map((p) => <PadRow key={p.id} pad={p} side="out" />)}
    </div>
  );
}

export function NodeShell(props: {
  id: string;
  title: string;
  subtitle?: string;
  media?: Media;
  selected?: boolean;
  inputs: PadDef[];
  outputs: PadDef[];
  inputMedia?: (pad: PadDef) => Media | undefined;
  /** Replaces the default output rows (e.g. grouped rows); `outputs` should then list only the rendered pads. */
  outputContent?: ReactNode;
  /** Extra key that forces handle re-measurement when the layout changes without the pad list changing. */
  layoutKey?: string;
  children?: ReactNode;
}) {
  const { id, inputs, outputs } = props;
  const updateNodeInternals = useUpdateNodeInternals();
  const padKey = [...inputs, ...outputs].map((p) => p.id).join(",") + "|" + (props.layoutKey ?? "");
  useEffect(() => updateNodeInternals(id), [id, padKey, updateNodeInternals]);

  const diags = useDerived().byNode.get(id) ?? [];
  const errors = diags.filter((d) => d.severity === "error").length;
  const warnings = diags.filter((d) => d.severity === "warning").length;

  return (
    <div className={`node ${props.media ? `node-${props.media}` : "node-neutral"} ${props.selected ? "selected" : ""} ${errors ? "has-error" : ""}`}>
      <div className="node-header">
        <span className="node-title">{props.title}</span>
        {props.subtitle && <span className="node-subtitle">{props.subtitle}</span>}
        {errors > 0 && <span className="badge badge-error" title={diags.map((d) => d.message).join("\n")}>{errors}</span>}
        {!errors && warnings > 0 && <span className="badge badge-warning" title={diags.map((d) => d.message).join("\n")}>{warnings}</span>}
      </div>
      {props.outputContent ?? outputs.map((p) => <PadRow key={p.id} pad={p} side="out" />)}
      {props.children && <div className="node-body">{props.children}</div>}
      {inputs.map((p) => (
        <PadRow key={p.id} pad={p} side="in" media={props.inputMedia?.(p)} />
      ))}
    </div>
  );
}
