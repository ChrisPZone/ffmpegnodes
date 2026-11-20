import { useState } from "react";
import * as ipc from "../ipc/ffmpeg";
import { parseProject, toProject, useGraph } from "../store/graph";
import { useDerived } from "./derived";
import { startRun } from "./run";
import { statusClass, statusText } from "./JobPanels";
import { deviceSummary } from "../model/devices";
import { DEFAULT_ZOOM_STEP, ZOOM_STEP_RANGE } from "./wheelZoom";
import { WizardDialog } from "../wizard/WizardDialog";

/** Asks before the graph on the canvas is replaced; true when it is empty or the user agrees. */
export async function confirmDiscard(): Promise<boolean> {
  if (!useGraph.getState().nodes.length) return true;
  return ipc.confirmDialog("Discard the current graph?", { title: "Discard graph", okLabel: "Discard", cancelLabel: "Cancel" });
}

export function Toolbar() {
  const { ser, errors } = useDerived();
  const jobs = useGraph((s) => s.jobs);
  const focusJob = useGraph((s) => s.focusJob);
  const gpus = useGraph((s) => s.gpus);
  const caps = useGraph((s) => s.caps);
  const capsError = useGraph((s) => s.capsError);
  const projectPath = useGraph((s) => s.projectPath);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  const saveAs = async () => {
    const st = useGraph.getState();
    const path = await ipc.pickSaveFile(st.projectPath ?? "graph.ffmpegnodes.json", ipc.PROJECT_FILTERS);
    if (!path) return;
    await save(path);
  };
  const save = async (path: string) => {
    const st = useGraph.getState();
    try {
      await ipc.writeTextFile(path, JSON.stringify(toProject(st.nodes, st.edges), null, 2));
      useGraph.setState({ projectPath: path });
      st.showToast(`Saved ${path}`);
    } catch (e) {
      st.showToast(String(e));
    }
  };
  const open = async () => {
    const st = useGraph.getState();
    const path = await ipc.pickOpenFile(ipc.PROJECT_FILTERS);
    if (!path) return;
    try {
      const project = parseProject(await ipc.readTextFile(path));
      if (!(await confirmDiscard())) return;
      st.setGraph(project, path);
      // files may have changed since the project was saved
      for (const n of useGraph.getState().nodes) if (n.data.kind === "input" && n.data.path) void useGraph.getState().probeInput(n.id);
    } catch (e) {
      st.showToast(String(e));
    }
  };
  const newProject = async () => {
    if (!(await confirmDiscard())) return;
    useGraph.getState().setGraph({ nodes: [], edges: [] });
  };

  return (
    <header className="toolbar">
      <span className="brand">ffmpeg<b>nodes</b></span>
      <button onClick={newProject}>New</button>
      <button onClick={() => setWizardOpen(true)} title="Build a recode graph for one file step by step">Wizard…</button>
      <button onClick={open}>Open…</button>
      <button onClick={() => (projectPath ? save(projectPath) : saveAs())}>Save</button>
      <button onClick={saveAs}>Save as…</button>
      <span className="project muted" title={projectPath}>{projectPath?.split(/[\\/]/).pop() ?? "unsaved"}</span>
      <span className="spacer" />
      {jobs.length > 0 && (
        <div className="job-pills">
          {jobs.map((j) => {
            const pct = Number.isFinite(j.progress) ? Math.round(j.progress * 100) : undefined;
            return (
              <button
                key={j.id}
                className={`job-pill ${statusClass(j)}${j.minimized ? " minimized" : ""}`}
                onClick={() => focusJob(j.id)}
                title={[`Job ${j.seq}: ${statusText(j)}`, ...(j.devices ? [deviceSummary(j.devices, gpus)] : []), ...j.outputs].join("\n")}
              >
                <span className="fill" style={{ width: `${pct ?? (j.running ? 0 : 100)}%` }} />
                <span>#{j.seq}</span>
                <span>{j.running ? (pct !== undefined ? `${pct}%` : "running") : statusText(j)}</span>
                {j.running && j.speed && <span className="muted">{j.speed}</span>}
              </button>
            );
          })}
        </div>
      )}
      <button className="primary" onClick={() => void startRun(ser, errors)} disabled={errors > 0 || ser.outputs.length === 0} title={errors ? "Fix problems first" : jobs.some((j) => j.running) ? "Run another job" : "Run ffmpeg"}>
        ▶ Run
      </button>
      <button
        className={capsError ? "warn" : ""}
        onClick={() => setSettingsOpen(true)}
        title={capsError ?? caps?.version ?? "Settings"}
      >
        ⚙
      </button>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {wizardOpen && (
        <WizardDialog
          onClose={() => setWizardOpen(false)}
          onCreate={async (create) => {
            if (!(await confirmDiscard())) return;
            create();
            setWizardOpen(false);
          }}
        />
      )}
    </header>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useGraph((s) => s.settings);
  const setSettings = useGraph((s) => s.setSettings);
  const setZoomStep = useGraph((s) => s.setZoomStep);
  const zoomStep = settings.zoomStep ?? DEFAULT_ZOOM_STEP;
  const caps = useGraph((s) => s.caps);
  const capsError = useGraph((s) => s.capsError);
  const [ffmpegPath, setFfmpeg] = useState(settings.ffmpegPath);
  const [ffprobePath, setFfprobe] = useState(settings.ffprobePath);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <label className="field">
          <span className="field-label">ffmpeg</span>
          <input type="text" value={ffmpegPath} onChange={(e) => setFfmpeg(e.target.value)} placeholder="ffmpeg (from PATH)" />
        </label>
        <label className="field">
          <span className="field-label">ffprobe</span>
          <input type="text" value={ffprobePath} onChange={(e) => setFfprobe(e.target.value)} placeholder="ffprobe (from PATH)" />
        </label>
        <label className="field">
          <span className="field-label">Zoom speed</span>
          <span className="zoom-speed">
            <span className="muted small">Fine</span>
            <input
              type="range"
              min={ZOOM_STEP_RANGE.min}
              max={ZOOM_STEP_RANGE.max}
              step={1}
              value={zoomStep}
              onChange={(e) => setZoomStep(Number(e.target.value))}
              title="Zoom per mouse-wheel notch"
            />
            <span className="muted small">Coarse</span>
            <span className="zoom-speed-value">{zoomStep}% per notch</span>
          </span>
        </label>
        <p className={capsError ? "error-text" : "muted small"}>
          {capsError ?? (caps ? `${caps.version} — ${caps.encoders.length} encoders, ${caps.muxers.length} muxers, ${caps.filters.length} filters` : "checking…")}
        </p>
        {!ipc.isTauri() && <p className="muted small">Browser mode: ffmpeg is mocked. Run inside Tauri (pnpm tauri dev) for real probing and encoding.</p>}
        <p className="muted small">Not affiliated with or endorsed by the FFmpeg project. FFmpeg is a trademark of Fabrice Bellard.</p>
        <div className="row end">
          <button onClick={onClose}>Close</button>
          <button
            className="primary"
            onClick={() => {
              setSettings({ ...useGraph.getState().settings, ffmpegPath, ffprobePath });
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
