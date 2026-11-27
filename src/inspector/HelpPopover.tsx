// "?" buttons next to filter, encoder and option names, opening a popup with the ffmpeg docs
// (bundled from FFmpeg's texinfo docs, see src/docs) and, for generic filters, what `ffmpeg -h` says.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { filterDoc, filterDocUrl, FILTER_DOCS_URL, loadFilterDocs, optionDoc } from "../docs/filterDocs";
import { cliOptionDoc, encoderDoc, encoderDocUrl, encoderOptionDoc, loadOptionDocs, type OptionHit } from "../docs/optionDocs";
import { MARK, type DocBlock, type FilterDoc } from "../docs/texi";
import { openExternal } from "../ipc/ffmpeg";
import type { HelpOption } from "../model/types";

// ---------------------------------------------------------------- button + popup

/**
 * A small "?" that opens `content` in a popup. A span, not a button: inside a <label> or
 * <summary> a button would take the label's clicks; preventDefault keeps the label and the
 * <details> toggle from reacting.
 */
export function HelpButton({ label, children }: { label: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLSpanElement>(null);
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen((o) => !o);
  };
  return (
    <>
      <span
        ref={btn}
        className={`help-btn${open ? " open" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={toggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(e)}
      >
        ?
      </span>
      {open && btn.current && (
        <Popup anchor={btn.current} onClose={() => setOpen(false)}>
          {children()}
        </Popup>
      )}
    </>
  );
}

const WIDTH = 380;
const GAP = 6;

function Popup({ anchor, onClose, children }: { anchor: HTMLElement; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(WIDTH, vw - 16);
    const left = Math.max(8, Math.min(r.right - width, vw - width - 8));
    const below = vh - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    setStyle(below >= 220 || below >= above ? { left, width, top: r.bottom + GAP, maxHeight: below } : { left, width, bottom: vh - r.top + GAP, maxHeight: above });
  }, [anchor]);

  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && (ref.current?.contains(t) || anchor.contains(t));
    const down = (e: Event) => !inside(e.target) && onClose();
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor.focus();
      }
    };
    // scrolling the inspector would leave the popup behind
    const scroll = (e: Event) => !inside(e.target) && onClose();
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className="help-popup" role="dialog" style={style}>
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- docs loading

function useDocs<T>(load: () => Promise<T>): { docs?: T; error?: string } {
  const [state, setState] = useState<{ docs?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    load().then(
      (docs) => live && setState({ docs }),
      (e) => live && setState({ error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return state;
}

const useFilterDocs = () => useDocs(loadFilterDocs);
const useOptionDocs = () => useDocs(loadOptionDocs);

// ---------------------------------------------------------------- rendering

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

const OPENERS = [MARK.code[0], MARK.em[0], MARK.strong[0], MARK.link[0]] as string[];

/** Renders text with the inline markers of src/docs/texi.ts. */
export function DocText({ text }: { text: string }): ReactNode {
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest) {
    let at = -1;
    for (let i = 0; i < rest.length; i++) {
      if (OPENERS.includes(rest[i])) {
        at = i;
        break;
      }
    }
    if (at < 0) {
      out.push(rest);
      break;
    }
    if (at > 0) out.push(rest.slice(0, at));
    const open = rest[at];
    if (open === MARK.link[0]) {
      const mid = rest.indexOf(MARK.link[1], at);
      const end = rest.indexOf(MARK.link[2], mid);
      if (mid < 0 || end < 0) {
        out.push(rest.slice(at + 1));
        break;
      }
      out.push(
        <Link key={k++} href={rest.slice(mid + 1, end)}>
          <DocText text={rest.slice(at + 1, mid)} />
        </Link>,
      );
      rest = rest.slice(end + 1);
      continue;
    }
    const close = open === MARK.code[0] ? MARK.code[1] : open === MARK.em[0] ? MARK.em[1] : MARK.strong[1];
    let end = rest.indexOf(close, at);
    if (end < 0) end = rest.length;
    const inner = rest.slice(at + 1, end);
    if (open === MARK.code[0]) out.push(<code key={k++}>{inner}</code>);
    else if (open === MARK.em[0]) out.push(<em key={k++}><DocText text={inner} /></em>);
    else out.push(<strong key={k++}><DocText text={inner} /></strong>);
    rest = rest.slice(end + 1);
  }
  return <>{out}</>;
}

/** Term names are mostly option or value names: show them as code when they carry no markup. */
const Term = ({ text }: { text: string }) => (/[-]/.test(text) ? <DocText text={text} /> : <code>{text}</code>);

export function DocBlocks({ blocks }: { blocks: DocBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (typeof b === "string") return <p key={i}><DocText text={b} /></p>;
        switch (b[0]) {
          case "code":
            return <pre key={i}>{b[1]}</pre>;
          case "h":
            return <h5 key={i}>{b[1]}</h5>;
          case "ul":
            return (
              <ul key={i}>
                {b[1].map((item, j) => (
                  <li key={j}><DocBlocks blocks={item} /></li>
                ))}
              </ul>
            );
          case "dl":
            return (
              <dl key={i}>
                {b[1].map(([terms, body], j) => (
                  <div key={j} className="help-dl-row">
                    <dt>
                      {terms.map((t, n) => (
                        <span key={n}>
                          {n > 0 && ", "}
                          <Term text={t} />
                        </span>
                      ))}
                    </dt>
                    <dd><DocBlocks blocks={body} /></dd>
                  </div>
                ))}
              </dl>
            );
        }
      })}
    </>
  );
}

function Footer({ docs, url, label }: { docs?: { ffmpeg: string }; url: string; label: string }) {
  return (
    <div className="help-foot">
      <Link href={url}>{label} ↗</Link>
      {docs && <span className="muted">FFmpeg {docs.ffmpeg} docs</span>}
    </div>
  );
}

// ---------------------------------------------------------------- option help

/** What `ffmpeg -h filter=` says about an option (generic filters). */
function BinaryFacts({ o }: { o: HelpOption }) {
  const range = o.min !== undefined || o.max !== undefined ? `${o.min ?? "…"} to ${o.max ?? "…"}` : undefined;
  return (
    <div className="help-facts">
      <span>
        Type <code>{o.type}</code>
      </span>
      {o.default !== undefined && o.default !== "" && (
        <span>
          Default <code>{o.default}</code>
        </span>
      )}
      {range && (
        <span>
          Range <code>{range}</code>
        </span>
      )}
    </div>
  );
}

export function OptionHelp({ filter, option, binary }: { filter: string; option: string; binary?: HelpOption }) {
  const { docs, error } = useFilterDocs();
  const hit = docs ? optionDoc(docs, filter, option) : undefined;
  const names = hit?.option.names ?? [option, ...(binary?.aliases ?? [])];
  const own = docs ? filterDoc(docs, filter) : undefined;
  return (
    <>
      <div className="help-head">
        <code className="help-name">{option}</code>
        <span className="muted">
          {filter}
          {names.length > 1 && ` · also ${names.filter((n) => n !== option).join(", ")}`}
        </span>
      </div>
      {binary && <BinaryFacts o={binary} />}
      {!docs && !error && <p className="muted">Loading docs…</p>}
      {error && <p className="error-text">Could not load the docs: {error}</p>}
      {hit?.borrowed && <p className="muted">From the {hit.borrowed} docs ({filter} takes the same options).</p>}
      {hit && <DocBlocks blocks={hit.option.body} />}
      {docs && !hit && (
        <>
          {binary?.description ? <p>{binary.description}</p> : null}
          <p className="muted">The ffmpeg docs have no entry for this option.</p>
          {own && (
            <details className="help-examples">
              <summary>{filter} filter docs</summary>
              <FilterDocBody f={own} />
            </details>
          )}
        </>
      )}
      {docs && !hit && binary && binary.consts.length > 0 && (
        <dl>
          {binary.consts.map((c) => (
            <div key={c.name} className="help-dl-row">
              <dt><code>{c.name}</code></dt>
              <dd>{c.description}</dd>
            </div>
          ))}
        </dl>
      )}
      <Footer docs={docs} url={own ? filterDocUrl(own) : hit ? filterDocUrl(hit.filter) : FILTER_DOCS_URL} label={`${filter} docs`} />
    </>
  );
}

// ---------------------------------------------------------------- filter help

export function FilterHelpContent({ filter, fallback }: { filter: string; fallback?: string }) {
  const { docs, error } = useFilterDocs();
  const f = docs ? filterDoc(docs, filter) : undefined;
  return (
    <>
      <div className="help-head">
        <code className="help-name">{filter}</code>
        {f && f.names.length > 1 && <span className="muted">also {f.names.filter((n) => n !== filter).join(", ")}</span>}
      </div>
      {!docs && !error && <p className="muted">Loading docs…</p>}
      {error && <p className="error-text">Could not load the docs: {error}</p>}
      {docs && !f && (
        <>
          {fallback && <p>{fallback}</p>}
          <p className="muted">The ffmpeg docs have no section for this filter.</p>
        </>
      )}
      {f && <FilterDocBody f={f} />}
      <Footer docs={docs} url={f ? filterDocUrl(f) : FILTER_DOCS_URL} label={`${filter} docs`} />
    </>
  );
}

/** A filter section's summary, text and examples. */
function FilterDocBody({ f }: { f: FilterDoc }) {
  return (
    <>
      {f.summary && <p><DocText text={f.summary} /></p>}
      <DocBlocks blocks={f.body} />
      {f.examples && (
        <details className="help-examples">
          <summary>Examples</summary>
          <DocBlocks blocks={f.examples} />
        </details>
      )}
    </>
  );
}

// ---------------------------------------------------------------- encoder and ffmpeg options

const SOURCE_NOTE: Record<OptionHit["from"], string | undefined> = {
  encoder: undefined,
  codec: "A generic codec option, the same for all encoders and decoders.",
  cli: "An ffmpeg command-line option.",
  demuxer: "An option of the image sequence demuxer (image2).",
};
const SOURCE_LINK: Record<OptionHit["from"], string> = { encoder: "", codec: "Codec options", cli: "ffmpeg options", demuxer: "image2 demuxer" };

function LoadState({ docs, error }: { docs?: unknown; error?: string }) {
  if (error) return <p className="error-text">Could not load the docs: {error}</p>;
  return docs ? null : <p className="muted">Loading docs…</p>;
}

/** Name, usage, source note and text of an option found in the codec / encoder / ffmpeg docs. */
function OptionHitView({ name, option, context, hit, plain }: { name: string; option: string; context?: string; hit?: OptionHit; plain?: OptionHit["from"] }) {
  const also = hit?.option.names.filter((n) => n !== option) ?? [];
  return (
    <>
      <div className="help-head">
        <code className="help-name">{name}</code>
        {(context || also.length > 0) && (
          <span className="muted">
            {context}
            {context && also.length > 0 && " · "}
            {also.length > 0 && `also ${also.join(", ")}`}
          </span>
        )}
      </div>
      {hit?.option.usage && <div className="help-usage"><code>{hit.option.usage}</code></div>}
      {hit && hit.from !== plain && SOURCE_NOTE[hit.from] && <p className="muted">{SOURCE_NOTE[hit.from]}</p>}
      {hit && <DocBlocks blocks={hit.option.body} />}
      {hit && !hit.option.body.length && <p className="muted">The ffmpeg docs list this option without a description.</p>}
    </>
  );
}

/** An Encoder Parameters option: the encoder's docs, else the generic codec or ffmpeg options. */
export function EncoderOptionHelp({ codec, option }: { codec: string; option: string }) {
  const { docs, error } = useOptionDocs();
  const hit = docs ? encoderOptionDoc(docs, codec, option) : undefined;
  const enc = docs ? encoderDoc(docs, codec) : undefined;
  return (
    <>
      <OptionHitView name={option} option={option} context={codec} hit={hit} plain="encoder" />
      <LoadState docs={docs} error={error} />
      {docs && !hit && <p className="muted">The ffmpeg docs have no entry for this option.</p>}
      <Footer
        docs={docs}
        url={hit?.url ?? (enc ? encoderDocUrl(enc) : "https://ffmpeg.org/ffmpeg-codecs.html")}
        label={hit && hit.from !== "encoder" ? SOURCE_LINK[hit.from] : `${codec} docs`}
      />
    </>
  );
}

/** An ffmpeg command-line option such as -ss or -hwaccel. */
export function CliOptionHelp({ option, demuxer }: { option: string; demuxer?: string }) {
  const { docs, error } = useOptionDocs();
  const hit = docs ? cliOptionDoc(docs, option, demuxer) : undefined;
  return (
    <>
      <OptionHitView name={`-${option}`} option={option} hit={hit} plain="cli" />
      <LoadState docs={docs} error={error} />
      {docs && !hit && <p className="muted">The ffmpeg docs have no entry for this option.</p>}
      <Footer docs={docs} url={hit?.url ?? "https://ffmpeg.org/ffmpeg.html#Options"} label={hit ? SOURCE_LINK[hit.from] : "ffmpeg options"} />
    </>
  );
}

/** The encoder itself (header of the Encoder Parameters "Codec" section). */
export function EncoderHelpContent({ codec }: { codec: string }) {
  const { docs, error } = useOptionDocs();
  const e = docs ? encoderDoc(docs, codec) : undefined;
  return (
    <>
      <div className="help-head">
        <code className="help-name">{codec}</code>
        {e && e.names.length > 1 && <span className="muted">also {e.names.filter((n) => n !== codec).join(", ")}</span>}
      </div>
      <LoadState docs={docs} error={error} />
      {docs && !e && <p className="muted">The ffmpeg docs have no section for this encoder. Its options fall back to the generic codec options.</p>}
      {e && (
        <>
          {e.summary && <p><DocText text={e.summary} /></p>}
          <DocBlocks blocks={e.body} />
          {e.examples && (
            <details className="help-examples">
              <summary>Examples</summary>
              <DocBlocks blocks={e.examples} />
            </details>
          )}
        </>
      )}
      <Footer docs={docs} url={e ? encoderDocUrl(e) : "https://ffmpeg.org/ffmpeg-codecs.html"} label={`${codec} docs`} />
    </>
  );
}
