import { useMemo, useState } from "react";
import * as ipc from "../ipc/ffmpeg";
import type { ProbeResult, StreamInfo } from "../model/types";
import { newId, useGraph } from "../store/graph";
import {
  audioStreams,
  buildRecodeGraph,
  codecChoices,
  COPY,
  cpuVideoFilters,
  defaultChoices,
  hasNvenc,
  isTextSubtitle,
  needsMovText,
  subtitleStreams,
  videoStreams,
  type WizardChoices,
} from "./build";

type Step = "file" | "video" | "audio" | "output";
const STEP_LABEL: Record<Step, string> = { file: "File", video: "Video", audio: "Audio", output: "Subtitles & output" };

const lang = (s: StreamInfo) => s.tags?.language;
const title = (s: StreamInfo) => s.tags?.title;
const fps = (s: StreamInfo) => {
  const [n, d] = (s.avg_frame_rate ?? "").split("/").map(Number);
  return n && d ? `${Math.round((n / d) * 1000) / 1000} fps` : "";
};
function streamLabel(s: StreamInfo): string {
  const parts = [`#${s.index}`, lang(s), s.codec_name];
  if (s.codec_type === "video") parts.push(s.width && s.height ? `${s.width}×${s.height}` : "", fps(s), s.disposition?.attached_pic ? "cover art" : "");
  if (s.codec_type === "audio") parts.push(s.channel_layout ?? (s.channels ? `${s.channels} ch` : ""), s.sample_rate ? `${Number(s.sample_rate) / 1000} kHz` : "");
  const t = title(s);
  return parts.filter(Boolean).join(" ") + (t ? ` – ${t}` : "");
}

