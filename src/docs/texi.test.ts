import { describe, expect, it } from "vitest";
import { inline, MARK, optionNames, parseEncodersTexi, parseFiltersTexi, parseOptionChapter, termNames } from "./texi";

const plainMarks = (s: string) =>
  s
    .replace(new RegExp(`[${MARK.code.join("")}]`, "g"), "`")
    .replace(new RegExp(`[${MARK.em.join("")}]`, "g"), "_")
    .replace(MARK.link[0], "[")
    .replace(MARK.link[1], "](")
    .replace(MARK.link[2], ")");

const TEXI = `
@chapter Filtering Introduction
@section notafilter
Ignored.

@chapter Video Filters

@anchor{eq}
@section eq
Set brightness and contrast.

More text with @code{x} and @var{y}.

The filter accepts the following options:

@table @option
@item contrast
Set the contrast. Default is "1".

@item eval
Set when expressions are evaluated.

It accepts the following values:
@table @samp
@item init
once
@item frame
per frame
@end table

Default value is @samp{init}.
@end table

The expressions accept the following parameters:
@table @option
@item n
frame count
@end table

@subsection Commands
@table @option
@item contrast
Set it at runtime.
@end table

@subsection Examples
@itemize
@item
Raise contrast:
@example
eq=contrast=1.5:eval=frame
@end example
@end itemize

@section lut, lutrgb
Lookup tables.

@table @option
@item c0
@itemx r
First component.
@item width, w
@item height, h
Size.
@end table

@section pad_cuda
CUDA pad.

It accepts the same options as the @ref{pad} filter.

@chapter Audio Sources
@section sine
Make a sine.

@subsection Options
@table @option
@item frequency, f
Tone in Hz.
@end table
`;

describe("inline", () => {
  it("converts markup and escapes", () => {
    expect(plainMarks(inline("Use @code{a@{b@}} with @var{n}@dots{} @@home"))).toBe("Use `a{b}` with _n_… @home");
  });
  it("turns refs into links to ffmpeg.org", () => {
    expect(plainMarks(inline("see @ref{framesync}"))).toBe("see [framesync](https://ffmpeg.org/ffmpeg-filters.html#framesync)");
    expect(plainMarks(inline("@ref{sws_flags,,the scaler manual,ffmpeg-scaler}"))).toBe("[the scaler manual](https://ffmpeg.org/ffmpeg-scaler.html#sws_flags)");
  });
  it("drops all formatting in plain mode", () => {
    expect(inline("@code{x} @emph{y}", true)).toBe("x y");
  });
});

describe("termNames", () => {
  it("splits aliases", () => {
    expect(termNames("width, w")).toEqual(["width", "w"]);
  });
});

describe("parseFiltersTexi", () => {
  const docs = parseFiltersTexi(TEXI);
  const get = (n: string) => docs.find((d) => d.names.includes(n))!;

  it("only reads filter chapters", () => {
    expect(docs.flatMap((d) => d.names)).toEqual(["eq", "lut", "lutrgb", "pad_cuda", "sine"]);
  });

  it("reads summary, options with value tables, body and examples", () => {
    const eq = get("eq");
    expect(eq.anchor).toBe("eq");
    expect(eq.summary).toBe("Set brightness and contrast.");
    expect(eq.options.map((o) => o.names)).toEqual([["contrast"], ["eval"]]);
    expect(eq.options[1].body).toEqual([
      "Set when expressions are evaluated.",
      "It accepts the following values:",
      ["dl", [[["init"], ["once"]], [["frame"], ["per frame"]]]],
      `Default value is ${MARK.code[0]}init${MARK.code[1]}.`,
    ]);
    // expression variables stay in the body, the options lead-in is dropped, commands are skipped
    expect(eq.body).toEqual([
      `More text with ${MARK.code[0]}x${MARK.code[1]} and ${MARK.em[0]}y${MARK.em[1]}.`,
      "The expressions accept the following parameters:",
      ["dl", [[["n"], ["frame count"]]]],
    ]);
    expect(eq.examples).toEqual([["ul", [["Raise contrast:", ["code", "eq=contrast=1.5:eval=frame"]]]]]);
  });

  it("groups @itemx and body-less items, and takes an unintroduced table", () => {
    const lut = get("lutrgb");
    expect(lut.anchor).toBe("lut_002c-lutrgb");
    expect(lut.options.map((o) => o.names)).toEqual([["c0", "r"], ["width", "w", "height", "h"]]);
  });

  it("notes filters that share another filter's options", () => {
    expect(get("pad_cuda").sameAs).toBe("pad");
  });

  it("reads an Options subsection", () => {
    expect(get("sine").options).toEqual([{ names: ["frequency", "f"], body: ["Tone in Hz."] }]);
  });
});

