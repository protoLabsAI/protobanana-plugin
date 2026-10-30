import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { EditMode } from "./ActionBar";
import type { Margins } from "./Composer";
import { MaskEditor } from "./MaskEditor";
import { MarginCanvas } from "./OpForm";
import {
  Button,
  Empty,
  FitIcon,
  FullscreenIcon,
  ImagesIcon,
  Lightbox,
  Skeleton,
  Tooltip,
  ZoomInIcon,
  ZoomOutIcon,
} from "./ds-pending";
import {
  FIT_VIEW,
  type View,
  containTransform,
  geomOf,
  hundredView,
  panByView,
  scaleZoomCentered,
  toggleHundredAt,
  zoomAroundPoint,
  zoomByCenter,
} from "./zoom";

function cls(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// The hand-built floating view toolbar (design §7). Token-only styles, raised bg,
// every control named (aria-label + Tooltip). It shows ONLY with an image.
function ViewToolbar({ pct, onOut, onIn, onHundred, onFit, onFull }: {
  pct: number;
  onOut: () => void;
  onIn: () => void;
  onHundred: () => void;
  onFit: () => void;
  onFull: () => void;
}) {
  return (
    <div className="view-toolbar" role="toolbar" aria-label="View controls">
      <Tooltip label="Zoom out">
        <Button size="xs" icon variant="ghost" aria-label="Zoom out" onClick={onOut}><ZoomOutIcon /></Button>
      </Tooltip>
      <Tooltip label="Zoom to 100%">
        <button type="button" className="view-zoom-pct" aria-label="Zoom to 100%" onClick={onHundred}>{pct}%</button>
      </Tooltip>
      <Tooltip label="Zoom in">
        <Button size="xs" icon variant="ghost" aria-label="Zoom in" onClick={onIn}><ZoomInIcon /></Button>
      </Tooltip>
      <Tooltip label="Fit to stage">
        <Button size="xs" icon variant="ghost" aria-label="Fit to stage" onClick={onFit}><FitIcon /></Button>
      </Tooltip>
      <Tooltip label="Fullscreen">
        <Button size="xs" icon variant="ghost" aria-label="Fullscreen" onClick={onFull}><FullscreenIcon /></Button>
      </Tooltip>
    </div>
  );
}

// The canvas stage (design §7). Hand-built zoom/pan until #642 ImageViewport:
//  • fit-to-stage is the default for every newly shown image;
//  • wheel/trackpad zoom around the cursor (clamped), drag pans, double-click
//    toggles Fit↔100% at the point, keyboard +/-/0/1/arrows when focused;
//  • in a painting/selecting MODE a plain drag keeps doing the mode's action, so
//    pan with space-drag or middle-drag; zoom still works and the mask stays
//    source-aligned;
//  • the render/error overlay stays pinned to the STAGE, not the zoomed image.
export function StageView({
  loading,
  hasImage,
  prunedSelected,
  unreachable,
  current,
  editRef,
  mode,
  dimmed,
  margins,
  setMargin,
  onMask,
  onUpload,
  overlay,
}: {
  loading: boolean;
  hasImage: boolean;
  prunedSelected: boolean;
  unreachable: boolean;
  current?: string;
  editRef: string;
  mode: EditMode;
  dimmed: boolean;
  margins: Margins;
  setMargin: (k: string, v: unknown) => void;
  onMask: (mask: string) => void;
  onUpload: () => void;
  overlay: ReactNode;
}) {
  const [view, setView] = useState<View>(FIT_VIEW);
  const [nat, setNat] = useState<{ iw: number; ih: number }>();
  const [box, setBox] = useState<{ W: number; H: number }>();
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [lightbox, setLightbox] = useState(false);

  // Outpaint's preview keeps its own (smaller) intrinsic size so the edge handles
  // stay inside the stage and grabbable; its zoom is a simple centred scale of
  // that preview. Normal/Region/Compose (plain <img>) and Inpaint (Konva) use the
  // precise fit+cursor geometry so a source pixel maps to one screen point.
  const outpaint = mode === "outpaint";
  const inMode = mode === "inpaint" || mode === "outpaint";

  const vpRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<{ W: number; H: number }>();
  const natRef = useRef<{ iw: number; ih: number }>();
  const outpaintRef = useRef(outpaint);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);
  boxRef.current = box;
  natRef.current = nat;
  outpaintRef.current = outpaint;

  // Fit is the DEFAULT for every newly shown image, a mode change, New and a
  // finished render — all of which change `current`/`editRef`/`mode` (design §7).
  useEffect(() => {
    setView(FIT_VIEW);
    setLightbox(false);
  }, [current, editRef, mode]);

  // Natural size is a property of the IMAGE, not the mode: only clear it when the
  // image itself changes, so a mode switch (same <img>, no fresh onLoad) keeps the
  // toolbar + transform instead of losing them until a reload that never comes.
  useEffect(() => {
    setNat(undefined);
  }, [current, editRef]);

  // Measure the viewport (its content box, inside the stage border) so fit and
  // the cursor math use the box the image actually occupies.
  useLayoutEffect(() => {
    const el = vpRef.current;
    if (!el) { setBox(undefined); return; }
    const measure = () => setBox({ W: el.clientWidth, H: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasImage, loading]);

  const geom = nat && box && nat.iw && nat.ih ? geomOf(box.W, box.H, nat.iw, nat.ih, view) : null;

  // Wheel / trackpad pinch zoom around the cursor. A native non-passive listener
  // (React's onWheel is passive) so preventDefault stops the page from scrolling.
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const b = boxRef.current, n = natRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      if (outpaintRef.current) {
        e.preventDefault();
        setView(v => scaleZoomCentered(v, factor));
        return;
      }
      if (!b || !n) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      setView(v => zoomAroundPoint(v, b.W, b.H, n.iw, n.ih, cx, cy, geomOf(b.W, b.H, n.iw, n.ih, v).absScale * factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasImage, loading]);

  // Pan: plain drag in the default view; space-drag or middle-drag inside a mode
  // (a plain drag there paints/selects, so the mode owns it).
  const canPan = !inMode || spaceHeld;
  const onPointerDown = (e: React.PointerEvent) => {
    if (!geom && !outpaint) return;
    const middle = e.button === 1;
    if (!(middle || (e.button === 0 && canPan))) return;
    if (inMode) e.preventDefault(); // suppress paint/select while panning in a mode
    drag.current = { x: e.clientX, y: e.clientY, view };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView(panByView(d.view, e.clientX - d.x, e.clientY - d.y));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  // Double-click toggles Fit↔100% at the point — a VIEWING gesture, so it is off
  // in paint/margin modes where a double-click is part of the mode's own action.
  const onDoubleClick = (e: React.MouseEvent) => {
    if (inMode || !geom || !vpRef.current) return;
    const rect = vpRef.current.getBoundingClientRect();
    setView(v => toggleHundredAt(v, geom.W, geom.H, geom.iw, geom.ih, e.clientX - rect.left, e.clientY - rect.top));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = 60;
    if (e.key === " ") { e.preventDefault(); setSpaceHeld(true); return; }
    if (e.key === "0") { e.preventDefault(); setView(FIT_VIEW); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); setView(v => panByView(v, step, 0)); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); setView(v => panByView(v, -step, 0)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setView(v => panByView(v, 0, step)); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setView(v => panByView(v, 0, -step)); return; }
    if (outpaint) {
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setView(v => scaleZoomCentered(v, 1.25)); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setView(v => scaleZoomCentered(v, 1 / 1.25)); }
      else if (e.key === "1") { e.preventDefault(); setView({ zoom: 1, panX: 0, panY: 0 }); }
      return;
    }
    if (!geom) return;
    const { W, H, iw, ih } = geom;
    switch (e.key) {
      case "+": case "=": e.preventDefault(); setView(v => zoomByCenter(v, W, H, iw, ih, 1.25)); break;
      case "-": case "_": e.preventDefault(); setView(v => zoomByCenter(v, W, H, iw, ih, 1 / 1.25)); break;
      case "1": e.preventDefault(); setView(hundredView(W, H, iw, ih)); break;
      default: break;
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => { if (e.key === " ") setSpaceHeld(false); };

  const zoomCenter = useCallback((factor: number) => {
    const b = boxRef.current, n = natRef.current;
    if (!b || !n) return;
    setView(v => zoomByCenter(v, b.W, b.H, n.iw, n.ih, factor));
  }, []);
  const fit = useCallback(() => setView(FIT_VIEW), []);
  const hundred = useCallback(() => {
    const b = boxRef.current, n = natRef.current;
    if (b && n) setView(hundredView(b.W, b.H, n.iw, n.ih));
  }, []);

  const surface = () => {
    if (mode === "inpaint") {
      return <MaskEditor source={editRef} onChange={onMask} geom={geom} box={box} panLock={spaceHeld} onNatural={(iw, ih) => setNat({ iw, ih })} />;
    }
    if (mode === "outpaint") {
      return (
        <div className="stage-outpaint" style={{ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`, transformOrigin: "center" }}>
          <MarginCanvas
            url={current}
            params={margins as unknown as Record<string, unknown>}
            set={setMargin}
            onNatural={(iw, ih) => setNat({ iw, ih })}
          />
        </div>
      );
    }
    if (current) {
      return (
        <img
          className={cls("stage-img", dimmed && "is-dimmed")}
          src={current}
          alt="Current image"
          draggable={false}
          style={geom ? { transform: containTransform(geom), transformOrigin: "0 0" } : undefined}
          onLoad={e => setNat({ iw: e.currentTarget.naturalWidth, ih: e.currentTarget.naturalHeight })}
        />
      );
    }
    return null;
  };

  return (
    <div className="stage">
      {loading ? (
        <Skeleton className="stage-skeleton" />
      ) : hasImage ? (
        <>
          <div
            ref={vpRef}
            className={cls("stage-viewport", Boolean(canPan && (geom || outpaint)) && "is-pannable")}
            tabIndex={0}
            aria-label="Image viewport"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
          >
            {surface()}
          </div>
          {(geom || outpaint) && (
            <ViewToolbar
              pct={outpaint ? Math.round(view.zoom * 100) : (geom?.pct ?? 100)}
              onOut={() => (outpaint ? setView(v => scaleZoomCentered(v, 1 / 1.25)) : zoomCenter(1 / 1.25))}
              onIn={() => (outpaint ? setView(v => scaleZoomCentered(v, 1.25)) : zoomCenter(1.25))}
              onHundred={() => (outpaint ? setView({ zoom: 1, panX: 0, panY: 0 }) : hundred())}
              onFit={fit}
              onFull={() => setLightbox(true)}
            />
          )}
          <Lightbox open={lightbox} src={current} alt="Current image" onClose={() => setLightbox(false)} />
        </>
      ) : prunedSelected ? (
        <Empty className="stage-empty" icon={<ImagesIcon />} title="This image expired" description="star images to keep them" />
      ) : !unreachable ? (
        <Empty
          className="stage-empty"
          icon={<ImagesIcon />}
          title="Describe an image to start"
          description="Type a prompt below, or drop, paste, or upload an image."
          action={<Button onClick={onUpload}>Upload</Button>}
        />
      ) : null}

      {overlay}
    </div>
  );
}
