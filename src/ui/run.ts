import * as ipc from "../ipc/ffmpeg";
import type { SerializeResult } from "../serializer";
import { useGraph } from "../store/graph";
import { RUN_PREFIX } from "./derived";

const MAX_LOG = 3000;

export async function startRun(ser: SerializeResult, errors: number) {
  const st = useGraph.getState();
  if (st.job?.running) return;
  if (errors > 0) {
    st.showToast("Fix the errors in Problems before running.");
    return;
  }
  if (ser.outputs.length === 0) {
    st.showToast("Nothing to run: connect streams to an Output.");
    return;
  }
  const id = `job-${Date.now().toString(36)}`;
  const args = [...RUN_PREFIX, ...ser.args];
  const duration = ser.durationSec;
  st.setJob(() => ({ id, running: true, progress: duration ? 0 : NaN, log: [`$ ffmpeg ${args.join(" ")}`], startedAt: Date.now() }));
  const patch = (fn: (j: NonNullable<ReturnType<typeof useGraph.getState>["job"]>) => object) =>
    useGraph.getState().setJob((j) => (j && j.id === id ? { ...j, ...fn(j) } : j));
  try {
    await ipc.runJob(id, args, st.settings, {
      onProgress: (v) =>
        patch(() => {
          const us = Number(v.out_time_us ?? v.out_time_ms);
          const t = Number.isFinite(us) ? us / 1e6 : undefined;
          return {
            outTime: t,
            speed: v.speed,
            fps: v.fps,
            progress: duration && t !== undefined ? Math.min(1, Math.max(0, t / duration)) : NaN,
          };
        }),
      onLog: (line) => patch((j) => ({ log: j.log.length >= MAX_LOG ? [...j.log.slice(-MAX_LOG + 1), line] : [...j.log, line] })),
      onDone: (success, code) =>
        patch((j) => ({
          running: false,
          progress: success ? 1 : j.progress,
          result: success ? "success" : j.result === "cancelled" ? "cancelled" : "failed",
          log: [...j.log, success ? "✔ finished" : `✖ ffmpeg exited with code ${code ?? "?"}`],
        })),
    });
  } catch (e) {
    patch((j) => ({ running: false, result: "failed", log: [...j.log, `✖ ${String(e)}`] }));
  }
}

export async function cancelRun() {
  const j = useGraph.getState().job;
  if (!j?.running) return;
  useGraph.getState().setJob((x) => (x && x.id === j.id ? { ...x, result: "cancelled" } : x));
  await ipc.cancelJob(j.id);
}
