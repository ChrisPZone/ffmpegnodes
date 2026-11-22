import { useEffect, useState, type ReactNode } from "react";
import type { KeyValue, ParamDef, ParamValue } from "../model/types";
import { pickOpenFile } from "../ipc/ffmpeg";
import { useGraph } from "../store/graph";

/**
 * NVIDIA GPU picker (CUDA order). Lists GPUs by name once detected; with a single GPU it
 * only shows which one is used; falls back to a plain index field if detection fails.
 */
export function GpuSelect({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  const gpus = useGraph((s) => s.gpus);
  const state = useGraph((s) => s.gpusState);
  const error = useGraph((s) => s.gpusError);
  const loadGpus = useGraph((s) => s.loadGpus);
  useEffect(() => {
    void loadGpus();
  }, [loadGpus]);

  if (state === "error" || (state === "ok" && !gpus?.length)) {
    return (
      <>
        <Field label={label} hint={hint}>
          <input type="text" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))} placeholder="default" />
        </Field>
        <p className="muted small">
          GPU detection failed: {error ?? "no GPU found"}{" "}
          <button className="small" onClick={() => void loadGpus(true)}>Retry</button>
        </p>
      </>
    );
  }
  if (state !== "ok" || !gpus) {
    return (
      <Field label={label} hint={hint}>
        <select disabled>
          <option>Detecting GPUs…</option>
        </select>
      </Field>
    );
  }
  if (gpus.length === 1 && !value) {
    return <p className="muted small">GPU: {gpus[0].name}</p>;
  }
  const known = gpus.some((g) => String(g.index) === value);
  return (
    <Field label={label} hint={hint}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Default ({gpus[0].name})</option>
        {gpus.map((g) => (
          <option key={g.index} value={String(g.index)}>
            {g.index}: {g.name}
          </option>
        ))}
        {value && !known && <option value={value}>{value}: not found</option>}
      </select>
    </Field>
  );
}

export function Field({ label, hint, help, children }: { label: string; hint?: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label className="field" title={hint}>
      <span className="field-label">
        {label}
        {help}
      </span>
      <span className="field-control">{children}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Text input that commits on blur / Enter (for paths, where every keystroke would re-probe). */
export function CommitText({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      type="text"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

export function ParamField({ def, value, onChange, help }: { def: ParamDef; value: ParamValue | undefined; onChange: (v: ParamValue) => void; help?: ReactNode }) {
  const v = value ?? def.default;
  const label = def.label ?? def.name;
  switch (def.type) {
    case "bool":
      return (
        <Field label={label} hint={def.description} help={help}>
          <input type="checkbox" checked={Boolean(v)} onChange={(e) => onChange(e.target.checked)} />
        </Field>
      );
    case "enum":
      return (
        <Field label={label} hint={def.description} help={help}>
          <select value={String(v)} onChange={(e) => onChange(e.target.value)}>
            {!def.options?.some((o) => o.value === String(v)) && <option value={String(v)}>{String(v)}</option>}
            {def.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label ?? o.value}
              </option>
            ))}
          </select>
        </Field>
      );
    case "int":
    case "float":
      return (
        <Field label={label} hint={def.description} help={help}>
          <span className="num">
            {def.min !== undefined && def.max !== undefined && (
              <input
                type="range"
                min={def.min}
                max={def.max}
                step={def.step ?? (def.type === "int" ? 1 : 0.1)}
                value={Number(v)}
                onChange={(e) => onChange(Number(e.target.value))}
              />
            )}
            <input
              type="number"
              min={def.min}
              max={def.max}
              step={def.step ?? (def.type === "int" ? 1 : "any")}
              value={String(v)}
              onChange={(e) => e.target.value !== "" && onChange(def.type === "int" ? Math.round(Number(e.target.value)) : Number(e.target.value))}
            />
          </span>
        </Field>
      );
    case "file":
      return (
        <Field label={label} hint={def.description} help={help}>
          <span className="file-field">
            <CommitText value={String(v)} onCommit={onChange} placeholder={def.placeholder} />
            <button
              className="small"
              onClick={async (e) => {
                e.preventDefault();
                const p = await pickOpenFile(def.fileFilters ? [...def.fileFilters, { name: "All files", extensions: ["*"] }] : undefined);
                if (p) onChange(p);
              }}
            >
              Browse…
            </button>
          </span>
        </Field>
      );
    default:
      return (
        <Field label={label} hint={def.description} help={help}>
          <input type="text" value={String(v)} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
  }
}

export function KVTable({ rows, onChange, keyPlaceholder = "key", valuePlaceholder = "value" }: { rows: KeyValue[]; onChange: (rows: KeyValue[]) => void; keyPlaceholder?: string; valuePlaceholder?: string }) {
  const set = (i: number, patch: Partial<KeyValue>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input type="text" value={r.key} placeholder={keyPlaceholder} onChange={(e) => set(i, { key: e.target.value })} />
          <input type="text" value={r.value} placeholder={valuePlaceholder} onChange={(e) => set(i, { value: e.target.value })} />
          <button className="icon" onClick={() => onChange(rows.filter((_, j) => j !== i))} title="Remove">
            ×
          </button>
        </div>
      ))}
      <button className="small" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        + add
      </button>
    </div>
  );
}

export function Section({ title, help, children, collapsed }: { title: string; help?: ReactNode; children: ReactNode; collapsed?: boolean }) {
  return (
    <details className="section" open={!collapsed}>
      <summary>
        {title}
        {help}
      </summary>
      <div className="section-body">{children}</div>
    </details>
  );
}
