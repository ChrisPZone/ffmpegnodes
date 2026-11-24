import { describe, expect, it } from "vitest";
import { FILTERS, paramDocRef } from "../nodes/defs/filters";
import { filterDoc, indexFilterDocs, optionDoc, type FilterDocsFile } from "./filterDocs";
import raw from "./filterDocs.json?raw";

const docs = indexFilterDocs(JSON.parse(raw) as FilterDocsFile);

describe("bundled filter docs", () => {
  it("covers every curated filter param that maps to an ffmpeg option", () => {
    const missing: string[] = [];
    for (const def of FILTERS) {
      for (const p of def.params) {
        const ref = paramDocRef(def, p);
        if (!ref) continue;
        const found = ref.option ? optionDoc(docs, ref.filter, ref.option) : filterDoc(docs, ref.filter);
        if (!found) missing.push(`${def.id}.${p.name} → ${ref.filter}:${ref.option ?? "(section)"}`);
      }
    }
    // add `doc: { option }`, `doc: { whole: true }` or `doc: false` to the param when this fails
    expect(missing).toEqual([]);
  });

  it("shows the whole pan section for the pan expression", () => {
    const pan = FILTERS.find((f) => f.id === "pan")!;
    const ref = paramDocRef(pan, pan.params.find((p) => p.name === "expr")!);
    expect(ref).toEqual({ filter: "pan", option: undefined });
    expect(JSON.stringify(filterDoc(docs, "pan")?.body)).toContain("Remapping examples");
  });

  it("falls back to shared and software filters", () => {
    expect(optionDoc(docs, "pad_cuda", "color")?.borrowed).toBe("pad");
    expect(optionDoc(docs, "scale", "w")?.option.names).toContain("width");
  });
});
