import { useState, type ReactNode } from "react";
import { pickOpenFile, pickSaveFile } from "../ipc/ffmpeg";
import { describeFormat, formatFromStream } from "../model/format";
import { encoderOnGpuFrames, gpuResidency, isGpuEncoder, upstreamInput } from "../model/hw";
import { encodersUsing, paramsNodeOf, PARAMS_PAD, resolveEncoder } from "../model/encoders";
import type { EncoderNodeData, EncoderParamsNodeData, FilterNodeData, GNode, InputNodeData, InputOptions, Media, MuxerNodeData, MuxSlot, NodeData } from "../model/types";
import { encoderDefaults, findPad, newEncoderParamsData, nodeTitle } from "../nodes/defs";
import { ENCODERS, getEncoderSchema, isParamVisible, withDefaults } from "../nodes/defs/encoders";
import { filterDefOf } from "../nodes/defs/generic";
import { LETTERBOX_ID } from "../model/letterbox";
import { useGraph } from "../store/graph";
import { useDerived } from "../ui/derived";
import { COMMON_FORMATS, isMp4Family, resolveFormat } from "../validation/compat";
import { CommitText, Field, GpuSelect, KVTable, ParamField, Section } from "./widgets";

export function Inspector() {
  const selectedId = useGraph((s) => s.selectedId);
  const node = useGraph((s) => s.nodes.find((n) => n.id === selectedId));
  const { byNode } = useDerived();
  const applyFix = useGraph((s) => s.applyFix);
  if (!node) {
    return (
      <aside className="inspector">
        <div className="empty">
          <h3>Inspector</h3>
          <p>Select a node to edit its settings.</p>
          <p className="muted">Wire <b>frames</b> (round pads) through filters into encoders, and <b>packets</b> (square pads) into an Output. Packets straight from an Input are a stream copy.</p>
        </div>
      </aside>
    );
  }
  const diags = byNode.get(node.id) ?? [];
  return (
    <aside className="inspector">
      <div className="inspector-title">
        <h3>{nodeTitle(node.data)}</h3>
        <DuplicateButton id={node.id} />
      </div>
      {diags.length > 0 && (
        <ul className="diag-list">
          {diags.map((d, i) => (
            <li key={i} className={`diag ${d.severity}`}>
              {d.message}
              {d.fix && (
                <button className="small" onClick={() => applyFix(d.fix!)}>
                  {d.fix.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <NodeInspector id={node.id} data={node.data} />
    </aside>
  );
}

function DuplicateButton({ id }: { id: string }) {
  const duplicate = useGraph((s) => s.duplicate);
  return (
    <button className="small" title="Duplicate this node with all its settings (Ctrl+D). Ctrl+Shift+D also copies the wires feeding it." onClick={() => duplicate({ ids: [id] })}>
      Duplicate
    </button>
  );
}

function NodeInspector({ id, data }: { id: string; data: NodeData }) {
  switch (data.kind) {
    case "input":
      return <InputInspector id={id} d={data} />;
    case "filter":
      return <FilterInspector id={id} d={data} />;
    case "encparams":
      return <EncoderParamsInspector id={id} d={data} />;
    case "encoder":
      return <EncoderInspector id={id} d={data} />;
    case "muxer":
      return <MuxerInspector id={id} d={data} />;
  }
}

function useUpdate<D extends NodeData>(id: string) {
  const updateData = useGraph((s) => s.updateData);
  return (patch: Partial<D>) => updateData(id, patch as Partial<NodeData>);
}

// ---------------------------------------------------------------- input

const HWACCELS = ["", "auto", "cuda", "qsv", "d3d11va", "dxva2", "videotoolbox", "vaapi", "vulkan"];

function InputInspector({ id, d }: { id: string; d: InputNodeData }) {
  const update = useUpdate<InputNodeData>(id);
  const probeInput = useGraph((s) => s.probeInput);
  const setPath = (path: string) => {
    update({ path });
    void probeInput(id);
  };
  const setOpt = (k: keyof InputOptions, v: string) => update({ options: { ...d.options, [k]: v } });
  return (
    <>
      <Section title="File">
        <Field label="Path">
          <CommitText value={d.path} onCommit={setPath} placeholder="/path/to/input.mkv" />
        </Field>
        <div className="row">
          <button onClick={async () => { const p = await pickOpenFile(); if (p) setPath(p); }}>Browse…</button>
          <button disabled={!d.path} onClick={() => void probeInput(id)}>Re-probe</button>
        </div>
        {d.probing && <p className="muted">Probing…</p>}
      </Section>
      {d.probe && (
        <Section title="Streams">
          <p className="muted small">
            {d.probe.format.format_name} · {d.probe.format.duration ? `${Number(d.probe.format.duration).toFixed(2)} s` : "duration unknown"}
            {d.probe.format.bit_rate ? ` · ${Math.round(Number(d.probe.format.bit_rate) / 1000)} kb/s` : ""}
          </p>
          <table className="streams">
            <tbody>
              {d.probe.streams.map((s) => (
                <tr key={s.index}>
                  <td>#{s.index}</td>
                  <td className={`media-text-${s.codec_type}`}>{s.codec_type}</td>
                  <td>{s.codec_name}{s.profile ? ` (${s.profile})` : ""}</td>
                  <td>{describeFormat(formatFromStream(s))}</td>
                  <td>{s.tags?.language ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      <Section title="Seek / trim / decoder (advanced)" collapsed={!d.options.ss && !d.options.t && !d.options.hwaccel && !d.options.threads && !d.options.r}>
        <Field label="Start (-ss)" hint="Input seek, e.g. 00:01:30 or 90">
          <input type="text" value={d.options.ss} onChange={(e) => setOpt("ss", e.target.value)} />
        </Field>
        <Field label="Duration (-t)">
          <input type="text" value={d.options.t} onChange={(e) => setOpt("t", e.target.value)} />
        </Field>
        <Field label="HW decode (-hwaccel)">
          <select value={d.options.hwaccel} onChange={(e) => setOpt("hwaccel", e.target.value)}>
            {HWACCELS.map((h) => (
              <option key={h} value={h}>{h || "none (software)"}</option>
            ))}
          </select>
        </Field>
        {d.options.hwaccel === "cuda" && <CudaInputOptions id={id} d={d} setOpt={setOpt} />}
        {d.options.hwaccel && d.options.hwaccel !== "cuda" && d.options.hwaccel !== "auto" && (
          <Field label="Device (-hwaccel_device)" hint="Leave empty for the system default">
            <input
              type="text"
              value={d.options.hwaccel_device}
              onChange={(e) => setOpt("hwaccel_device", e.target.value)}
              placeholder={d.options.hwaccel === "vaapi" ? "/dev/dri/renderD128" : "adapter index, e.g. 1"}
            />
          </Field>
        )}
        <Field label="Decoder threads">
          <input type="text" value={d.options.threads} onChange={(e) => setOpt("threads", e.target.value)} placeholder="auto" />
        </Field>
        <Field label="Force frame rate (-r)">
          <input type="text" value={d.options.r} onChange={(e) => setOpt("r", e.target.value)} placeholder="from file" />
        </Field>
      </Section>
    </>
  );
}

function CudaInputOptions({ id, d, setOpt }: { id: string; d: InputNodeData; setOpt: (k: keyof InputOptions, v: string) => void }) {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const r = gpuResidency({ nodes, edges }).get(id);
  let explain: ReactNode;
  if (d.options.gpuFrames === "off") explain = "Decoded frames are copied to system memory.";
  else if (r?.resident) explain = <>✓ Frames stay on the GPU{r.consumers.length ? ` (used by ${r.consumers.join(", ")})` : ""}.</>;
  else if (r?.blocker)
    explain = (
      <>
        Frames are copied to system memory because <b>{r.blocker.label}</b> ({r.blocker.reason}) uses them.
        {r.blocker.reason === "CPU filter" && " Use GPU filters such as Scale (CUDA) to keep them on the GPU."}
      </>
    );
  else explain = "Connect a video stream to an nvenc encoder to keep frames on the GPU.";
  return (
    <>
      <GpuSelect label="GPU (-hwaccel_device)" value={d.options.hwaccel_device} onChange={(v) => setOpt("hwaccel_device", v)} />
      <Field label="Keep frames on GPU" hint="Auto adds -hwaccel_output_format cuda when every consumer of the decoded video runs on the GPU">
        <select value={d.options.gpuFrames} onChange={(e) => setOpt("gpuFrames", e.target.value)}>
          <option value="auto">Auto</option>
          <option value="off">Off</option>
        </select>
      </Field>
      <p className="muted small">{explain}</p>
    </>
  );
}

/** nvenc's GPU option: locked to the Input's GPU when frames arrive in GPU memory. */
/** GPU picker of a parameters node; hidden when all its nvenc encoders get GPU frames anyway. */
function EncoderGpuField({ paramsId, value, onChange }: { paramsId: string; value: string; onChange: (v: string) => void }) {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const gpus = useGraph((s) => s.gpus);
  const g = { nodes, edges } as { nodes: GNode[]; edges: typeof edges };
  const users = encodersUsing(g, paramsId);
  const res = gpuResidency(g);
  if (users.length && users.every((u) => encoderOnGpuFrames(g, res, u.id))) {
    const inp = upstreamInput(g, users[0].id);
    const dev = inp?.data.options.hwaccel_device || "";
    const name = gpus?.find((x) => String(x.index) === (dev || "0"))?.name;
    return (
      <Field label="GPU" hint="nvenc encodes on the GPU that already holds the frames">
        <span className="muted small">
          Follows the Input's GPU ({dev || "default"}{name ? `: ${name}` : ""})
        </span>
      </Field>
    );
  }
  return <GpuSelect label="GPU (-gpu)" value={value} onChange={onChange} hint="Which NVIDIA GPU encodes" />;
}

// ---------------------------------------------------------------- filter

function FilterInspector({ id, d }: { id: string; d: FilterNodeData }) {
  const update = useUpdate<FilterNodeData>(id);
  const [optQuery, setOptQuery] = useState("");
  const def = filterDefOf(d);
  if (!def) return <p className="error-text">Unknown filter {d.defId}</p>;
  const field = (p: (typeof def.params)[number]) => (
    <ParamField key={p.name} def={p} value={d.params[p.name]} onChange={(v) => update({ params: { ...d.params, [p.name]: v } })} />
  );
  const visible = def.params.filter((p) => isParamVisible(p, d.params));
  if (d.defId === LETTERBOX_ID) return <LetterboxInspector id={id} d={d} fields={visible.map(field)} />;
  if (!d.generic) {
    return (
      <Section title={`${def.ffName} options`}>
        <p className="muted small">{def.description}</p>
        {visible.map(field)}
      </Section>
    );
  }
  // generic node: options read from ffmpeg, pad settings and raw text apart
  const g = d.generic;
  const changed = (p: (typeof def.params)[number]) => d.params[p.name] !== undefined && d.params[p.name] !== p.default;
  const options = visible.filter((p) => !p.ui && p.name !== "enable");
  const q = optQuery.trim().toLowerCase();
  const shown = q ? options.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q)) : options;
  const padParams = visible.filter((p) => p.ui && p.name !== "_raw");
  return (
    <>
      <Section title={`${g.name} options`}>
        <p className="muted small">{def.description}</p>
        {!g.help && !g.error && <p className="muted small">Reading options from ffmpeg…</p>}
        {g.error && <p className="error-text small">{g.error}</p>}
        {g.help && !options.length && <p className="muted small">This filter has no options.</p>}
        {options.length > 10 && (
          <input className="palette-search" type="search" placeholder={`Filter ${options.length} options…`} value={optQuery} onChange={(e) => setOptQuery(e.target.value)} />
        )}
        {shown.map(field)}
        {options.some(changed) && (
          <button className="small" onClick={() => update({ params: Object.fromEntries(Object.entries(d.params).filter(([k]) => !options.some((p) => p.name === k))) })}>
            Reset options to ffmpeg defaults
          </button>
        )}
      </Section>
      {padParams.length > 0 && <Section title="Pads">{padParams.map(field)}</Section>}
      <Section title="Advanced">{visible.filter((p) => p.name === "enable" || p.name === "_raw").map(field)}</Section>
    </>
  );
}

function LetterboxInspector({ id, d, fields }: { id: string; d: FilterNodeData; fields: ReactNode[] }) {
  const detect = useGraph((s) => s.detectLetterbox);
  const st = d.letterbox;
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
  return (
    <>
      <Section title="Black bars">
        <p className="muted small">Grabs frames spread over the Input file, finds the rows with picture, and crops the black bars above and below.</p>
        <div className="row">
          <button onClick={() => void detect(id)} disabled={st?.running}>
            {st?.running ? "Detecting…" : st?.path ? "Detect again" : "Detect"}
          </button>
        </div>
        {st?.path && !st.running && (
          <p className="muted small">
            {base(st.path)}: {st.usable} of {st.sampled} frames usable, measured on {st.height}-line frames.
          </p>
        )}
        {st?.warning && <p className="warning-text small">{st.warning}</p>}
        {st?.error && <p className="error-text small">{st.error}</p>}
        {fields.slice(0, 2)}
      </Section>
      <Section title="Detection settings">{fields.slice(2)}</Section>
    </>
  );
}

// ---------------------------------------------------------------- encoder

/** An encoder only shows the settings it receives; they are edited on the parameters node. */
function EncoderInspector({ id, d }: { id: string; d: EncoderNodeData }) {
  const nodes = useGraph((s) => s.nodes) as GNode[];
  const edges = useGraph((s) => s.edges);
  const select = useGraph((s) => s.select);
  const duplicate = useGraph((s) => s.duplicate);
  const addNode = useGraph((s) => s.addNode);
  const onConnect = useGraph((s) => s.onConnect);
  const g = { nodes, edges };
  const self = nodes.find((n) => n.id === id) as GNode<EncoderNodeData>;
  const p = paramsNodeOf(g, id);
  const users = p ? encodersUsing(g, p.id).length : 0;
  const media = `${d.media[0].toUpperCase()}${d.media.slice(1)}`;
  const wire = (paramsId: string) => onConnect({ source: paramsId, sourceHandle: PARAMS_PAD, target: id, targetHandle: PARAMS_PAD });
  if (!p) {
    return (
      <Section title="Parameters">
        <p className="muted small">This encoder has no settings of its own. Connect {media} Encoder Parameters to its top pad, or:</p>
        <button
          onClick={() => {
            const pid = addNode(newEncoderParamsData(d.media), { x: self.position.x - 250, y: self.position.y - 60 }, { withParams: false });
            wire(pid);
          }}
        >
          Add parameters
        </button>
      </Section>
    );
  }
  const r = resolveEncoder(g, self);
  const schema = getEncoderSchema(r.codec, r.media);
  const summary = schema.summary?.(withDefaults(schema, r.params));
  return (
    <Section title="Parameters">
      <p className="muted small">
        Settings come from the connected parameters node{users > 1 ? `, shared with ${users - 1} other encoder${users > 2 ? "s" : ""}` : ""}.
      </p>
      <Field label="Encoder">
        <b>{r.codec}</b>
      </Field>
      {summary && (
        <Field label={d.media === "video" ? "Quality" : "Bitrate"}>
          <b>{summary}</b>
        </Field>
      )}
      <div className="row">
        <button onClick={() => select(p.id)}>Edit parameters</button>
        {users > 1 && (
          <button
            title="Copy the shared parameters into a new node used only by this encoder"
            onClick={() => {
              const [copy] = duplicate({ ids: [p.id] });
              if (copy) wire(copy);
            }}
          >
            Use own copy
          </button>
        )}
      </div>
    </Section>
  );
}

function EncoderParamsInspector({ id, d }: { id: string; d: EncoderParamsNodeData }) {
  const update = useUpdate<EncoderParamsNodeData>(id);
  const users = useGraph((s) => encodersUsing(s as unknown as { nodes: GNode[]; edges: typeof s.edges }, id).length);
  const caps = useGraph((s) => s.caps);
  const schema = getEncoderSchema(d.codec, d.media);
  const available = new Set(caps?.encoders.filter((e) => e.media === d.media).map((e) => e.name) ?? []);
  // hardware encoders only when this ffmpeg has them (keep the current one visible regardless)
  const known = ENCODERS.filter((e) => e.media === d.media && (!e.hardware || available.has(e.codec) || e.codec === d.codec));
  const others = [...available].filter((n) => !ENCODERS.some((k) => k.codec === n)).sort();

  const setCodec = (codec: string) => {
    const defaults = encoderDefaults(codec, d.media);
    const defs = new Map(getEncoderSchema(codec, d.media).params.map((p) => [p.name, p]));
    // keep values for options both codecs share (bitrate, sample rate, ...) when still valid
    const keep = (k: string, v: unknown) => {
      const old = d.params[k];
      if (!(k in d.params) || typeof old !== typeof v) return false;
      const def = defs.get(k);
      return def?.type !== "enum" || !def.options || def.options.some((o) => o.value === String(old));
    };
    const params = Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, keep(k, v) ? d.params[k] : v]));
    update({ codec, params });
  };
  const visible = schema.params.filter((p) => isParamVisible(p, withDefaults(schema, d.params)));
  const main = visible.filter((p) => p.face);
  const rest = visible.filter((p) => !p.face);
  const setParam = (name: string, v: string | number | boolean) => update({ params: { ...d.params, [name]: v } });

  return (
    <>
      <p className="muted small">
        {users === 0 ? "Not connected to an encoder yet: wire its output to the top pad of encoders." : `Used by ${users} encoder${users > 1 ? "s" : ""}.`}
      </p>
      <Section title="Codec">
        <Field label="Encoder">
          <select value={d.codec} onChange={(e) => setCodec(e.target.value)}>
            <optgroup label="With presets">
              {known.map((k) => (
                <option key={k.codec} value={k.codec}>
                  {k.label}{caps && available.size && !available.has(k.codec) ? " — not in your ffmpeg" : ""}
                </option>
              ))}
            </optgroup>
            {others.length > 0 && (
              <optgroup label="Other encoders in your ffmpeg (generic options)">
                {others.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </optgroup>
            )}
            {!known.some((k) => k.codec === d.codec) && !others.includes(d.codec) && <option value={d.codec}>{d.codec}</option>}
          </select>
        </Field>
        {main.map((p) =>
          p.name === "gpu" && isGpuEncoder(d.codec) ? (
            <EncoderGpuField key={p.name} paramsId={id} value={String(d.params.gpu ?? "")} onChange={(v) => setParam("gpu", v)} />
          ) : (
            <ParamField key={p.name} def={p} value={d.params[p.name]} onChange={(v) => setParam(p.name, v)} />
          ),
        )}
      </Section>
      {rest.length > 0 && (
        <Section title="Advanced" collapsed>
          {rest.map((p) => (
            <ParamField key={p.name} def={p} value={d.params[p.name]} onChange={(v) => setParam(p.name, v)} />
          ))}
        </Section>
      )}
      <Section title="Extra options" collapsed={d.extra.length === 0}>
        <p className="muted small">Emitted as <code>-key:{d.media[0]}:N value</code> with this stream's specifier.</p>
        <KVTable rows={d.extra} onChange={(extra) => update({ extra })} keyPlaceholder="g" valuePlaceholder="250" />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- muxer

const DISPOSITIONS = [
  { value: "", label: "(leave as is)" },
  { value: "default", label: "default" },
  { value: "forced", label: "forced" },
  { value: "default+forced", label: "default + forced" },
  { value: "0", label: "none (clear)" },
];

function MuxerInspector({ id, d }: { id: string; d: MuxerNodeData }) {
  const update = useUpdate<MuxerNodeData>(id);
  const caps = useGraph((s) => s.caps);
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const fmt = resolveFormat(d);
  const formats = [...new Set([...COMMON_FORMATS, ...(caps?.muxers.map((m) => m.name) ?? [])])];

  const connected = d.slots.filter((s) => edges.some((e) => e.target === id && e.targetHandle === s.id));
  const describe = (slot: MuxSlot): { media?: Media; what: string } => {
    const e = edges.find((x) => x.target === id && x.targetHandle === slot.id)!;
    const src = nodes.find((n) => n.id === e.source);
    const pad = findPad(src as GNode | undefined, e.sourceHandle, "source");
    const media = pad?.type.media === "any" ? undefined : pad?.type.media;
    const what = src?.data.kind === "encoder" ? `encode ${resolveEncoder({ nodes: nodes as GNode[], edges }, src as GNode<EncoderNodeData>).codec}` : src?.data.kind === "input" ? `copy ${pad?.label ?? ""}` : "?";
    return { media, what };
  };
  const setSlot = (slotId: string, patch: Partial<MuxSlot>) => update({ slots: d.slots.map((s) => (s.id === slotId ? { ...s, ...patch } : s)) });
  const move = (slotId: string, dir: -1 | 1) => {
    const order = connected.map((s) => s.id);
    const i = order.indexOf(slotId);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    const spare = d.slots.filter((s) => !order.includes(s.id));
    update({ slots: [...order.map((sid) => d.slots.find((s) => s.id === sid)!), ...spare] });
  };

  return (
    <>
      <Section title="File">
        <Field label="Path">
          <CommitText value={d.path} onCommit={(path) => update({ path })} placeholder="/path/to/output.mp4" />
        </Field>
        <div className="row">
          <button onClick={async () => { const p = await pickSaveFile(d.path || "output.mp4"); if (p) update({ path: p }); }}>Browse…</button>
        </div>
        <Field label="Container" hint={d.format === "auto" ? `auto → ${fmt ?? "unknown extension"}` : undefined}>
          <select value={d.format} onChange={(e) => update({ format: e.target.value })}>
            <option value="auto">auto (from extension)</option>
            {formats.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </Field>
        {isMp4Family(fmt) && (
          <Field label="Fast start" hint="-movflags +faststart: index at the front for web streaming">
            <input type="checkbox" checked={d.faststart} onChange={(e) => update({ faststart: e.target.checked })} />
          </Field>
        )}
      </Section>
      <Section title={`Streams (${connected.length})`}>
        {connected.length === 0 && <p className="muted">Connect packets from encoders or inputs to the Output node.</p>}
        {connected.map((slot, i) => {
          const { media, what } = describe(slot);
          return (
            <div key={slot.id} className={`slot media-border-${media ?? "any"}`}>
              <div className="slot-head">
                <b>#{i}</b> <span className={`media-text-${media}`}>{media}</span> <span className="muted">{what}</span>
                <span className="spacer" />
                <button className="icon" disabled={i === 0} onClick={() => move(slot.id, -1)} title="Move up">↑</button>
                <button className="icon" disabled={i === connected.length - 1} onClick={() => move(slot.id, 1)} title="Move down">↓</button>
              </div>
              <Field label="Language" hint="ISO 639-2, e.g. eng, ger, jpn">
                <input type="text" value={slot.language} onChange={(e) => setSlot(slot.id, { language: e.target.value })} />
              </Field>
              <Field label="Title">
                <input type="text" value={slot.title} onChange={(e) => setSlot(slot.id, { title: e.target.value })} />
              </Field>
              <Field label="Disposition">
                <select value={slot.disposition} onChange={(e) => setSlot(slot.id, { disposition: e.target.value })}>
                  {DISPOSITIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Codec tag" hint="e.g. hvc1 for H.265 on Apple devices">
                <input type="text" value={slot.tag} onChange={(e) => setSlot(slot.id, { tag: e.target.value })} />
              </Field>
            </div>
          );
        })}
      </Section>
      <Section title="Global metadata" collapsed={d.metadata.length === 0}>
        <KVTable rows={d.metadata} onChange={(metadata) => update({ metadata })} keyPlaceholder="title" valuePlaceholder="My movie" />
      </Section>
    </>
  );
}
