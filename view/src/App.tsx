import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
  submitJob,
  subscribe,
} from "./api";
import { ActionBar, type EditMode } from "./ActionBar";
import { Composer, type Margins } from "./Composer";
import { Gallery } from "./Gallery";
import { MarginCanvas } from "./OpForm";
import { MaskEditor } from "./MaskEditor";
import {
  Badge,
  Banner,
  Button,
  Callout,
  Drawer,
  Empty,
  ImagesIcon,
  PanelHeader,
  Progress,
  Skeleton,
  Spinner,
  Tabs,
  ToastProvider,
} from "./ds-pending";

const ZERO_MARGINS: Margins = { left: 0, top: 0, right: 0, bottom: 0 };

// Poll GET /jobs/{id} as a FALLBACK for the bus (design R1 / card): short
// requests, never a long-poll. Whichever of the bus event or a poll lands first
// settles the job; the other is torn down.
const POLL_MS = 2500;

// Below this width of the VIEW'S OWN root (container query, not the viewport —
// design §8) History collapses into a right-side Drawer opened from the header.
const NARROW_PX = 780;

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

// A queued/in-flight render (design §7). We keep the same QueueItem + job-runner
// machinery as before; it is just rendered on the canvas and the header badge
// now, not in a permanent Queue section.
export interface QueueItem { id: number; request: JobRequest; startedAt: number }

/** One headless tracker per queued render: it drives a useJobRunner to
 *  completion and reports phase/outcome up to the shell, which paints the
 *  canvas overlay and the header badge. */
function JobTracker({ item, onPhase, onDone, onFail }: {
  item: QueueItem;
  onPhase: (id: number, phase: Phase, jobId: string | null) => void;
  onDone: (item: QueueItem, phase: Extract<Phase, { kind: "done" }>) => void;
  onFail: (item: QueueItem, phase: Extract<Phase, { kind: "failed" }>, jobId: string | null) => void;
}) {
  const { phase, run } = useJobRunner();
  const jobId = useRef<string | null>(null);
  const reported = useRef(false);

  useEffect(() => {
    // StrictMode replays effects in development; defer the launch so one user
    // submission still creates exactly one GPU job.
    let active = true;
    queueMicrotask(() => { if (active) run(item.request); });
    return () => { active = false; };
  }, [item, run]);

  useEffect(() => { if (phase.kind === "pending") jobId.current = phase.jobId; }, [phase]);

  useEffect(() => {
    onPhase(item.id, phase, jobId.current);
    if (!reported.current && phase.kind === "done") { reported.current = true; onDone(item, phase); }
    if (!reported.current && phase.kind === "failed") { reported.current = true; onFail(item, phase, jobId.current); }
  }, [phase, item, onPhase, onDone, onFail]);

  return null;
}

/** The render overlay that sits over the (dimmed) previous image while a job is
 *  in flight (design §7): spinner, honest elapsed/typical, a Progress against
 *  the catalog's typical latency that turns indeterminate past it, a cold-load
 *  line after 1.5× typical, and a ghost Stop. role="status" lives on the shell. */
function RenderOverlay({ item, entry, onStop }: { item: QueueItem; entry?: CatalogEntry; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(t); }, []);
  const elapsed = Math.max(0, Math.floor((now - item.startedAt) / 1000));
  const typical = entry?.typical_latency_s ?? 25;
  const cold = elapsed > typical * 1.5;
  return (
    <div className="render-overlay">
      <div className="render-overlay-row">
        <Spinner size={18} />
        <span className="render-overlay-text">Rendering · {elapsed}s · usually ~{typical}s</span>
      </div>
      <Progress ariaLabel="Render progress" indeterminate={elapsed > typical} value={(elapsed / typical) * 100} />
      {cold && <span className="render-overlay-cold">Model is loading — first render after a swap can take longer</span>}
      <Button
        variant="ghost"
        size="sm"
        className="render-overlay-stop"
        title="Stops tracking; the GPU still finishes. The result will appear in History."
        onClick={onStop}
      >
        Stop
      </Button>
    </div>
  );
}

