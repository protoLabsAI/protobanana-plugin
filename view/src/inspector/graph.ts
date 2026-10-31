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

// Layered left→right layout (the same idea as pipelines.ts autoLayout): each node
// sits one column past its deepest input; a column stacks vertically. The small
// ~180×64 boxes + these pitches keep clear gaps, and fitView scales the whole
// graph into the Drawer body so nothing ever needs a scrollbar.
const WF_COL = 230;
const WF_ROW = 108;
const WF_ORIGIN = 24;

function layout(ids: string[], links: WorkflowLink[]): Record<string, { x: number; y: number }> {
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
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [d, layerIds] of Object.entries(layers)) {
    layerIds.forEach((id, i) => {
      pos[id] = { x: WF_ORIGIN + Number(d) * WF_COL, y: WF_ORIGIN + i * WF_ROW };
    });
  }
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
 *  ``class_type`` (laid out left→right), an edge per API input link, and the
 *  slot nodes flagged. */
export function buildWorkflowGraph(payload: WorkflowPayload): { nodes: Node[]; edges: Edge[] } {
  const entries = workflowNodeEntries(payload.workflow);
  const ids = entries.map(([id]) => id);
  const links = workflowLinks(payload.workflow);
  const { nodeIds: slotNodeIds, inputsByNode } = slotFlags(payload.slots);
  const pos = layout(ids, links);
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
