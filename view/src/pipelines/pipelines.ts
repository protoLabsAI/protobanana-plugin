// Pure logic for the Pipelines tab (design images-view-redesign §9, studio S8):
// typed ports, the canvas-graph ↔ S7-spec round trip, and thin apiFetch wrappers.
// It carries NO React/xyflow import so it is unit-testable and so the UI
// (Canvas.tsx) stays a thin shell over these functions. Every rule here mirrors
// the backend pipelines.py (SPEC_SCHEMA, validate, _REF_PORTS, _param_port_type)
// so a spec the canvas saves passes the real validator unchanged (acceptance r3).

import { load as loadYaml } from "js-yaml";

import {
  apiFetch,
  fetchCatalog,
  type CatalogEntry,
  type JsonSchemaProp,
} from "../api";

// ------------------------------------------------------------------- ports

// Typed, coloured ports (card: image/mask/text/seed, no orange, --pl-* tokens).
export type PortType = "image" | "mask" | "text" | "seed" | "int";

// Each op's ref (media) INPUT ports — the fields that carry a media hand-off
// between nodes. Mirrors pipelines.py `_REF_PORTS`. Every op's OUTPUT is an
// image. `image_list` is compose's `images` field (many refs into one port).
export type RefPortType = "image" | "mask" | "image_list";
export const REF_PORTS: Record<string, { name: string; type: RefPortType }[]> = {
  generate: [],
  edit: [{ name: "image", type: "image" }],
  inpaint: [{ name: "image", type: "image" }, { name: "mask", type: "mask" }],
  region_edit: [{ name: "image", type: "image" }],
  outpaint: [{ name: "image", type: "image" }],
  remove_background: [{ name: "image", type: "image" }],
  compose: [{ name: "images", type: "image_list" }],
};

// The input types a declared pipeline input may take — mirrors pipelines.py
// `_INPUT_TYPES`. These are the source types of an input node's output port.
export const INPUT_TYPES: PortType[] = ["text", "image", "mask", "int", "seed"];

export function isRefPort(op: string, name: string): boolean {
  return (REF_PORTS[op] || []).some((p) => p.name === name);
}

/** The port type of a scalar param, from its JSON-schema type — mirrors
 *  pipelines.py `_param_port_type` (integer → int, else text). `seed` is an
 *  integer param but we colour it as its own `seed` port; it still validates
 *  like an int (never accepts an image/mask), see {@link connectionAllowed}. */
export function paramPortType(name: string, schema?: JsonSchemaProp): PortType {
  if (name === "seed") return "seed";
  return schema?.type === "integer" ? "int" : "text";
}

/** Whether a connection from a source output of `srcType` into `target` is
 *  allowed. This is the UI mirror of pipelines.py `validate`: a ref `image`/
 *  `image_list` port takes an image; a ref `mask` port takes a mask; a scalar
 *  (text/int/seed) param port refuses an image or mask (the image→text mismatch
 *  the card calls out) and accepts anything else. */
export function connectionAllowed(
  srcType: PortType,
  target: { kind: "ref"; type: RefPortType } | { kind: "param"; type: PortType },
): boolean {
  if (target.kind === "ref") {
    const want: PortType = target.type === "mask" ? "mask" : "image";
    return srcType === want;
  }
  const scalar = target.type === "text" || target.type === "int" || target.type === "seed";
  if ((srcType === "image" || srcType === "mask") && scalar) return false;
  return true;
}

// -------------------------------------------------------------- node model

// A canvas node is either an OP (one pipeline step) or an INPUT (a declared
// pipeline input — a typed source other nodes wire from). The data lives in
// xyflow's `node.data`; these are plain objects so the round-trip functions
// below stay pure and testable without xyflow.
export interface OpNodeData {
  kind: "op";
  op: string;
  label: string;
  // Scalar widget values (prompt, grounding, size, seed, margins, …). Ref ports
  // (image/mask/images) are NEVER here — they are edges, not widgets.
  params: Record<string, unknown>;
  // Param names currently promoted to an input PORT (card: widget↔input
  // promotion). A promoted param wired from an input becomes `{{inputs.NAME}}`.
  promoted: string[];
  tier: string;
  // The step's gateway-model alias (spec `step.alias`, consumed by pipelines.py
  // `_resolve_alias`). The canvas doesn't edit it, but it is round-tripped so a
  // loaded/imported spec's aliases survive Save (it is not a ref/widget).
  alias?: string;
}

