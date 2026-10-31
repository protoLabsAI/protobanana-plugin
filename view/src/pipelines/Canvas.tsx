import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { fetchHistoryImage, subscribe, type CatalogEntry } from "../api";
import { MIN_ABS, MAX_ABS } from "../zoom";
import {
  Badge,
  Button,
  Callout,
  Empty,
  FitIcon,
  FormField,
  FullscreenIcon,
  ImagesIcon,
  Input,
  Menu,
  MenuItem,
  Popover,
  Segmented,
  SlidersIcon,
  Spinner,
  Switch,
  Textarea,
  Tooltip,
  ZoomInIcon,
  ZoomOutIcon,
  useToast,
} from "../ds-pending";
import {
  BUS,
  CANVAS_KEYBINDINGS,
  OUT_HANDLE,
  REF_PORTS,
  autoLayout,
  connectionAllowed,
  getLastOpen,
  graphToSpec,
  inputNodeId,
  isParamHandle,
  listPipelines,
  loadLocalSpec,
  makeOpNode,
  newNodeId,
  nodeOutputType,
  paramHandle,
  paramOfHandle,
  paramPortType,
  parseSpecText,
  registerKeybindings,
  resumeRun,
  runPipeline,
  savePipeline,
  saveLocalSpec,
  scalarParams,
  slugifyId,
  specToGraph,
  getRun,
  setLastOpen,
  type GEdge,
  type GNode,
  type InputNodeData,
  type NodeData,
  type OpNodeData,
  type PipelineSummary,
  type PortType,
  type RunNode,
  type Spec,
  type SpecMeta,
} from "./pipelines";

// Aspect presets, mirrored from Composer.tsx so the inspector options popover
// looks identical to the Playground composer (card: same options pattern).
const ASPECTS = [
  { value: "1024x1024", label: "1:1" },
  { value: "768x1024", label: "3:4" },
  { value: "1024x768", label: "4:3" },
  { value: "1280x720", label: "16:9" },
  { value: "720x1280", label: "9:16" },
];
const QUALITY = [
  { value: "draft", label: "Draft" },
  { value: "final", label: "Final" },
];

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

// ------------------------------------------------------------ graph context

interface GraphCtxValue {
  catalog: CatalogEntry[] | null;
  runNodes: Record<string, RunNode>;
  thumbs: Record<string, string>;
  onRerunFrom: (id: string) => void;
}
const GraphCtx = createContext<GraphCtxValue>({ catalog: null, runNodes: {}, thumbs: {}, onRerunFrom: () => {} });

// --------------------------------------------------------------- node views

const PORT_LABEL: Record<PortType, string> = { image: "image", mask: "mask", text: "text", seed: "seed", int: "int" };

function portClass(type: PortType | "image_list"): string {
  const t = type === "image_list" ? "image" : type;
  return `pbx-port pbx-port--${t}`;
}

function OpNode({ id, data: raw, selected }: NodeProps) {
  const data = raw as unknown as OpNodeData;
  const { runNodes, thumbs, onRerunFrom } = useContext(GraphCtx);
  const run = runNodes[id];
  const status = run?.status ?? "idle";
  const thumb = run?.media_id ? thumbs[run.media_id] : undefined;
  const refPorts = REF_PORTS[data.op] || [];
  return (
    <div className={`pbx-node pbx-node--op${selected ? " is-selected" : ""} is-${status}`} data-status={status}>
      <div className="pbx-node-head">
        <span className="pbx-node-title">{data.label}</span>
        {status === "running" && <Spinner size={12} label={`${data.label} running`} />}
        {(status === "done" || status === "cached") && <span className="pbx-node-dot is-done" aria-hidden="true" />}
        {status === "failed" && <span className="pbx-node-dot is-failed" aria-hidden="true" />}
      </div>
      <div className="pbx-node-thumb">
        {thumb ? (
          <img src={thumb} alt={`${data.label} output`} />
        ) : status === "running" ? (
          <Spinner size={18} />
        ) : (
          <span className="pbx-node-thumb-empty" aria-hidden="true" />
        )}
        {run?.cached && <Badge className="pbx-node-cached">cached</Badge>}
      </div>
      {run?.status === "failed" && run.recoverable && (
        <button type="button" className="pbx-node-rerun" onClick={() => onRerunFrom(id)}>
          Re-run from here
        </button>
      )}

      {/* Ref input ports (left), promoted param ports (left), one output (right).
          Each port is a flow row; xyflow pins its Handle to the row's left edge,
          vertically centred — no inline offsets to drift out of alignment. */}
      <div className="pbx-node-ports">
        {refPorts.map((port) => (
          <span key={port.name} className="pbx-port-row">
            <Handle id={port.name} type="target" position={Position.Left} className={portClass(port.type)} />
            <span className="pbx-port-label">{port.name}</span>
          </span>
        ))}
        {data.promoted.map((pname) => (
          <span key={pname} className="pbx-port-row">
            <Handle id={paramHandle(pname)} type="target" position={Position.Left}
              className={portClass(paramPortType(pname))} />
            <span className="pbx-port-label">{pname}</span>
          </span>
        ))}
      </div>
      <Handle id={OUT_HANDLE} type="source" position={Position.Right} className={`${portClass("image")} pbx-port-out`} />
      <span className="pbx-port-out-label" aria-hidden="true">out</span>
    </div>
  );
}

