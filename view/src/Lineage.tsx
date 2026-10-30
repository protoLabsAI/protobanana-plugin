import type { HistoryRecord, JobRequest } from "./api";

export function branchRequest(rec: HistoryRecord): JobRequest {
  return { op: rec.op, alias: rec.alias, parent_id: rec.parent_id,
    params: { ...rec.params, seed: (Number(rec.params.seed || 0) + 1 + Math.floor(Math.random() * (2 ** 30))) % (2 ** 31) } };
}

export function Lineage({ records, selected, onSelect, onBranch }: {
  records: HistoryRecord[]; selected?: string; onSelect: (rec: HistoryRecord) => void; onBranch: (req: JobRequest) => void;
}) {
  const ids = new Set(records.map(r => r.media_id));
  const visited = new Set<string>();
  const node = (rec: HistoryRecord): React.ReactNode => {
    if (visited.has(rec.media_id)) return null;
    visited.add(rec.media_id);
    const children = records.filter(r => r.parent_id === rec.media_id);
    return <li key={rec.media_id}><div className="lineage-node">
      <button type="button" aria-pressed={selected === rec.media_id} disabled={rec.pruned} onClick={() => onSelect(rec)}>{rec.op} · {rec.media_id.slice(0, 8)}{rec.pruned ? " (pruned)" : ""}</button>
      <button type="button" onClick={() => onBranch(branchRequest(rec))} title="Re-run these parameters with a new seed, alongside this node">Branch / new seed</button>
    </div>{children.length > 0 && <ul>{children.map(node)}</ul>}</li>;
  };
  return <section className="lineage" aria-label="Lineage"><h2 className="section-title">Lineage</h2>
    <p className="hint">Select an image to continue editing. Branch re-runs it as a sibling with a new seed.</p>
    <ul>{records.filter(r => !r.parent_id || !ids.has(r.parent_id)).map(node)}{records.filter(r => !visited.has(r.media_id)).map(node)}</ul>
  </section>;
}
