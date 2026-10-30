import { sendToAgent } from "./api";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CatalogEntry,
  type HistoryRecord,
  type JobRequest,
  fetchHistory,
  fetchHistoryImage,
  rerunParams,
  starMedia,
  subscribe,
  unstarMedia,
} from "./api";

// The right-pane gallery: one shared history index over BOTH agent renders
// (source=agent) and Studio renders (source=studio). It follows the DS
// image-viewer conventions — a lightbox, download, and open-in-new-tab — and
// adds copy-params, re-run (same params + a new seed; a locked seed reproduces),
// star (retention-proof pin), and op/starred/source filters. A pruned record
// (store original gone, not starred) renders a "pruned" tile, never a broken
// image. It refreshes on protobanana.job.done and on a manual Refresh.

const PAGE = 48;

type SourceFilter = "" | "studio" | "agent";

interface Filters {
  op: string;
  source: SourceFilter;
  starredOnly: boolean;
}

/** Fetch each non-pruned record's bytes through the kit (bearer) once and cache
 *  the resulting blob URL by media id; revoke everything on unmount. Pruned
 *  records are never fetched. */
function useImageUrls(records: HistoryRecord[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const cache = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    const wanted = records.filter((r) => !r.pruned && !cache.current.has(r.media_id));
    if (wanted.length === 0) return;
    (async () => {
      for (const rec of wanted) {
        if (!alive) return;
        try {
          const url = await fetchHistoryImage(rec.media_id);
          if (!alive) {
            URL.revokeObjectURL(url);
            return;
          }
          cache.current.set(rec.media_id, url);
          setUrls((prev) => ({ ...prev, [rec.media_id]: url }));
        } catch {
          /* leave it un-imaged; the tile shows a spinner-less placeholder */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [records]);

  // Revoke every cached blob URL when the component unmounts.
  useEffect(
    () => () => {
      for (const url of cache.current.values()) URL.revokeObjectURL(url);
      cache.current.clear();
    },
    [],
  );

  return urls;
}

function opLabel(catalog: CatalogEntry[] | null, op: string): string {
  return catalog?.find((e) => e.op === op)?.label || op;
}

// ----------------------------------------------------------------- lightbox

function Lightbox({
  rec,
  url,
  label,
  onClose,
}: {
  rec: HistoryRecord;
  url: string | undefined;
  label: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${label} preview`} onClick={onClose}>
      <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
        {url ? <img src={url} alt={`${label} render`} /> : <div className="pruned-tile">image unavailable</div>}
        <div className="lightbox-bar">
          <span className="lightbox-meta">
            {label}
            {rec.alias ? ` · ${rec.alias}` : ""} · {rec.source}
          </span>
          <span className="spacer" />
          {url ? (
            <>
              <a className="icon-btn" href={url} download={`${rec.media_id}.png`}>
                Download
              </a>
              <a className="icon-btn" href={url} target="_blank" rel="noreferrer">
                Open in new tab
              </a>
            </>
          ) : null}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close preview">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- tile

function Tile({
  rec,
  url,
  label,
  onOpen,
  onStar,
  onCopy,
  onRerun,
  copied,
}: {
  rec: HistoryRecord;
  url: string | undefined;
  label: string;
  onOpen: () => void;
  onStar: () => void;
  onCopy: () => void;
  onRerun: () => void;
  copied: boolean;
}) {
  return (
    <figure className={`g-tile${rec.pruned ? " pruned" : ""}`}>
      <button
        type="button"
        className="g-thumb"
        onClick={rec.pruned ? undefined : onOpen}
        disabled={rec.pruned}
        aria-label={rec.pruned ? "pruned render" : `open ${label} render`}
      >
        {rec.pruned ? (
          <span className="pruned-tile">
            pruned
            <small>retention removed this; star to keep future renders</small>
          </span>
        ) : url ? (
          <img src={url} alt={`${label} render`} loading="lazy" />
        ) : (
          <span className="g-loading" aria-hidden="true" />
        )}
      </button>

      <figcaption className="g-caption">
        <span className="g-op">{label}</span>
        <span className={`g-src g-src-${rec.source}`}>{rec.source}</span>
      </figcaption>

      <div className="g-actions">
        <button type="button" className="icon-btn g-send" onClick={() => sendToAgent(rec)}>Send to agent</button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={rec.starred}
          title={rec.starred ? "Starred (kept through retention)" : "Star — keep through retention"}
          aria-label={rec.starred ? "Unstar" : "Star"}
          onClick={onStar}
          disabled={rec.pruned}
        >
          {rec.starred ? "★" : "☆"}
        </button>
        <button type="button" className="icon-btn" title="Copy params as JSON" onClick={onCopy}>
          {copied ? "copied" : "copy"}
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Re-run with these params and a new seed (a locked seed reproduces)"
          onClick={onRerun}
        >
          re-run
        </button>
      </div>
    </figure>
  );
}

// ------------------------------------------------------------------ gallery

export function Gallery({
  catalog,
  onRerun,
  revision = 0,
}: {
  catalog: CatalogEntry[] | null;
  revision?: number;
  onRerun: (req: JobRequest) => void;
}) {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ op: "", source: "", starredOnly: false });

  const urls = useImageUrls(records);

  // Load the first page for the current filters (replaces the list).
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await fetchHistory({
        op: filters.op || undefined,
        source: filters.source || undefined,
        starred: filters.starredOnly ? true : undefined,
        limit: PAGE,
      });
      setRecords(page.records);
      setCursor(page.next_cursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // Append the next cursor page (keeps what's already shown).
  const loadMore = useCallback(async () => {
    if (cursor == null || loading) return;
    setLoading(true);
    try {
      const page = await fetchHistory({
        cursor,
        op: filters.op || undefined,
        source: filters.source || undefined,
        starred: filters.starredOnly ? true : undefined,
        limit: PAGE,
      });
      setRecords((prev) => [...prev, ...page.records]);
      setCursor(page.next_cursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, filters]);

  // Reload whenever the filters change…
  useEffect(() => {
    reload();
  }, [reload, revision]);

  // …and on every job completion (ADR 0039 bus-driven refresh): a fresh render —
  // whether from the agent or this view — joins the gallery within one bus tick.
  useEffect(() => {
    const off = subscribe("protobanana.job.done", () => {
      reload();
    });
    return off;
  }, [reload]);

  const copyParams = useCallback((rec: HistoryRecord) => {
    const text = JSON.stringify(rec.params ?? {}, null, 2);
    const done = () => {
      setCopied(rec.media_id);
      window.setTimeout(() => setCopied((c) => (c === rec.media_id ? null : c)), 1200);
    };
    try {
      navigator.clipboard?.writeText(text).then(done, done);
    } catch {
      done();
    }
  }, []);

  const toggleStar = useCallback(async (rec: HistoryRecord) => {
    try {
      const starred = rec.starred ? await unstarMedia(rec.media_id) : await starMedia(rec.media_id);
      setRecords((prev) => prev.map((r) => (r.media_id === rec.media_id ? { ...r, starred } : r)));
    } catch {
      /* ignore — the star button simply stays as it was */
    }
  }, []);

  const rerun = useCallback(
    (rec: HistoryRecord) => {
      onRerun({
        op: rec.op,
        params: rerunParams(rec),
        alias: rec.alias ?? undefined,
        parent_id: rec.parent_id ?? undefined,
      });
    },
    [onRerun],
  );

  const openRec = open ? records.find((r) => r.media_id === open) : undefined;

  return (
    <div className="gallery">
      <div className="g-head">
        <h2 className="section-title">Gallery</h2>
        <button type="button" className="icon-btn" onClick={reload} disabled={loading} title="Refresh">
          ⟳
        </button>
      </div>

      <div className="g-filters">
        <label className="g-filter">
          <span>Op</span>
          <select value={filters.op} onChange={(e) => setFilters((f) => ({ ...f, op: e.target.value }))}>
            <option value="">All</option>
            {(catalog || []).map((e) => (
              <option key={e.op} value={e.op}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <label className="g-filter">
          <span>Source</span>
          <select
            value={filters.source}
            onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value as SourceFilter }))}
          >
            <option value="">All</option>
            <option value="studio">Studio</option>
            <option value="agent">Agent</option>
          </select>
        </label>
        <button
          type="button"
          className="chip"
          aria-pressed={filters.starredOnly}
          onClick={() => setFilters((f) => ({ ...f, starredOnly: !f.starredOnly }))}
        >
          ★ Starred
        </button>
      </div>

      {error ? (
        <p className="hint">Could not load history ({error}).</p>
      ) : records.length === 0 ? (
        <p className="hint">
          {loading ? "Loading renders…" : "No renders yet. Generate one, or run an image tool in chat — it appears here."}
        </p>
      ) : (
        <>
          <div className="g-grid">
            {records.map((rec) => {
              const label = opLabel(catalog, rec.op);
              return (
                <Tile
                  key={`${rec.media_id}-${rec.job_id ?? ""}`}
                  rec={rec}
                  url={urls[rec.media_id]}
                  label={label}
                  copied={copied === rec.media_id}
                  onOpen={() => setOpen(rec.media_id)}
                  onStar={() => toggleStar(rec)}
                  onCopy={() => copyParams(rec)}
                  onRerun={() => rerun(rec)}
                />
              );
            })}
          </div>
          {cursor != null ? (
            <button type="button" className="g-more" onClick={loadMore} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}

      {openRec ? (
        <Lightbox
          rec={openRec}
          url={urls[openRec.media_id]}
          label={opLabel(catalog, openRec.op)}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
