import { useRef } from "react";

// Images view R2 (§6): the old data-driven OpForm — the per-op form with its
// Operation-era input slots — is gone. Every single-image op is now a verb on the
// current image (ActionBar) whose params come from the composer, so the per-slot
// free-text "media reference" input and the alias/seed remnants no longer exist.
// What survives is MarginCanvas: the outpaint margin stage, reused on the canvas
// in outpaint mode with the composer's numeric margins as the WCAG 2.5.7
// dragging alternative (§4.3 / §10).

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
