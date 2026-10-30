import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as CanvasImage } from "react-konva";
import { fetchHistoryImage } from "./api";
import type { Geom } from "./zoom";
import { Slider } from "./ds-pending";

/** Selection alpha is inverted exactly once at the gateway boundary. */
export function exportMask(selection: HTMLCanvasElement): string {
  const output = document.createElement("canvas");
  output.width = selection.width; output.height = selection.height;
  const ctx = output.getContext("2d")!;
  const pixels = selection.getContext("2d")!.getImageData(0, 0, output.width, output.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
    pixels.data[i + 3] = 255 - pixels.data[i + 3];
  }
  ctx.putImageData(pixels, 0, 0);
  return output.toDataURL("image/png");
}

/** Resolve the DS accent token to an [r,g,b] triple for the mask tint (design
 *  §10: the tint is `--pl-color-accent` at 35%). Falls back to the token's own
 *  literal (#6164ef) when no kit CSS defines the variable (standalone / tests). */
function useAccentRgb(): [number, number, number] {
  const [rgb, setRgb] = useState<[number, number, number]>([97, 100, 239]);
  useEffect(() => {
    const probe = document.createElement("span");
    probe.style.cssText = "color:var(--accent);position:absolute;visibility:hidden";
    document.body.appendChild(probe);
    const m = getComputedStyle(probe).color.match(/\d+/g);
    document.body.removeChild(probe);
    if (m && m.length >= 3) setRgb([+m[0], +m[1], +m[2]]);
  }, []);
  return rgb;
}

