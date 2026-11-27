import { addEdge, type Connection, type Edge, type EdgeChangeset, type Node, type NodeChangeset } from "@xyflow/react";
import { create } from "zustand";
import * as ipc from "../ipc/ffmpeg";
import type { Settings } from "../ipc/ffmpeg";
import { PROJECT_VERSION, type Capabilities, type FilterNodeData, type GNode, type GpuInfo, type Graph, type InputNodeData, type NodeData, type ProjectFile, type QuickFix } from "../model/types";
import { findPad, newEncoderParamsData, newInputData, normalizeMuxerSlots, PARAMS_PAD } from "../nodes/defs";
import { parseFilterHelp, type FilterHelp } from "../nodes/defs/generic";
import { letterboxOptions, letterboxSource } from "../model/letterbox";
import { detectSequence, inputDemuxArgs, isImageFile, isSequencePattern, sequenceFromPattern, splitPath, type SequenceInfo } from "../model/sequence";
import { checkConnection } from "../validation/connections";
import { duplicateNodes } from "./duplicate";
import { readStored, storageKey } from "./storage";
import type { OutStreamInfo, ProgressInfo } from "../ui/jobInfo";
import type { JobDevices } from "../model/devices";

export type AppNode = Node<NodeData>;

export interface JobState extends Partial<Omit<ProgressInfo, "progress">> {
  id: string;
  /** Short number shown in the UI ("Job 2"). */
  seq: number;
  running: boolean;
  /** Stop was clicked; ffmpeg is finishing the file. */
  stopping?: boolean;
  progress: number; // 0..1, NaN when unknown
  /** Expected output duration in seconds. */
  duration?: number;
  /** Input and output paths as they were when the job started. */
  inputs: string[];
  outputs: string[];
  /** Where the work runs (from the graph at start). */
  devices?: JobDevices;
  /** Output streams as ffmpeg reported them on stderr. */
  streams: OutStreamInfo[];
  log: string[];
  result?: "success" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  minimized?: boolean;
  /** Stacking order of the popup; the highest is in front. */
  z: number;
}

interface State {
  nodes: AppNode[];
  edges: Edge[];
  selectedId?: string;
  caps?: Capabilities;
  capsError?: string;
  settings: Settings;
  projectPath?: string;
  /** Jobs in start order; finished ones stay until their popup is closed. */
  jobs: JobState[];
  /** Job whose log the dock shows (defaults to the newest). */
  logJobId?: string;
  /** Bumped when a popup asks the dock to show its log. */
  logNonce: number;
  toast?: string;
  /** Bumped when the whole graph is replaced; the canvas re-fits the view. */
  fitNonce: number;

  onNodesChange: (c: NodeChangeset<AppNode>) => void;
  onEdgesChange: (c: EdgeChangeset) => void;
  onConnect: (c: Connection) => void;
  /**
   * Adds a node (selected). An encoder also gets a new parameters node wired to it,
   * unless `withParams` is false. Returns the id of `data`'s node.
   */
  addNode: (data: NodeData, position: { x: number; y: number }, opts?: { withParams?: boolean }) => string;
  /** Duplicates the selected nodes (or `ids`) with all settings; the copies become the selection. Returns their ids. */
  duplicate: (opts?: { withInputs?: boolean; ids?: string[] }) => string[];
  /** Deletes nodes and their wires. */
  removeNodes: (ids: string[]) => void;
  updateData: (id: string, patch: Partial<NodeData> | ((d: NodeData) => NodeData)) => void;
  select: (id?: string) => void;
  applyFix: (fix: QuickFix) => void;
  probeInput: (id: string) => Promise<void>;
  loadCaps: () => Promise<void>;
  /** Measures the black bars for a Remove-letterbox node and writes them into its params. */
  detectLetterbox: (id: string) => Promise<void>;
  /** Reads `ffmpeg -h filter=<name>` for a generic filter node that has no options yet. */
  loadFilterHelp: (id: string) => Promise<void>;
  /** NVIDIA GPUs (CUDA order). Loaded lazily the first time a GPU picker is shown. */
  gpus?: GpuInfo[];
  gpusState?: "loading" | "ok" | "error";
  gpusError?: string;
  loadGpus: (force?: boolean) => Promise<void>;
  setSettings: (s: Settings) => void;
  /** Changes only the canvas zoom step (no ffmpeg reload). */
  setZoomStep: (percent: number) => void;
  setGraph: (g: Graph, projectPath?: string) => void;
  addJob: (job: JobState) => void;
  updateJob: (id: string, fn: (j: JobState) => Partial<JobState>) => void;
  removeJob: (id: string) => void;
  /** Brings a job's popup to the front (and restores it when minimized). */
  focusJob: (id: string) => void;
  setLogJob: (id?: string) => void;
  showToast: (msg?: string) => void;
}