describe("optionNames", () => {
  it("reads names from codec, encoder and ffmpeg terms", () => {
    expect(optionNames("b (bitrate)")).toEqual(["b"]);
    expect(optionNames(`preset ${MARK.em[0]}integer${MARK.em[1]}`)).toEqual(["preset"]);
    expect(optionNames("-r[:stream_specifier] fps (input/output,per-stream)")).toEqual(["r"]);
    expect(optionNames("vbr (vbr, hard-cbr, and cvbr)")).toEqual(["vbr"]);
    expect(optionNames("application (N.A.)")).toEqual(["application"]);
    expect(optionNames("none", true)).toEqual([]);
  });
});

const ENCODERS_TEXI = `
@chapter Video Encoders

@section libx264, libx264rgb
x264 wrapper.

@subsection Options
@table @option
@item crf (@emph{crf})
Constant quality.
@item preset @var{string}
Speed.
@table @samp
@item fast
quick
@end table
@end table

@subsection Examples
@example
-c:v libx264
@end example

@section NVENC encoders
The @code{h264_nvenc} and @code{hevc_nvenc} encoders use NVIDIA NVENC.

@subsection Common options
@table @option
@item cq @var{float}
Target quality.
@end table
`;

describe("parseEncodersTexi", () => {
  const docs = parseEncodersTexi(ENCODERS_TEXI);
  it("names sections by title or by the encoders in their intro", () => {
    expect(docs.map((d) => d.names)).toEqual([["libx264", "libx264rgb"], ["h264_nvenc", "hevc_nvenc"]]);
    expect(docs[1].anchor).toBe("NVENC-encoders");
  });
  it("takes options from every subsection, keeping value tables inside", () => {
    const x = docs[0];
    expect(x.options.map((o) => [o.names, o.usage])).toEqual([[["crf"], "crf (crf)"], [["preset"], "preset string"]]);
    expect(x.options[1].body).toEqual(["Speed.", ["dl", [[["fast"], ["quick"]]]]]);
    expect(x.examples).toEqual([["code", "-c:v libx264"]]);
    expect(docs[1].options[0].names).toEqual(["cq"]);
  });
});

describe("parseOptionChapter", () => {
  it("reads codec options from the chapter text", () => {
    const opts = parseOptionChapter("@anchor{codec-options}\n@chapter Codec Options\n@table @option\n@item b @var{integer} (@emph{encoding})\nBitrate.\n@end table\n", /^Codec Options$/);
    expect(opts).toEqual([{ names: ["b"], body: ["Bitrate."], usage: "b integer (encoding)", anchor: "codec-options" }]);
  });
  it("reads only -options of ffmpeg's Options chapter", () => {
    const texi = "@chapter Options\n@section Main options\n@table @option\n@item -ss @var{position} (@emph{input/output})\nSeek.\n@end table\n@table @samp\n@item none\nNot an option.\n@end table\n";
    expect(parseOptionChapter(texi, /^Options$/, true)).toEqual([{ names: ["ss"], body: ["Seek."], usage: "-ss position (input/output)", anchor: "Main-options" }]);
  });
});

describe("encoder option tables", () => {
  const texi = [
    "@chapter Video Encoders",
    "@section libvpx",
    "VP8/VP9 wrapper.",
    "@table @option",
    "@item g (@emph{kf-max-dist})",
    "",
    "@item qmin (@emph{min-q})",
    "Minimum quantizer.",
    "@item VP9-specific options",
    "@table @option",
    "@item row-mt @var{boolean}",
    "Row threads.",
    "@end table",
    "@end table",
  ].join("\n");
  const [doc] = parseEncodersTexi(texi);

  it("keeps an undescribed item apart when a blank line follows it", () => {
    expect(doc.options.slice(0, 2).map((o) => [o.names, o.body])).toEqual([
      [["g"], []],
      [["qmin"], ["Minimum quantizer."]],
    ]);
  });

  it("flattens groups of options", () => {
    expect(doc.options.map((o) => o.names[0])).toEqual(["g", "qmin", "row-mt"]);
  });
});
