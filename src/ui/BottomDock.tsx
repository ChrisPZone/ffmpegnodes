import { useEffect, useMemo, useRef, useState } from "react";
import { defaultFlavor, formatCommand, type ShellFlavor } from "../serializer/shellQuote";
import { useGraph } from "../store/graph";
import { useDerived } from "./derived";
import { splitPath } from "./jobInfo";

type Tab = "command" | "problems" | "log";

export function BottomDock() {
  const { ser, diagnostics, errors } = useDerived();
  const jobs = useGraph((s) => s.jobs);
  const logJobId = useGraph((s) => s.logJobId);
  const logNonce = useGraph((s) => s.logNonce);
  const setLogJob = useGraph((s) => s.setLogJob);
  const job = jobs.find((j) => j.id === logJobId) ?? jobs[jobs.length - 1];
  const running = jobs.filter((j) => j.running).length;
  const select = useGraph((s) => s.select);
  const applyFix = useGraph((s) => s.applyFix);
  const [tab, setTab] = useState<Tab>("command");
  const [flavor, setFlavor] = useState<ShellFlavor>(defaultFlavor());
  const [copied, setCopied] = useState(false);
  const command = useMemo(() => formatCommand("ffmpeg", ser.args, flavor), [ser.args, flavor]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (logNonce) setTab("log");
  }, [logNonce]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job?.id, job?.log.length, tab]);

  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  return (
    <section className="dock">
      <nav className="tabs">
        <button className={tab === "command" ? "active" : ""} onClick={() => setTab("command")}>Command</button>
        <button className={tab === "problems" ? "active" : ""} onClick={() => setTab("problems")}>
          Problems {errors > 0 && <span className="badge badge-error">{errors}</span>}
          {warnings > 0 && <span className="badge badge-warning">{warnings}</span>}
        </button>
        <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>
          Log {running > 0 && <span className="badge badge-info">{running > 1 ? `${running} running` : "running"}</span>}
        </button>
        <span className="spacer" />
        {tab === "log" && jobs.length > 1 && (
          <select value={job?.id} onChange={(e) => setLogJob(e.target.value)} title="Job to show">
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                Job {j.seq}: {splitPath(j.outputs[0] ?? "").name} ({j.running ? "running" : j.result})
              </option>
            ))}
          </select>
        )}
        {tab === "command" && (
          <>
            <select value={flavor} onChange={(e) => setFlavor(e.target.value as ShellFlavor)} title="Quoting style for copy/paste">
              <option value="posix">bash / zsh</option>
              <option value="powershell">PowerShell</option>
            </select>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(command);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </>
        )}
      </nav>
      <div className="dock-body">
        {tab === "command" && <pre className="command">{ser.args.length ? command : "# Connect Input → Encoder → Output to build a command"}</pre>}
        {tab === "problems" && (
          <ul className="problems">
            {diagnostics.length === 0 && <li className="muted">No problems.</li>}
            {diagnostics.map((d, i) => (
              <li key={i} className={`diag ${d.severity}`} onClick={() => d.nodeId && select(d.nodeId)}>
                <span className="sev">{d.severity}</span>
                <span>{d.message}</span>
                {d.fix && (
                  <button className="small" onClick={(e) => (e.stopPropagation(), applyFix(d.fix!))}>
                    {d.fix.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {tab === "log" && <pre className="log" ref={logRef}>{job ? job.log.join("\n") : "No job has run yet."}</pre>}
      </div>
    </section>
  );
}
