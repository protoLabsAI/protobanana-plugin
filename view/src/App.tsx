import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CatalogEntry,
  type JobRequest,
  type JobState,
  fetchCatalog,
  getJob,
  fetchHistory,
  fetchHistoryImage,
  type HistoryRecord,
  ready,
  sendToAgent,
  submitJob,
  subscribe,
} from "./api";
import { Gallery } from "./Gallery";
import { OpForm, MarginCanvas } from "./OpForm";
import { Lineage } from "./Lineage";
import { Compare } from "./Compare";
import { QueueStrip, type QueueItem } from "./QueueStrip";

// Poll GET /jobs/{id} as a FALLBACK for the bus (design R1 / card): short
// requests, never a long-poll. Whichever of the bus event or a poll lands first
// settles the job; the other is torn down.
const POLL_MS = 2500;

export type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "pending"; jobId: string; startedAt: number; queuePosition: number }
  | { kind: "done"; url: string; mediaId: string | null; elapsed: number }
  | { kind: "failed"; error: string; errorKind: string; recoverable: boolean; hint: string };

function failedPhase(d: Partial<JobState>): Phase {
  return {
    kind: "failed",
    error: d.error || "render failed",
    errorKind: d.error_kind || "error",
    recoverable: Boolean(d.recoverable),
    hint: d.hint || "",
  };
}

// The job store is in-memory, so a plugin reload, host restart, or ring eviction
// makes GET /jobs/{id} 404 (getJob → null) for a job we are still tracking. When
// that persists and no bus event lands either, we surface THIS recoverable
// failure rather than hanging in `pending` forever with Generate disabled.
function lostPhase(): Phase {
  return {
    kind: "failed",
    error: "job not found",
    errorKind: "job_missing",
    recoverable: true,
    hint: "Lost track of this render — the Studio reloaded or the job expired. Press Retry to run it again.",
  };
}

/** Submit a job and track it to completion over the bus, with a GET /jobs/{id}
 *  polling backstop. Returns the current phase and a `run(req)` launcher. */
export function useJobRunner() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const cleanupRef = useRef<() => void>(() => {});

  const generation = useRef(0);

  // Tear down subscriptions/poll on unmount.
  useEffect(() => () => { generation.current++; cleanupRef.current(); }, []);

  const run = useCallback(async (req: JobRequest) => {
    cleanupRef.current();
    const token = ++generation.current;
    setPhase({ kind: "submitting" });

    let jobId: string;
    try {
      jobId = await submitJob(req); // returns a job_id in well under 1 s (R1)
    } catch (e) {
      if (token !== generation.current) return;
      setPhase({
        kind: "failed",
        error: String(e),
        errorKind: "error",
        recoverable: false,
        hint: "Could not reach the Studio API — is the plugin loaded?",
      });
      return;
    }

    if (token !== generation.current) return;
    setPhase({ kind: "pending", jobId, startedAt: Date.now(), queuePosition: 0 });

    let settled = false;
    const finish = (p: Phase) => {
      if (settled || token !== generation.current) return;
      settled = true;
      cleanupRef.current();
      setPhase(p);
    };

    const matches = (data: unknown): (JobState & Record<string, unknown>) | null => {
      const d = data as (JobState & Record<string, unknown>) | null;
      return d && typeof d === "object" && d.job_id === jobId ? d : null;
    };
    const onDone = (data: unknown) => {
      const d = matches(data);
      if (d) finish({ kind: "done", url: d.url || "", mediaId: d.media_id ?? null, elapsed: d.elapsed_s ?? 0 });
    };
    const onFailed = (data: unknown) => {
      const d = matches(data);
      if (d) finish(failedPhase(d));
    };

    const offDone = subscribe("protobanana.job.done", onDone);
    const offFailed = subscribe("protobanana.job.failed", onFailed);

    // One authoritative "can't reach this job" signal: count consecutive ticks
    // where we observe no live job — a 404 (getJob → null, the store was wiped)
    // OR a thrown request error. Any live read resets it. After MAX_STRIKES with
    // no bus event either, give up polling and surface a recoverable failure so
    // the form re-enables instead of hanging in `pending`.
    let strikes = 0;
    const MAX_STRIKES = 4; // ~4 × POLL_MS ≈ 10s grace; the bus can still win first

    const strike = () => {
      strikes += 1;
      if (strikes >= MAX_STRIKES) finish(lostPhase());
    };

    const poll = window.setInterval(async () => {
      if (settled || token !== generation.current) return;
      let st: JobState | null;
      try {
        st = await getJob(jobId);
      } catch {
        strike(); // transient request error — but don't hang forever on it
        return;
      }
      if (settled || token !== generation.current) return;
      if (st === null) {
        strike(); // 404: job gone from the in-memory store (reload/restart/evicted)
        return;
      }
      strikes = 0;
      if (st.status === "done") {
        finish({ kind: "done", url: st.url || "", mediaId: st.media_id ?? null, elapsed: st.elapsed_s ?? 0 });
      } else if (st.status === "failed") {
        finish(failedPhase(st));
      } else {
        const qp = st.queue_position ?? 0;
        setPhase((p) => (p.kind === "pending" && p.jobId === jobId ? { ...p, queuePosition: qp } : p));
      }
    }, POLL_MS);

    cleanupRef.current = () => {
      offDone();
      offFailed();
      window.clearInterval(poll);
    };
  }, []);

  return { phase, run };
}