/** Recode wizard: pick a file, choose streams, filters and codecs, then build the whole graph. */
export function WizardDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (create: () => void) => void }) {
  const caps = useGraph((s) => s.caps);
  const settings = useGraph((s) => s.settings);
  const [path, setPath] = useState("");
  const [probe, setProbe] = useState<ProbeResult>();
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string>();
  const [c, setC] = useState<WizardChoices>();
  const [step, setStep] = useState<Step>("file");

  const steps = useMemo<Step[]>(() => {
    if (!probe) return ["file", "video", "audio", "output"];
    return ["file", ...(videoStreams(probe).length ? ["video" as const] : []), ...(audioStreams(probe).length ? ["audio" as const] : []), "output"];
  }, [probe]);
  const at = steps.indexOf(step);

  const load = async (p: string) => {
    setPath(p);
    setProbe(undefined);
    setError(undefined);
    if (!p.trim()) return;
    setProbing(true);
    try {
      const r = await ipc.probeFile(p.trim(), settings);
      setProbe(r);
      setC(defaultChoices({ path: p.trim(), probe: r }, caps));
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  };

  const set = <K extends "video" | "audio" | "subtitles">(k: K, patch: Partial<WizardChoices[K]>) => setC((x) => (x ? { ...x, [k]: { ...x[k], ...patch } } : x));
  const toggleStream = (k: "video" | "audio", index: number, on: boolean) =>
    setC((x) => {
      if (!x) return x;
      const streams = on ? [...x[k].streams, index].sort((a, b) => a - b) : x[k].streams.filter((i) => i !== index);
      return { ...x, [k]: { ...x[k], streams } };
    });

  const create = () => {
    if (!probe || !c) return;
    onCreate(() => {
      const g = buildRecodeGraph({ path: path.trim(), probe }, c, newId);
      useGraph.getState().setGraph(g);
    });
  };

  const nothing = !!c && !c.video.streams.length && !c.audio.streams.length && !(c.subtitles.copy && probe && subtitleStreams(probe).length);
  const last = at === steps.length - 1;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wizard" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Recode wizard">
        <h3>Recode wizard</h3>
        <ol className="wizard-steps">
          {steps.map((s, i) => (
            <li key={s} className={s === step ? "current" : i < at ? "done" : ""}>
              <button className="link" disabled={i > at && (!probe || !c)} onClick={() => setStep(s)}>
                {STEP_LABEL[s]}
              </button>
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          {step === "file" && (
            <>
              <label className="field">
                <span className="field-label">Input file</span>
                <span className="field-control">
                  <input type="text" value={path} placeholder="Pick a video or audio file" onChange={(e) => setPath(e.target.value)} onBlur={(e) => e.target.value !== (probe?.format.filename ?? "") && void load(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void load(path)} />
                  <button onClick={async () => { const p = await ipc.pickOpenFile(); if (p) void load(p); }}>Browse…</button>
                </span>
              </label>
              {probing && <p className="muted small">Reading streams…</p>}
              {error && <p className="error-text">{error}</p>}
              {probe && (
                <ul className="wizard-summary muted small">
                  {probe.streams.map((s) => (
                    <li key={s.index}>{s.codec_type}: {streamLabel(s)}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          {step === "video" && probe && c && (
            <>
              <Streams list={videoStreams(probe)} chosen={c.video.streams} onToggle={(i, on) => toggleStream("video", i, on)} />
              <Toggle label="GPU (NVIDIA decode, Scale (CUDA), nvenc)" disabled={!hasNvenc(caps)} hint={hasNvenc(caps) ? undefined : "This ffmpeg build has no nvenc encoder."} checked={c.video.gpu} onChange={(gpu) => {
                const list = codecChoices("video", caps, gpu).map((x) => x.value);
                set("video", { gpu, codec: gpu ? (list.includes("hevc_nvenc") ? "hevc_nvenc" : (list[0] ?? COPY)) : c.video.codec === COPY ? COPY : defaultChoices({ path, probe }, caps).video.codec });
              }} />
              <label className="field">
                <span className="field-label">Video codec</span>
                <span className="field-control">
                  <select value={c.video.codec} onChange={(e) => set("video", { codec: e.target.value })}>
                    {codecChoices("video", caps, c.video.gpu).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    <option value={COPY}>Copy (no re-encode)</option>
                  </select>
                </span>
              </label>
              <fieldset className="wizard-filters" disabled={c.video.codec === COPY}>
                <legend>Filters{c.video.codec === COPY ? " (not with Copy)" : ""}</legend>
                <Toggle label={`Deinterlace${c.video.gpu ? " (CUDA)" : ""}`} checked={c.video.deinterlace} onChange={(v) => set("video", { deinterlace: v })} />
                <Toggle label="Remove letterbox (detects the black bars)" checked={c.video.letterbox} onChange={(v) => set("video", { letterbox: v })} />
                <Toggle label="Denoise" checked={c.video.denoise} onChange={(v) => set("video", { denoise: v })} />
                <Toggle label="Deband" checked={c.video.deband} onChange={(v) => set("video", { deband: v })} />
                <Toggle label={`Scale${c.video.gpu ? " (CUDA)" : ""}`} checked={c.video.scale} onChange={(v) => set("video", { scale: v })} />
              </fieldset>
              {c.video.gpu && cpuVideoFilters(c.video) && c.video.codec !== COPY && (
                <p className="muted small">Remove letterbox, Denoise and Deband have no GPU version: frames are copied to system memory for them and back to the GPU afterwards.</p>
              )}
            </>
          )}

          {step === "audio" && probe && c && (
            <>
              <Streams list={audioStreams(probe)} chosen={c.audio.streams} onToggle={(i, on) => toggleStream("audio", i, on)} />
              <label className="field">
                <span className="field-label">Audio codec</span>
                <span className="field-control">
                  <select value={c.audio.codec} onChange={(e) => set("audio", { codec: e.target.value })}>
                    {codecChoices("audio", caps).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    <option value={COPY}>Copy (no re-encode)</option>
                  </select>
                </span>
              </label>
              <fieldset className="wizard-filters" disabled={c.audio.codec === COPY}>
                <legend>Filters{c.audio.codec === COPY ? " (not with Copy)" : ""}</legend>
                {audioStreams(probe).some((s) => (s.channels ?? 0) > 2) && (
                  <Toggle label="Downmix to stereo (streams with more than 2 channels)" checked={c.audio.downmix} onChange={(v) => set("audio", { downmix: v })} />
                )}
                <Toggle label="Normalize loudness (EBU R128, sets 48 kHz)" checked={c.audio.normalize} onChange={(v) => set("audio", { normalize: v })} />
                {!c.audio.normalize && <Toggle label="Resample to 48 kHz" checked={c.audio.resample} onChange={(v) => set("audio", { resample: v })} />}
              </fieldset>
            </>
          )}

          {step === "output" && probe && c && (
            <>
              {subtitleStreams(probe).length > 0 ? (
                <>
                  <Toggle label={`Copy subtitles (${subtitleStreams(probe).length})`} checked={c.subtitles.copy} onChange={(v) => set("subtitles", { copy: v })} />
                  {c.subtitles.copy && needsMovText(c.output) && (
                    <p className="muted small">
                      MP4 only takes mov_text subtitles: text subtitles are converted
                      {subtitleStreams(probe).some((s) => !isTextSubtitle(s)) ? ", picture subtitles are left out" : ""}.
                    </p>
                  )}
                </>
              ) : (
                <p className="muted small">This file has no subtitles.</p>
              )}
              <label className="field">
                <span className="field-label">Output file</span>
                <span className="field-control">
                  <input type="text" value={c.output} onChange={(e) => setC({ ...c, output: e.target.value })} />
                  <button onClick={async () => { const p = await ipc.pickSaveFile(c.output); if (p) setC({ ...c, output: p }); }}>Browse…</button>
                </span>
              </label>
              {nothing && <p className="error-text">No stream is selected.</p>}
            </>
          )}
        </div>

        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          {at > 0 && <button onClick={() => setStep(steps[at - 1])}>Back</button>}
          {last ? (
            <button className="primary" disabled={!probe || !c || nothing || !c.output.trim()} onClick={create}>Create nodes</button>
          ) : (
            <button className="primary" disabled={!probe || !c || probing} onClick={() => setStep(steps[at + 1])}>Next</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string }) {
  return (
    <label className={`wizard-toggle${disabled ? " disabled" : ""}`} title={hint}>
      <input type="checkbox" checked={checked && !disabled} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Streams({ list, chosen, onToggle }: { list: StreamInfo[]; chosen: number[]; onToggle: (index: number, on: boolean) => void }) {
  return (
    <fieldset className="wizard-streams">
      <legend>Streams</legend>
      {list.map((s) => (
        <Toggle key={s.index} label={streamLabel(s)} checked={chosen.includes(s.index)} onChange={(on) => onToggle(s.index, on)} />
      ))}
    </fieldset>
  );
}
