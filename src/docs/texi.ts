// Parses FFmpeg's doc/filters.texi (the source of ffmpeg.org/ffmpeg-filters.html) into compact
// per-filter docs for the help popups. Pure and import-free: scripts/gen-filter-docs.ts runs it
// with plain node.
//
// Inline text uses private-use markers instead of markdown, because filter docs are full of
// `*`, `_` and `[` in expressions:
//   code  …   emphasis …   strong …
//   link  texturl

/** A paragraph (inline text), a code block, a bullet list, a term list or a heading. */
export type DocBlock = string | ["code", string] | ["ul", DocBlock[][]] | ["dl", [string[], DocBlock[]][]] | ["h", string];

export interface DocOption {
  /** Option name and its aliases. */
  names: string[];
  body: DocBlock[];
}

export interface FilterDoc {
  /** All filter names the section documents ("lut, lutrgb, lutyuv"). */
  names: string[];
  /** Fragment on ffmpeg.org/ffmpeg-filters.html. */
  anchor: string;
  summary: string;
  /** Everything else in the section except the options, examples and commands. */
  body: DocBlock[];
  options: DocOption[];
  examples?: DocBlock[];
  /** Anchor of the filter whose options this one shares ("same options as pad"). */
  sameAs?: string;
}

export const MARK = {
  code: ["", ""],
  em: ["", ""],
  strong: ["", ""],
  link: ["", "", ""],
} as const;

const DOCS_URL = "https://ffmpeg.org/";

// ---------------------------------------------------------------- inline markup

/** Index of the `}` closing the brace at `open`, honouring `@{` / `@}` escapes and nesting. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "@") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return s.length;
}

/** Splits brace arguments on top-level commas. */
function args(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "@" && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const CODE_CMDS = new Set(["code", "samp", "option", "command", "env", "file", "kbd", "verb", "t", "indicateurl", "key"]);
const EM_CMDS = new Set(["emph", "i", "var", "dfn", "cite", "sc"]);
const STRONG_CMDS = new Set(["strong", "b"]);
const SYMBOLS: Record<string, string> = { dots: "…", enddots: "…", bullet: "•", minus: "−", copyright: "©", tie: " ", equiv: "≡", result: "⇒", expansion: "↦", error: "error→", TeX: "TeX", LaTeX: "LaTeX", today: "" };

function refUrl(a: string[]): string {
  const node = a[0];
  const manual = a[3];
  const page = manual ? `${manual.replace(/\.html$/, "")}.html` : "ffmpeg-filters.html";
  return `${DOCS_URL}${page}#${node.replace(/\s+/g, "-")}`;
}

/**
 * Texinfo inline markup to marked text. `plain` drops all formatting (for code blocks and
 * option names).
 */
export function inline(s: string, plain = false): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "@") {
      out += c;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) break;
    if ("@{}".includes(next)) {
      out += next;
      i++;
      continue;
    }
    if (next === "*") {
      out += plain ? "\n" : " ";
      i++;
      continue;
    }
    if (":.?!-/ \t\n=&'\"^`,~".includes(next)) {
      // accents and spacing commands: keep sentence punctuation, drop the rest
      if (".?!".includes(next) || next === " ") out += next === " " ? " " : next;
      i++;
      continue;
    }
    const m = /^[A-Za-z]+/.exec(s.slice(i + 1));
    if (!m) {
      out += c;
      continue;
    }
    const cmd = m[0];
    const at = i + 1 + cmd.length;
    if (s[at] !== "{") {
      // brace-less command inside a line (rare): drop the command word
      i = at - 1;
      continue;
    }
    const end = closing(s, at);
    const raw = s.slice(at + 1, end);
    i = end;
    if (cmd in SYMBOLS) {
      out += SYMBOLS[cmd];
      continue;
    }
    if (cmd === "w" || cmd === "math" || cmd === "sup" || cmd === "sub" || cmd === "r" || cmd === "sansserif" || cmd === "slanted") {
      out += (cmd === "sup" ? "^" : cmd === "sub" ? "_" : "") + inline(raw, plain);
      continue;
    }
    if (cmd === "ref" || cmd === "xref" || cmd === "pxref") {
      const a = args(raw);
      const text = inline(a[2] || a[1] || a[0], true);
      out += plain ? text : MARK.link[0] + text + MARK.link[1] + refUrl(a) + MARK.link[2];
      continue;
    }
    if (cmd === "url" || cmd === "uref" || cmd === "email") {
      const a = args(raw);
      const url = (cmd === "email" ? "mailto:" : "") + inline(a[0], true);
      const text = a[1] ? inline(a[1], true) : url.replace(/^mailto:/, "");
      out += plain ? text : MARK.link[0] + text + MARK.link[1] + url + MARK.link[2];
      continue;
    }
    if (cmd === "footnote" || cmd === "anchor" || cmd === "cindex" || cmd === "image") continue;
    const inner = inline(raw, plain);
    if (plain) out += inner;
    else if (CODE_CMDS.has(cmd)) out += MARK.code[0] + inline(raw, true) + MARK.code[1];
    else if (EM_CMDS.has(cmd)) out += MARK.em[0] + inner + MARK.em[1];
    else if (STRONG_CMDS.has(cmd)) out += MARK.strong[0] + inner + MARK.strong[1];
    else out += inner;
  }
  return out;
}