function InputNode({ data: raw, selected }: NodeProps) {
  const data = raw as unknown as InputNodeData;
  return (
    <div className={`pbx-node pbx-node--input${selected ? " is-selected" : ""}`}>
      <div className="pbx-node-head">
        <span className="pbx-node-title">{data.name}</span>
        <Badge className={`pbx-type-badge pbx-type-badge--${data.inputType}`}>{PORT_LABEL[data.inputType]}</Badge>
      </div>
      <Handle id={OUT_HANDLE} type="source" position={Position.Right} className={portClass(data.inputType)} />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { op: OpNode, input: InputNode };

// ------------------------------------------------------------- view toolbar

// Floating view toolbar — the SAME pattern as StageView.tsx (Button size="xs"
// icon ghost + Tooltip + aria-label). Zoom / Fit / Fullscreen map to xyflow's
// viewport API; the zoom clamp reuses zoom.ts's MIN_ABS/MAX_ABS.
function ViewToolbar({ stageRef }: { stageRef: React.RefObject<HTMLDivElement> }) {
  const flow = useReactFlow();
  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => flow.fitView({ padding: 0.2, maxZoom: 1 }));
  };
  return (
    <div className="view-toolbar" role="toolbar" aria-label="View controls">
      <Tooltip label="Zoom out">
        <Button size="xs" icon variant="ghost" aria-label="Zoom out" onClick={() => flow.zoomOut()}><ZoomOutIcon /></Button>
      </Tooltip>
      <Tooltip label="Zoom in">
        <Button size="xs" icon variant="ghost" aria-label="Zoom in" onClick={() => flow.zoomIn()}><ZoomInIcon /></Button>
      </Tooltip>
      <Tooltip label="Fit to view">
        <Button size="xs" icon variant="ghost" aria-label="Fit to view" onClick={() => flow.fitView({ padding: 0.2, maxZoom: 1 })}><FitIcon /></Button>
      </Tooltip>
      <Tooltip label="Fullscreen">
        <Button size="xs" icon variant="ghost" aria-label="Fullscreen" onClick={fullscreen}><FullscreenIcon /></Button>
      </Tooltip>
    </div>
  );
}

// --------------------------------------------------------------- inspector

/** The composer slot turned into the selected node's inspector (card / design
 *  §9). It reuses Composer's classes (`.composer`, `.composer-prompt`,
 *  `.composer-options`, `.composer-submit`) so it looks identical. */
