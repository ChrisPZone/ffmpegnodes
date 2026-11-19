import { useEffect, useMemo, useRef, useState } from "react";
import { defaultFlavor, formatCommand, type ShellFlavor } from "../serializer/shellQuote";
import { useGraph } from "../store/graph";
import { useDerived } from "./derived";

type Tab = "command" | "problems" | "log";

export function BottomDock() {
  const { ser, diagnostics, errors } = useDerived();
  const job = useGraph((s) => s.job);
  const select = useGraph((s) => s.select);
  const applyFix = useGraph((s) => s.applyFix);
  const [tab, setTab] = useState<Tab>("command");
  const [flavor, setFlavor] = useState<ShellFlavor>(defaultFlavor());
  const [copied, setCopied] = useState(false);
  const command = useMemo(() => formatCommand("ffmpeg", ser.args, flavor), [ser.args, flavor]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (job?.running) setTab("log");
  }, [job?.id, job?.running]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job?.log.length, tab]);

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
          Log {job?.running && <span className="badge badge-info">running</span>}
        </button>
        <span className="spacer" />
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