export function App() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  // Catalog provenance (Studio S6): source "static" means the live gateway
  // catalog was unreachable and we're on the built-in schema (→ banner);
  // warnings flag configured aliases the gateway doesn't know (→ Settings hint).
  const [catalogSource, setCatalogSource] = useState<string>("gateway");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [unreachable, setUnreachable] = useState("");
  const [focusError, setFocusError] = useState("");

  const [selected, setSelected] = useState<HistoryRecord>();
  const [result, setResult] = useState<{ mediaId: string | null; url: string; elapsed: number }>();
  const [upload, setUpload] = useState<string>();
  const [prunedSelected, setPrunedSelected] = useState(false);

  // The active edit verb on the current image (design §4.3). `null` is the
  // default whole-image edit; the contextual modes put extra controls on the
  // canvas (Inpaint mask, Outpaint margins) and in the composer. `mask` and
  // `margins` are shared so the canvas and composer stay in lock-step (the
  // composer's numeric margins are the WCAG 2.5.7 dragging alternative).
  const [mode, setMode] = useState<EditMode>(null);
  const [mask, setMask] = useState("");
  const [margins, setMargins] = useState<Margins>(ZERO_MARGINS);
  // A bounded recent-history slice for the Compose "pick from History" slots,
  // emitted by the History grid (no extra fetch of its own).
  const [records, setRecords] = useState<HistoryRecord[]>([]);

  const leaveMode = useCallback(() => {
    setMode(null);
    setMask("");
    setMargins(ZERO_MARGINS);
  }, []);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [phases, setPhases] = useState<Record<number, { phase: Phase; jobId: string | null }>>({});
  const [callouts, setCallouts] = useState<{ item: QueueItem; phase: Extract<Phase, { kind: "failed" }>; jobId: string | null }[]>([]);

  const [revision, setRevision] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);
  const sequence = useRef(0);
  const [focus, setFocus] = useState<{ id: string }>();

  // Container-query sizing: measure the VIEW'S OWN width (ResizeObserver on the
  // root), not the viewport, so History collapses with the Work panel (§8).
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth < NARROW_PX);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (!narrow) setDrawerOpen(false); }, [narrow]);

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

  // Resolve the shared history index on demand — used only to turn a focused
  // media id into a record (§5 "Send to agent" inbox). History's own grid owns
  // its paging/refresh (Gallery), so the shell keeps no records of its own.
  const reload = useCallback(async () => {
    const all: HistoryRecord[] = [];
    let cursor: number | null = null;
    do {
      const page = await fetchHistory({ cursor, limit: 100 });
      all.push(...page.records); cursor = page.next_cursor;
    } while (cursor !== null);
    return all;
  }, []);

  useEffect(() => {
    let alive = true;
    ready().then(async () => {
      try {
        const cat = await fetchCatalog();
        if (!alive) return;
        setCatalog(cat.ops); setCatalogSource(cat.source); setWarnings(cat.warnings);
        // The static-fallback warning carries the raw gateway exception (an httpx
        // error, often with a URL). Keep it OUT of the visible banner — log it and
        // surface it only behind the banner's Details disclosure (fix round: a).
        if (cat.source === "static" && cat.warnings.length) {
          console.error("protoBanana: live model catalog unavailable —", cat.warnings.join("; "));
        }
      }
      catch (e) {
        if (!alive) return;
        console.error("protoBanana: Studio plugin/API unreachable —", e);
        setUnreachable(String(e));
      }
    });
    return () => { alive = false; };
  }, []);

  // Land a finished render as the current image: show it and, when it has a
  // media id, synthesise an optimistic History record so the canvas and the
  // (soon-to-refresh) grid agree before the index reloads.
  const landResult = useCallback((mediaId: string | null, url: string, elapsed: number, req?: JobRequest) => {
    setResult({ mediaId, url, elapsed });
    if (mediaId) setSelected({ media_id: mediaId, parent_id: req?.parent_id || null, op: req?.op || "generate",
      alias: req?.alias || null, params: req?.params || {}, source: "studio", job_id: null,
      created: Date.now() / 1000, starred: false, pruned: false });
    setUpload(undefined);
    setPrunedSelected(false);
    leaveMode(); // a fresh current image resets to the default edit verb
  }, [leaveMode]);

  // History keeps listening on the bus (ADR 0039 / design §7): a late result for
  // a job whose error callout is still showing clears that callout and lands the
  // image. (Gallery refreshes its own grid off the same bus topic + `revision`.)
  useEffect(() => subscribe("protobanana.job.done", (data) => {
    const d = data as JobState | null;
    const callout = d && callouts.find(c => c.jobId === d.job_id);
    if (d && callout) {
      setCallouts(cs => cs.filter(c => c.item.id !== callout.item.id));
      landResult(d.media_id ?? null, d.url || "", d.elapsed_s ?? 0, callout.item.request);
      setRevision(v => v + 1);
    }
  }), [callouts, landResult]);

  useEffect(() => {
    if (!focus) return;
    let alive = true;
    ready().then(reload).then(all => {
      if (!alive) return;
      const rec = all.find(r => r.media_id === focus.id);
      setResult(undefined);
      setUpload(undefined);
      setPrunedSelected(Boolean(rec?.pruned));
      setSelected(rec);
      leaveMode();
      setFocusError(rec ? "" : `Image ${focus.id} is not in Studio history. It may predate the Studio or have expired.`);
    }).catch(e => { if (alive) setFocusError(`Could not focus image ${focus.id}: ${e}`); });
    return () => { alive = false; };
  }, [focus, reload, leaveMode]);

  const loading = catalog === null && !unreachable;

  // The current image: an uploaded/dropped/pasted data URL, a fresh render, or a
  // selected History record. Edits run against it; "Generate" when there is none.
  const displaySource = prunedSelected ? undefined : (upload || result?.url || selected?.media_id || undefined);
  const current = useImage(displaySource);
  const currentMediaId = result?.mediaId || selected?.media_id || null;
  const editRef = upload || currentMediaId;
  const hasImage = Boolean(editRef) && !prunedSelected;
  // The record backing the current image (for Vary params, Star, Send to agent).
  // Uploads have no record; a pruned selection isn't editable.
  const currentRecord = prunedSelected ? undefined : selected;

  // MarginCanvas edits one edge; mirror it into the shared Margins (keeps the
  // composer's numeric inputs in lock-step — WCAG 2.5.7).
  const setMargin = useCallback((k: string, v: unknown) => {
    setMargins(m => ({ ...m, [k]: Math.max(0, Number(v) || 0) }) as Margins);
  }, []);

  // Esc leaves the active mode (design §4.3 / §10).
  const onRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && mode !== null) leaveMode();
  };

  const submit = useCallback((req: JobRequest) => {
    setQueue(q => [...q, { id: ++sequence.current, request: req, startedAt: Date.now() }]);
  }, []);

  const handlePhase = useCallback((id: number, phase: Phase, jobId: string | null) => {
    setPhases(p => ({ ...p, [id]: { phase, jobId } }));
  }, []);

  const handleDone = useCallback((item: QueueItem, phase: Extract<Phase, { kind: "done" }>) => {
    landResult(phase.mediaId, phase.url, phase.elapsed, item.request);
    setQueue(q => q.filter(j => j.id !== item.id));
    setPhases(p => { const n = { ...p }; delete n[item.id]; return n; });
    setRevision(v => v + 1); // nudges Gallery to re-fetch the shared index
    setFocusSignal(s => s + 1); // focus is never lost when a render completes (§10)
  }, [landResult]);

  const handleFail = useCallback((item: QueueItem, phase: Extract<Phase, { kind: "failed" }>, jobId: string | null) => {
    setQueue(q => q.filter(j => j.id !== item.id));
    setPhases(p => { const n = { ...p }; delete n[item.id]; return n; });
    setCallouts(cs => [...cs, { item, phase, jobId }]);
  }, []);

  const stop = useCallback((id: number) => {
    setQueue(q => q.filter(j => j.id !== id));
    setPhases(p => { const n = { ...p }; delete n[id]; return n; });
  }, []);

  const startNew = () => {
    setSelected(undefined);
    setResult(undefined);
    setUpload(undefined);
    setPrunedSelected(false);
    setFocusError("");
    leaveMode();
    setFocusSignal(s => s + 1);
  };

  const pickRecord = (rec: HistoryRecord) => {
    setResult(undefined);
    setUpload(undefined);
    setPrunedSelected(rec.pruned);
    setSelected(rec);
    setFocusError("");
    leaveMode();
    setDrawerOpen(false);
  };

  // Load an uploaded / dropped / pasted image as the current input (§4.1).
  const loadFile = useCallback((file?: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      setSelected(undefined);
      setResult(undefined);
      setPrunedSelected(false);
      setFocusError("");
      leaveMode();
      setUpload(String(reader.result));
    };
    reader.readAsDataURL(file);
  }, [leaveMode]);
  const fileInput = useRef<HTMLInputElement>(null);

  // Active render = the oldest in-flight job; it drives the canvas overlay.
  const active = queue[0];
  const activePhase = active ? phases[active.id]?.phase : undefined;
  const activeRendering = Boolean(active) && (!activePhase || activePhase.kind === "submitting" || activePhase.kind === "pending");

  const renderingCount = queue.filter(it => {
    const p = phases[it.id]?.phase;
    return !p || p.kind === "submitting" || (p.kind === "pending" && (p.queuePosition ?? 0) === 0);
  }).length;
  const queuedCount = queue.filter(it => {
    const p = phases[it.id]?.phase;
    return p?.kind === "pending" && (p.queuePosition ?? 0) > 0;
  }).length;
  const busy = queue.length > 0;

  const calloutNodes = callouts.map(callout => {
    const dismiss = () => setCallouts(cs => cs.filter(c => c.item.id !== callout.item.id));
    const retry = () => { submit(callout.item.request); dismiss(); };
    const editPrompt = () => { dismiss(); setFocusSignal(s => s + 1); };
    const copyDetails = () => {
      const text = `${callout.phase.error}\n${callout.phase.hint}`.trim();
      try { navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
    };
    const dismissButton = <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>;
    const content = (() => {
      const kind = callout.phase.errorKind;
      if (kind === "gateway_timeout") {
        return <Callout tone="warning" title="GPU busy"
          actions={<><Button variant="primary" size="sm" onClick={retry}>Retry</Button>
            <Button variant="ghost" size="sm" onClick={editPrompt}>Edit prompt</Button>{dismissButton}</>}>
          GPU busy — the gateway timed out. Your render may still land in History.
        </Callout>;
      }
      if (callout.phase.recoverable) {
        return <Callout tone="warning" title="Lost track of this render"
          actions={<><Button variant="primary" size="sm" onClick={retry}>Retry</Button>{dismissButton}</>}>
          {callout.phase.hint || "Press Retry to run it again."}
        </Callout>;
      }
      return <Callout tone="error" title="Render failed"
        actions={<><Button variant="ghost" size="sm" onClick={copyDetails}>Copy details</Button>
          <Button variant="ghost" size="sm" onClick={editPrompt}>Edit prompt</Button>{dismissButton}</>}>
        {callout.phase.hint || callout.phase.error}
      </Callout>;
    })();
    return <section key={callout.item.id} aria-label={`Failed render: ${callout.item.request.params.prompt || callout.item.request.op}`}>
      {content}
    </section>;
  });

  const gallery = (
    <Gallery
      revision={revision}
      catalog={catalog}
      compact
      selectedId={selected?.media_id}
      onSelect={pickRecord}
      onRecords={setRecords}
    />
  );

  return (
    <ToastProvider>
    <div className={`images${narrow ? " is-narrow" : ""}`} ref={rootRef} onKeyDown={onRootKeyDown}>
      {queue.map(item => (
        <JobTracker key={item.id} item={item} onPhase={handlePhase} onDone={handleDone} onFail={handleFail} />
      ))}

      <PanelHeader
        className="images-header"
        kicker="protoBanana"
        title="Images"
        actions={
          <>
            {busy && (
              <Badge className="rendering-badge">
                <Spinner size={13} />
                {renderingCount} rendering{queuedCount ? ` · ${queuedCount} queued` : ""}
              </Badge>
            )}
            <Button variant="ghost" size="sm" className="new-btn" onClick={startNew}>+ New</Button>
            {narrow && (
              <Button variant="ghost" size="sm" className="history-btn" onClick={() => setDrawerOpen(true)}>
                History
              </Button>
            )}
          </>
        }
      >
        <Tabs
          ariaLabel="View mode"
          value="playground"
          items={[
            { id: "playground", label: "Playground" },
            { id: "pipelines", label: "Pipelines", disabled: true, title: "Coming soon" },
          ]}
        />
      </PanelHeader>

      <div className="images-body">
        <main
          className="canvas"
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); loadFile(e.dataTransfer.files?.[0]); }}
          onPaste={(e) => { const f = e.clipboardData?.files?.[0]; if (f) { e.preventDefault(); loadFile(f); } }}
        >
          {unreachable && (
            <Banner tone="error" role="alert" className="unreachable"
              action={<Button size="sm" onClick={() => location.reload()}>Reload</Button>}>
              <p className="banner-line">Couldn't reach the Studio plugin or its API. Renders and History are unavailable.</p>
              <details className="banner-details">
                <summary>Details</summary>
                <code>{unreachable}</code>
              </details>
            </Banner>
          )}

          {catalogSource === "static" && !unreachable && (
            <div className="banner banner-stale" role="status">
              <p className="banner-line">Couldn't load the live model catalog — showing the built-in list.</p>
              {warnings.length > 0 && (
                <details className="banner-details">
                  <summary>Details</summary>
                  <code>{warnings.join("\n")}</code>
                </details>
              )}
            </div>
          )}
          {/* Alias-drift notes (gateway path only) are curated and URL-free; the
              static-fallback warning is the raw exception and shows only behind
              the banner's Details disclosure above (fix round: a). */}
          {catalogSource !== "static" && warnings.length > 0 && (
            <div className="banner banner-warn" role="alert">
              <strong>Settings</strong>
              <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {focusError && <p className="banner banner-warn focus-error" role="alert">{focusError}</p>}

          <div className="stage">
            {loading ? (
              <Skeleton className="stage-skeleton" />
            ) : hasImage && mode === "inpaint" ? (
              <MaskEditor source={editRef ?? ""} onChange={setMask} />
            ) : hasImage && mode === "outpaint" ? (
              <MarginCanvas url={current} params={margins as unknown as Record<string, unknown>} set={setMargin} />
            ) : current ? (
              <img className={`stage-img${activeRendering ? " is-dimmed" : ""}`} src={current} alt="Current image" />
            ) : prunedSelected ? (
              <Empty
                className="stage-empty"
                icon={<ImagesIcon />}
                title="This image expired"
                description="star images to keep them"
              />
            ) : !unreachable ? (
              <Empty
                className="stage-empty"
                icon={<ImagesIcon />}
                title="Describe an image to start"
                description="Type a prompt below, or drop, paste, or upload an image."
                action={<Button onClick={() => fileInput.current?.click()}>Upload</Button>}
              />
            ) : null}

            {(activeRendering || calloutNodes.length > 0) && (
              <div className="overlay" role="status">
                {activeRendering && active && (
                  <RenderOverlay item={active} entry={catalog?.find(e => e.op === active.request.op)} onStop={() => stop(active.id)} />
                )}
                {calloutNodes}
              </div>
            )}
          </div>

          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept="image/*"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = ""; }}
          />

          {hasImage && (
            <ActionBar
              catalog={catalog}
              record={currentRecord}
              mediaId={currentMediaId}
              imageRef={editRef}
              imageUrl={current}
              mode={mode}
              narrow={narrow}
              onSetMode={setMode}
              onSubmit={submit}
              onFocusComposer={() => setFocusSignal(s => s + 1)}
            />
          )}

          <Composer
            catalog={catalog}
            hasImage={hasImage}
            inputRef={editRef}
            parentId={currentMediaId}
            unreachable={Boolean(unreachable)}
            focusSignal={focusSignal}
            mode={mode}
            onLeaveMode={leaveMode}
            mask={mask}
            margins={margins}
            onMarginsChange={setMargins}
            records={records}
            onSubmit={submit}
          />
        </main>

        {!narrow && <aside className="history-col">{gallery}</aside>}
      </div>

      {narrow && (
        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} side="right" label="History">
          {gallery}
        </Drawer>
      )}
    </div>
    </ToastProvider>
  );
}