function NodeInspector({
  node,
  entry,
  running,
  canRerun,
  onPatch,
  onPromote,
  onRun,
  onOpenOutput,
  onDelete,
  outputMediaId,
}: {
  node: GNode | null;
  entry?: CatalogEntry;
  running: boolean;
  canRerun: boolean;
  onPatch: (data: Partial<OpNodeData | InputNodeData>) => void;
  onPromote: (param: string, on: boolean) => void;
  onRun: () => void;
  onOpenOutput: () => void;
  onDelete: () => void;
  outputMediaId: string | null;
}) {
  // Roving-focus toolbar for the node actions (card: ActionBar's layout).
  const toolbarRef = useRef<HTMLDivElement>(null);
  const onToolbarKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("[data-toolbar-item]") ?? []).filter((b) => !b.disabled);
    const cur = list.indexOf(document.activeElement as HTMLButtonElement);
    if (cur < 0) return;
    let next = cur;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % list.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (cur - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault();
    list[next]?.focus();
  };
  useEffect(() => {
    const list = Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("[data-toolbar-item]") ?? []);
    list.forEach((b, i) => { b.tabIndex = i === 0 ? 0 : -1; });
  }, [node?.id]);

  if (!node) {
    return (
      <div className="composer pbx-inspector pbx-inspector--empty" aria-label="Node inspector">
        <Empty className="pbx-inspector-empty" icon={<ImagesIcon size={28} />} title="Select a node"
          description="Pick a node to edit its parameters, or add one from the toolbar." />
      </div>
    );
  }

  if (node.data.kind === "input") {
    const d = node.data;
    return (
      <form className="composer pbx-inspector" aria-label="Node inspector" onSubmit={(e) => e.preventDefault()}>
        <span className="pbx-inspector-kind">Input</span>
        <FormField label="Name">
          <Input aria-label="Input name" value={d.name}
            onChange={(e) => onPatch({ name: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })} />
        </FormField>
        <FormField label="Type">
          <Segmented ariaLabel="Input type" size="sm" value={d.inputType}
            onChange={(v) => onPatch({ inputType: v as PortType })}
            options={[{ value: "text", label: "Text" }, { value: "image", label: "Image" }, { value: "mask", label: "Mask" }, { value: "seed", label: "Seed" }]} />
        </FormField>
        <FormField label="Default" hint="Optional default value for this input.">
          <Input aria-label="Input default" value={String(d.default ?? "")}
            onChange={(e) => onPatch({ default: e.target.value })} />
        </FormField>
        <div className="composer-actions">
          <div className="action-bar pbx-node-actions" role="toolbar" aria-label="Node actions" ref={toolbarRef} onKeyDown={onToolbarKey}>
            <Button variant="ghost" size="sm" data-toolbar-item="" className="pbx-node-delete" onClick={onDelete}>Delete</Button>
          </div>
        </div>
      </form>
    );
  }

  const d = node.data;
  const props = entry?.params.properties ?? {};
  const scalars = entry ? scalarParams(entry) : [];
  const has = (name: string) => name in props;
  const strVal = (name: string) => String(d.params[name] ?? "");
  const setParam = (name: string, value: unknown) => onPatch({ params: { ...d.params, [name]: value } });

  const hasSize = has("size");
  const hasAvoid = has("negative_prompt");
  const hasSeed = has("seed");
  const hasKeepT = has("keep_transparency");
  const margins = ["left", "top", "right", "bottom"].filter(has);
  const promoted = (name: string) => d.promoted.includes(name);
  const seed = Number(d.params.seed ?? -1);
  const seedLocked = seed >= 0;

  const optionSummary = [hasSize ? (ASPECTS.find((a) => a.value === strVal("size"))?.label ?? "1:1") : null, d.tier === "draft" ? "Draft" : "Final"].filter(Boolean).join(" · ");

  return (
    <form className="composer pbx-inspector" aria-label="Node inspector" onSubmit={(e) => { e.preventDefault(); onRun(); }}>
      <span className="pbx-inspector-kind">{d.label} node</span>

      {has("grounding") && (
        <FormField className="composer-grounding" label="What to change?" hint="A short noun phrase, e.g. “the red car”.">
          <Input aria-label="What to change?" value={strVal("grounding")} placeholder="the red car"
            onChange={(e) => setParam("grounding", e.target.value)} />
        </FormField>
      )}

      {has("prompt") && (
        <Textarea className="composer-prompt" aria-label="Prompt" rows={2} value={strVal("prompt")}
          placeholder="Describe this step…" onChange={(e) => setParam("prompt", e.target.value)} />
      )}

      {margins.length > 0 && (
        <div className="composer-margins" role="group" aria-label="Outpaint margins">
          {margins.map((edge) => (
            <FormField key={edge} className="composer-margin" label={edge[0].toUpperCase() + edge.slice(1)}>
              <Input aria-label={edge} type="number" inputMode="numeric" min={0} step={16}
                value={String(Number(d.params[edge] ?? 0))}
                onChange={(e) => setParam(edge, Math.max(0, Number(e.target.value) || 0))} />
            </FormField>
          ))}
        </div>
      )}

      {entry?.licence?.non_commercial && (
        <Badge tone="warning" className="badge-nc">Non-commercial · {entry.licence.note || "RMBG CC BY-NC"}</Badge>
      )}

      <div className="composer-actions">
        <Popover className="composer-options" label="Options" align="start" side="top"
          trigger={({ toggle, open }) => (
            <Button variant="ghost" className="composer-options-btn" aria-expanded={open} aria-label={`Options: ${optionSummary}`} onClick={toggle}>
              <span className="composer-options-icon" aria-hidden="true"><SlidersIcon /></span>
              <span className="composer-options-summary">{optionSummary}</span>
              <span className="composer-options-caret" aria-hidden="true">▾</span>
            </Button>
          )}>
          <div className="composer-opt-grid">
            {hasSize && (
              <FormField label="Aspect">
                <Segmented ariaLabel="Aspect" size="sm" value={strVal("size") || "1024x1024"} onChange={(v) => setParam("size", v)}
                  options={ASPECTS} />
              </FormField>
            )}
            <FormField label="Quality">
              <Segmented ariaLabel="Quality" size="sm" value={d.tier} onChange={(v) => onPatch({ tier: v })} options={QUALITY} />
            </FormField>
            {hasAvoid && (
              <FormField label="Avoid" hint="What the render should not contain.">
                <Input aria-label="Avoid" value={strVal("negative_prompt")} placeholder="e.g. text, watermark"
                  onChange={(e) => setParam("negative_prompt", e.target.value)} />
              </FormField>
            )}
            {hasKeepT && (
              <Switch ariaLabel="Keep transparency" label="Keep transparency" checked={Boolean(d.params.keep_transparency)}
                onChange={(v) => setParam("keep_transparency", v)} />
            )}
            {hasSeed && (
              <FormField label="Seed" hint="Empty = random. Lock to reproduce.">
                <div className="composer-seed">
                  <Input aria-label="Seed" inputMode="numeric" value={seedLocked ? String(seed) : ""} placeholder="random"
                    onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ""); setParam("seed", v === "" ? -1 : Number(v)); }} />
                  <Button icon aria-label={seedLocked ? "Unlock seed" : "Lock seed"} aria-pressed={seedLocked}
                    title={seedLocked ? "Seed locked" : "Lock a seed to reproduce"}
                    onClick={() => setParam("seed", seedLocked ? -1 : randomSeed())}>{seedLocked ? "🔒" : "🔓"}</Button>
                </div>
              </FormField>
            )}
            {/* Widget↔input promotion lives here (card): each scalar can become
                an input port, and back. */}
            {scalars.length > 0 && (
              <div className="pbx-promote" role="group" aria-label="Expose as input">
                <span className="pbx-field-label">Expose as input</span>
                {scalars.map((name) => (
                  <Switch key={name} ariaLabel={`Expose ${name} as input`} label={name} checked={promoted(name)}
                    onChange={(on) => onPromote(name, on)} />
                ))}
              </div>
            )}
          </div>
        </Popover>

        <div className="action-bar pbx-node-actions" role="toolbar" aria-label="Node actions" ref={toolbarRef} onKeyDown={onToolbarKey}>
          <Button variant="ghost" size="sm" data-toolbar-item="" disabled={!outputMediaId} onClick={onOpenOutput}>Open in Playground</Button>
          <Button variant="ghost" size="sm" data-toolbar-item="" className="pbx-node-delete" onClick={onDelete}>Delete</Button>
        </div>
        <Button variant="primary" type="submit" className="composer-submit" data-toolbar-item="" loading={running}>
          {canRerun ? "Run from here" : "Run"}
        </Button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------- the canvas

