import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  useReactFlow,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { fetchWorkflow, type WorkflowPayload } from "../api";
import {
  Button,
  Callout,
  CloseIcon,
  Drawer,
  Empty,
  FitIcon,
  ImagesIcon,
  Spinner,
  Tooltip,
  ZoomInIcon,
  ZoomOutIcon,
} from "../ds-pending";
import { buildWorkflowGraph, workflowDoc, type WfNodeData } from "./graph";

// ------------------------------------------------------------------ node view

function WfNode({ data }: NodeProps) {
  const d = data as unknown as WfNodeData;
  return (
    <div
      className={`pbx-wf-node${d.isSlot ? " pbx-wf-node--slot" : ""}`}
      data-node-id={d.nodeId}
      data-slot={d.isSlot ? "true" : "false"}
    >
      <Handle type="target" position={Position.Left} className="pbx-wf-handle" isConnectable={false} />
      <span className="pbx-wf-node-title">{d.label}</span>
      {d.isSlot && (
        // A LABEL, not just a colour, so the slot cue survives for colour-blind
        // users and in a monochrome capture (design §10 contrast rule).
        <span className="pbx-wf-slot-tag">
          slot{d.slotInputs.length ? `: ${d.slotInputs.join(", ")}` : ""}
        </span>
      )}
      <Handle type="source" position={Position.Right} className="pbx-wf-handle" isConnectable={false} />
    </div>
  );
}

const WF_NODE_TYPES: NodeTypes = { wf: WfNode };

// Floating view toolbar — the SAME pattern as StageView/Canvas (Button size="xs"
// icon ghost + Tooltip + aria-label). Zoom / Fit map to xyflow's viewport API.
function WorkflowToolbar() {
  const flow = useReactFlow();
  return (
    <div className="view-toolbar pbx-wf-toolbar" role="toolbar" aria-label="Workflow view controls">
      <Tooltip label="Zoom out">
        <Button size="xs" icon variant="ghost" aria-label="Zoom out" onClick={() => flow.zoomOut()}><ZoomOutIcon /></Button>
      </Tooltip>
      <Tooltip label="Zoom in">
        <Button size="xs" icon variant="ghost" aria-label="Zoom in" onClick={() => flow.zoomIn()}><ZoomInIcon /></Button>
      </Tooltip>
      <Tooltip label="Fit to view">
        <Button size="xs" icon variant="ghost" aria-label="Fit workflow to view" onClick={() => flow.fitView({ padding: 0.15, maxZoom: 1 })}><FitIcon /></Button>
      </Tooltip>
    </div>
  );
}

function WorkflowGraph({ payload }: { payload: WorkflowPayload }) {
  const { nodes, edges } = useMemo(() => buildWorkflowGraph(payload), [payload]);
  return (
    <div className="pbx-wf-flow">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={WF_NODE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          minZoom={0.2}
          maxZoom={1.5}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} />
          <WorkflowToolbar />
        </ReactFlow>
      </ReactFlowProvider>
      {nodes.length === 0 && (
        <div className="pbx-wf-empty">
          <Empty icon={<ImagesIcon />} title="No nodes" description="This workflow has no renderable nodes." />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the drawer

/** The read-only "Inspect workflow" drawer (Studio S10, design §5 side panels are
 *  Drawer side="right"). Opened from the image info popover's alias row. The
 *  header shows the alias/stem and the ``_doc``; the body is a read-only xyflow
 *  render of the API-format graph with the substituted slots flagged; when the
 *  operator has configured ``comfy_ui_url`` an "Open in ComfyUI" new-tab link
 *  shows (never framed, proxied or fetched — studio.md §2). */
export function WorkflowDrawer({ open, alias, workflowsHash, onClose }: {
  open: boolean;
  alias: string | null;
  workflowsHash?: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<WorkflowPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || !alias) return;
    let alive = true;
    setLoading(true);
    setError("");
    setData(null);
    fetchWorkflow(alias, workflowsHash)
      .then((p) => { if (alive) setData(p); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, alias, workflowsHash]);

  // Esc closes the Drawer WITHOUT bubbling to the app's root keydown — that one
  // also leaves an Inpaint/Outpaint mode (App.tsx onRootKeyDown), and the card
  // forbids the inspector from disturbing modes. A capture-phase listener with
  // stopPropagation keeps Esc scoped to the drawer; the DS Drawer still handles
  // the backdrop/close-button path.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Move focus into the drawer on open so Tab/Esc are scoped here; focus returns
  // to the Inspect trigger on close (StageView owns that, keeping the popover
  // mounted so the trigger survives).
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;
  const doc = workflowDoc(data?.workflow);
  return (
    <Drawer open={open} onClose={onClose} side="right" className="pbx-wf-drawer"
      label={alias ? `Workflow: ${alias}` : "Workflow"}>
      <div className="pbx-wf">
        <div className="pbx-wf-head">
          <div className="pbx-wf-head-main">
            <span className="pbx-wf-kicker">Workflow</span>
            <h2 className="pbx-wf-title">{alias || "Unknown"}{data?.stem ? ` · ${data.stem}` : ""}</h2>
            <p className="pbx-wf-doc">{doc || (loading ? "Loading…" : "No description provided.")}</p>
          </div>
          <Tooltip label="Close">
            <Button ref={closeRef} size="xs" icon variant="ghost" aria-label="Close workflow inspector" onClick={onClose}>
              <CloseIcon />
            </Button>
          </Tooltip>
        </div>

        <div className="pbx-wf-body">
          {loading ? (
            <div className="pbx-wf-status" role="status"><Spinner label="Loading workflow" /></div>
          ) : error ? (
            <div className="pbx-wf-status"><Callout tone="error" title="Could not load workflow">{error}</Callout></div>
          ) : data ? (
            <WorkflowGraph payload={data} />
          ) : null}
        </div>

        {data?.comfy_ui_url ? (
          <div className="pbx-wf-foot">
            <a className="pbx-wf-link" href={data.comfy_ui_url} target="_blank" rel="noopener noreferrer">
              Open in ComfyUI ↗
            </a>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