export interface InputNodeData {
  kind: "input";
  name: string;
  inputType: PortType;
  default?: unknown;
}

export type NodeData = OpNodeData | InputNodeData;

// The minimal node/edge shapes the pure functions operate on. xyflow's Node/Edge
// are structurally assignable to these, so Canvas.tsx passes its state straight
// in with no mapping.
export interface GNode {
  id: string;
  // The xyflow node type selects the custom renderer ("op" | "input"); it always
  // mirrors data.kind. The round-trip functions key off data.kind, not this.
  type?: string;
  position: { x: number; y: number };
  data: NodeData;
}
export interface GEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export const OUT_HANDLE = "out";
export const inputNodeId = (name: string): string => `input:${name}`;
export const paramHandle = (name: string): string => `param:${name}`;
export const isParamHandle = (h?: string | null): boolean => !!h && h.startsWith("param:");
export const paramOfHandle = (h: string): string => h.slice("param:".length);

/** The output type of a node (its single output port). Op nodes always output an
 *  image; an input node outputs its declared type. */
export function nodeOutputType(data: NodeData): PortType {
  return data.kind === "input" ? data.inputType : "image";
}

// ------------------------------------------------------------- catalog use

/** Scalar param names for an op (everything in its schema that is not a ref
 *  port, and not the removed `n`/count — design §6). These are the inspector
 *  widgets, each promotable to an input port. */
export function scalarParams(entry: CatalogEntry): string[] {
  return Object.keys(entry.params.properties).filter(
    (name) => !isRefPort(entry.op, name) && name !== "n",
  );
}

/** A fresh op node's default param values from the schema defaults. */
export function defaultParams(entry: CatalogEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of scalarParams(entry)) {
    const schema = entry.params.properties[name];
    if (schema && "default" in schema) out[name] = schema.default;
  }
  return out;
}

let _seq = 0;
/** A step id that satisfies the spec pattern `^[a-z0-9][a-z0-9_-]*$`, unique
 *  within `existing`. */
export function newNodeId(op: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = op.replace(/[^a-z0-9_-]/g, "_");
  let id = `${base}_${++_seq}`;
  while (taken.has(id)) id = `${base}_${++_seq}`;
  return id;
}

export function makeOpNode(entry: CatalogEntry, position: { x: number; y: number }, id: string): GNode {
  return {
    id,
    type: "op",
    position,
    data: { kind: "op", op: entry.op, label: entry.label, params: defaultParams(entry), promoted: [], tier: "final" },
  };
}

// ------------------------------------------------------------- ordering

/** Dependency order (deps first) over op nodes, from the ref edges — the TS
 *  mirror of pipelines.py `_run_order` / `_topo_order`. Input nodes are not
 *  ordered (they are pure sources). */
export function runOrder(nodes: GNode[], edges: GEdge[]): string[] {
  const opIds = nodes.filter((n) => n.data.kind === "op").map((n) => n.id);
  const set = new Set(opIds);
  const indeg: Record<string, number> = {};
  const down: Record<string, string[]> = {};
  for (const id of opIds) { indeg[id] = 0; down[id] = []; }
  for (const e of edges) {
    if (isParamHandle(e.targetHandle)) continue; // param edges don't order steps
    if (set.has(e.source) && set.has(e.target)) {
      indeg[e.target] += 1;
      down[e.source].push(e.target);
    }
  }
  const ready = opIds.filter((id) => indeg[id] === 0);
  const out: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    for (const nxt of down[id]) { indeg[nxt] -= 1; if (indeg[nxt] === 0) ready.push(nxt); }
  }
  return out.length === opIds.length ? out : opIds; // a cycle → leave validate to report it
}

