// Local #640 stand-ins until the host kit supplies image thumbnails.
import { useEffect, useState, type HTMLAttributes } from "react";
import { fetchHistoryImage, type HistoryRecord } from "../api";
import { Tooltip } from ".";

export function imageName(rec: HistoryRecord) {
  const labels: Record<string, string> = { generate: "Generate", edit: "Edit", region: "Region edit", region_edit: "Region edit" };
  const minutes = rec.created == null ? null : Math.max(0, Math.floor((Date.now() / 1000 - rec.created) / 60));
  return `${labels[rec.op] || rec.op}, ${minutes == null ? "time unknown" : minutes < 1 ? "just now" : `${minutes} min ago`}`;
}

export function ScrollArea(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`pbx-scroll-area ${props.className || ""}`} />;
}

export function ThumbnailStrip(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} role="listbox" className="pbx-thumbnail-strip" onKeyDown={e => {
    const options = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : e.key === "ArrowRight" ? index + 1 : e.key === "ArrowLeft" ? index - 1 : null;
    if (next !== null) { e.preventDefault(); options[Math.max(0, Math.min(options.length - 1, next))]?.focus(); }
  }} />;
}

export function ImageThumb({ record, selected, onSelect }: { record: HistoryRecord; selected: boolean; onSelect: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let alive = true;
    let blob: string | undefined;
    setUrl(undefined);
    if (!record.pruned) fetchHistoryImage(record.media_id).then(value => {
      if (alive) { blob = value; setUrl(value); } else URL.revokeObjectURL(value);
    }).catch(() => {});
    return () => { alive = false; if (blob) URL.revokeObjectURL(blob); };
  }, [record.media_id, record.pruned]);
  return <Tooltip label={imageName(record)}><button type="button" role="option" aria-selected={selected}
    aria-label={imageName(record)} className="pbx-image-thumb" onClick={onSelect}>
    {url ? <img src={url} alt="" /> : <span>{record.pruned ? "Expired" : record.op}</span>}
  </button></Tooltip>;
}