function useImage(ref?: string | null) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (!ref) return;
    if (/^(data:|blob:|https?:|\/)/.test(ref)) { setUrl(ref); return; }
    let alive = true;
    let blob: string | undefined;
    fetchHistoryImage(ref).then(value => { blob = value; if (alive) setUrl(value); else URL.revokeObjectURL(value); }).catch(() => {});
    return () => { alive = false; if (blob) URL.revokeObjectURL(blob); };
  }, [ref]);
  return url;
}

export function App() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  // Catalog provenance (Studio S6): source "static" means the live gateway
  // catalog was unreachable and we're on the built-in schema (→ banner);
  // warnings flag configured aliases the gateway doesn't know (→ Settings hint).
  const [catalogSource, setCatalogSource] = useState<string>("gateway");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [op, setOp] = useState("generate");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [selected, setSelected] = useState<HistoryRecord>();
  const [result, setResult] = useState<{ mediaId: string | null; url: string; elapsed: number }>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const [focus, setFocus] = useState<{ id: string }>();
  // Install before ready(): the host drains its inbox during that handshake,
  // including when opening a previously collapsed/unmounted dock.
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== (location.ancestorOrigins?.[0] || location.origin)) return;
      const message = event.data;
      if (message?.type !== "protobanana:focus" || typeof message.focus !== "string" ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(message.focus)) return;
      setFocus({ id: message.focus });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  const reload = useCallback(async () => {
    const all: HistoryRecord[] = [];
    let cursor: number | null = null;
    do {
      const page = await fetchHistory({ cursor, limit: 100 });
      all.push(...page.records); cursor = page.next_cursor;
    } while (cursor !== null);
    setRecords(all);
    return all;
  }, []);
  useEffect(() => {
    let alive = true;
    ready().then(async () => {
      try {
        const cat = await fetchCatalog();
        if (alive) { setCatalog(cat.ops); setCatalogSource(cat.source); setWarnings(cat.warnings); }
        await reload();
      }
      catch (e) { if (alive) setError(String(e)); }
    });
    return () => { alive = false; };
  }, [reload]);
  useEffect(() => subscribe("protobanana.job.done", () => { reload().catch(e => setError(String(e))); }), [reload]);
  useEffect(() => {
    if (!focus) return;
    let alive = true;
    ready().then(reload).then(all => {
      if (!alive) return;
      const rec = all.find(r => r.media_id === focus.id);
      setSelected(rec);
      setResult(undefined);
      setError(rec ? "" : `Image ${focus.id} is not in Studio history. It may predate the Studio or have expired.`);
    }).catch(e => { if (alive) setError(`Could not focus image ${focus.id}: ${e}`); });
    return () => { alive = false; };
  }, [focus, reload]);
  const entry = catalog?.find(e => e.op === op);
  useEffect(() => {
    if (entry) setParams(Object.fromEntries(Object.entries(entry.params.properties).map(([key, schema]) =>
      [key, schema.default ?? (schema.type === "array" ? Array(schema.minItems || 2).fill("") : schema.type === "boolean" ? false : "")])));
  }, [entry]);
  const submit = useCallback((req: JobRequest) => {
    setQueue(q => [...q, { id: ++sequence.current, request: req, startedAt: Date.now() }]);
  }, []);
  const completed = useCallback((item: QueueItem, phase: Extract<Phase, { kind: "done" }>) => {
    setResult(phase);
    if (phase.mediaId) setSelected({ media_id: phase.mediaId, parent_id: item.request.parent_id || null,
      op: item.request.op, alias: item.request.alias || null, params: item.request.params,
      source: "studio", job_id: null, created: Date.now() / 1000, starred: false, pruned: false });
    setQueue(q => q.filter(job => job.id !== item.id));
    setRevision(v => v + 1);
    reload().catch(e => setError(String(e)));
  }, [reload]);
  const current = useImage(result?.url || selected?.media_id);
  const parent = useImage(selected?.parent_id);
  const outpaint = useImage(String(params.image || ""));
  return <div className="studio">
    <header className="topbar"><span className="dot" /><h1>protoBanana Studio</h1><span className="spacer" /><span className="hint">Playground</span></header>
    <aside className="pane left">
      {catalogSource === "static" && <p className="banner banner-stale" role="status">
        Showing the built-in schema — the live gateway catalog is unavailable. New models or
        param changes won't appear until it's reachable again.
      </p>}
      {warnings.length > 0 && <div className="banner banner-warn" role="alert">
        <strong>Settings</strong>
        <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      </div>}
      <label className="field">Operation<select aria-label="Operation" value={op} onChange={e => setOp(e.target.value)}>
        {(catalog || []).map(e => <option key={e.op} value={e.op}>{e.label}</option>)}
      </select></label>
      {error && <p role="alert">{error}</p>}
      {entry ? <OpForm key={entry.op} entry={entry} current={selected?.media_id} records={records} params={params} setParams={setParams}
        onSubmit={req => {
          const source = req.params.image || (Array.isArray(req.params.images) ? req.params.images[0] : undefined);
          const parentId = records.find(r => r.media_id === source)?.media_id;
          submit({ ...req, parent_id: parentId || (req.op === "generate" ? selected?.media_id : undefined) });
        }} /> : <p>Loading operations…</p>}
    </aside>
    <main className="pane centre">
      <Compare key={selected?.media_id} current={current} parent={parent} />
      {op === "outpaint" && <MarginCanvas url={outpaint} params={params} set={(k, v) => setParams(p => ({ ...p, [k]: v }))} />}
      {selected && <div className="meta-row"><span>Current: {selected.op} · {selected.media_id}</span>
        <button type="button" onClick={() => sendToAgent(selected)}>Send to agent</button>
        <button type="button" onClick={() => { setSelected(undefined); setResult(undefined); }}>New root</button>
        {result && <span>done in {result.elapsed}s</span>}
        {current && <a href={current} target="_blank" rel="noreferrer">Open in new tab</a>}</div>}
      <QueueStrip items={queue} catalog={catalog || []} onDone={completed} onCancel={id => setQueue(q => q.filter(j => j.id !== id))} />
    </main>
    <aside className="pane right"><Lineage records={records} selected={selected?.media_id} onSelect={rec => { setSelected(rec); setResult(undefined); }} onBranch={submit} />
      <Gallery revision={revision} catalog={catalog} onRerun={submit} /></aside>
  </div>;
}
