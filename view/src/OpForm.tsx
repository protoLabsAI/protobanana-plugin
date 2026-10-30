import { useRef, useState } from "react";
import { type CatalogEntry, type HistoryRecord, type JobRequest } from "./api";

export function InputSlot({ label, value, required, current, records, onChange }: {
  label: string; value: string; required?: boolean; current?: string;
  records: HistoryRecord[]; onChange: (value: string) => void;
}) {
  const [error, setError] = useState("");
  const read = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Choose an image file."); return; }
    const reader = new FileReader();
    reader.onload = () => { onChange(String(reader.result)); setError(""); };
    reader.onerror = () => setError("Could not read that image.");
    reader.readAsDataURL(file);
  };
  return <fieldset className="input-slot" onDragOver={e => e.preventDefault()}
    onDrop={e => { e.preventDefault(); read(e.dataTransfer.files[0]); }}
    onPaste={e => { const file = e.clipboardData.files[0]; if (file) { e.preventDefault(); read(file); } }}>
    <legend>{label}</legend>
    <input aria-label={`${label} reference`} required={required} value={value}
      placeholder="Drop or paste an image, or enter a media reference" onChange={e => onChange(e.target.value)} />
    <input aria-label={`Upload ${label}`} type="file" accept="image/*" onChange={e => read(e.target.files?.[0])} />
    <div className="slot-actions"><button type="button" disabled={!current} onClick={() => onChange(current!)}>Use current</button>
      <select aria-label={`Pick ${label} from gallery`} value="" onChange={e => onChange(e.target.value)}>
        <option value="">Pick from gallery</option>
        {records.filter(r => !r.pruned).map(r => <option key={r.media_id} value={r.media_id}>{r.op} · {r.media_id}</option>)}
      </select><button type="button" onClick={() => onChange("")}>Clear</button></div>
    {error && <span role="alert">{error}</span>}
  </fieldset>;
}

export function MarginCanvas({ url, params, set }: { url?: string; params: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  const drag = useRef<{ edge: string; start: number; value: number; scale: number }>();
  return <div className="margin-canvas" aria-label="Outpaint margins">
    {url ? <img src={url} alt="Outpaint source" draggable={false} /> : <p>Choose an image to extend its canvas.</p>}
    {(["left", "top", "right", "bottom"] as const).map(edge => <button key={edge} type="button"
      className={`margin-handle ${edge}`} aria-label={`Drag ${edge} margin`} title={`Drag ${edge} margin; arrow keys adjust by 16px`}
      onKeyDown={e => { if (e.key.startsWith("Arrow")) { e.preventDefault(); set(edge, Math.max(0, Number(params[edge] || 0) + (["ArrowUp", "ArrowRight"].includes(e.key) ? 16 : -16))); } }}
      onPointerDown={e => {
        const img = e.currentTarget.parentElement?.querySelector("img");
        drag.current = { edge, start: edge === "left" || edge === "right" ? e.clientX : e.clientY,
          value: Number(params[edge] || 0), scale: img ? img.naturalWidth / (img.width || 1) : 1 };
        e.currentTarget.setPointerCapture(e.pointerId);
      }} onPointerMove={e => {
        const d = drag.current; if (!d || d.edge !== edge) return;
        const delta = (edge === "left" || edge === "right" ? e.clientX : e.clientY) - d.start;
        set(edge, Math.max(0, Math.round((d.value + delta * d.scale * (["left", "top"].includes(edge) ? -1 : 1)) / 16) * 16));
      }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
      {edge} {Number(params[edge] || 0)}px
    </button>)}
  </div>;
}

export function OpForm({ entry, current, records, onSubmit, params, setParams }: {
  entry: CatalogEntry; current?: string; records: HistoryRecord[]; onSubmit: (req: JobRequest) => void;
  params: Record<string, unknown>; setParams: (params: Record<string, unknown>) => void;
}) {
  const [tier, setTier] = useState(entry.default_tier || "final");
  const [alias, setAlias] = useState("");
  const set = (key: string, value: unknown) => setParams({ ...params, [key]: value });
  const selectedAlias = alias || entry.aliases[params.realism ? "realism" : tier] || "";
  return <form className="form" onSubmit={e => { e.preventDefault(); onSubmit({ op: entry.op, tier, alias: alias || undefined, params }); }}>
    <div className="toggle" role="group" aria-label="Quality tier">{["draft", "final"].map(t =>
      <button key={t} type="button" aria-pressed={tier === t} onClick={() => setTier(t)}>{t === "draft" ? "Draft" : "Final"}</button>)}</div>
    <small className="desc">{selectedAlias}</small>
    {/rmbg/i.test(selectedAlias) && <span className="badge-nc">Non-commercial · RMBG CC BY-NC</span>}
    {Object.entries(entry.params.properties).map(([key, schema]) => {
      const label = schema.title || key;
      const required = entry.params.required.includes(key);
      if (key === "image" || key === "person_image") return <InputSlot key={key} label={label} required={required}
        current={current} records={records} value={String(params[key] || "")} onChange={v => set(key, v)} />;
      if (schema.type === "array") {
        const refs = (params[key] as string[] | undefined) || Array(schema.minItems || 2).fill("");
        return <div key={key}>{refs.map((ref, i) => <div key={i}><InputSlot label={`Reference ${i + 1}`} required current={current}
          records={records} value={ref} onChange={v => set(key, refs.map((r, j) => i === j ? v : r))} />
          {refs.length > (schema.minItems || 2) && <button type="button" onClick={() => set(key, refs.filter((_, j) => i !== j))}>Remove reference {i + 1}</button>}</div>)}
          <button type="button" disabled={refs.length >= (schema.maxItems || 10)} onClick={() => set(key, [...refs, ""])}>Add reference</button></div>;
      }
      return <label className="field" key={key}>{label}
        {schema.type === "boolean" ? <input aria-label={label} type="checkbox" checked={Boolean(params[key])} onChange={e => set(key, e.target.checked)} />
          : key === "prompt" ? <textarea aria-label={label} required={required} value={String(params[key] || "")} onChange={e => set(key, e.target.value)} />
          : <input aria-label={label} type={schema.type === "integer" ? "number" : "text"} required={required}
            min={schema.minimum} max={schema.maximum} step={schema.type === "integer" ? 1 : undefined} readOnly={schema.const !== undefined}
            value={String(params[key] ?? "")} onChange={e => set(key, schema.type === "integer" ? Number(e.target.value) : e.target.value)} />}
        {key === "size" && <div className="chips">{["1024x1024", "768x1280", "1280x768", "1344x768", "768x1344"].map(size =>
          <button type="button" className="chip" key={size} onClick={() => set(key, size)}>{size}</button>)}</div>}
        {key === "seed" && <div className="seed-row"><button type="button" aria-pressed={Number(params.seed) >= 0}
          onClick={() => set("seed", Number(params.seed) >= 0 ? -1 : Math.floor(Math.random() * 2 ** 31))}> {Number(params.seed) >= 0 ? "🔒 Fixed" : "🔓 Random"}</button>
          <button type="button" onClick={() => set("seed", Math.floor(Math.random() * 2 ** 31))}>🎲 New seed</button></div>}
        <small className="desc">{schema.description}</small>
      </label>;
    })}
    <details><summary>Advanced alias override</summary><input aria-label="Alias override" value={alias} onChange={e => setAlias(e.target.value)} /></details>
    <button className="submit" type="submit">{entry.label}</button>
  </form>;
}
