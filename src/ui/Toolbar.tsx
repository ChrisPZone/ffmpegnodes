import { useState } from "react";
import * as ipc from "../ipc/ffmpeg";
import { parseProject, toProject, useGraph } from "../store/graph";
import { useDerived } from "./derived";
import { cancelRun, startRun } from "./run";
import { WizardDialog } from "../wizard/WizardDialog";

/** Asks before the graph on the canvas is replaced; true when it is empty or the user agrees. */
export async function confirmDiscard(): Promise<boolean> {
  if (!useGraph.getState().nodes.length) return true;
  return ipc.confirmDialog("Discard the current graph?", { title: "Discard graph", okLabel: "Discard", cancelLabel: "Cancel" });
}

const fmtTime = (s?: number) => {
  if (s === undefined || !Number.isFinite(s)) return "–";
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

export function Toolbar() {
  const { ser, errors } = useDerived();
  const job = useGraph((s) => s.job);
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

  const pct = job && Number.isFinite(job.progress) ? Math.round(job.progress * 100) : undefined;
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
      {job && (
        <div className={`progress ${job.result ?? ""}`} title={`${job.speed ?? ""} ${job.fps ? `${job.fps} fps` : ""}`}>
          <div className="bar" style={{ width: `${pct ?? (job.running ? 100 : 0)}%` }} data-indeterminate={pct === undefined && job.running} />
          <span>
            {job.running ? `${pct !== undefined ? `${pct}%` : "running"} · ${fmtTime(job.outTime)} · ${job.speed ?? ""}` : job.result}
          </span>
        </div>
      )}
      {job?.running ? (
        <button className="danger" onClick={() => void cancelRun()}>Cancel</button>
      ) : (
        <button className="primary" onClick={() => void startRun(ser, errors)} disabled={errors > 0 || ser.outputs.length === 0} title={errors ? "Fix problems first" : "Run ffmpeg"}>
          ▶ Run
        </button>
      )}
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
              setSettings({ ffmpegPath, ffprobePath });
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
