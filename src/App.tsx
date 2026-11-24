import { ReactFlowProvider } from "@xyflow/react";
import { Inspector } from "./inspector/Inspector";
import { newEncoderData, newEncoderParamsData, newInputData, newMuxerData, PARAMS_PAD } from "./nodes/defs";
import { restoreAutosave, startAutosave, useGraph } from "./store/graph";
import { BottomDock } from "./ui/BottomDock";
import { Canvas } from "./ui/Canvas";
import { DerivedProvider } from "./ui/derived";
import { JobPanels } from "./ui/JobPanels";
import { installCloseGuard } from "./ui/run";
import { Palette } from "./ui/palette";
import { Toolbar } from "./ui/Toolbar";

/** Runs once before the first render so React Flow's fitView sees the nodes. */
export function initApp() {
  if (!restoreAutosave()) starterGraph();
  void useGraph.getState().loadCaps();
  startAutosave();
  installCloseGuard();
}

function starterGraph() {
  const { addNode, onConnect, select } = useGraph.getState();
  addNode(newInputData(), { x: 0, y: 140 });
  for (const [media, y] of [["video", 0], ["audio", 260]] as const) {
    const p = addNode(newEncoderParamsData(media), { x: 300, y: y - 120 });
    const e = addNode(newEncoderData(media), { x: 580, y }, { withParams: false });
    onConnect({ source: p, sourceHandle: PARAMS_PAD, target: e, targetHandle: PARAMS_PAD });
  }
  addNode(newMuxerData(), { x: 880, y: 120 });
  select(undefined);
}

export function App() {
  const toast = useGraph((s) => s.toast);
  return (
    <ReactFlowProvider>
      <DerivedProvider>
        <div className="app">
          <Toolbar />
          <div className="main">
            <Palette />
            <div className="center">
              <Canvas />
              <BottomDock />
            </div>
            <Inspector />
          </div>
          <JobPanels />
          {toast && <div className="toast">{toast}</div>}
        </div>
      </DerivedProvider>
    </ReactFlowProvider>
  );
}
