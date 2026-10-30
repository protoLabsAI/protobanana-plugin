import type { HistoryRecord, JobRequest } from "./api";
import { Button, Popover, Spinner } from "./ds-pending";
import { ImageThumb, ScrollArea, ThumbnailStrip } from "./ds-pending/ImageThumb";

export function branchRequest(rec: HistoryRecord): JobRequest {
  return { op: rec.op, alias: rec.alias, parent_id: rec.parent_id,
    params: { ...rec.params, seed: (Number(rec.params.seed || 0) + 1 + Math.floor(Math.random() * (2 ** 30))) % (2 ** 31) } };
}

export function Lineage({ records, selected, pending, onSelect }: {
  records: HistoryRecord[]; selected: HistoryRecord; pending: boolean; onSelect: (rec: HistoryRecord) => void;
}) {
  const index = new Map(records.map(rec => [rec.media_id, rec]));
  index.set(selected.media_id, selected);
  const path: HistoryRecord[] = [];
  const seen = new Set<string>();
  let node: HistoryRecord | undefined = selected;
  while (node && !seen.has(node.media_id)) {
    seen.add(node.media_id); path.unshift(node);
    node = node.parent_id ? index.get(node.parent_id) : undefined;
  }
  return <section className="lineage" aria-label="Lineage">
    <ScrollArea><ThumbnailStrip aria-label="Image lineage">
      {path.map(rec => <ImageThumb key={rec.media_id} record={rec} selected={rec.media_id === selected.media_id} onSelect={() => onSelect(rec)} />)}
      {pending && <span className="lineage-pending" role="option" aria-selected={false} aria-label="Rendering image"><Spinner /></span>}
    </ThumbnailStrip></ScrollArea>
    {path.map(rec => {
      const siblings = [...index.values()].filter(r => r.parent_id === rec.parent_id);
      if (siblings.length < 2) return null;
      return <Popover key={rec.media_id} side="top" label={`Variants of ${rec.op}`} trigger={({ toggle, open }) =>
        <Button size="xs" aria-expanded={open} onClick={toggle}>⑂ {siblings.length} variants</Button>}>
        <ThumbnailStrip aria-label="Variants">{siblings.map(sibling => <ImageThumb key={sibling.media_id} record={sibling}
          selected={sibling.media_id === selected.media_id} onSelect={() => onSelect(sibling)} />)}</ThumbnailStrip>
      </Popover>;
    })}
  </section>;
}
