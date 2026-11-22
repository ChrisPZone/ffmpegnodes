import { describe, expect, it } from "vitest";
import { FILTERS, paramDocRef } from "../nodes/defs/filters";
import { indexFilterDocs, optionDoc, type FilterDocsFile } from "./filterDocs";
import raw from "./filterDocs.json?raw";

const docs = indexFilterDocs(JSON.parse(raw) as FilterDocsFile);

describe("bundled filter docs", () => {
  it("covers every curated filter param that maps to an ffmpeg option", () => {
    const missing: string[] = [];
    for (const def of FILTERS) {
      for (const p of def.params) {
        const ref = paramDocRef(def, p);
        if (ref && !optionDoc(docs, ref.filter, ref.option)) missing.push(`${def.id}.${p.name} → ${ref.filter}:${ref.option}`);
      }
    }
    // add `doc: { option }` or `doc: false` to the param when this fails
    expect(missing).toEqual([]);
  });

  it("falls back to shared and software filters", () => {
    expect(optionDoc(docs, "pad_cuda", "color")?.borrowed).toBe("pad");
    expect(optionDoc(docs, "scale", "w")?.option.names).toContain("width");
  });
});