// ---------------------------------------------------------------- blocks

const RAW_ENVS = new Set(["example", "smallexample", "verbatim", "display", "smalldisplay", "format", "smallformat", "lisp", "smalllisp"]);
const TABLE_ENVS = new Set(["table", "ftable", "vtable"]);
const LIST_ENVS = new Set(["itemize", "enumerate"]);
/** Environments whose content is skipped. */
const SKIP_ENVS = new Set(["ignore", "iftex", "ifinfo", "ifplaintext", "ifdocbook", "ifxml", "tex", "macro", "float", "multitable", "titlepage"]);

/** Line-level command: `@word` followed by whitespace or end of line. */
const lineCmd = (t: string) => /^@([A-Za-z]+)(?:\s|$)/.exec(t)?.[1];

interface Cursor {
  lines: string[];
  i: number;
}

/**
 * Parses blocks until `@end <env>` (consumed) or, with `stopAtItem`, until an `@item` /
 * `@itemx` line at this level (not consumed).
 */
function parseBlocks(c: Cursor, env?: string, stopAtItem = false): DocBlock[] {
  const blocks: DocBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      const text = inline(para.join(" ")).replace(/\s+/g, " ").trim();
      if (text) blocks.push(text);
    }
    para = [];
  };
  while (c.i < c.lines.length) {
    const line = c.lines[c.i];
    const t = line.trim();
    const cmd = lineCmd(t);
    if (cmd === "end") {
      const name = t.split(/\s+/)[1];
      if (env && name === env) {
        c.i++;
        break;
      }
      // an @end for an enclosing table or list: let the caller see it; skip others (@end ifhtml)
      if ((env || stopAtItem) && (TABLE_ENVS.has(name) || LIST_ENVS.has(name))) break;
      c.i++;
      continue;
    }
    if (stopAtItem && (cmd === "item" || cmd === "itemx")) break;
    if (!t) {
      flush();
      c.i++;
      continue;
    }
    if (cmd === "c" || cmd === "comment") {
      c.i++;
      continue;
    }
    if (cmd && RAW_ENVS.has(cmd)) {
      flush();
      c.i++;
      const raw: string[] = [];
      while (c.i < c.lines.length && !new RegExp(`^\\s*@end\\s+${cmd}\\b`).test(c.lines[c.i])) raw.push(c.lines[c.i++]);
      c.i++;
      const text = (cmd === "verbatim" ? raw.join("\n") : inline(raw.join("\n"), true)).replace(/^\n+|\s+$/g, "");
      if (text) blocks.push(["code", text]);
      continue;
    }
    if (cmd && TABLE_ENVS.has(cmd)) {
      flush();
      c.i++;
      const rows = parseTable(c, cmd);
      if (rows.length) blocks.push(["dl", rows]);
      continue;
    }
    if (cmd && LIST_ENVS.has(cmd)) {
      flush();
      c.i++;
      const items = parseList(c, cmd);
      if (items.length) blocks.push(["ul", items]);
      continue;
    }
    if (cmd && (SKIP_ENVS.has(cmd) || /^if/.test(cmd) && cmd !== "ifhtml" && cmd !== "ifnottex")) {
      c.i++;
      if (!SKIP_ENVS.has(cmd)) continue; // @ifhtml / @ifnottex content is kept, its @end skipped
      let depth = 1;
      while (c.i < c.lines.length && depth > 0) {
        const tt = c.lines[c.i].trim();
        if (lineCmd(tt) === cmd) depth++;
        else if (new RegExp(`^@end\\s+${cmd}\\b`).test(tt)) depth--;
        c.i++;
      }
      continue;
    }
    if (cmd && (cmd === "item" || cmd === "itemx")) {
      // stray item outside a table: treat as text
      para.push(t.replace(/^@itemx?\s*/, ""));
      c.i++;
      continue;
    }
    if (cmd && (cmd === "section" || cmd === "subsection" || cmd === "subsubsection" || cmd === "chapter")) break;
    if (cmd) {
      // @anchor, @noindent, @sp, @group, @ifhtml, @cindex, ...
      c.i++;
      continue;
    }
    if (/^@anchor\{/.test(t)) {
      c.i++;
      continue;
    }
    para.push(t);
    c.i++;
  }
  flush();
  return blocks;
}

