import { useEffect, useRef, useState } from "react";
import { type CatalogEntry, type JobRequest } from "./api";
import { type Phase, useJobRunner } from "./App";

export interface QueueItem { id: number; request: JobRequest; startedAt: number }
interface Props {
  items: QueueItem[]; catalog: CatalogEntry[];
  onDone: (item: QueueItem, phase: Extract<Phase, { kind: "done" }>) => void;
  onCancel: (id: number) => void;
}
function QueueJob({ item, entry, onDone, onCancel }: { item: QueueItem; entry?: CatalogEntry } & Pick<Props, "onDone" | "onCancel">) {
  const { phase, run } = useJobRunner();
  const [now, setNow] = useState(Date.now());
  const [startedAt, setStartedAt] = useState(item.startedAt);
  const reported = useRef(false);
  useEffect(() => {
    // StrictMode replays effects in development. Defer until that replay has
    // completed so one user submission still creates exactly one GPU job.
    let active = true;
    queueMicrotask(() => { if (active) run(item.request); });
    return () => { active = false; };
  }, [item, run]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { if (phase.kind === "done" && !reported.current) { reported.current = true; onDone(item, phase); } }, [phase, item, onDone]);
  const recoverable = phase.kind === "failed" && (phase.recoverable || phase.errorKind === "gateway_timeout");
  return <div className="queue-job" role="status">
    <strong>{entry?.label || item.request.op}</strong>
    <span>{Math.max(0, Math.floor((now - startedAt) / 1000))}s elapsed · ~{entry?.typical_latency_s ?? "?"}s typical</span>
    {phase.kind === "pending" && <span>{phase.queuePosition > 0 ? `Queued · position ${phase.queuePosition}` : "Rendering…"}</span>}
    <small className="hint">First render or model swap can take longer while the model loads.</small>
    {phase.kind === "failed" && <span>{recoverable ? "Render interrupted" : "Render failed"}: {phase.hint || phase.error}</span>}
    {recoverable && <button type="button" onClick={() => { setStartedAt(Date.now()); run(item.request); }}>Retry</button>}
    <button type="button" title="Abandon tracking only. The gateway cannot interrupt ComfyUI; the render continues on the GPU."
      onClick={() => onCancel(item.id)}>Cancel</button>
  </div>;
}
export function QueueStrip({ items, catalog, onDone, onCancel }: Props) {
  return <section className="queue-strip" aria-label="Render queue"><h2 className="section-title">Queue {items.length ? `· ${items.length}` : ""}</h2>
    {items.length ? items.map(item => <QueueJob key={item.id} item={item} entry={catalog.find(e => e.op === item.request.op)} onDone={onDone} onCancel={onCancel} />) : <p className="hint">Ready to render</p>}
  </section>;
}