// --------------------------------------------------------- graph ↔ spec

export interface SpecMeta {
  id: string;
  name?: string;
  description?: string;
  expose_as_tool?: boolean;
}

// The S7 spec shape (design §3.2 / pipelines.py SPEC_SCHEMA), only the parts the
// canvas produces/consumes.
export interface Spec {
  id: string;
  name?: string;
  description?: string;
  expose_as_tool?: boolean;
  inputs?: Record<string, string | { type: string; default?: unknown }>;
  steps: SpecStep[];
  output?: string;
  ui?: { positions?: Record<string, { x: number; y: number }> };
}
export interface SpecStep {
  id: string;
  op: string;
  image?: string;
  mask?: string;
  images?: string[];
  alias?: string;
  tier?: string;
  params?: Record<string, unknown>;
}

const TEMPLATE_RE = /\{\{\s*(?:inputs\.)?([a-zA-Z0-9_]+)\s*\}\}/g;
export function placeholders(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  TEMPLATE_RE.lastIndex = 0;
  while ((m = TEMPLATE_RE.exec(text))) out.push(m[1]);
  return out;
}

/** Build a runnable S7 spec from the canvas graph. Ref ports become `image`/
 *  `mask`/`images` fields; a scalar param wired from an input becomes a
 *  `{{inputs.NAME}}` template; every node's position is saved under
 *  `ui.positions` so a reload restores the layout (acceptance r4). */
export function graphToSpec(nodes: GNode[], edges: GEdge[], meta: SpecMeta): Spec {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const opNodes = nodes.filter((n): n is GNode & { data: OpNodeData } => n.data.kind === "op");
  const inputNodes = nodes.filter((n): n is GNode & { data: InputNodeData } => n.data.kind === "input");

  // ref(sourceId): a step id for an op source, else the input's bare name.
  const refOf = (sourceId: string): string | null => {
    const n = byId.get(sourceId);
    if (!n) return null;
    return n.data.kind === "input" ? n.data.name : n.id;
  };

  const inputs: Record<string, string | { type: string; default?: unknown }> = {};
  for (const n of inputNodes) {
    inputs[n.data.name] = n.data.default == null || n.data.default === ""
      ? n.data.inputType
      : { type: n.data.inputType, default: n.data.default };
  }

  const order = runOrder(nodes, edges);
  const ordered = [...opNodes].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  const steps: SpecStep[] = ordered.map((n) => {
    const step: SpecStep = { id: n.id, op: n.data.op };
    const params: Record<string, unknown> = { ...n.data.params };

    // Promoted params wired from an input become a template; drop a promoted but
    // unwired param flag (the literal widget value stays).
    for (const pname of n.data.promoted) {
      const edge = edges.find((e) => e.target === n.id && e.targetHandle === paramHandle(pname));
      const ref = edge ? refOf(edge.source) : null;
      if (ref) params[pname] = `{{inputs.${ref}}}`;
    }
    if (Object.keys(params).length) step.params = params;

    // Ref ports → step fields.
    for (const port of REF_PORTS[n.data.op] || []) {
      const incoming = edges.filter((e) => e.target === n.id && e.targetHandle === port.name);
      if (port.type === "image_list") {
        const refs = incoming.map((e) => refOf(e.source)).filter((r): r is string => !!r);
        if (refs.length) step.images = refs;
      } else if (incoming.length) {
        const ref = refOf(incoming[0].source);
        if (ref) (step as unknown as Record<string, unknown>)[port.name] = ref;
      }
    }
    if (n.data.tier && n.data.tier !== "final") step.tier = n.data.tier;
    // Preserve the step's gateway-model alias so a loaded/imported spec keeps
    // its model selection (pipelines.py `_resolve_alias` prefers step.alias).
    if (n.data.alias) step.alias = n.data.alias;
    return step;
  });

  // The output is the one op node no other op consumes; if ambiguous, the last
  // in run order (validate accepts a missing output and defaults the same way).
  const consumed = new Set<string>();
  for (const e of edges) {
    if (isParamHandle(e.targetHandle)) continue;
    const src = byId.get(e.source);
    const tgt = byId.get(e.target);
    if (src?.data.kind === "op" && tgt?.data.kind === "op") consumed.add(e.source);
  }
  const sinks = opNodes.map((n) => n.id).filter((id) => !consumed.has(id));
  const output = sinks.length === 1 ? sinks[0] : order[order.length - 1];

  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };

  const spec: Spec = { id: meta.id, steps, ui: { positions } };
  if (meta.name) spec.name = meta.name;
  if (meta.description) spec.description = meta.description;
  if (meta.expose_as_tool) spec.expose_as_tool = true;
  if (Object.keys(inputs).length) spec.inputs = inputs;
  if (output) spec.output = output;
  return spec;
}

