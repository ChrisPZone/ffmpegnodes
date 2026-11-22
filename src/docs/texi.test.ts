import { describe, expect, it } from "vitest";
import { inline, MARK, parseFiltersTexi, termNames } from "./texi";

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
