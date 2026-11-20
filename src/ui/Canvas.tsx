import { Background, Controls, MiniMap, ReactFlow, useReactFlow, type Connection, type Edge, type FinalConnectionState } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { GNode } from "../model/types";
import { findPad, nodeMedia } from "../nodes/defs";
import { nodeTypes } from "../nodes/ui/nodes";
import { useGraph } from "../store/graph";
import { checkConnection } from "../validation/connections";
import { useDerived } from "./derived";
import { PALETTE_MIME } from "./palette";
import { createFromSpec, type PaletteSpec } from "./paletteItems";
import { QuickAdd, type QuickAddRequest } from "./QuickAdd";
import { edgeTypes, type PipeEdge } from "./PipeEdge";
import { MAX_ZOOM, MIN_ZOOM, wheelNotches, zoomAt } from "./wheelZoom";

export function Canvas() {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const onNodesChange = useGraph((s) => s.onNodesChange);
  const onEdgesChange = useGraph((s) => s.onEdgesChange);
  const onConnect = useGraph((s) => s.onConnect);
  const addNode = useGraph((s) => s.addNode);
  const duplicate = useGraph((s) => s.duplicate);
  const removeNodes = useGraph((s) => s.removeNodes);
  const { neg, byEdge } = useDerived();
  const rf = useReactFlow();
  const fitNonce = useGraph((s) => s.fitNonce);
  useEffect(() => {
    if (!fitNonce) return;
    // wait until every new node has been measured (large graphs take more than one frame)
    let t: ReturnType<typeof setTimeout>;
    let tries = 0;
    const fit = () => {
      const nodes = rf.getNodes();
      if (tries++ < 40 && nodes.some((n) => !rf.getInternalNode(n.id)?.measured?.width)) t = setTimeout(fit, 25);
      else void rf.fitView({ maxZoom: 1, padding: 0.15 });
    };
    t = setTimeout(fit, 30);
    return () => clearTimeout(t);
  }, [fitNonce, rf]);

  const styledEdges = useMemo<PipeEdge[]>(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges.map((e) => {
      const pad = findPad(byId.get(e.source) as GNode | undefined, e.sourceHandle, "source");
      const info = neg.edges.get(e.id);
      const sev = byEdge.get(e.id)?.some((d) => d.severity === "error") ? "error" : byEdge.get(e.id)?.length ? "warning" : undefined;
      return {
        ...e,
        type: "pipe" as const,
        data: { media: pad?.type.media ?? "any", domain: pad?.type.domain ?? "frames", label: info?.label, conversion: info?.conversion, severity: sev },
      };
    });
  }, [nodes, edges, neg, byEdge]);

  const isValidConnection = useCallback(
    (c: Connection | Edge) => checkConnection({ nodes: useGraph.getState().nodes as GNode[], edges: useGraph.getState().edges }, c).ok,
    [],
  );

  // ---- quick-add popup
  const wrapRef = useRef<HTMLDivElement>(null);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const [quick, setQuick] = useState<QuickAddRequest | null>(null);
  const closeQuick = useCallback(() => setQuick(null), []);
  const openQuick = useCallback(
    (clientX: number, clientY: number, from?: QuickAddRequest["from"]) => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      // keep the popup inside the canvas
      const at = { x: Math.max(4, Math.min(clientX - r.left, r.width - 264)), y: Math.max(4, Math.min(clientY - r.top, r.height - 340)) };
      setQuick({ at, flow: rf.screenToFlowPosition({ x: clientX, y: clientY }), from });
    },
    [rf],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, select, [contenteditable]");
      // Ctrl/Cmd+D duplicates the selected nodes, +Shift also copies the wires feeding them
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "d" && !typing && !quick) {
        e.preventDefault();
        duplicate({ withInputs: e.shiftKey });
        return;
      }
      if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey || quick) return;
      if (t && (typing || t.closest(".inspector, .palette"))) return;
      const m = mouse.current;
      if (!m) return;
      e.preventDefault();
      openQuick(m.x, m.y);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openQuick, quick, duplicate]);

  // ---- mouse-wheel zoom: a fixed step per notch (Settings → Zoom speed)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      const flow = t?.closest(".react-flow") as HTMLElement | null;
      // the minimap and controls handle their own wheel; .nowheel marks scrollable parts of nodes
      if (!flow || t?.closest(".react-flow__minimap, .react-flow__panel, .nowheel")) return;
      e.preventDefault();
      e.stopPropagation();
      const r = flow.getBoundingClientRect();
      const step = useGraph.getState().settings.zoomStep ?? 0;
      void rf.setViewport(zoomAt(rf.getViewport(), wheelNotches(e.deltaY, e.deltaMode), step, e.clientX - r.left, e.clientY - r.top));
    };
    // capture + non-passive: runs before React Flow's handler and may cancel page scrolling
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [rf]);

  // ---- node context menu
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const onNodeContextMenu = useCallback((ev: ReactMouseEvent, node: { id: string; selected?: boolean }) => {
    ev.preventDefault();
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    // a right-click on a selected node acts on the whole selection
    const sel = useGraph.getState().nodes.filter((n) => n.selected).map((n) => n.id);
    const ids = node.selected && sel.includes(node.id) ? sel : [node.id];
    setMenu({ x: Math.min(ev.clientX - r.left, r.width - 200), y: Math.min(ev.clientY - r.top, r.height - 120), ids });
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof PointerEvent && (e.target as HTMLElement | null)?.closest(".node-menu")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);
  const menuAction = (fn: () => void) => () => {
    fn();
    setMenu(null);
  };

  const onConnectEnd = useCallback(
    (ev: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode || !state.fromHandle?.id) return;
      if (!(ev.target as HTMLElement | null)?.classList.contains("react-flow__pane")) return;
      const side = state.fromHandle.type;
      const node = useGraph.getState().nodes.find((n) => n.id === state.fromNode!.id) as GNode | undefined;
      const pad = findPad(node, state.fromHandle.id, side);
      if (!pad) return;
      const p = "changedTouches" in ev ? ev.changedTouches[0] : ev;
      openQuick(p.clientX, p.clientY, { nodeId: state.fromNode.id, handleId: state.fromHandle.id, side, type: pad.type });
    },
    [openQuick],
  );

  const onDrop = useCallback(
    (ev: DragEvent) => {
      const raw = ev.dataTransfer.getData(PALETTE_MIME);
      if (!raw) return;
      ev.preventDefault();
      const spec = JSON.parse(raw) as PaletteSpec;
      addNode(createFromSpec(spec), rf.screenToFlowPosition({ x: ev.clientX - 90, y: ev.clientY - 20 }));
    },
    [addNode, rf],
  );

  return (
    <div
      ref={wrapRef}
      className="canvas"
      onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = "copy"))}
      onDrop={onDrop}
      onMouseMove={(e) => (mouse.current = { x: e.clientX, y: e.clientY })}
      onMouseLeave={() => (mouse.current = null)}
      onDoubleClick={(e) => (e.target as HTMLElement).classList.contains("react-flow__pane") && openQuick(e.clientX, e.clientY)}
    >
      {quick && <QuickAdd req={quick} onClose={closeQuick} />}
      {menu && (
        <div className="node-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button role="menuitem" onClick={menuAction(() => duplicate({ ids: menu.ids }))}>
            Duplicate{menu.ids.length > 1 ? ` ${menu.ids.length} nodes` : ""} <kbd>Ctrl+D</kbd>
          </button>
          <button role="menuitem" onClick={menuAction(() => duplicate({ ids: menu.ids, withInputs: true }))}>
            Duplicate with inputs <kbd>Ctrl+Shift+D</kbd>
          </button>
          <button role="menuitem" className="danger" onClick={menuAction(() => removeNodes(menu.ids))}>
            Delete <kbd>Del</kbd>
          </button>
        </div>
      )}
      <ReactFlow
        onConnectEnd={onConnectEnd}
        onNodeContextMenu={onNodeContextMenu}
        zoomOnDoubleClick={false}
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange as never}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        deleteKeyCode={["Delete", "Backspace"]}
        colorMode="dark"
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls />
        <MiniMap pannable zoomable nodeColor={(n) => `var(--media-${nodeMedia((n as unknown as GNode).data) ?? "neutral"})`} />
      </ReactFlow>
    </div>
  );
}
