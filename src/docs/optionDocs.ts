// Lookup in the bundled encoder, codec-option and ffmpeg-option docs (src/docs/optionDocs.json,
// made by `pnpm gen:docs`). Loaded on first use, like the filter docs.
import type { DocOption, FilterDoc } from "./texi";

export interface OptionDocsFile {
  ffmpeg: string;
  /** encoders.texi sections. */
  encoders: FilterDoc[];
  /** codecs.texi "Codec Options" (b, maxrate, threads, ...). */
  codec: DocOption[];
  /** ffmpeg.texi "Options" (-ss, -t, -r, -hwaccel, ...). */
  cli: DocOption[];
}

export interface OptionDocs extends OptionDocsFile {
  encoderByName: Map<string, FilterDoc>;
}

export function indexOptionDocs(file: OptionDocsFile): OptionDocs {
  const encoderByName = new Map<string, FilterDoc>();
  for (const e of file.encoders) for (const n of e.names) if (!encoderByName.has(n)) encoderByName.set(n, e);
  return { ...file, encoderByName };
}

let loading: Promise<OptionDocs> | undefined;

export function loadOptionDocs(): Promise<OptionDocs> {
  loading ??= import("./optionDocs.json?raw").then((m) => indexOptionDocs(JSON.parse(m.default) as OptionDocsFile));
  return loading;
}

const CODECS_URL = "https://ffmpeg.org/ffmpeg-codecs.html";
const FFMPEG_URL = "https://ffmpeg.org/ffmpeg.html";

export type OptionSource = "encoder" | "codec" | "cli";

export interface OptionHit {
  option: DocOption;
  from: OptionSource;
  /** Page section the text comes from. */
  url: string;
}

const find = (opts: DocOption[] | undefined, name: string) => opts?.find((o) => o.names.includes(name));

const codecHit = (docs: OptionDocs, name: string): OptionHit | undefined => {
  const o = find(docs.codec, name);
  return o && { option: o, from: "codec", url: `${CODECS_URL}#${o.anchor ?? "codec-options"}` };
};

const cliHit = (docs: OptionDocs, name: string): OptionHit | undefined => {
  const o = find(docs.cli, name);
  return o && { option: o, from: "cli", url: `${FFMPEG_URL}#${o.anchor ?? "Options"}` };
};

/** Encoders documented under another section name. */
const ENCODER_SECTIONS: Record<string, string> = {
  "libvpx-vp9": "libvpx",
  eac3: "ac3",
  prores_ks: "prores",
  prores_aw: "prores",
};

export function encoderDoc(docs: OptionDocs, codec: string): FilterDoc | undefined {
  return docs.encoderByName.get(codec) ?? docs.encoderByName.get(ENCODER_SECTIONS[codec] ?? "");
}

export const encoderDocUrl = (e: FilterDoc) => `${CODECS_URL}#${e.anchor}`;

/** An encoder option: the encoder's own docs, then the generic codec options, then ffmpeg's. */
export function encoderOptionDoc(docs: OptionDocs, codec: string, option: string): OptionHit | undefined {
  const enc = encoderDoc(docs, codec);
  const own = find(enc?.options, option);
  if (enc && own) return { option: own, from: "encoder", url: encoderDocUrl(enc) };
  return codecHit(docs, option) ?? cliHit(docs, option);
}

/** An ffmpeg command-line option (-ss, -hwaccel, ...), or a codec option given on the command line (-threads). */
export function cliOptionDoc(docs: OptionDocs, option: string): OptionHit | undefined {
  return cliHit(docs, option) ?? codecHit(docs, option);
}