const SETTINGS_KEY = storageKey("settings");
function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
const topZ = (jobs: JobState[]) => jobs.reduce((m, j) => Math.max(m, j.z), 0);
/** Parsed filter help per ffmpeg path + filter name, shared by all nodes of a session. */
const helpCache = new Map<string, Promise<FilterHelp>>();
const AUTOSAVE_KEY = storageKey("autosave");

/**
 * Where a window autosaves: the main window in localStorage (restored after a restart), windows
 * opened with "New window" in their own sessionStorage, so windows don't overwrite each other.
 */
export function autosaveStore(search: string): "local" | "session" {
  return new URLSearchParams(search).get("window") === "new" ? "session" : "local";
}
function autosaveStorage(): Storage {
  return autosaveStore(location.search) === "session" ? sessionStorage : localStorage;
}

function loadJSON<T>(key: string): T | undefined {
  try {
    const v = readStored(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep edges and dynamic pads consistent: drop edges to pads that no longer exist,
 * keep one edge per input pad, and normalize muxer slots.
 */
export function reconcile(nodes: AppNode[], edges: Edge[]): { nodes: AppNode[]; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seenTarget = new Set<string>();
  const kept: Edge[] = [];
  for (const e of [...edges].reverse()) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!findPad(s as GNode | undefined, e.sourceHandle, "source") || !findPad(t as GNode | undefined, e.targetHandle, "target")) continue;
    const k = `${e.target}|${e.targetHandle}`;
    if (seenTarget.has(k)) continue; // later edge wins
    seenTarget.add(k);
    kept.unshift(e);
  }
  let changed = false;
  const nextNodes = nodes.map((n) => {
    if (n.data.kind !== "muxer") return n;
    const d = normalizeMuxerSlots(n.data, n.id, kept);
    if (!d) return n;
    changed = true;
    return { ...n, data: d };
  });
  return { nodes: changed ? nextNodes : nodes, edges: kept.length === edges.length && kept.every((e, i) => e === edges[i]) ? edges : kept };
}

let idCounter = Date.now() % 100000;
export const newId = (kind: string) => `${kind}-${(idCounter++).toString(36)}`;

export const useGraph = create<State>((set, get) => ({
  nodes: [],
  edges: [],
  fitNonce: 0,
  jobs: [],
  logNonce: 0,
  settings: loadJSON<Settings>(SETTINGS_KEY) ?? { ffmpegPath: "", ffprobePath: "" },

  onNodesChange: (changes) => {
    const nodes = changes.applyTo(get().nodes);
    const removed = changes.getByType("remove").length > 0;
    const selects = changes.getByType("select");
    const sel = selects.find((c) => c.selected);
    const desel = selects.find((c) => !c.selected && c.id === get().selectedId);
    const selectedId = sel ? sel.id : desel ? undefined : get().selectedId;
    if (removed) set({ ...reconcile(nodes, get().edges), selectedId: nodes.some((n) => n.id === selectedId) ? selectedId : undefined });
    else set({ nodes, selectedId });
  },

  onEdgesChange: (changes) => {
    const edges = changes.applyTo(get().edges);
    set(reconcile(get().nodes, edges));
  },

  onConnect: (c) => {
    const { nodes, edges } = get();
    const check = checkConnection({ nodes: nodes as GNode[], edges }, c);
    if (!check.ok) {
      if (check.reason) get().showToast(check.reason);
      return;
    }
    // An input pad takes one connection: replace whatever was there.
    const others = edges.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle));
    const next = addEdge({ ...c, id: `e-${c.source}.${c.sourceHandle}-${c.target}.${c.targetHandle}` }, others);
    set(reconcile(nodes, next));
  },

  addNode: (data, position, opts) => {
    const id = newId(data.kind);
    const nodes: AppNode[] = [...get().nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), { id, type: `ff-${data.kind}`, position, data, selected: true }];
    let edges = get().edges;
    if (data.kind === "encoder" && opts?.withParams !== false) {
      // every encoder starts with its own settings node, up-left of it
      const pid = newId("encparams");
      nodes.push({ id: pid, type: "ff-encparams", position: { x: position.x - 250, y: position.y - 60 }, data: newEncoderParamsData(data.media) });
      edges = [...edges, { id: `e-${pid}.${PARAMS_PAD}-${id}.${PARAMS_PAD}`, source: pid, sourceHandle: PARAMS_PAD, target: id, targetHandle: PARAMS_PAD }];
    }
    set({ nodes, edges, selectedId: id });
    return id;
  },

  duplicate: (opts) => {
    const { nodes, edges, selectedId } = get();
    const ids = opts?.ids ?? (nodes.some((n) => n.selected) ? nodes.filter((n) => n.selected).map((n) => n.id) : selectedId ? [selectedId] : []);
    if (!ids.length) return [];
    const r = duplicateNodes(nodes, edges, ids, { withInputs: opts?.withInputs, newId });
    const copies = r.nodes.map((n) => ({ ...n, selected: true }));
    const next = [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...copies];
    set({ ...reconcile(next, [...edges, ...(r.edges as Edge[])]), selectedId: r.newIds[0] });
    return r.newIds;
  },

  removeNodes: (ids) => {
    const nodes = get().nodes.filter((n) => !ids.includes(n.id));
    const edges = get().edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target));
    set({ ...reconcile(nodes, edges), selectedId: ids.includes(get().selectedId ?? "") ? undefined : get().selectedId });
  },

  updateData: (id, patch) => {
    const nodes = get().nodes.map((n) => {
      if (n.id !== id) return n;
      const data = typeof patch === "function" ? patch(n.data) : ({ ...n.data, ...patch } as NodeData);
      return { ...n, data };
    });
    set(reconcile(nodes, get().edges));
  },

  select: (id) => set({ selectedId: id, nodes: get().nodes.map((n) => ({ ...n, selected: n.id === id })) }),

  applyFix: (fix) => get().updateData(fix.nodeId, fix.patch as Partial<NodeData>),

  probeInput: async (id) => {
    const node = get().nodes.find((n) => n.id === id);
    if (!node || node.data.kind !== "input") return;
    const path = node.data.path.trim();
    if (!path) {
      get().updateData(id, { probe: undefined, probeError: undefined, probing: false } as Partial<InputNodeData>);
      return;
    }
    get().updateData(id, { probing: true, probeError: undefined } as Partial<InputNodeData>);
    try {
      const probe = await ipc.probeFile(path, get().settings, inputDemuxArgs(node.data.options));
      get().updateData(id, (d) => (d.kind === "input" && d.path.trim() === path ? { ...d, probe, probing: false, probeError: undefined } : d));
    } catch (e) {
      get().updateData(id, (d) => (d.kind === "input" && d.path.trim() === path ? { ...d, probe: undefined, probing: false, probeError: String(e) } : d));
    }
  },

  loadCaps: async () => {
    try {
      set({ caps: await ipc.getCapabilities(get().settings), capsError: undefined });
    } catch (e) {
      set({ caps: undefined, capsError: String(e) });
    }
  },

  detectLetterbox: async (id) => {
    const node = get().nodes.find((n) => n.id === id);
    if (node?.data.kind !== "filter" || node.data.letterbox?.running) return;
    const setState = (st: FilterNodeData["letterbox"], params?: Record<string, number>) =>
      get().updateData(id, (d) => (d.kind === "filter" ? { ...d, letterbox: st, params: params ? { ...d.params, ...params } : d.params } : d));
    const src = letterboxSource({ nodes: get().nodes as GNode[], edges: get().edges }, id);
    const path = src?.input.data.path.trim() ?? "";
    const duration = Number(src?.stream?.duration ?? src?.input.data.probe?.format.duration);
    const width = src?.stream?.width ?? 0;
    const height = src?.stream?.height ?? 0;
    if (!src || !path || !width || !height) {
      setState({ error: "Connect a probed video stream from an Input first." });
      return;
    }
    setState({ ...node.data.letterbox, running: true, error: undefined });
    try {
      const r = await ipc.detectLetterbox({ path, inputArgs: inputDemuxArgs(src.input.data.options), duration, width, height, options: letterboxOptions(node.data.params) }, get().settings);
      setState({ path, height: r.height, usable: r.usable, sampled: r.sampled, warning: r.warning ?? undefined }, { top: r.top, bottom: r.bottom });
    } catch (e) {
      setState({ error: String(e) });
    }
  },

  loadFilterHelp: async (id) => {
    const node = get().nodes.find((n) => n.id === id);
    const spec = node?.data.kind === "filter" ? node.data.generic : undefined;
    if (!spec || spec.help || spec.error) return;
    const name = spec.name;
    const k = `${get().settings.ffmpegPath}|${name}`;
    let p = helpCache.get(k);
    if (!p) {
      p = ipc.filterHelp(name, get().settings).then(parseFilterHelp);
      helpCache.set(k, p);
      p.catch(() => helpCache.delete(k)); // retry on the next node
    }
    const apply = (patch: { help?: FilterHelp; error?: string }) =>
      get().updateData(id, (d) => (d.kind === "filter" && d.generic?.name === name && !d.generic.help ? { ...d, generic: { ...d.generic, ...patch } } : d));
    try {
      apply({ help: await p, error: undefined });
    } catch (e) {
      apply({ error: String(e) });
    }
  },

  loadGpus: async (force) => {
    const st = get().gpusState;
    if (!force && (st === "loading" || st === "ok")) return;
    set({ gpusState: "loading" });
    if (!get().caps) await get().loadCaps();
    const encoder = get().caps?.encoders.find((e) => /_nvenc$/.test(e.name))?.name;
    if (!encoder) {
      set({ gpus: undefined, gpusState: "error", gpusError: "This ffmpeg build has no NVIDIA (nvenc) encoder." });
      return;
    }
    try {
      set({ gpus: await ipc.listGpus(encoder, get().settings), gpusState: "ok", gpusError: undefined });
    } catch (e) {
      set({ gpus: undefined, gpusState: "error", gpusError: String(e) });
    }
  },

  setSettings: (settings) => {
    set({ settings, gpus: undefined, gpusState: undefined });
    saveSettings(settings);
    void get().loadCaps();
  },

  setZoomStep: (zoomStep) => {
    const settings = { ...get().settings, zoomStep };
    set({ settings });
    saveSettings(settings);
  },

  setGraph: (g, projectPath) => {
    const nodes: AppNode[] = g.nodes.map((n) => ({ id: n.id, type: `ff-${n.data.kind}`, position: n.position, data: n.data }));
    set({ ...reconcile(nodes, g.edges.map((e) => ({ ...e }))), selectedId: undefined, projectPath, fitNonce: get().fitNonce + 1 });
  },

  addJob: (job) => set({ jobs: [...get().jobs, { ...job, z: topZ(get().jobs) + 1 }], logJobId: job.id, logNonce: get().logNonce + 1 }),
  updateJob: (id, fn) => set({ jobs: get().jobs.map((j) => (j.id === id ? { ...j, ...fn(j) } : j)) }),
  removeJob: (id) => {
    const { jobs, logJobId } = get();
    if (jobs.find((j) => j.id === id)?.running) return;
    set({ jobs: jobs.filter((j) => j.id !== id), logJobId: logJobId === id ? undefined : logJobId });
  },
  focusJob: (id) => {
    const jobs = get().jobs;
    const j = jobs.find((x) => x.id === id);
    if (!j || (!j.minimized && j.z === topZ(jobs))) return;
    set({ jobs: jobs.map((x) => (x.id === id ? { ...x, minimized: false, z: topZ(jobs) + 1 } : x)) });
  },
  setLogJob: (logJobId) => set({ logJobId, logNonce: get().logNonce + 1 }),

  showToast: (toast) => {
    set({ toast });
    if (toast) setTimeout(() => get().toast === toast && set({ toast: undefined }), 3500);
  },
}));

