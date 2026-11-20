// Floating progress popups, one per job. They can be dragged, minimized (restore from the
// toolbar) and closed once the job has ended.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useGraph, type JobState } from "../store/graph";
import { deviceLabel, deviceStages, type Device } from "../model/devices";
import { describeStream, fmtBytes, fmtDuration, splitPath, timeLeft } from "./jobInfo";
import { cancelRun } from "./run";

const WIDTH = 460;

export function JobPanels() {
  const jobs = useGraph((s) => s.jobs);
  return (
    <>
      {jobs.filter((j) => !j.minimized).map((j) => (
        <JobPanel key={j.id} job={j} />
      ))}
    </>
  );
}

export const statusText = (j: JobState) =>
  j.running ? (j.stopping ? "Stopping…" : "Running") : j.result === "success" ? "Done" : j.result === "cancelled" ? "Stopped" : "Failed";

export const statusClass = (j: JobState) => (j.running ? "running" : j.result ?? "failed");

/** Re-renders every second while `on`, for the elapsed / time-left clocks. */
function useTick(on: boolean) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setT((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

function initialPos(seq: number) {
  const step = ((seq - 1) % 6) * 28;
  const left = Math.max(8, Math.min(window.innerWidth - WIDTH - 340, 240) + step);
  return { x: left, y: 56 + step };
}

function JobPanel({ job: j }: { job: JobState }) {
  const focusJob = useGraph((s) => s.focusJob);
  const updateJob = useGraph((s) => s.updateJob);
  const removeJob = useGraph((s) => s.removeJob);
  const setLogJob = useGraph((s) => s.setLogJob);
  const gpus = useGraph((s) => s.gpus);
  const [pos, setPos] = useState(() => initialPos(j.seq));
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  useTick(j.running);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    focusJob(j.id);
    if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    setPos({
      x: Math.min(window.innerWidth - 80, Math.max(80 - WIDTH, e.clientX - d.dx)),
      y: Math.min(window.innerHeight - 40, Math.max(0, e.clientY - d.dy)),
    });
  };
  const onPointerUp = () => (drag.current = null);

  const now = j.endedAt ?? Date.now();
  const elapsed = (now - j.startedAt) / 1000;
  const pct = Number.isFinite(j.progress) ? j.progress * 100 : undefined;
  const left = j.running ? timeLeft(j.duration, j.outTime, j.speedX, elapsed) : undefined;
  const main = splitPath(j.outputs[0] ?? "");
  const failLines = j.result === "failed" ? lastErrorLines(j.log) : [];

  return (
    <section
      className={`job-panel ${statusClass(j)}`}
      style={{ left: pos.x, top: pos.y, width: WIDTH, zIndex: 30 + j.z }}
      onPointerDown={() => focusJob(j.id)}
      role="dialog"
      aria-label={`Job ${j.seq}`}
    >
      <header className="job-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <span className={`job-dot ${statusClass(j)}`} />
        <span className="job-status">{statusText(j)}</span>
        <span className="job-title" title={j.outputs.join("\n")}>
          Job {j.seq} · {main.name || "output"}
          {j.outputs.length > 1 && <span className="muted"> +{j.outputs.length - 1}</span>}
        </span>
        <span className="spacer" />
        <button className="icon" title="Minimize" onClick={() => updateJob(j.id, () => ({ minimized: true }))}>
          –
        </button>
        <button className="icon" title={j.running ? "Stop the job first" : "Close"} disabled={j.running} onClick={() => removeJob(j.id)}>
          ×
        </button>
      </header>

      <div className="job-body">
        <div className={`job-progress ${statusClass(j)}`}>
          <div className="bar" style={{ width: `${pct ?? (j.running ? 100 : 0)}%` }} data-indeterminate={pct === undefined && j.running} />
          <span>{pct !== undefined ? `${pct.toFixed(1)}%` : j.running ? "Running (length unknown)" : statusText(j)}</span>
        </div>

        {j.devices && deviceStages(j.devices).length > 0 && (
          <div className="job-devices">
            {deviceStages(j.devices).map(([stage, list]) => (
              <div key={stage} className="job-device-group">
                <span className="job-label">{stage}</span>
                {list.map((d, i) => (
                  <span key={i} className={`device-chip ${d.kind}`}>
                    {deviceLabel(d, gpus)}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="job-tiles">
          <Tile label="Time" value={fmtDuration(j.outTime)} sub={j.duration ? `of ${fmtDuration(j.duration)}` : undefined} />
          <Tile label="Speed" value={j.speed ?? "–"} big />
          <Tile label="Time left" value={j.running ? fmtDuration(left) : j.result === "success" ? "0:00" : "–"} />
          <Tile label="Elapsed" value={fmtDuration(elapsed)} />
          <Tile label="FPS" value={j.fps ?? "–"} />
          <Tile label="Frames" value={j.frame !== undefined ? String(j.frame) : "–"} sub={frameNote(j)} />
          <Tile label="Size" value={fmtBytes(j.totalSize)} />
          <Tile label="Bitrate" value={j.bitrate ?? "–"} />
        </div>

        <div className="job-files">
          <FileList label="Inputs" paths={j.inputs} />
          <FileList label="Outputs" paths={j.outputs} />
        </div>

        <div className="job-streams">
          <div className="job-label">Output streams</div>
          {j.streams.length === 0 ? (
            <div className="muted small">{j.running ? "Waiting for ffmpeg…" : "No stream info."}</div>
          ) : (
            <div className="job-stream-list">
              {j.streams.map((s) => (
                <div key={`${s.output}:${s.index}`} className="job-stream" title={describeStream(s).join(" · ")}>
                  <span className={`media-chip media-${s.media}`}>{s.media}</span>
                  <span className="muted mono">
                    #{s.output}:{s.index}
                  </span>
                  <span className="job-stream-desc">{describeStream(s).join(" · ")}</span>
                  <DeviceTag d={j.devices?.streams[s.output]?.[s.index]} gpus={gpus} />
                </div>
              ))}
            </div>
          )}
        </div>

        {failLines.length > 0 && <pre className="job-error">{failLines.join("\n")}</pre>}
      </div>

      <footer className="job-foot">
        <button onClick={() => setLogJob(j.id)}>Show log</button>
        <span className="spacer" />
        {j.running ? (
          <button className="danger" disabled={j.stopping} onClick={() => void cancelRun(j.id)} title="Stop ffmpeg; the output is finalized">
            {j.stopping ? "Stopping…" : "■ Stop"}
          </button>
        ) : (
          <button className="primary" onClick={() => removeJob(j.id)}>
            Close
          </button>
        )}
      </footer>
    </section>
  );
}

function DeviceTag({ d, gpus }: { d?: Device; gpus?: Parameters<typeof deviceLabel>[1] }) {
  if (!d) return null;
  return <span className={`device-tag ${d.kind}`}>{deviceLabel(d, gpus, { names: false })}</span>;
}

function Tile({ label, value, sub, big }: { label: string; value: string; sub?: string; big?: boolean }) {
  return (
    <div className={`job-tile${big ? " big" : ""}`}>
      <div className="job-label">{label}</div>
      <div className="job-value">{value}</div>
      {sub && <div className="job-sub">{sub}</div>}
    </div>
  );
}

function FileList({ label, paths }: { label: string; paths: string[] }) {
  return (
    <div className="job-filelist">
      <div className="job-label">{label}</div>
      {paths.length === 0 && <div className="muted small">–</div>}
      {paths.map((p, i) => {
        const { name, dir } = splitPath(p);
        return (
          <div key={i} className="job-file" title={p}>
            <div className="job-file-text">
              <div className="job-file-dir">{dir ? <bdi>{dir}</bdi> : " "}</div>
              <div className="job-file-name">{name}</div>
            </div>
            <CopyButton text={p} />
          </div>
        );
      })}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon copy"
      title="Copy full path"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } else useGraph.getState().showToast("Could not copy to the clipboard.");
      }}
    >
      {done ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )}
    </button>
  );
}

/** Clipboard API, with the old textarea + execCommand way as a fallback when it is not allowed. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function frameNote(j: JobState): string | undefined {
  const parts = [];
  if (j.dropFrames) parts.push(`${j.dropFrames} dropped`);
  if (j.dupFrames) parts.push(`${j.dupFrames} dup`);
  return parts.length ? parts.join(", ") : undefined;
}

/** The last few ffmpeg lines before our own "✖ exited" marker. */
function lastErrorLines(log: string[]): string[] {
  return log
    .slice(1)
    .filter((l) => l.trim() && !l.startsWith("✖") && !l.startsWith("■") && !l.startsWith("✔"))
    .slice(-3);
}