/** Reconstruct the canvas graph from a spec (load / duplicate / import). Inverse
 *  of {@link graphToSpec}: it restores op and input nodes, the ref and templated
 *  edges, and the `ui.positions` layout. */
export function specToGraph(spec: Spec, catalog: CatalogEntry[]): { nodes: GNode[]; edges: GEdge[] } {
  const positions = spec.ui?.positions || {};
  const steps = spec.steps || [];
  const stepIds = new Set(steps.map((s) => s.id));
  const inputDecls = spec.inputs || {};
  const inputNames = new Set(Object.keys(inputDecls));

  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  let auto = 0;
  const posFor = (id: string) => positions[id] || { x: 40 + (auto++ % 4) * 220, y: 40 + Math.floor(auto / 4) * 150 };

  // Input nodes.
  for (const [name, decl] of Object.entries(inputDecls)) {
    const inputType = (typeof decl === "string" ? decl : decl.type) as PortType;
    const def = typeof decl === "string" ? undefined : decl.default;
    const id = inputNodeId(name);
    nodes.push({ id, type: "input", position: posFor(id), data: { kind: "input", name, inputType, default: def } });
  }

  const sourceNodeIdFor = (ref: string): string | null => {
    const bare = ref.startsWith("inputs.") ? ref.slice("inputs.".length) : ref;
    if (stepIds.has(ref)) return ref;
    if (inputNames.has(bare)) return inputNodeId(bare);
    return null;
  };

  // Op nodes + edges.
  for (const step of steps) {
    const entry = catalog.find((e) => e.op === step.op);
    const params = { ...(step.params || {}) };
    const promoted: string[] = [];
    // Templated scalar params → a promoted port + an edge from the input.
    for (const [pname, pval] of Object.entries(params)) {
      if (typeof pval !== "string") continue;
      const names = placeholders(pval);
      if (!names.length) continue;
      promoted.push(pname);
      for (const n of names) {
        if (inputNames.has(n)) {
          edges.push({ id: `e-${step.id}-${pname}-${n}`, source: inputNodeId(n), sourceHandle: OUT_HANDLE, target: step.id, targetHandle: paramHandle(pname) });
        }
      }
    }
    nodes.push({
      id: step.id,
      type: "op",
      position: posFor(step.id),
      data: { kind: "op", op: step.op, label: entry?.label || step.op, params, promoted, tier: step.tier || "final", alias: step.alias },
    });
    // Ref ports → edges.
    for (const port of REF_PORTS[step.op] || []) {
      const raw = (step as unknown as Record<string, unknown>)[port.name];
      const refs = port.type === "image_list" ? (Array.isArray(raw) ? raw : []) : raw != null ? [raw] : [];
      refs.forEach((ref, i) => {
        if (typeof ref !== "string") return;
        const sourceId = sourceNodeIdFor(ref);
        if (sourceId) edges.push({ id: `e-${sourceId}-${step.id}-${port.name}-${i}`, source: sourceId, sourceHandle: OUT_HANDLE, target: step.id, targetHandle: port.name });
      });
    }
  }
  return { nodes: Object.keys(positions).length ? nodes : autoLayout(nodes, edges), edges };
}

