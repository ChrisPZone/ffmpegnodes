import { useReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Capabilities } from "../model/types";
import { useGraph } from "../store/graph";
import { readStored, storageKey } from "../store/storage";
import { allPaletteItems, createFromSpec, DEFAULT_OPEN, matchItems, paletteSections, type PaletteItem, type PaletteSpec } from "./paletteItems";

export { createFromSpec, type PaletteSpec } from "./paletteItems";

export const PALETTE_MIME = "application/x-ffmpegnodes-node";
const OPEN_KEY = storageKey("palette.open");

/** True when caps are known and this item's ffmpeg filter is not in the build. */
export function isMissing(it: PaletteItem, caps?: Capabilities): boolean {
  return !!(it.ffFilter && caps?.filters.length && !caps.filters.some((f) => f.name === it.ffFilter));
}

/** Curated nodes plus every other filter of the loaded ffmpeg build. */
export function usePaletteItems(): PaletteItem[] {
  const caps = useGraph((s) => s.caps);
  return useMemo(() => allPaletteItems(caps), [caps]);
}

function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(readStored(OPEN_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function ItemButton({
  it,
  missing,
  active,
  onPick,
  draggable = true,
}: {
  it: PaletteItem;
  missing: boolean;
  active?: boolean;
  onPick: () => void;
  draggable?: boolean;
}) {
  return (
    <button
      className={`palette-item ${it.media ? `media-${it.media}` : ""} ${missing ? "missing" : ""} ${active ? "active" : ""}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(PALETTE_MIME, JSON.stringify(it.spec));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onMouseDown={(e) => !draggable && e.preventDefault() /* keep focus in the search field */}
      onClick={onPick}
      title={`${it.description}${missing ? "\n\nNot in this ffmpeg build." : ""}${draggable ? "\n\nClick to add, or drag onto the canvas." : ""}`}
    >
      <span className="swatch" />
      <span className="palette-label">{it.label}</span>
      {it.hint && <small>{it.hint}</small>}
    </button>
  );
}

/** Arrow keys / Enter / Escape for a search field over a result list. */
export function useListKeys(results: PaletteItem[], onPick: (it: PaletteItem) => void, onEscape: () => void) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [results]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(results.length - 1, a + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === "Enter" && results[active]) (e.preventDefault(), onPick(results[active]));
    else if (e.key === "Escape") (e.preventDefault(), onEscape());
  };
  return { active, onKeyDown };
}

export function Palette() {
  const addNode = useGraph((s) => s.addNode);
  const caps = useGraph((s) => s.caps);
  const rf = useReactFlow();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);
  const listRef = useRef<HTMLDivElement>(null);
  const items = usePaletteItems();
  const sections = useMemo(() => paletteSections(items), [items]);
  const results = useMemo(() => (query.trim() ? matchItems(query, items).slice(0, 200) : []), [query, items]);

  const addAtCenter = (spec: PaletteSpec) => {
    const el = document.querySelector(".canvas")?.getBoundingClientRect();
    const jitter = () => Math.round((Math.random() - 0.5) * 60);
    const pos = el ? rf.screenToFlowPosition({ x: el.left + el.width / 2 - 90 + jitter(), y: el.top + el.height / 2 - 40 + jitter() }) : { x: 0, y: 0 };
    addNode(createFromSpec(spec), pos);
  };
  const { active, onKeyDown } = useListKeys(
    results,
    (it) => addAtCenter(it.spec),
    () => setQuery(""),
  );
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const isOpen = (id: string) => open[id] ?? DEFAULT_OPEN.has(id);
  const toggle = (id: string) => {
    const next = { ...open, [id]: !isOpen(id) };
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: state just isn't remembered */
    }
  };

  return (
    <aside className="palette">
      <input
        className="palette-search"
        type="search"
        placeholder={`Search ${items.length} nodes…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Search nodes"
      />
      <div ref={listRef}>
        {query.trim() ? (
          results.length ? (
            results.map((it, i) => <ItemButton key={it.key} it={it} missing={isMissing(it, caps)} active={i === active} onPick={() => addAtCenter(it.spec)} />)
          ) : (
            <p className="muted small">No node matches “{query}”.</p>
          )
        ) : (
          sections.map((s) => (
            <section key={s.id}>
              {s.heading && <h4>{s.heading}</h4>}
              <div className={`pad-group palette-group ${isOpen(s.id) ? "open" : ""}`}>
                <button className="pad-group-header" onClick={() => toggle(s.id)} aria-expanded={isOpen(s.id)}>
                  <span className="pad-group-caret">{isOpen(s.id) ? "▾" : "▸"}</span>
                  <span className="pad-group-title">{s.title}</span>
                  <span className="pad-group-count">{s.items.length}</span>
                </button>
                {isOpen(s.id) &&
                  s.items.map((it) => <ItemButton key={it.key} it={it} missing={isMissing(it, caps)} onPick={() => addAtCenter(it.spec)} />)}
              </div>
            </section>
          ))
        )}
      </div>
      <p className="legend">
        Tab or double-click the canvas to quick-add; drop a wire on empty canvas to add a connected node. Ctrl+D duplicates the selected nodes.
      </p>
    </aside>
  );
}
