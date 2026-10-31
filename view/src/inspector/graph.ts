// Pure graph-building helpers for the workflow inspector (Studio S10), kept apart
// from WorkflowDrawer.tsx so the spec can import and exercise them host-free (no
// React, no xyflow CSS side-effect) — the same split pipelines.spec relies on.
// Only TYPE imports from @xyflow/react, so esbuild erases them: this module has
// no runtime dependency on xyflow.
import type { Edge, Node } from "@xyflow/react";

import type { WorkflowNode, WorkflowPayload, WorkflowSlot } from "../api";

/** A node key vs a bookkeeping key: the API-format map interleaves node ids with
 *  ``_``-prefixed keys like ``_doc`` that the loader strips (studio.md §2). */
export function isNodeKey(key: string): boolean {
  return !key.startsWith("_");
}

/** The ``_doc`` string the Drawer header shows (empty when absent). */
export function workflowDoc(workflow: Record<string, WorkflowNode | string> | undefined): string {
  const doc = workflow?._doc;
  return typeof doc === "string" ? doc : "";
}

/** The ``[node_id, WorkflowNode]`` pairs, skipping ``_``-keys and non-objects. */
export function workflowNodeEntries(
  workflow: Record<string, WorkflowNode | string> | undefined,
): [string, WorkflowNode][] {
  return Object.entries(workflow || {})
    .filter(([k, v]) => isNodeKey(k) && v != null && typeof v === "object")
    .map(([k, v]) => [k, v as WorkflowNode]);
}

export interface WorkflowLink {
  source: string;
  target: string;
  input: string;
  outIdx: number;
}

/** Derive the graph edges from API-format input links. In API format an input is
 *  a LINK when its value is a ``[node_id, out_idx]`` tuple that names an existing
 *  node; every other value (a string/number/bool/object, or a 2-element array
 *  that is NOT a node reference) is a literal and yields no edge. */
export function workflowLinks(
  workflow: Record<string, WorkflowNode | string> | undefined,
): WorkflowLink[] {
  const entries = workflowNodeEntries(workflow);
  const ids = new Set(entries.map(([id]) => id));
  const links: WorkflowLink[] = [];
  for (const [target, node] of entries) {
    const inputs = node.inputs || {};
    for (const [input, value] of Object.entries(inputs)) {
      if (!Array.isArray(value) || value.length !== 2) continue;
      const [rawSrc, rawOut] = value as [unknown, unknown];
      const source = typeof rawSrc === "number" ? String(rawSrc) : rawSrc;
      if (typeof source !== "string" || !ids.has(source)) continue;
      if (typeof rawOut !== "number") continue;
      links.push({ source, target, input, outIdx: rawOut });
    }
  }
  return links;
}

/** The nodes (and their substituted inputs) the backend fills per render. The
 *  view flags the named node and lists the named inputs, so the highlight never
 *  rests on colour alone (design §10). */
export function slotFlags(slots: WorkflowSlot[] | undefined): {
  nodeIds: Set<string>;
  inputsByNode: Record<string, string[]>;
} {
  const nodeIds = new Set<string>();
  const inputsByNode: Record<string, string[]> = {};
  for (const s of slots || []) {
    if (!s || typeof s.node_id !== "string") continue;
    nodeIds.add(s.node_id);
    if (s.input) {
      const list = inputsByNode[s.node_id] || (inputsByNode[s.node_id] = []);
      if (!list.includes(s.input)) list.push(s.input);
    }
  }
  return { nodeIds, inputsByNode };
}

// Top→bottom dependency ranks suit the tall drawer. Center each rank under the
// widest one; disconnected loaders remain on the first rank. The canvas owns
// pan/zoom when a larger workflow cannot fit at a readable scale.
const WF_NODE_W = 250; // matches .pbx-wf-node width
const WF_GAP = 30; // horizontal gutter between columns
const WF_COL = WF_NODE_W + WF_GAP; // 280: column pitch (node width + gap)
const WF_ROW = 150;
const WF_ORIGIN = 24;
// The most zoomed-out initial scale: equals the ReactFlow minZoom and the fit
// minZoom, so it is the worst case for a rank spilling past the Drawer's edges.
const WF_INIT_ZOOM = 0.7;