// ---------------------------------------------------------------- project files

/**
 * The image sequence an Input path belongs to: for a numbered image file, the sequence around
 * it; for a pattern (`shot_%04d.exr`), the files it names. Null when there is none.
 */
export async function scanSequence(path: string): Promise<SequenceInfo | null> {
  const { dir, name } = splitPath(path.trim());
  const pattern = isSequencePattern(name);
  if (!name || (!pattern && !isImageFile(name))) return null;
  const entries = await ipc.listDir(dir || ".");
  return pattern ? sequenceFromPattern(name, entries) : detectSequence(name, entries);
}

export function toProject(nodes: AppNode[], edges: Edge[]): ProjectFile {
  return {
    app: "ffmpegnodes",
    version: PROJECT_VERSION,
    nodes: nodes.map((n) => {
      const data = { ...n.data } as Record<string, unknown>;
      delete data.probing;
      return { id: n.id, position: n.position, data: data as unknown as NodeData };
    }),
    edges: edges.map(({ id, source, sourceHandle, target, targetHandle }) => ({ id, source, sourceHandle, target, targetHandle })),
  };
}

export function parseProject(text: string): ProjectFile {
  const p = JSON.parse(text) as ProjectFile;
  const known = p.app === "ffmpegnodes" || p.app === "ffmpeg-node-gui"; // the latter: saved before the rename
  if (!known || !Array.isArray(p.nodes) || !Array.isArray(p.edges)) throw new Error("Not an ffmpegnodes graph file.");
  if (p.version > PROJECT_VERSION) throw new Error(`Project version ${p.version} is newer than this app supports.`);
  // fill in options added after a file was saved
  const defaults = newInputData("").options;
  for (const n of p.nodes) {
    if (n.data?.kind === "input") n.data = { ...n.data, options: { ...defaults, ...n.data.options } };
  }
  return p;
}

export function startAutosave() {
  let t: ReturnType<typeof setTimeout> | undefined;
  return useGraph.subscribe((s, prev) => {
    if (s.nodes === prev.nodes && s.edges === prev.edges) return;
    clearTimeout(t);
    t = setTimeout(() => {
      try {
        autosaveStorage().setItem(AUTOSAVE_KEY, JSON.stringify(toProject(s.nodes, s.edges)));
      } catch {
        /* ignore */
      }
    }, 500);
  });
}

export function restoreAutosave(): boolean {
  const text = (() => {
    try {
      // readStored also reads the pre-rename key; only the main window used that one
      return autosaveStore(location.search) === "session" ? sessionStorage.getItem(AUTOSAVE_KEY) : readStored(AUTOSAVE_KEY);
    } catch {
      return null;
    }
  })();
  if (!text) return false;
  try {
    useGraph.getState().setGraph(parseProject(text));
    return true;
  } catch {
    return false;
  }
}


