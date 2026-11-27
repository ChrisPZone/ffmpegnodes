import { describe, expect, it } from "vitest";
import { ENCODERS, encoderParamDocRef, getEncoderSchema } from "../nodes/defs/encoders";
import { INPUT_DOC_DEMUXER, INPUT_DOC_OPTIONS } from "./inputOptions";
import { cliOptionDoc, encoderOptionDoc, indexOptionDocs, type OptionDocsFile } from "./optionDocs";
import raw from "./optionDocs.json?raw";

const docs = indexOptionDocs(JSON.parse(raw) as OptionDocsFile);

describe("bundled option docs", () => {
  it("covers every encoder param that maps to an ffmpeg option", () => {
    const missing: string[] = [];
    const schemas = [...ENCODERS, getEncoderSchema("libsvtav1", "video"), getEncoderSchema("libmp3lame", "audio"), getEncoderSchema("hevc_nvenc", "video")];
    for (const s of schemas) {
      for (const p of s.params) {
        const option = encoderParamDocRef(p);
        if (option && !encoderOptionDoc(docs, s.codec, option)) missing.push(`${s.codec}.${p.name} → ${option}`);
      }
    }
    // add `doc: { option }` or `doc: false` to the param when this fails
    expect(missing).toEqual([]);
  });

  it("covers the Input node's options", () => {
    const keys = Object.keys(INPUT_DOC_OPTIONS) as (keyof typeof INPUT_DOC_OPTIONS)[];
    expect(keys.filter((k) => !cliOptionDoc(docs, INPUT_DOC_OPTIONS[k]!, INPUT_DOC_DEMUXER[k]))).toEqual([]);
    expect(cliOptionDoc(docs, "framerate", "image2")?.from).toBe("demuxer");
  });

  it("prefers the encoder's own docs, then codec options, then ffmpeg's", () => {
    expect(encoderOptionDoc(docs, "libx264", "crf")?.from).toBe("encoder");
    expect(encoderOptionDoc(docs, "libopus", "maxrate")?.from).toBe("codec");
    expect(encoderOptionDoc(docs, "libopus", "pix_fmt")?.from).toBe("cli");
    expect(cliOptionDoc(docs, "threads")?.from).toBe("codec");
  });
});
