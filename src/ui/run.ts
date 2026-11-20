import * as ipc from "../ipc/ffmpeg";
import type { SerializeResult } from "../serializer";
import { useGraph, type JobState } from "../store/graph";
import { RUN_PREFIX } from "./derived";
import { OutputInfoParser, parseProgress } from "./jobInfo";
import { jobDevices, usesNvidiaGpu } from "../model/devices";

const MAX_LOG = 3000;
let seq = 0;

/** Starts ffmpeg as a new job; other jobs keep running. Returns the job id, or undefined if nothing started. */
export async function startRun(ser: SerializeResult, errors: number): Promise<string | undefined> {
  const st = useGraph.getState();
  if (errors > 0) {
    st.showToast("Fix the errors in Problems before running.");
    return;
  }
  if (ser.outputs.length === 0) {
    st.showToast("Nothing to run: connect streams to an Output.");
    return;
  }
  const outputs = ser.outputs.map((o) => o.path);
  const busy = outputs.filter((p) => st.jobs.some((j) => j.running && j.outputs.some((o) => samePath(o, p))));
  if (busy.length && !(await ipc.confirmDialog(`Another job is still writing ${busy.join(", ")}.\nRun anyway?`, { title: "Output in use", okLabel: "Run", cancelLabel: "Cancel" }))) return;

  const n = ++seq;
  const id = `job-${Date.now().toString(36)}-${n}`;
  const args = [...RUN_PREFIX, ...ser.args];
  const duration = ser.durationSec;
  const inputs = ser.inputOrder.map((nid) => {
    const node = st.nodes.find((x) => x.id === nid);
    return node?.data.kind === "input" ? node.data.path.trim() : "";
  }).filter(Boolean);
  const devices = jobDevices({ nodes: st.nodes, edges: st.edges }, ser);
  // GPU names for the popup; the list is otherwise only loaded when a GPU picker is shown
  if (usesNvidiaGpu(devices) && !st.gpusState) void st.loadGpus();
  st.addJob({
    id,
    seq: n,
    running: true,
    progress: duration ? 0 : NaN,
    duration,
    inputs,
    outputs,
    streams: [],
    devices,
    log: [`$ ffmpeg ${args.join(" ")}`],
    startedAt: Date.now(),
    z: 0,
  });
  const patch = (fn: (j: JobState) => Partial<JobState>) => useGraph.getState().updateJob(id, fn);
  const parser = new OutputInfoParser();
  try {
    await ipc.runJob(id, args, st.settings, {
      onProgress: (v) => patch(() => parseProgress(v, duration)),
      onLog: (line) =>
        patch((j) => ({
          log: j.log.length >= MAX_LOG ? [...j.log.slice(-MAX_LOG + 1), line] : [...j.log, line],
          ...(parser.feed(line) ? { streams: [...parser.streams] } : {}),
        })),
      onDone: (success, code) =>
        patch((j) => ({
          running: false,
          stopping: false,
          endedAt: Date.now(),
          progress: success && !j.stopping ? 1 : j.progress,
          result: success && !j.stopping ? "success" : j.stopping ? "cancelled" : "failed",
          log: [...j.log, success ? (j.stopping ? "■ stopped" : "✔ finished") : `✖ ffmpeg exited with code ${code ?? "?"}`],
        })),
    });
  } catch (e) {
    patch((j) => ({ running: false, endedAt: Date.now(), result: "failed", log: [...j.log, `✖ ${String(e)}`] }));
  }
  return id;
}

/** Asks ffmpeg to stop (it finalizes the file, then is killed after 3 s if needed). */
export async function cancelRun(id: string) {
  const j = useGraph.getState().jobs.find((x) => x.id === id);
  if (!j?.running || j.stopping) return;
  useGraph.getState().updateJob(id, () => ({ stopping: true }));
  await ipc.cancelJob(id);
}

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

const anyRunning = () => useGraph.getState().jobs.some((j) => j.running);

/** Before the app closes with jobs running: ask, then stop them and wait (up to 5 s) for ffmpeg to finish the files. */
export function installCloseGuard() {
  void ipc.guardWindowClose(async () => {
    const running = useGraph.getState().jobs.filter((j) => j.running);
    if (running.length === 0) return true;
    const ok = await ipc.confirmDialog(`${running.length === 1 ? "A job is" : `${running.length} jobs are`} still running. Stop and quit?`, {
      title: "Jobs running",
      okLabel: "Stop and quit",
      cancelLabel: "Keep running",
    });
    if (!ok) return false;
    await Promise.all(running.map((j) => cancelRun(j.id)));
    const deadline = Date.now() + 5000;
    while (anyRunning() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return true;
  }, anyRunning);
}
