import { useRef, useState, type ReactNode } from "react";

/** The split lives in viewport coordinates, independently of image zoom/pan. */
export function Compare({ parent, children }: { parent: ReactNode; children: ReactNode }) {
  const [split, setSplit] = useState(50);
  const root = useRef<HTMLDivElement>(null);
  const move = (x: number) => {
    const box = root.current!.getBoundingClientRect();
    setSplit(Math.round(Math.max(0, Math.min(100, (x - box.left) / box.width * 100))));
  };
  return <div className="compare" ref={root}>
    {children}
    <div className="compare-parent" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>{parent}</div>
    <div className="compare-handle" role="slider" tabIndex={0} aria-label="Parent / result split" aria-valuemin={0} aria-valuemax={100} aria-valuenow={split}
      style={{ left: `${split}%` }} onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); move(e.clientX); }}
      onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e.clientX); }}
      onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)}
      onDoubleClick={e => e.stopPropagation()} onKeyDown={e => {
        e.stopPropagation();
        const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
        if (delta || e.key === "Home" || e.key === "End") {
          e.preventDefault(); setSplit(v => e.key === "Home" ? 0 : e.key === "End" ? 100 : Math.max(0, Math.min(100, v + delta * (e.shiftKey ? 10 : 1))));
        }
      }}><span aria-hidden="true">↔</span></div>
  </div>;
}