/** After the `@table` line; consumes through `@end table`. */
function parseTable(c: Cursor, env: string): [string[], DocBlock[]][] {
  const rows: [string[], DocBlock[]][] = [];
  let terms: string[] = [];
  while (c.i < c.lines.length) {
    const t = c.lines[c.i].trim();
    const cmd = lineCmd(t);
    if (cmd === "end") {
      if (t.split(/\s+/)[1] === env) c.i++;
      break;
    }
    if (cmd === "item" || cmd === "itemx") {
      terms.push(t.replace(/^@itemx?\s*/, ""));
      c.i++;
      const body = parseBlocks(c, undefined, true);
      if (body.length) {
        rows.push([terms, body]);
        terms = [];
      }
      continue;
    }
    c.i++; // text before the first item
  }
  if (terms.length) rows.push([terms, []]);
  return rows.map(([ts, body]) => [ts.map((x) => inline(x)), body]);
}

/** After the `@itemize` line; consumes through `@end itemize`. */
function parseList(c: Cursor, env: string): DocBlock[][] {
  const items: DocBlock[][] = [];
  while (c.i < c.lines.length) {
    const t = c.lines[c.i].trim();
    const cmd = lineCmd(t);
    if (cmd === "end") {
      if (t.split(/\s+/)[1] === env) c.i++;
      break;
    }
    if (cmd === "item") {
      const first = t.replace(/^@item\s*/, "");
      c.i++;
      const body = parseBlocks(c, undefined, true);
      if (first) {
        const lead = inline(first).trim();
        if (typeof body[0] === "string") body[0] = `${lead} ${body[0]}`;
        else body.unshift(lead);
      }
      items.push(body);
      continue;
    }
    c.i++;
  }
  return items;
}

// ---------------------------------------------------------------- sections

const stripMarks = (s: string) => s.replace(/[-]/g, "");

/** Option names of a table term: "width, w" → ["width", "w"]. */
export function termNames(term: string): string[] {
  return stripMarks(term)
    .split(/\s*,\s*/)
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z0-9_.-]+$/.test(x));
}

/** ffmpeg.org's id for a section without @anchor ("a, b" → "a_002c-b"). */
function sectionId(title: string): string {
  return title.replace(/,/g, "_002c").replace(/\s+/g, "-");
}

/** "It accepts the following parameters:" (but not "The expressions accept the following parameters:"). */
const OPTIONS_INTRO = /\b(options?|parameters?)\b/i;
const NOT_OPTIONS = /\b(expressions?|variables?|constants?|values?|commands?|functions?|flags?)\b/i;
const introducesOptions = (b: DocBlock | undefined) => typeof b === "string" && OPTIONS_INTRO.test(stripMarks(b)) && !NOT_OPTIONS.test(stripMarks(b));

