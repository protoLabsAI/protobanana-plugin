// Hand-built canvas zoom/pan math (design §7 item 7). This is the stand-in until
// #642 ImageViewport lands; it is intentionally pure so the stage surfaces (the
// plain <img>, the Konva mask, the outpaint preview) all map a source pixel to
// the same on-screen point and the view toolbar reads one honest zoom %.
//
// A `View` is expressed RELATIVE to fit: `zoom` is a multiple of the fit scale
// (1 = fit-to-stage, the default for every newly shown image) and `panX/panY` is
// an extra screen-pixel offset on top of the centred box. Keeping the state
// relative to fit means a stage resize re-fits for free while a user zoom holds.

export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export const FIT_VIEW: View = { zoom: 1, panX: 0, panY: 0 };

// Absolute scale clamp (~0.1x–8x of the source). Fit itself may sit below the
// lower bound for a very large image, so the floor is relaxed to the fit scale.
export const MIN_ABS = 0.1;
export const MAX_ABS = 8;

export interface Geom {
  W: number;
  H: number;
  iw: number;
  ih: number;
  fitScale: number; // source→screen scale that fits the image centred in the box
  absScale: number; // actual source→screen scale (fitScale * zoom)
  ox: number; // image top-left X in viewport coords
  oy: number; // image top-left Y in viewport coords
  pct: number; // Math.round(absScale * 100) — the readout
}

export function fitScaleOf(W: number, H: number, iw: number, ih: number): number {
  if (!W || !H || !iw || !ih) return 1;
  return Math.min(W / iw, H / ih);
}

/** Resolve a View against the current box + natural size into concrete geometry. */
export function geomOf(W: number, H: number, iw: number, ih: number, v: View): Geom {
  const fitScale = fitScaleOf(W, H, iw, ih);
  const absScale = fitScale * v.zoom;
  const ox = (W - iw * absScale) / 2 + v.panX;
  const oy = (H - ih * absScale) / 2 + v.panY;
  return { W, H, iw, ih, fitScale, absScale, ox, oy, pct: Math.round(absScale * 100) };
}

/** Clamp a desired ABSOLUTE scale into range (fit may legally sit below MIN). */
export function clampAbs(abs: number, fitScale: number): number {
  const lo = Math.min(MIN_ABS, fitScale);
  return Math.max(lo, Math.min(MAX_ABS, abs));
}

function viewFor(W: number, H: number, iw: number, ih: number, absScale: number, ox: number, oy: number): View {
  const fitScale = fitScaleOf(W, H, iw, ih);
  return {
    zoom: absScale / fitScale,
    panX: ox - (W - iw * absScale) / 2,
    panY: oy - (H - ih * absScale) / 2,
  };
}

/** Zoom to `targetAbs`, keeping the viewport point (cx, cy) pinned to the same
 *  source pixel (used by wheel/trackpad and double-click-to-100%). */
export function zoomAroundPoint(
  v: View, W: number, H: number, iw: number, ih: number, cx: number, cy: number, targetAbs: number,
): View {
  const g = geomOf(W, H, iw, ih, v);
  const newAbs = clampAbs(targetAbs, g.fitScale);
  const imgX = (cx - g.ox) / g.absScale;
  const imgY = (cy - g.oy) / g.absScale;
  const ox = cx - imgX * newAbs;
  const oy = cy - imgY * newAbs;
  return viewFor(W, H, iw, ih, newAbs, ox, oy);
}

/** Multiply the zoom by `factor` about the box centre (toolbar ± and keyboard). */
export function zoomByCenter(v: View, W: number, H: number, iw: number, ih: number, factor: number): View {
  const g = geomOf(W, H, iw, ih, v);
  return zoomAroundPoint(v, W, H, iw, ih, W / 2, H / 2, g.absScale * factor);
}

/** Centred 100% (source 1:1). */
export function hundredView(W: number, H: number, iw: number, ih: number): View {
  const fitScale = fitScaleOf(W, H, iw, ih);
  return { zoom: clampAbs(1, fitScale) / fitScale, panX: 0, panY: 0 };
}

export function isFitView(v: View): boolean {
  return v.zoom === 1 && v.panX === 0 && v.panY === 0;
}

/** True when the view is (near) the fit box — used to toggle Fit↔100%. */
export function atFit(v: View, W: number, H: number, iw: number, ih: number): boolean {
  const g = geomOf(W, H, iw, ih, v);
  return Math.abs(g.absScale - g.fitScale) < 0.001 && Math.abs(v.panX) < 0.5 && Math.abs(v.panY) < 0.5;
}

/** Double-click toggles Fit↔100% at the click point (design §7). */
export function toggleHundredAt(v: View, W: number, H: number, iw: number, ih: number, cx: number, cy: number): View {
  if (atFit(v, W, H, iw, ih)) return zoomAroundPoint(v, W, H, iw, ih, cx, cy, 1);
  return FIT_VIEW;
}

export function panByView(v: View, dx: number, dy: number): View {
  return { zoom: v.zoom, panX: v.panX + dx, panY: v.panY + dy };
}

// Geometry-free centred zoom (outpaint preview, whose fit is its own intrinsic
// size, not the stage): with a centre transform-origin the pan is unchanged.
export function scaleZoomCentered(v: View, factor: number): View {
  return { zoom: Math.max(MIN_ABS, Math.min(MAX_ABS, v.zoom * factor)), panX: v.panX, panY: v.panY };
}

/** Inline transform for an object-fit:contain element that FILLS the viewport
 *  (the plain stage image): identity at fit, so the 417d0fa fit baseline holds. */
export function containTransform(g: Geom): string {
  const cx0 = (g.W - g.iw * g.fitScale) / 2;
  const cy0 = (g.H - g.ih * g.fitScale) / 2;
  const z = g.absScale / g.fitScale;
  const tx = g.ox - z * cx0;
  const ty = g.oy - z * cy0;
  return `translate(${tx}px, ${ty}px) scale(${z})`;
}