/** A simple layered auto-layout (card: Auto-layout). Depth = longest ref path
 *  from a source; nodes in a layer stack vertically. */
export function autoLayout(nodes: GNode[], edges: GEdge[]): GNode[] {
  const depth: Record<string, number> = {};
  const order = [...runOrder(nodes, edges)];
  // Every node starts at depth 0; settle() below raises each to one past its
  // deepest input (inputs stay at 0 unless they feed something).
  for (const n of nodes) depth[n.id] = 0;
  const incoming: Record<string, string[]> = {};
  for (const n of nodes) incoming[n.id] = [];
  for (const e of edges) incoming[e.target]?.push(e.source);
  const settle = (id: string) => {
    const deps = incoming[id] || [];
    depth[id] = deps.length ? Math.max(...deps.map((d) => (depth[d] ?? 0) + 1)) : 0;
  };
  for (const id of order) settle(id);
  for (const n of nodes) if (n.data.kind === "input") settle(n.id);
  const layers: Record<number, string[]> = {};
  for (const n of nodes) (layers[depth[n.id]] ||= []).push(n.id);
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of Object.entries(layers)) {
    ids.forEach((id, i) => pos.set(id, { x: 40 + Number(d) * 300, y: 40 + i * 360 }));
  }
  return nodes.map((n) => ({ ...n, position: pos.get(n.id) || n.position }));
}

export function slugifyId(name: string): string {
  const s = (name || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z0-9]+/, "");
  return s || "pipeline";
}

/** Parse an imported spec file into a Spec. The import picker offers .json AND
 *  .yaml/.yml (the formats the backend `_load_text_spec` reads); JSON is a
 *  subset of YAML, so one YAML parse handles both the canvas's own .json export
 *  and a hand-authored .yaml spec. Throws on malformed input or a non-object. */
export function parseSpecText(text: string): Spec {
  const data = loadYaml(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("not a pipeline spec");
  }
  return data as Spec;
}

// --------------------------------------------------------- api wrappers

export interface PipelineSummary {
  id: string;
  name: string;
  description: string;
  source: string;
  read_only: boolean;
  spec: Spec;
  expose_as_tool: boolean;
  inputs: Record<string, unknown>;
  steps: string[];
}

export type RunNodeStatus = "pending" | "running" | "done" | "cached" | "failed";
export interface RunNode {
  id: string;
  op: string;
  alias: string | null;
  status: RunNodeStatus;
  media_id: string | null;
  url: string | null;
  cached: boolean;
  elapsed_s: number | null;
  error: string | null;
  error_kind: string | null;
  recoverable: boolean | null;
  hint: string | null;
}
export interface RunState {
  run_id: string;
  pipeline: string;
  status: "queued" | "running" | "done" | "failed";
  order: string[];
  output: string | null;
  output_media_id: string | null;
  cache_hits: number;
  error: string | null;
  nodes: Record<string, RunNode>;
}

export const BUS = {
  nodeStarted: "protobanana.pipeline.node.started",
  nodeDone: "protobanana.pipeline.node.done",
  nodeFailed: "protobanana.pipeline.node.failed",
  runDone: "protobanana.pipeline.run.done",
  saved: "protobanana.pipeline.saved",
} as const;

export { fetchCatalog };

export async function listPipelines(): Promise<PipelineSummary[]> {
  const r = await apiFetch("pipelines");
  if (!r.ok) throw new Error(`pipelines ${r.status}`);
  const body = (await r.json()) as { pipelines?: PipelineSummary[] };
  return body.pipelines || [];
}

// The backend lists full specs; the canvas also keeps specs it authors in a
// small localStorage store. That is also how `ui.positions` survives a reload
// (acceptance r4): Save persists server-side (so the agent/runs can use it) AND
// locally with the layout, and the editor restores the last-open graph on mount.
const LS_SPECS = "protobanana.pipelines.specs";
const LS_LAST = "protobanana.pipelines.last";