// Inpaint mask painter (design §4.3 / §5). R2 item 7: the Konva stage now FILLS
// the zoom viewport; the source image + the (source-size) mask selection are
// drawn through a Layer carrying the shared fit+zoom transform (`geom`), and a
// pointer maps back to SOURCE pixels via `layer.getRelativePointerPosition()` —
// so a stroke lands on the right source coordinate at any zoom or pan and the
// exported PNG stays source-size and aligned. Panning (space / middle-drag) is
// owned by the stage, so `panLock` tells us to ignore those pointers here.
export function MaskEditor({ source, onChange, geom, box, panLock, onNatural }: {
  source: string;
  onChange: (mask: string) => void;
  geom: Geom | null;
  box?: { W: number; H: number };
  panLock?: boolean;
  onNatural?: (iw: number, ih: number) => void;
}) {
  const [image, setImage] = useState<HTMLImageElement>();
  const [selection, setSelection] = useState<HTMLCanvasElement>();
  const [error, setError] = useState("");
  const [eraser, setEraser] = useState(false);
  const [size, setSize] = useState(40);
  const [feather, setFeather] = useState(0);
  const [revision, redraw] = useState(0);
  const layerRef = useRef<{ getRelativePointerPosition: () => { x: number; y: number } | null }>(null);
  const undo = useRef<ImageData[]>([]);
  const last = useRef<{ x: number; y: number }>();
  const changed = useRef(onChange); changed.current = onChange;
  const natural = useRef(onNatural); natural.current = onNatural;
  const [r, g, b] = useAccentRgb();
  const tint = `rgb(${r}, ${g}, ${b})`;
  useEffect(() => {
    let alive = true; let blob: string | undefined;
    setImage(undefined); setSelection(undefined); setError(""); undo.current = [];
    if (!source) return;
    (async () => {
      const url = /^(data:|blob:|https?:|\/)/.test(source) ? source : (blob = await fetchHistoryImage(source));
      const img = new window.Image(); img.crossOrigin = "anonymous"; img.src = url;
      await img.decode();
      if (!alive) return;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      setImage(img); setSelection(canvas);
      natural.current?.(img.naturalWidth, img.naturalHeight);
    })().catch(() => { if (alive) setError("Could not load source for mask painting."); });
    return () => { alive = false; if (blob) URL.revokeObjectURL(blob); };
  }, [source]);
  const snapshot = () => {
    if (!selection) return;
    undo.current.push(selection.getContext("2d")!.getImageData(0, 0, selection.width, selection.height));
    if (undo.current.length > 20) undo.current.shift();
  };
  const publish = () => { if (selection) { changed.current(exportMask(selection)); redraw(v => v + 1); } };
  // Stroke in SOURCE pixels (the selection canvas is source-size).
  const stroke = (point: { x: number; y: number }) => {
    if (!selection || !last.current) return;
    const ctx = selection.getContext("2d")!;
    ctx.save();
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    ctx.strokeStyle = tint; ctx.lineWidth = size; ctx.lineCap = "round";
    ctx.filter = feather ? `blur(${feather}px)` : "none";
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(point.x + 0.01, point.y);
    ctx.stroke(); ctx.restore(); last.current = point; redraw(v => v + 1);
  };
  const pointer = () => layerRef.current?.getRelativePointerPosition() ?? null;
  // `[` / `]` resize the brush (design §10). Handled on the tools panel so any
  // focused tool drives it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "[") { e.preventDefault(); setSize(s => Math.max(1, s - 8)); }
    else if (e.key === "]") { e.preventDefault(); setSize(s => Math.min(300, s + 8)); }
  };
  const ready = image && selection && geom && box;
  return <>
    {ready && <div className="mask-stage" aria-label="Mask canvas" style={{ width: box!.W, height: box!.H }}>
      <Stage width={box!.W} height={box!.H} style={{ touchAction: "none" }}
        onPointerDown={e => {
          if (panLock || e.evt.button !== 0) return;
          e.evt.preventDefault();
          const p = pointer(); if (!p) return;
          snapshot(); last.current = p; stroke(p);
        }}
        onPointerMove={() => {
          if (panLock || !last.current) return;
          const p = pointer(); if (p) stroke(p);
        }}
        onPointerUp={() => { if (last.current) { last.current = undefined; publish(); } }}
        onPointerLeave={() => { if (last.current) { last.current = undefined; publish(); } }}>
        <Layer ref={layerRef as never} x={geom!.ox} y={geom!.oy} scaleX={geom!.absScale} scaleY={geom!.absScale}>
          <CanvasImage image={image} />
          <CanvasImage key={revision} image={selection} opacity={0.35} />
        </Layer>
      </Stage>
    </div>}
    <fieldset className="mask-tools" onKeyDown={onKeyDown}>
      <legend>Paint mask</legend>
      <p className="hint">Tinted = edit. <kbd>[</kbd>/<kbd>]</kbd> brush size. Space/middle-drag to pan.</p>
      <div className="slot-actions">
        <button type="button" aria-pressed={!eraser} onClick={() => setEraser(false)}>Brush</button>
        <button type="button" aria-pressed={eraser} onClick={() => setEraser(true)}>Eraser</button>
        <button type="button" disabled={!selection} onClick={() => {
          snapshot(); const ctx = selection!.getContext("2d")!;
          const pixels = ctx.getImageData(0, 0, selection!.width, selection!.height);
          for (let i = 0; i < pixels.data.length; i += 4) {
            pixels.data[i] = r; pixels.data[i + 1] = g; pixels.data[i + 2] = b;
            pixels.data[i + 3] = 255 - pixels.data[i + 3];
          }
          ctx.putImageData(pixels, 0, 0); publish();
        }}>Invert</button>
        <button type="button" disabled={!selection} onClick={() => {
          snapshot(); selection!.getContext("2d")!.clearRect(0, 0, selection!.width, selection!.height); publish();
        }}>Clear mask</button>
        <button type="button" disabled={!undo.current.length} onClick={() => {
          const pixels = undo.current.pop(); if (pixels) selection!.getContext("2d")!.putImageData(pixels, 0, 0); publish();
        }}>Undo</button>
      </div>
      <label>Brush size (source px)<Slider ariaLabel="Brush size" min={1} max={300} value={size} onChange={setSize} /></label>
      <label>Feather (source px)<Slider ariaLabel="Feather" min={0} max={50} value={feather} onChange={setFeather} /></label>
      {error && <p role="status">{error}</p>}
    </fieldset>
  </>;
}
