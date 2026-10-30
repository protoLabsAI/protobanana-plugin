import { sendToAgent } from "./api";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CatalogEntry,
  type HistoryRecord,
  fetchHistory,
  fetchHistoryImage,
  starMedia,
  subscribe,
  unstarMedia,
} from "./api";
import { Badge, Button, DropdownSelect, PanelHeader, Popover, Segmented, SkeletonGroup, Switch } from "./ds-pending";

// History (design §3/§4): one shared index over BOTH agent renders
// (source=agent) and Studio renders (source=studio), as a 248px right column
// (or a Drawer when the view is narrow — §8). A 3-column thumb grid; selecting a
// thumb makes it the current image. A pruned record (store original gone, not
// starred) renders a "pruned" tile and, when selected, the canvas shows the
// expired Empty. Refreshes on protobanana.job.done and on the shell's revision.

const PAGE = 48;

type SourceFilter = "" | "studio" | "agent";

interface Filters {
  op: string;
  source: SourceFilter;
  starredOnly: boolean;
}

/** Fetch each non-pruned record's bytes through the kit (bearer) once and cache
 *  the resulting blob URL by media id; revoke everything on unmount. */
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
          /* leave it un-imaged; the tile shows a placeholder */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [records]);

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

// -------------------------------------------------------------------- tile

function Tile({
  rec,
  url,
  label,
  selected,
  onSelect,
  onStar,
}: {
  rec: HistoryRecord;
  url: string | undefined;
  label: string;
  selected: boolean;
  onSelect: () => void;
  onStar: () => void;
}) {
  return (
    <figure className={`g-tile${rec.pruned ? " pruned" : ""}${selected ? " selected" : ""}`}>
      <button
        type="button"
        className="g-thumb"
        onClick={onSelect}
        aria-current={selected || undefined}
        aria-label={`${rec.pruned ? "Pruned " : ""}${label} render`}
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
        {rec.source === "agent" && (
          <Badge tone="info" className="g-agent">
            agent
          </Badge>
        )}
      </button>

      <div className="g-actions">
        <Button variant="ghost" size="xs" className="g-send" onClick={() => sendToAgent(rec)}>
          Send to agent
        </Button>
        <Button
          variant="ghost"
          size="xs"
          icon
          aria-pressed={rec.starred}
          title={rec.starred ? "Starred (kept through retention)" : "Star — keep through retention"}
          aria-label={rec.starred ? "Unstar" : "Star"}
          onClick={onStar}
          disabled={rec.pruned}
        >
          {rec.starred ? "★" : "☆"}
        </Button>
      </div>
    </figure>
  );
}

// ------------------------------------------------------------------ history

export function Gallery({
  catalog,
  revision = 0,
  compact,
  selectedId,
  onSelect,
  onRecords,
}: {
  catalog: CatalogEntry[] | null;
  revision?: number;
  compact?: boolean;
  selectedId?: string;
  onSelect: (rec: HistoryRecord) => void;
  onRecords?: (records: HistoryRecord[]) => void;
}) {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<Filters>({ op: "", source: "", starredOnly: false });

  const urls = useImageUrls(records);

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

  useEffect(() => {
    reload();
  }, [reload, revision]);

  // Surface the loaded records so the shell can offer them to the Compose
  // reference slots ("pick from History", §4.3) without a second fetch.
  useEffect(() => {
    onRecords?.(records);
  }, [records, onRecords]);

  // Bus-driven refresh (ADR 0039): a fresh render — agent or studio — joins
  // History within one bus tick.
  useEffect(() => {
    const off = subscribe("protobanana.job.done", () => {
      reload();
    });
    return off;
  }, [reload]);

  const toggleStar = useCallback(async (rec: HistoryRecord) => {
    try {
      const starred = rec.starred ? await unstarMedia(rec.media_id) : await starMedia(rec.media_id);
      setRecords((prev) => prev.map((r) => (r.media_id === rec.media_id ? { ...r, starred } : r)));
    } catch {
      /* ignore — the star button simply stays as it was */
    }
  }, []);

  const filterActive = filters.op !== "" || filters.source !== "" || filters.starredOnly;

  return (
    <div className={`gallery${compact ? " compact" : ""}`}>
      <PanelHeader
        compact
        className="g-head"
        title="History"
        actions={
          <Popover
            align="end"
            label="Filter history"
            trigger={({ toggle, open }) => (
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={open}
                aria-label="Filter history"
                className={filterActive ? "is-active" : undefined}
                onClick={toggle}
              >
                Filter
              </Button>
            )}
          >
            <div className="g-filter-grid">
              <div className="pl-field">
                <span className="pl-field-label">Operation</span>
                <DropdownSelect
                  ariaLabel="Filter by operation"
                  value={filters.op}
                  onChange={(op) => setFilters((f) => ({ ...f, op }))}
                  options={[{ value: "", label: "All" }, ...(catalog || []).map((e) => ({ value: e.op, label: e.label }))]}
                />
              </div>
              <div className="pl-field">
                <span className="pl-field-label">Source</span>
                <Segmented
                  ariaLabel="Filter by source"
                  size="sm"
                  value={filters.source}
                  onChange={(v) => setFilters((f) => ({ ...f, source: v as SourceFilter }))}
                  options={[
                    { value: "", label: "All" },
                    { value: "studio", label: "Mine" },
                    { value: "agent", label: "Agent" },
                  ]}
                />
              </div>
              <Switch
                checked={filters.starredOnly}
                onChange={(starredOnly) => setFilters((f) => ({ ...f, starredOnly }))}
                label="Starred only"
                ariaLabel="Starred only"
              />
            </div>
          </Popover>
        }
      />

      {error ? (
        <p className="hint">Could not load history ({error}).</p>
      ) : records.length === 0 ? (
        loading ? (
          <SkeletonGroup count={6} className="g-grid" />
        ) : (
          <p className="hint">No renders yet. Generate one, or run an image tool in chat — it appears here.</p>
        )
      ) : (
        <>
          <div className="g-grid">
            {records.map((rec) => (
              <Tile
                key={`${rec.media_id}-${rec.job_id ?? ""}`}
                rec={rec}
                url={urls[rec.media_id]}
                label={opLabel(catalog, rec.op)}
                selected={selectedId === rec.media_id}
                onSelect={() => onSelect(rec)}
                onStar={() => toggleStar(rec)}
              />
            ))}
          </div>
          {cursor != null ? (
            <Button variant="ghost" size="sm" className="g-more" onClick={loadMore} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
