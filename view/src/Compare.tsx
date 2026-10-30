import { useRef, useState } from "react";

export function Compare({ current, parent }: { current?: string; parent?: string }) {
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number }>();
  return <section aria-label="Image comparison">
    <div className="compare-toolbar">
      <label>Zoom <input aria-label="Zoom" type="range" min="1" max="5" step="0.1" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
      <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); setSplit(50); }}>Reset view</button>
    </div>
    <div className="compare-viewport" onPointerDown={e => {
      drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }; e.currentTarget.setPointerCapture(e.pointerId);
    }} onPointerMove={e => { if (drag.current) setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }); }}
      onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
      {current ? <div className="compare-images" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        <img src={current} alt="Current result" draggable={false} />
        {parent && <img className="compare-parent" src={parent} alt="Parent image" draggable={false} style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />}
      </div> : <p className="placeholder">Choose an operation or select a history image to begin.</p>}
    </div>
    {parent && <label className="field">Parent / result<input aria-label="A/B comparison" type="range" min="0" max="100" value={split} onChange={e => setSplit(Number(e.target.value))} /></label>}
  </section>;
}