function readStore(): Record<string, Spec> {
  try {
    return JSON.parse(window.localStorage.getItem(LS_SPECS) || "{}") as Record<string, Spec>;
  } catch {
    return {};
  }
}
function writeStore(store: Record<string, Spec>): void {
  try { window.localStorage.setItem(LS_SPECS, JSON.stringify(store)); } catch { /* storage unavailable */ }
}
export function saveLocalSpec(spec: Spec): void {
  const store = readStore();
  store[spec.id] = spec;
  writeStore(store);
  setLastOpen(spec.id);
}
export function loadLocalSpec(id: string): Spec | null {
  return readStore()[id] || null;
}
export function deleteLocalSpec(id: string): void {
  const store = readStore();
  delete store[id];
  writeStore(store);
}
export function localSpecIds(): string[] {
  return Object.keys(readStore());
}
export function setLastOpen(id: string): void {
  try { window.localStorage.setItem(LS_LAST, id); } catch { /* storage unavailable */ }
}
export function getLastOpen(): string | null {
  try { return window.localStorage.getItem(LS_LAST); } catch { return null; }
}

/** POST /pipelines — validate + persist. Returns the saved summary or throws
 *  with the backend's readable SpecError message. */
export async function savePipeline(spec: Spec): Promise<{ id: string; source: string }> {
  const r = await apiFetch("pipelines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { detail?: string }).detail || `save ${r.status}`);
  return body as { id: string; source: string };
}

/** POST /pipelines/{id}/run — returns a run_id at once (R1: nothing held open). */
export async function runPipeline(id: string, inputs: Record<string, unknown> = {}): Promise<string> {
  const r = await apiFetch(`pipelines/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs }),
  });
  const body = await r.json().catch(() => ({}));
  if (!(r.status === 202 || r.ok)) throw new Error((body as { detail?: string }).detail || `run ${r.status}`);
  return (body as { run_id: string }).run_id;
}

/** GET /runs/{id} — the per-node state, the poll backstop for the bus. */
export async function getRun(runId: string): Promise<RunState | null> {
  const r = await apiFetch(`runs/${encodeURIComponent(runId)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`runs/${runId} ${r.status}`);
  return (await r.json()) as RunState;
}

/** POST /runs/{id}/resume?from_step= — "re-run from here" after a recoverable
 *  failure or a param edit; the cache serves the untouched upstream steps. */
export async function resumeRun(runId: string, fromStep?: string): Promise<boolean> {
  const q = fromStep ? `?from_step=${encodeURIComponent(fromStep)}` : "";
  const r = await apiFetch(`runs/${encodeURIComponent(runId)}/resume${q}`, { method: "POST" });
  if (!r.ok) return false;
  const body = (await r.json().catch(() => ({}))) as { resumed?: boolean };
  return Boolean(body.resumed ?? true);
}

// ------------------------------------------------------- keybindings bridge

export interface Keybinding { id: string; keys: string[]; description: string }

/** Declare the canvas's keyboard verbs to the host so Delete / copy / paste /
 *  fit-view don't clash with the console (studio.md S8 / card r5). A plain
 *  postMessage to the parent, matching api.ts's subscribe/compose bridges; the
 *  host owns de-duping and the view still works standalone. Returns the payload
 *  it posted (for the test). */
export function registerKeybindings(bindings: Keybinding[]): { type: string; scope: string; bindings: Keybinding[] } {
  const payload = { type: "protoagent:keybindings", scope: "protobanana.pipelines", bindings };
  try {
    window.parent?.postMessage(payload, "*");
  } catch {
    /* no parent frame (standalone) */
  }
  return payload;
}

export const CANVAS_KEYBINDINGS: Keybinding[] = [
  { id: "delete", keys: ["Delete", "Backspace"], description: "Delete the selected node(s)" },
  { id: "copy", keys: ["Mod+c"], description: "Copy the selected node(s)" },
  { id: "paste", keys: ["Mod+v"], description: "Paste node(s)" },
  { id: "fit", keys: ["1"], description: "Fit the graph to the view" },
];
