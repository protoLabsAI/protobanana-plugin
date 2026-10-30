import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type CatalogEntry,
  type JobRequest,
  type JobState,
  fetchCatalog,
  getJob,
  mediaSrc,
  ready,
  submitJob,
  subscribe,
} from "./api";

// Poll GET /jobs/{id} as a FALLBACK for the bus (design R1 / card): short
// requests, never a long-poll. Whichever of the bus event or a poll lands first
// settles the job; the other is torn down.
const POLL_MS = 2500;

type Phase =
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
function useJobRunner() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const cleanupRef = useRef<() => void>(() => {});

  // Tear down subscriptions/poll on unmount.
  useEffect(() => () => cleanupRef.current(), []);

  const run = useCallback(async (req: JobRequest) => {
    cleanupRef.current();
    setPhase({ kind: "submitting" });

    let jobId: string;
    try {
      jobId = await submitJob(req); // returns a job_id in well under 1 s (R1)
    } catch (e) {
      setPhase({
        kind: "failed",
        error: String(e),
        errorKind: "error",
        recoverable: false,
        hint: "Could not reach the Studio API — is the plugin loaded?",
      });
      return;
    }

    setPhase({ kind: "pending", jobId, startedAt: Date.now(), queuePosition: 0 });

    let settled = false;
    const finish = (p: Phase) => {
      if (settled) return;
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
      if (settled) return;
      let st: JobState | null;
      try {
        st = await getJob(jobId);
      } catch {
        strike(); // transient request error — but don't hang forever on it
        return;
      }
      if (settled) return;
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

/** A live tabular-digits seconds counter (isolated so only it re-renders). */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  return <>{Math.max(0, Math.round((now - startedAt) / 1000))}s</>;
}

// ------------------------------------------------------------- Generate form

const SIZE_PRESETS = [
  { label: "Square", value: "1024x1024" },
  { label: "Portrait", value: "768x1280" },
  { label: "Landscape", value: "1280x768" },
  { label: "Wide", value: "1344x768" },
  { label: "Tall", value: "768x1344" },
];

function schemaDefault(entry: CatalogEntry, key: string, fallback: string): string {
  const v = entry.params.properties[key]?.default;
  return typeof v === "string" ? v : fallback;
}

interface GenerateFormProps {
  entry: CatalogEntry;
  busy: boolean;
  onSubmit: (req: JobRequest) => void;
}

function GenerateForm({ entry, busy, onSubmit }: GenerateFormProps) {
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState(() => schemaDefault(entry, "negative_prompt", ""));
  const [size, setSize] = useState(() => schemaDefault(entry, "size", "1024x1024"));
  const [tier, setTier] = useState<string>(entry.default_tier || "final");
  const [locked, setLocked] = useState(false);
  const [seed, setSeed] = useState(0);

  const roll = () => {
    setSeed(Math.floor(Math.random() * 2 ** 31));
    setLocked(true);
  };
  const toggleLock = () => {
    setLocked((was) => {
      if (!was && seed === 0) setSeed(Math.floor(Math.random() * 2 ** 31));
      return !was;
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || busy) return;
    onSubmit({
      op: "generate",
      tier,
      params: {
        prompt: prompt.trim(),
        negative_prompt: negative,
        size,
        // Locked → the fixed, reproducible seed; unlocked → -1 (the runner reads
        // a negative seed as "random", exactly as the agent tool does).
        seed: locked ? seed : -1,
      },
    });
  };

  return (
    <form className="form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="prompt">Prompt</label>
        <textarea
          id="prompt"
          value={prompt}
          placeholder="a studio product shot of a ripe banana on seamless paper"
          onChange={(e) => setPrompt(e.target.value)}
          autoFocus
        />
      </div>

      <div className="field">
        <label htmlFor="negative">Negative prompt</label>
        <input
          id="negative"
          type="text"
          value={negative}
          placeholder="what to avoid (optional)"
          onChange={(e) => setNegative(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Size</label>
        <div className="chips" role="group" aria-label="Size presets">
          {SIZE_PRESETS.map((p) => (
            <button
              type="button"
              key={p.value}
              className="chip"
              aria-pressed={size === p.value}
              onClick={() => setSize(p.value)}
            >
              {p.label} · {p.value}
            </button>
          ))}
        </div>
        <input
          type="text"
          aria-label="Custom size (WxH)"
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
        <span className="desc">{entry.params.properties.size?.description}</span>
      </div>

      <div className="field">
        <label>Seed</label>
        <div className="seed-row">
          <input
            type="number"
            min={0}
            aria-label="Seed"
            value={locked ? seed : ""}
            placeholder="random"
            disabled={!locked}
            onChange={(e) => setSeed(Math.max(0, Number(e.target.value) || 0))}
          />
          <button
            type="button"
            className="icon-btn"
            aria-pressed={locked}
            aria-label={locked ? "Seed locked (reused each render)" : "Seed random each render"}
            title={locked ? "Locked — this seed is reused" : "Unlocked — a random seed each render"}
            onClick={toggleLock}
          >
            {locked ? "🔒" : "🔓"}
          </button>
          <button type="button" className="icon-btn" aria-label="Roll a new random seed" title="Roll a new seed" onClick={roll}>
            🎲
          </button>
        </div>
        <span className="desc">{locked ? "Fixed seed — reproducible." : "A fresh random seed each render."}</span>
      </div>

      <div className="field">
        <label>Quality tier</label>
        <div className="toggle" role="group" aria-label="Quality tier">
          <button type="button" aria-pressed={tier === "draft"} onClick={() => setTier("draft")}>
            Draft
          </button>
          <button type="button" aria-pressed={tier === "final"} onClick={() => setTier("final")}>
            Final
          </button>
        </div>
        <span className="desc">
          {tier === "draft" ? "Fast turbo tier — rapid exploration." : "Full model — best quality."}{" "}
          {entry.aliases[tier] ? `(${entry.aliases[tier]})` : ""}
        </span>
      </div>

      <button className="submit" type="submit" disabled={busy || !prompt.trim()}>
        {busy ? "Rendering…" : "Generate"}
      </button>
    </form>
  );
}

// -------------------------------------------------------------- centre canvas

function Canvas({ entry, phase, onRetry }: { entry?: CatalogEntry; phase: Phase; onRetry: () => void }) {
  if (phase.kind === "done") {
    return (
      <>
        <div className="canvas">
          <img className="result" src={mediaSrc(phase.url)} alt="Generated image" />
        </div>
        <div className="meta-row">
          <span>done in {phase.elapsed}s</span>
          {phase.mediaId ? <span>media {phase.mediaId}</span> : null}
          {phase.url ? (
            <a href={mediaSrc(phase.url)} target="_blank" rel="noreferrer">
              Open in new tab
            </a>
          ) : null}
        </div>
      </>
    );
  }

  if (phase.kind === "failed") {
    const recoverable = phase.recoverable || phase.errorKind === "gateway_timeout";
    // A 524 keeps the GPU job running (retry re-attaches); a missing job was lost
    // and must be re-run. Both are recoverable (Retry shows), but say which.
    const heading =
      phase.errorKind === "gateway_timeout" ? "Still rendering" : recoverable ? "Render interrupted" : "Render failed";
    return (
      <div className="canvas">
        <div className={`failure${recoverable ? " recoverable" : ""}`}>
          <div className="kind">{heading}</div>
          <div className="hint">{phase.hint || phase.error}</div>
          {recoverable ? (
            <button className="submit" type="button" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (phase.kind === "pending" || phase.kind === "submitting") {
    const startedAt = phase.kind === "pending" ? phase.startedAt : Date.now();
    const queued = phase.kind === "pending" && phase.queuePosition > 0;
    return (
      <div className="canvas">
        <div className="pending">
          <div className="spinner" aria-hidden="true" />
          <div className="elapsed">
            <Elapsed startedAt={startedAt} />
          </div>
          <div>{queued ? "Queued behind another render…" : "Rendering…"}</div>
          {entry ? <div className="hint">~{entry.typical_latency_s}s typical</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="canvas">
      <div className="placeholder">
        <p>Fill the form and press Generate.</p>
        <p className="hint">The image appears here when the render completes.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------- shell

export function App() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string>("");
  const [selectedOp, setSelectedOp] = useState("generate");
  const lastReq = useRef<JobRequest | null>(null);
  const { phase, run } = useJobRunner();

  useEffect(() => {
    let alive = true;
    (async () => {
      await ready(); // bearer + theme handshake first
      try {
        const ops = await fetchCatalog();
        if (alive) setCatalog(ops);
      } catch (e) {
        if (alive) setCatalogError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const entry = useMemo(() => catalog?.find((e) => e.op === selectedOp), [catalog, selectedOp]);
  const busy = phase.kind === "submitting" || phase.kind === "pending";

  const submit = useCallback(
    (req: JobRequest) => {
      lastReq.current = req;
      run(req);
    },
    [run],
  );
  const retry = useCallback(() => {
    if (lastReq.current) run(lastReq.current);
  }, [run]);

  const generateEntry = catalog?.find((e) => e.op === "generate");

  return (
    <div className="studio">
      <header className="topbar">
        <span className="dot" aria-hidden="true" />
        <h1>protoBanana Studio</h1>
        <span className="spacer" />
        <span className="hint">
          {entry ? `${entry.label} · ~${entry.typical_latency_s}s` : catalogError ? "catalog unavailable" : "loading…"}
        </span>
      </header>

      <aside className="pane left">
        <nav>
          <ul className="op-nav">
            {(catalog || []).map((e) => {
              const active = e.op === selectedOp;
              // S1b wires Generate only; the rest render in the shell as the
              // later Playground slice (S3) with an honest "soon" badge.
              const wired = e.op === "generate";
              return (
                <li key={e.op}>
                  <button
                    type="button"
                    aria-current={active}
                    disabled={!wired}
                    onClick={() => wired && setSelectedOp(e.op)}
                  >
                    {e.label}
                    {e.licence?.non_commercial ? <span className="badge-nc">NC</span> : null}
                    {!wired ? <span className="later">S3</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {catalogError ? (
          <p className="hint">Could not load the catalog ({catalogError}). The Studio API may be unavailable.</p>
        ) : !catalog ? (
          <p className="hint">Loading operations…</p>
        ) : generateEntry && selectedOp === "generate" ? (
          <GenerateForm entry={generateEntry} busy={busy} onSubmit={submit} />
        ) : (
          <p className="hint">This operation arrives in the S3 Playground slice.</p>
        )}
      </aside>

      <main className="pane centre">
        <Canvas entry={entry || generateEntry} phase={phase} onRetry={retry} />
      </main>

      <aside className="pane right">
        <h2 className="section-title">Gallery</h2>
        <div className="gallery-ph" aria-hidden="true">
          <div className="tile" />
          <div className="tile" />
          <div className="tile" />
        </div>
        <p className="hint">
          The lineage gallery arrives in S2. Renders you make here already persist to the media store and will appear
          then.
        </p>
      </aside>
    </div>
  );
}