/** Builds the doc for one section's lines (without the @section line). */
function buildFilter(title: string, anchor: string | undefined, lines: string[]): FilterDoc {
  // split into the main part and @subsection parts
  const parts: { title: string; lines: string[] }[] = [{ title: "", lines: [] }];
  for (const line of lines) {
    const m = /^@(sub)?subsection\s+(.*)$/.exec(line.trim());
    if (m) parts.push({ title: inline(m[2], true).trim(), lines: [] });
    else parts[parts.length - 1].lines.push(line);
  }
  const doc: FilterDoc = { names: termNames(title), anchor: anchor ?? sectionId(title), summary: "", body: [], options: [] };
  let examples: DocBlock[] | undefined;
  for (const part of parts) {
    const kind = /^examples?$/i.test(part.title) ? "examples" : /^commands?$/i.test(part.title) ? "commands" : /^options$/i.test(part.title) ? "options" : part.title ? "other" : "main";
    if (kind === "commands") continue; // the app does not send runtime commands
    const blocks = parseBlocks({ lines: part.lines, i: 0 });
    if (kind === "examples") {
      examples = [...(examples ?? []), ...blocks];
      continue;
    }
    if (kind === "other") doc.body.push(["h", part.title]);
    // option tables: term lists after "accepts the following options", or the first one in an
    // "Options" subsection
    let tookTable = false;
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      const prev = blocks[k - 1];
      const intro = introducesOptions(prev);
      if (Array.isArray(b) && b[0] === "dl" && (intro || (kind === "options" && !tookTable))) {
        tookTable = true;
        for (const [terms, body] of b[1]) {
          const names = terms.flatMap(termNames);
          if (names.length) doc.options.push({ names, body });
        }
        // drop the "accepts the following options:" lead-in
        if (intro && doc.body[doc.body.length - 1] === prev) doc.body.pop();
        continue;
      }
      if (!doc.summary && typeof b === "string" && kind === "main") {
        doc.summary = b;
        continue;
      }
      doc.body.push(b);
    }
  }
  // no introduced table: the first term list of option-like names that is not introduced as
  // values, constants or variables
  if (!doc.options.length) {
    const k = doc.body.findIndex((b, j) => {
      if (!Array.isArray(b) || b[0] !== "dl") return false;
      const prev = doc.body[j - 1];
      if (typeof prev === "string" && NOT_OPTIONS.test(stripMarks(prev))) return false;
      if (Array.isArray(prev) && prev[0] === "h") return false;
      return b[1].every(([ts]) => ts.flatMap(termNames).length > 0);
    });
    if (k >= 0) {
      for (const [terms, body] of (doc.body[k] as ["dl", [string[], DocBlock[]][]])[1]) doc.options.push({ names: terms.flatMap(termNames), body });
      doc.body.splice(k, 1);
    }
  }
  // "accepts the same options as the @ref{pad} filter"
  if (!doc.options.length) {
    for (const b of [doc.summary, ...doc.body]) {
      if (typeof b !== "string" || !/same (options|parameters)|description of (the )?available options/i.test(stripMarks(b))) continue;
      const m = /ffmpeg-filters\.html#([^]+)/.exec(b);
      if (m) {
        doc.sameAs = m[1];
        break;
      }
    }
  }
  if (examples?.length) doc.examples = examples;
  return doc;
}

/** All filter sections of filters.texi (sections under the filter, source and sink chapters). */
export function parseFiltersTexi(texi: string): FilterDoc[] {
  const lines = texi.replace(/\r\n?/g, "\n").split("\n");
  const docs: FilterDoc[] = [];
  let chapter = "";
  let cur: { title: string; anchor?: string; lines: string[] } | undefined;
  let pendingAnchor: string | undefined;
  const isFilterChapter = (ch: string) => /(Filters|Sources|Sinks)$/.test(ch) && !/Introduction/.test(ch);
  const finish = () => {
    if (cur && isFilterChapter(chapter)) {
      const d = buildFilter(cur.title, cur.anchor, cur.lines);
      if (d.names.length) docs.push(d);
    }
    cur = undefined;
  };
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpExecArray | null;
    if ((m = /^@chapter\s+(.*)$/.exec(t))) {
      finish();
      chapter = m[1].trim();
      pendingAnchor = undefined;
      continue;
    }
    if ((m = /^@section\s+(.*)$/.exec(t))) {
      finish();
      cur = { title: m[1].trim(), anchor: pendingAnchor, lines: [] };
      pendingAnchor = undefined;
      continue;
    }
    // an @anchor directly before @section (blank lines allowed) names that section
    if ((m = /^@anchor\{([^}]*)\}\s*$/.exec(t))) pendingAnchor = m[1];
    else if (t) pendingAnchor = undefined;
    cur?.lines.push(line);
  }
  finish();
  return docs;
}
