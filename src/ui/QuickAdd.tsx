// Search popup at the cursor: Tab / double-click on the canvas, or a wire dropped on empty canvas
// (then only nodes that can take that wire are listed, and the new node is connected).
import { useEffect, useMemo, useRef, useState } from "react";
import { useGraph } from "../store/graph";
import { ItemButton, isMissing, useListKeys, usePaletteItems } from "./palette";
import { createFromSpec, matchingPad, matchItems, type DragFrom, type PaletteItem } from "./paletteItems";

export interface QuickAddRequest {
  /** Position inside the canvas element (px) for the popup. */
  at: { x: number; y: number };
  /** Flow position for the new node. */
  flow: { x: number; y: number };
  from?: DragFrom & { nodeId: string; handleId: string };
}

const MAX_RESULTS = 14;

export function QuickAdd({ req, onClose }: { req: QuickAddRequest; onClose: () => void }) {
  const addNode = useGraph((s) => s.addNode);
  const onConnect = useGraph((s) => s.onConnect);
  const caps = useGraph((s) => s.caps);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const items = usePaletteItems();
  const candidates = useMemo(() => {
    const from = req.from;
    if (!from) return items;
    const fits = items.filter((it) => matchingPad(it.spec, from) !== undefined);
    // nodes of the wire's own media first (an audio wire lists audio filters before Concat)
    return [...fits.filter((it) => it.media === from.type.media), ...fits.filter((it) => it.media !== from.type.media)];
  }, [req.from, items]);
  const results = useMemo(() => matchItems(query, candidates).slice(0, MAX_RESULTS), [query, candidates]);

  const pick = (it: PaletteItem) => {
    const from = req.from;
    // wires from an output grow to the right, wires from an input to the left
    const pos = from?.side === "target" ? { x: req.flow.x - 220, y: req.flow.y - 20 } : { x: req.flow.x, y: req.flow.y - 20 };
    // a wire from a parameters node is the encoder's settings: don't add another one
    const id = addNode(createFromSpec(it.spec), pos, { withParams: from?.type.domain !== "params" });
    const pad = from && matchingPad(it.spec, from);
    if (from && pad) {
      onConnect(
        from.side === "source"
          ? { source: from.nodeId, sourceHandle: from.handleId, target: id, targetHandle: pad }
          : { source: id, sourceHandle: pad, target: from.nodeId, targetHandle: from.handleId },
      );
    }
    onClose();
  };
  const { active, onKeyDown } = useListKeys(results, pick, onClose);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    boxRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [onClose]);

  return (
    <div ref={boxRef} className="quick-add" style={{ left: req.at.x, top: req.at.y }} onKeyDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        type="search"
        placeholder={req.from ? `Add node for this ${req.from.type.media === "any" ? "" : `${req.from.type.media} `}${req.from.type.domain}…` : "Add node…"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Search nodes to add"
      />
      <div className="quick-add-list">
        {results.length ? (
          results.map((it, i) => <ItemButton key={it.key} it={it} missing={isMissing(it, caps)} active={i === active} draggable={false} onPick={() => pick(it)} />)
        ) : (
          <p className="muted small">{candidates.length ? `No node matches “${query}”.` : "No node can take this connection."}</p>
        )}
      </div>
    </div>
  );
}