export interface PipelinesCanvasProps {
  catalog: CatalogEntry[] | null;
  hidden: boolean;
  onOpenInPlayground: (mediaId: string) => void;
  onHistoryChanged: () => void;
}

export function PipelinesCanvas(props: PipelinesCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

let pipelineSeq = 0;

function CanvasInner({ catalog, hidden, onOpenInPlayground, onHistoryChanged }: PipelinesCanvasProps) {
  const toast = useToast();
  const flow = useReactFlow();
  // True once xyflow has measured every node; the authoritative signal to fit the
  // view AFTER measurement (never before — review item 6), and to reveal a freshly
  // added node once its real footprint is known.
  const nodesInitialized = useNodesInitialized();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The spec's non-graph metadata. `description` and `expose_as_tool` are not
  // edited on the canvas but are round-tripped so a loaded/imported pipeline
  // keeps its agent-tool exposure and description on Save (pipeline_tool_factory
  // requires expose_as_tool === true).
  const [meta, setMeta] = useState<SpecMeta>(() => ({ id: "untitled_pipeline", name: "Untitled pipeline" }));
  const [addOpen, setAddOpen] = useState(false);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);

  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [runNodes, setRunNodes] = useState<Record<string, RunNode>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const nodesRef = useRef<Node[]>(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef<Edge[]>(edges);
  edgesRef.current = edges;
  const stageRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const clipboard = useRef<Node[]>([]);
  // One-shot view intents consumed by the nodesInitialized effect below: a full
  // fit after a load, or revealing one freshly added node.
  const fitPending = useRef(false);
  const revealPending = useRef<string | null>(null);

  const asGraph = useCallback((): { nodes: GNode[]; edges: GEdge[] } => ({
    nodes: nodesRef.current as unknown as GNode[],
    edges: edgesRef.current as unknown as GEdge[],
  }), []);

  const fitGraph = useCallback(() => flow.fitView({ padding: 0.15, maxZoom: 1 }), [flow]);

  // Bring a freshly placed node fully into view: leave the viewport alone if it
  // already fits, else fit the whole graph so nothing lands half-off the canvas
  // (review item 6 — a node that fell to x=-44 after an add).
  const ensureNodeVisible = useCallback((id: string) => {
    const node = flow.getNode(id);
    const container = flowRef.current;
    if (!node || !container) { fitGraph(); return; }
    const vp = flow.getViewport();
    const rect = container.getBoundingClientRect();
    const w = (node.measured?.width ?? 240) * vp.zoom;
    const h = (node.measured?.height ?? 200) * vp.zoom;
    const sx = node.position.x * vp.zoom + vp.x;
    const sy = node.position.y * vp.zoom + vp.y;
    const outside = sx < 0 || sy < 0 || sx + w > rect.width || sy + h > rect.height;
    if (outside) fitGraph();
  }, [flow, fitGraph]);

  // Fit / reveal ONLY after xyflow has measured the nodes (nodesInitialized),
  // never on a bare requestAnimationFrame before measurement (review item 6).
  useEffect(() => {
    if (!nodesInitialized) return;
    if (fitPending.current) {
      fitPending.current = false;
      revealPending.current = null;
      if (nodesRef.current.length) fitGraph();
      return;
    }
    if (revealPending.current) {
      const id = revealPending.current;
      revealPending.current = null;
      ensureNodeVisible(id);
    }
  }, [nodesInitialized, fitGraph, ensureNodeVisible]);

  const openSpec = useCallback((spec: Spec) => {
    const g = specToGraph(spec, catalog || []);
    setNodes(g.nodes as unknown as Node[]);
    setEdges(g.edges as unknown as Edge[]);
    setMeta({ id: spec.id, name: spec.name || spec.id, description: spec.description, expose_as_tool: spec.expose_as_tool });
    setSelectedId(null);
    setRunId(null);
    setRunStatus("idle");
    setRunNodes({});
    setReadOnly(false);
    // Fit once the new nodes are measured (see the nodesInitialized effect).
    fitPending.current = true;
    revealPending.current = null;
  }, [catalog]);

  // Restore the last-open graph on mount (card r4: ui.positions survive a
  // reload — the editor keeps full specs in localStorage, see pipelines.ts).
  useEffect(() => {
    const last = getLastOpen();
    const spec = last ? loadLocalSpec(last) : null;
    if (spec && catalog) openSpec(spec);
  }, [catalog, openSpec]);

  useEffect(() => {
    registerKeybindings(CANVAS_KEYBINDINGS);
    listPipelines().then(setPipelines).catch(() => {});
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);

  // Connection validation (card r3): the UI mirror of pipelines.validate — a
  // mismatched port (e.g. image → text) is refused before it ever connects.
  const portTarget = useCallback((targetId: string, handle: string | null | undefined) => {
    const target = nodesRef.current.find((n) => n.id === targetId);
    if (!target || !handle) return null;
    if (isParamHandle(handle)) return { kind: "param" as const, type: paramPortType(paramOfHandle(handle)) };
    const op = (target.data as unknown as OpNodeData).op;
    const ref = (REF_PORTS[op] || []).find((p) => p.name === handle);
    return ref ? { kind: "ref" as const, type: ref.type } : null;
  }, []);

  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const src = nodesRef.current.find((n) => n.id === c.source);
    const tgt = portTarget(c.target, c.targetHandle);
    if (!src || !tgt) return false;
    return connectionAllowed(nodeOutputType(src.data as unknown as NodeData), tgt);
  }, [portTarget]);

  const onConnect = useCallback((c: Connection) => {
    if (!isValidConnection(c)) { toast("Port types don't match"); return; }
    setEdges((es) => {
      // Single ref/param ports hold one edge; `images` (image_list) allows many.
      const op = (nodesRef.current.find((n) => n.id === c.target)?.data as unknown as OpNodeData)?.op;
      const port = (REF_PORTS[op] || []).find((p) => p.name === c.targetHandle);
      const multi = port?.type === "image_list";
      const pruned = multi ? es : es.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle));
      return addEdge({ ...c, id: `e-${c.source}-${c.target}-${c.targetHandle}-${pruned.length}` }, pruned);
    });
  }, [isValidConnection, toast]);

  // ---- node/graph mutations ------------------------------------------------

  const placeNode = useCallback((node: GNode) => {
    const existing = nodesRef.current;
    const source = existing.find((n) => n.id === selectedId);
    let pos = source ? { x: source.position.x + 300, y: source.position.y } : { x: 40, y: 40 };
    // Reserve the measured footprint, including promoted ports and failure UI.
    while (existing.some((n) => pos.x < n.position.x + (n.measured?.width ?? 240) + 32 &&
      pos.x + 272 > n.position.x && pos.y < n.position.y + (n.measured?.height ?? 320) + 32 &&
      pos.y + 352 > n.position.y)) pos = { x: pos.x, y: pos.y + 360 };
    node.position = pos;
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...node, selected: true } as unknown as Node]);
    if (source && node.data.kind === "op") {
      const port = (REF_PORTS[node.data.op] || []).find((p) => connectionAllowed(
        nodeOutputType(source.data as unknown as NodeData), { kind: "ref", type: p.type }));
      if (port) setEdges((es) => [...es, { id: `e-${source.id}-${node.id}-${port.name}`, source: source.id,
        sourceHandle: OUT_HANDLE, target: node.id, targetHandle: port.name }]);
    }
    setSelectedId(node.id);
    setAddOpen(false);
    // Reveal the new node once measured — fit only if it would fall outside the
    // viewport, so earlier nodes aren't pushed off the canvas (review item 6).
    revealPending.current = node.id;
    fitPending.current = false;
  }, [selectedId]);

  const addOpNode = useCallback((entry: CatalogEntry) => {
    placeNode(makeOpNode(entry, { x: 0, y: 0 }, newNodeId(entry.op, nodesRef.current.map((n) => n.id))));
  }, [placeNode]);

  const addInputNode = useCallback((inputType: PortType) => {
    const existing = new Set(nodesRef.current.map((n) => n.id));
    let i = 1;
    let name = `${inputType}_${i}`;
    while (existing.has(inputNodeId(name))) name = `${inputType}_${++i}`;
    placeNode({ id: inputNodeId(name), type: "input", position: { x: 0, y: 0 }, data: { kind: "input", name, inputType } });
  }, [placeNode]);

  const patchSelected = useCallback((patch: Partial<OpNodeData | InputNodeData>) => {
    const selected = nodesRef.current.find((n) => n.id === selectedId);
    if (!selected) return;
    const data = selected.data as unknown as NodeData;
    let nextId = selected.id;
    if ("name" in patch && data.kind === "input") {
      const name = (patch as Partial<InputNodeData>).name || data.name;
      nextId = inputNodeId(name);
      if (nodesRef.current.some((n) => n.id === nextId && n.id !== selected.id)) return;
      patch = { ...patch, name };
    }
    setNodes((ns) => ns.map((n) => n.id === selected.id
      ? { ...n, id: nextId, data: { ...n.data, ...patch } } as Node : n));
    if (nextId !== selected.id) {
      setEdges((es) => es.map((e) => ({
        ...e,
        source: e.source === selected.id ? nextId : e.source,
        target: e.target === selected.id ? nextId : e.target,
      })));
      setSelectedId(nextId);
    }
  }, [selectedId]);

  const promote = useCallback((param: string, on: boolean) => {
    setNodes((ns) => ns.map((n) => {
      if (n.id !== selectedId) return n;
      const data = n.data as unknown as NodeData;
      if (data.kind !== "op") return n;
      const promoted = on ? [...data.promoted, param] : data.promoted.filter((p) => p !== param);
      return { ...n, data: { ...data, promoted } } as unknown as Node;
    }));
    if (!on) setEdges((es) => es.filter((e) => !(e.target === selectedId && e.targetHandle === paramHandle(param))));
  }, [selectedId]);

  const deleteSelected = useCallback(() => {
    if (!selectedId || readOnly) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  }, [selectedId, readOnly]);

  // ---- save / load / duplicate / export / import / auto-layout ------------

  // Pass the WHOLE meta (not just id/name) so `description` and `expose_as_tool`
  // survive Save — graphToSpec writes them back onto the spec.
  const currentSpec = useCallback((): Spec => graphToSpec(asGraph().nodes, asGraph().edges, meta), [asGraph, meta]);

  const doSave = useCallback(async (): Promise<Spec | null> => {
    if (readOnly) return null;
    const spec = currentSpec();
    try {
      await savePipeline(spec);
      saveLocalSpec(spec);
      setPipelines(await listPipelines().catch(() => pipelines));
      toast("Pipeline saved");
      return spec;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      toast("Could not save — see the error");
      return null;
    }
  }, [currentSpec, pipelines, toast, readOnly]);

  const doNew = useCallback(() => {
    setReadOnly(false);
    const id = `untitled_${++pipelineSeq}`;
    setNodes([]); setEdges([]); setSelectedId(null);
    setMeta({ id, name: "Untitled pipeline" });
    setRunId(null); setRunStatus("idle"); setRunNodes({});
    setLastOpen(id);
  }, []);

  const doDuplicate = useCallback(() => {
    setReadOnly(false);
    const id = slugifyId(`${meta.id}-copy`);
    // A duplicate is a full copy: keep description/expose_as_tool, only the id
    // and name change.
    setMeta((m) => ({ ...m, id, name: `${m.name} (copy)` }));
    setRunId(null); setRunStatus("idle"); setRunNodes({});
    toast("Duplicated — save to keep it");
  }, [meta, toast]);

  const doExport = useCallback(() => {
    const spec = currentSpec();
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${spec.id}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }, [currentSpec]);

  const fileInput = useRef<HTMLInputElement>(null);
  const doImport = useCallback((file?: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { openSpec(parseSpecText(String(reader.result))); toast("Pipeline imported"); }
      catch { toast("Could not parse that file"); }
    };
    reader.readAsText(file);
  }, [openSpec, toast]);

  const doAutoLayout = useCallback(() => {
    const laid = autoLayout(asGraph().nodes, asGraph().edges);
    setNodes(laid as unknown as Node[]);
  }, [asGraph]);

  const loadListed = useCallback((p: PipelineSummary) => {
    const spec = p.spec || loadLocalSpec(p.id);
    if (!spec) { toast("Pipeline could not be loaded"); return; }
    openSpec(spec);
    setReadOnly(p.read_only);
    setPipelineOpen(false);
  }, [openSpec, toast]);

  // ---- run tracking --------------------------------------------------------

  const trackRun = useCallback((rid: string) => {
    setRunId(rid);
    setRunStatus("running");
    setError("");
    let stopped = false;
    let finished = false;
    const finish = (status: "done" | "failed") => {
      if (stopped || finished) return;
      finished = true;
      window.clearInterval(poll);
      setRunStatus(status);
      onHistoryChanged();
    };
    const mergeNode = (step: string, patch: Partial<RunNode>) =>
      setRunNodes((prev) => ({ ...prev, [step]: { ...(prev[step] || { id: step } as RunNode), ...patch } }));

    const matches = (d: unknown): (Record<string, unknown>) | null => {
      const o = d as Record<string, unknown> | null;
      return !stopped && o && typeof o === "object" && o.run_id === rid ? o : null;
    };
    const offStart = subscribe(BUS.nodeStarted, (d) => { const o = matches(d); if (o) mergeNode(String(o.step), { status: "running", op: String(o.op), alias: (o.alias as string) ?? null }); });
    const offDone = subscribe(BUS.nodeDone, (d) => {
      const o = matches(d); if (!o) return;
      mergeNode(String(o.step), { status: o.cached ? "cached" : "done", media_id: (o.media_id as string) ?? null, cached: Boolean(o.cached), elapsed_s: (o.elapsed_s as number) ?? null });
    });
    const offFail = subscribe(BUS.nodeFailed, (d) => {
      const o = matches(d); if (!o) return;
      mergeNode(String(o.step), { status: "failed", error: (o.error as string) ?? null, error_kind: (o.error_kind as string) ?? null, recoverable: Boolean(o.recoverable), hint: (o.hint as string) ?? null });
    });
    const offRun = subscribe(BUS.runDone, (d) => {
      const o = matches(d); if (!o) return;
      finish(o.status === "failed" ? "failed" : "done");
    });

    // Poll backstop (ADR 0039): short GET /runs/{id}, never held open; it also
    // fills node state after a view reload.
    const poll = window.setInterval(async () => {
      let st; try { st = await getRun(rid); } catch { return; }
      if (!st || stopped || finished) return;
      setRunNodes((prev) => {
        const merged = { ...prev };
        for (const [sid, n] of Object.entries(st.nodes)) merged[sid] = { ...(merged[sid] || {}), ...n };
        return merged;
      });
      if (st.status === "done" || st.status === "failed") finish(st.status);
    }, 2500);

    return () => { stopped = true; offStart(); offDone(); offFail(); offRun(); window.clearInterval(poll); };
  }, [onHistoryChanged]);

  const cleanupRun = useRef<() => void>(() => {});
  useEffect(() => () => cleanupRun.current(), []);

  const runSpec = useRef<string | null>(null);

  const startRun = useCallback(async () => {
    const spec = await doSave();
    if (!spec) return;
    try {
      const rid = await runPipeline(spec.id, {});
      cleanupRun.current();
      runSpec.current = JSON.stringify(spec);
      setRunNodes({});
      cleanupRun.current = trackRun(rid);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [doSave, trackRun]);

  // Resume only the spec captured by the runner. Edits need a saved fresh run;
  // the backend step cache still serves unchanged upstream nodes.
  const runFrom = useCallback(async (stepId: string) => {
    if (runId && (runStatus === "done" || runStatus === "failed")
      && runSpec.current === JSON.stringify(currentSpec())) {
      const ok = await resumeRun(runId, stepId);
      if (ok) {
        setRunStatus("running");
        setRunNodes((prev) => ({ ...prev, [stepId]: { ...(prev[stepId] || { id: stepId } as RunNode), status: "running" } }));
        cleanupRun.current();
        cleanupRun.current = trackRun(runId);
        return;
      }
    }
    await startRun();
  }, [runId, runStatus, trackRun, startRun, currentSpec]);

  // Fetch each produced node's thumbnail once (card: per-node thumbnails).
  useEffect(() => {
    const wanted = Object.values(runNodes).map((n) => n.media_id).filter((m): m is string => !!m && !thumbs[m]);
    if (!wanted.length) return;
    let alive = true;
    (async () => {
      for (const mediaId of wanted) {
        try { const url = await fetchHistoryImage(mediaId); if (alive) setThumbs((t) => ({ ...t, [mediaId]: url })); }
        catch { /* leave the node without a thumb */ }
      }
    })();
    return () => { alive = false; };
  }, [runNodes, thumbs]);

  // ---- keyboard: delete / copy / paste / fit (declared via the bridge) -----

  const onCanvasKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod && e.key === "1") { e.preventDefault(); flow.fitView({ padding: 0.2, maxZoom: 1 }); return; } // fit (declared keybinding)
    if (mod && e.key.toLowerCase() === "c") {
      clipboard.current = nodesRef.current.filter((n) => n.id === selectedId);
    } else if (!readOnly && mod && e.key.toLowerCase() === "v" && clipboard.current.length) {
      e.preventDefault();
      const existing = nodesRef.current.map((n) => n.id);
      const copies = clipboard.current
        .filter((n) => (n.data as unknown as OpNodeData).kind === "op")
        .map((n) => {
          const id = newNodeId((n.data as unknown as OpNodeData).op, existing);
          existing.push(id);
          return { ...n, id, position: { x: n.position.x + 40, y: n.position.y + 40 }, selected: false } as Node;
        });
      if (copies.length) placeNode(copies[0] as unknown as GNode);
    }
  };

  const graphCtx = useMemo<GraphCtxValue>(() => ({ catalog, runNodes, thumbs, onRerunFrom: runFrom }), [catalog, runNodes, thumbs, runFrom]);

  const selectedNode = (nodes.find((n) => n.id === selectedId) as unknown as GNode) || null;
  const selectedEntry = selectedNode?.data.kind === "op" ? catalog?.find((e) => e.op === (selectedNode.data as OpNodeData).op) : undefined;
  const selectedRun = selectedId ? runNodes[selectedId] : undefined;
  const running = runStatus === "running";

  const addNodeMenu = (
    <Menu open={addOpen} onOpenChange={setAddOpen} label="Add node" align="start" side="bottom"
      trigger={({ toggle, open }) => (
        <Button size="xs" variant="ghost" disabled={readOnly} aria-label="Add node" aria-expanded={open} onClick={toggle}>+ Add node</Button>
      )}>
      <span className="pbx-field-label">Inputs</span>
      <MenuItem onClick={() => addInputNode("text")}>Text</MenuItem>
      <MenuItem onClick={() => addInputNode("image")}>Image</MenuItem>
      <MenuItem onClick={() => addInputNode("mask")}>Mask</MenuItem>
      <span className="pbx-field-label">Operations</span>
      {Object.entries({ generate: "Generate", edit: "Edit", region_edit: "Region edit", inpaint: "Inpaint",
        outpaint: "Outpaint", remove_background: "Remove background", compose: "Compose" }).map(([op, label]) => {
        const entry = catalog?.find((e) => e.op === op);
        return entry ? <MenuItem key={op} onClick={() => addOpNode({ ...entry, label })}>{label}</MenuItem> : null;
      })}
    </Menu>
  );

  const pipelineMenu = (
    <Popover open={pipelineOpen} onOpenChange={setPipelineOpen} label="Pipeline" align="start" side="bottom" className="pbx-pipeline-menu"
      trigger={({ toggle, open }) => (
        <Button size="xs" variant="ghost" aria-label="Pipeline menu" aria-expanded={open} onClick={toggle}>Pipeline ▾</Button>
      )}>
      <div className="pbx-pipeline-panel">
        <FormField label="Name">
          <Input disabled={readOnly} aria-label="Pipeline name" value={meta.name}
            onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value, id: slugifyId(e.target.value) }))} />
        </FormField>
        <div className="pbx-pipeline-actions">
          <Button size="xs" variant="ghost" onClick={doNew}>New</Button>
          <Button size="xs" variant="ghost" disabled={readOnly} onClick={doSave}>Save</Button>
          <Button size="xs" variant="ghost" onClick={doDuplicate}>Duplicate</Button>
          <Button size="xs" variant="ghost" onClick={doExport}>Export file</Button>
          <Button size="xs" variant="ghost" onClick={() => fileInput.current?.click()}>Import file</Button>
          <Button size="xs" variant="ghost" disabled={readOnly} onClick={doAutoLayout}>Auto-layout</Button>
        </div>
        <div className="pbx-pipeline-list" role="listbox" aria-label="Saved pipelines">
          {pipelines.length === 0 ? (
            <p className="hint">No saved pipelines yet.</p>
          ) : pipelines.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={p.id === meta.id} className="pbx-pipeline-item"
              onClick={() => loadListed(p)}>
              <span>{p.name}</span>
              {p.read_only && <Badge className="pbx-ro-badge">read-only</Badge>}
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );

  return (
    // One provider wrapping BOTH ReactFlow (whose custom node renderers read run
    // state + thumbs) and the inspector — it must be an ancestor of ReactFlow.
    <GraphCtx.Provider value={graphCtx}>
    <main className="canvas pbx-pipelines" style={hidden ? { display: "none" } : undefined} aria-hidden={hidden || undefined}>
      <div className="pbx-graph-toolbar">
        {pipelineMenu}
        {addNodeMenu}
        {readOnly && <><Badge>Read-only</Badge><Button size="xs" onClick={doDuplicate}>Duplicate</Button></>}
        <span className="pbx-graph-name" aria-hidden="true">{meta.name}</span>
        {running && <Badge className="rendering-badge"><Spinner size={12} /> running</Badge>}
      </div>

      <div className="stage pbx-graph-stage" ref={stageRef}>
        <div className="pbx-flow" ref={flowRef} onKeyDown={onCanvasKeyDown}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel[0]?.id ?? null)}
            onPaneClick={() => setSelectedId(null)}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
            minZoom={Math.max(MIN_ABS, 0.25)}
            maxZoom={Math.min(MAX_ABS, 1.5)}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} />
            <ViewToolbar stageRef={stageRef} />
          </ReactFlow>
        </div>
        {nodes.length === 0 && (
          <div className="pbx-graph-empty">
            <Empty icon={<ImagesIcon />} title="Build a pipeline"
              description="Add a node from the toolbar, then wire outputs into inputs. Run to see each node's output." />
          </div>
        )}
        {error && (
          <div className="overlay" role="status">
            <Callout tone="error" title="Pipeline error" actions={<Button size="sm" variant="ghost" onClick={() => setError("")}>Dismiss</Button>}>{error}</Callout>
          </div>
        )}
      </div>

      <fieldset className="pbx-inspector-slot" disabled={readOnly}>
      <NodeInspector
        node={selectedNode}
        entry={selectedEntry}
        running={running}
        canRerun={Boolean(runId) && (runStatus === "done" || runStatus === "failed")}
        onPatch={patchSelected}
        onPromote={promote}
        onRun={() => (selectedNode && runId && (runStatus === "done" || runStatus === "failed")) ? runFrom(selectedNode.id) : startRun()}
        onOpenOutput={() => { if (selectedRun?.media_id) onOpenInPlayground(selectedRun.media_id); }}
        onDelete={deleteSelected}
        outputMediaId={selectedRun?.media_id ?? null}
      />

      </fieldset>

      <input ref={fileInput} className="visually-hidden" type="file" accept="application/json,.json,.yaml,.yml"
        aria-hidden="true" tabIndex={-1} onChange={(e) => { doImport(e.target.files?.[0]); e.target.value = ""; }} />
    </main>
    </GraphCtx.Provider>
  );
}
