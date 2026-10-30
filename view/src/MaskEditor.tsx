import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as CanvasImage } from "react-konva";
import { fetchHistoryImage } from "./api";

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

export function MaskEditor({ source, onChange }: { source: string; onChange: (mask: string) => void }) {
  const [image, setImage] = useState<HTMLImageElement>();
  const [selection, setSelection] = useState<HTMLCanvasElement>();
  const [error, setError] = useState("");
  const [eraser, setEraser] = useState(false);
  const [size, setSize] = useState(40);
  const [feather, setFeather] = useState(0);
  const [revision, redraw] = useState(0);
  const undo = useRef<ImageData[]>([]);
  const last = useRef<{ x: number; y: number }>();
  const changed = useRef(onChange); changed.current = onChange;
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
    })().catch(() => { if (alive) setError("Could not load source for mask painting."); });
    return () => { alive = false; if (blob) URL.revokeObjectURL(blob); };
  }, [source]);
  const snapshot = () => {
    if (!selection) return;
    undo.current.push(selection.getContext("2d")!.getImageData(0, 0, selection.width, selection.height));
    if (undo.current.length > 20) undo.current.shift();
  };
  const publish = () => { if (selection) { changed.current(exportMask(selection)); redraw(v => v + 1); } };
  const scale = image ? Math.min(1, 300 / image.naturalWidth) : 1;
  const stroke = (point: { x: number; y: number }) => {
    if (!selection || !last.current) return;
    const ctx = selection.getContext("2d")!;
    ctx.save();
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    ctx.strokeStyle = "#ff4080"; ctx.lineWidth = size; ctx.lineCap = "round";
    ctx.filter = feather ? `blur(${feather}px)` : "none";
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(point.x + 0.01, point.y);
    ctx.stroke(); ctx.restore(); last.current = point; redraw(v => v + 1);
  };
  return <fieldset className="mask-editor"><legend>Paint mask</legend>
    <p>Pink = edit. Exported PNG: transparent = edit, opaque = preserve.</p>
    <div className="slot-actions">
      <button type="button" aria-pressed={!eraser} onClick={() => setEraser(false)}>Brush</button>
      <button type="button" aria-pressed={eraser} onClick={() => setEraser(true)}>Eraser</button>
      <button type="button" disabled={!selection} onClick={() => {
        snapshot(); const ctx = selection!.getContext("2d")!;
        const pixels = ctx.getImageData(0, 0, selection!.width, selection!.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          pixels.data[i] = 255; pixels.data[i + 1] = 64; pixels.data[i + 2] = 128;
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
    <label>Brush size (source px)<input aria-label="Brush size" type="range" min="1" max="300" value={size} onChange={e => setSize(+e.target.value)} /></label>
    <label>Feather (source px)<input aria-label="Feather" type="range" min="0" max="50" value={feather} onChange={e => setFeather(+e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    {image && selection && <div style={{ touchAction: "none" }} aria-label="Mask canvas">
      <Stage width={image.naturalWidth * scale} height={image.naturalHeight * scale}
        onPointerDown={e => {
          e.evt.preventDefault();
          const point = e.target.getStage()!.getPointerPosition()!;
          snapshot(); last.current = { x: point.x / scale, y: point.y / scale }; stroke(last.current);
        }}
        onPointerMove={e => {
          const point = e.target.getStage()!.getPointerPosition();
          if (point && last.current) stroke({ x: point.x / scale, y: point.y / scale });
        }}
        onPointerUp={() => { if (last.current) { last.current = undefined; publish(); } }}
        onPointerLeave={() => { if (last.current) { last.current = undefined; publish(); } }}>
        <Layer scaleX={scale} scaleY={scale}>
          <CanvasImage image={image} />
          <CanvasImage key={revision} image={selection} opacity={0.6} />
        </Layer>
      </Stage>
    </div>}
  </fieldset>;
}