/** How many nodes fit on one rank inside a Drawer of ``drawerWidth`` px at the
 *  initial zoom: ``floor(drawerWidth / (nodeWidth + gap))`` measured at that
 *  zoom. A rank wider than this wraps onto extra rows so it never overflows the
 *  Drawer on open (Studio S10 review item 3). Never below 1. */
export function wfMaxPerRow(drawerWidth: number): number {
  return Math.max(1, Math.floor(drawerWidth / (WF_COL * WF_INIT_ZOOM)));
}

function layout(
  ids: string[],
  links: WorkflowLink[],
  maxPerRow: number,
): Record<string, { x: number; y: number }> {
  const incoming: Record<string, string[]> = {};
  for (const id of ids) incoming[id] = [];
  for (const l of links) incoming[l.target]?.push(l.source);
  const depth: Record<string, number> = {};
  for (const id of ids) depth[id] = 0;
  // Longest-path relaxation, bounded by node count (a DAG settles within that);
  // the bound also makes a stray cycle terminate instead of looping forever.
  for (let i = 0; i < ids.length; i++) {
    let changed = false;
    for (const id of ids) {
      const deps = incoming[id];
      const d = deps.length ? Math.max(...deps.map((s) => depth[s] + 1)) : 0;
      if (d > depth[id]) { depth[id] = d; changed = true; }
    }
    if (!changed) break;
  }
  const layers: Record<number, string[]> = {};
  for (const id of ids) (layers[depth[id]] ||= []).push(id);
  // Flatten depth ranks to visual rows, wrapping any rank wider than the Drawer
  // into ``ceil(count / maxPerRow)`` stacked rows (review item 3). Deeper ranks
  // shift down by the extra rows a shallower rank introduced; because the whole
  // of rank d precedes rank d+1, every edge still points from a lower row to a
  // higher one (top→bottom preserved).
  const cap = Math.max(1, maxPerRow);
  const rows: string[][] = [];
  for (const d of Object.keys(layers).map(Number).sort((a, b) => a - b)) {
    const layer = layers[d];
    for (let i = 0; i < layer.length; i += cap) rows.push(layer.slice(i, i + cap));
  }
  const widest = Math.max(0, ...rows.map((row) => row.length));
  const pos: Record<string, { x: number; y: number }> = {};
  rows.forEach((row, r) => {
    row.forEach((id, i) => {
      // Center each row under the widest one so the graph bbox is symmetric and
      // the initial fit sits centered horizontally in the Drawer.
      pos[id] = {
        x: WF_ORIGIN + (i + (widest - row.length) / 2) * WF_COL,
        y: WF_ORIGIN + r * WF_ROW,
      };
    });
  });
  return pos;
}

export interface WfNodeData {
  label: string;
  nodeId: string;
  isSlot: boolean;
  slotInputs: string[];
  [key: string]: unknown;
}

/** Build the read-only xyflow graph from the API payload: a node per
 *  ``class_type`` (laid out top→bottom), an edge per API input link, and the
 *  slot nodes flagged. ``maxPerRow`` caps how many nodes a dependency rank may
 *  place on one row before wrapping (review item 3); the default leaves the
 *  canvas unbounded — the Drawer passes the measured width-derived cap. */
export function buildWorkflowGraph(
  payload: WorkflowPayload,
  maxPerRow = Infinity,
): { nodes: Node[]; edges: Edge[] } {
  const entries = workflowNodeEntries(payload.workflow);
  const ids = entries.map(([id]) => id);
  const links = workflowLinks(payload.workflow);
  const { nodeIds: slotNodeIds, inputsByNode } = slotFlags(payload.slots);
  const pos = layout(ids, links, maxPerRow);
  const nodes: Node[] = entries.map(([id, node]) => ({
    id,
    type: "wf",
    position: pos[id] || { x: 0, y: 0 },
    data: {
      label: node.class_type || id,
      nodeId: id,
      isSlot: slotNodeIds.has(id),
      slotInputs: inputsByNode[id] || [],
    } as WfNodeData,
    draggable: false,
    connectable: false,
    selectable: false,
  }));
  const edges: Edge[] = links.map((l, i) => ({
    id: `e${i}-${l.source}-${l.target}-${l.input}`,
    source: l.source,
    target: l.target,
    data: { input: l.input },
    label: l.input,
    className: "pbx-wf-edge",
    selectable: false,
    focusable: false,
  }));
  return { nodes, edges };
}
