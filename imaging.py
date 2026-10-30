"""Client-side pixel fix-ups around the gateway round trip.

The ComfyUI workflows behind the gateway are RGB pipelines: ``LoadImage``
drops the alpha channel and keeps whatever colour sits under it — black (0,0,0)
for a cutout — so a transparent PNG sent as-is comes back with its empty areas
solid black (and SAM/Qwen treat that black as content). The fixes here wrap the
round trip instead of the backend so they work against any deployed gateway:

- ``prepare``  flattens a transparent input onto white before it is sent, and
  remembers its size and alpha;
- ``finish_edit`` scales an edit result back to the input's dimensions (the
  Qwen editors rescale to their own ~1MP grid, e.g. 1216x832 → 1248x832) and
  re-applies the input's transparency when asked;
- ``decontaminate`` repaints the colour of semi-transparent cutout edges from
  the opaque interior, removing the light halo that the matting node leaves
  (its ``refine_foreground`` only premultiplies; it never estimates the true
  foreground colour, so the old background's colour stays in the edge pixels).

Pillow is a hard dependency of protoAgent core (since v0.190.0, and bundled in
the desktop app), but every helper still degrades to a no-op if it can't be
imported, so the tools keep working on an unusual host.
"""

from __future__ import annotations

import io
import logging
import struct
from dataclasses import dataclass

log = logging.getLogger(__name__)

WHITE = (255, 255, 255)
# A pixel at or above this alpha counts as "solid" when deciding whether an
# image has real transparency and which pixels carry uncontaminated colour.
_SOLID = 250
# Aspect ratios closer than this are treated as "the same shape": a result
# that only drifted to the model's pixel grid gets scaled back; one whose
# shape genuinely changed is left alone rather than distorted.
_ASPECT_TOLERANCE = 0.06


def _pil():
    try:
        from PIL import Image

        return Image
    except ImportError:  # pragma: no cover - Pillow ships with protoAgent core
        return None


def png_size(raw: bytes) -> tuple[int, int] | None:
    """Width/height from a PNG header (stdlib only), else via Pillow."""
    if len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", raw[16:24])
    Image = _pil()
    if Image is None:
        return None
    try:
        return Image.open(io.BytesIO(raw)).size
    except Exception:  # noqa: BLE001 — best-effort pixel pass, never fail the tool
        return None


def _to_png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@dataclass
class Prepared:
    """What was sent to the gateway, plus what we need to undo afterwards."""

    data: bytes  # bytes to upload
    size: tuple[int, int] | None  # the ORIGINAL input size
    alpha: object = None  # PIL "L" alpha band when the input had transparency

    @property
    def had_alpha(self) -> bool:
        return self.alpha is not None


def prepare(raw: bytes, background: tuple[int, int, int] = WHITE) -> Prepared:
    """Flatten a transparent image onto ``background`` (white by default).

    Opaque images pass through byte-for-byte. White rather than black because
    it is what "empty" looks like to the editors and to SAM: a black void reads
    as a dark object to segment or preserve, white reads as blank paper."""
    size = png_size(raw)
    Image = _pil()
    if Image is None:
        return Prepared(raw, size)
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception:  # noqa: BLE001 — best-effort pixel pass, never fail the tool
        return Prepared(raw, size)
    has_alpha = img.mode in ("RGBA", "LA", "PA") or (
        img.mode == "P" and "transparency" in img.info
    )
    if not has_alpha:
        return Prepared(raw, img.size)
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    lo, _hi = alpha.getextrema()
    if lo >= _SOLID:  # an alpha channel that is fully opaque isn't transparency
        return Prepared(raw, img.size)
    flat = Image.new("RGBA", rgba.size, background + (255,))
    flat.alpha_composite(rgba)
    return Prepared(_to_png(flat.convert("RGB")), rgba.size, alpha)


def same_shape(a: tuple[int, int], b: tuple[int, int]) -> bool:
    ra, rb = a[0] / a[1], b[0] / b[1]
    return abs(ra - rb) / rb <= _ASPECT_TOLERANCE


def finish_edit(
    raw: bytes,
    prep: Prepared,
    *,
    keep_size: bool = True,
    keep_transparency: bool = False,
) -> bytes:
    """Post-process an edit result against the input it was made from.

    keep_size: scale the result back to the input's exact dimensions when the
        editor only drifted to its own pixel grid (same aspect within ~6%).
    keep_transparency: re-apply the input's alpha channel (resized to the
        result) — for in-place edits of a cutout, where the silhouette stays.
    """
    if prep.size is None or not (keep_size or (keep_transparency and prep.had_alpha)):
        return raw
    Image = _pil()
    if Image is None:
        return raw
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception:  # noqa: BLE001 — best-effort pixel pass, never fail the tool
        return raw
    changed = False
    if keep_size and img.size != prep.size and same_shape(img.size, prep.size):
        img = img.resize(prep.size, Image.LANCZOS)
        changed = True
    if keep_transparency and prep.had_alpha:
        alpha = prep.alpha
        if alpha.size != img.size:
            alpha = alpha.resize(img.size, Image.LANCZOS)
        img = img.convert("RGB")
        img.putalpha(alpha)
        # The edit ran on white, so soft edges now hold white: repaint them
        # from the interior or the restored cutout gets a light fringe.
        return decontaminate(_to_png(img))
    return _to_png(img) if changed else raw


def decontaminate(raw: bytes) -> bytes:
    """Repaint semi-transparent edge pixels with colour from the opaque interior.

    A matte's soft edge (hair, fur, cotton candy) mixes the subject's colour with
    the old background's; keeping that colour under a partial alpha shows the old
    background as a halo on any new backdrop. This is normalised convolution done
    entirely in Pillow's C code (no numpy): take only the solid pixels, blur them
    in premultiplied space ("RGBa" — blur(colour·w)/blur(w) on unpremultiply) at
    a few radii so colour reaches every edge pixel, then use that colour wherever
    alpha is partial. Alpha itself is untouched, so the silhouette is identical.
    """
    Image = _pil()
    if Image is None:
        return raw
    try:
        from PIL import ImageFilter

        img = Image.open(io.BytesIO(raw))
        img.load()
        if img.mode != "RGBA":
            return raw
        alpha = img.getchannel("A")
        # Solid core, shrunk by a pixel: the first fully-opaque ring can still
        # carry background colour from the matting model's resampling.
        core = alpha.point(lambda a: 255 if a >= _SOLID else 0).filter(
            ImageFilter.MinFilter(3)
        )
        if core.getextrema()[1] == 0:
            return raw  # nothing solid to borrow colour from
        partial = alpha.point(lambda a: 255 if 0 < a < _SOLID else 0)
        if partial.getextrema()[1] == 0:
            return raw  # hard-edged matte, nothing to fix
        fill = _spread(img.convert("RGB"), core)
        out = img.convert("RGB")
        out.paste(fill, mask=partial)
        out.putalpha(alpha)
        return _to_png(out)
    except Exception as e:  # noqa: BLE001 — never let a cosmetic pass fail the tool
        log.warning("[protobanana] edge decontamination skipped: %s", e)
        return raw


def _spread(rgb, weight, radii=(48, 12, 3)):
    """Normalised convolution: every pixel gets the weighted mean colour of the
    nearby ``weight`` pixels (blur in premultiplied "RGBa", unpremultiply on the
    way back). Coarse radius first so far-away pixels still get a colour, finer
    radii paint over it wherever they have support. Returns RGB."""
    from PIL import ImageFilter

    seed = rgb.copy()
    seed.putalpha(weight)
    premult = seed.convert("RGBa")
    fill = None
    for radius in radii:
        layer = premult.filter(ImageFilter.GaussianBlur(radius)).convert("RGBA")
        if fill is None:
            fill = layer.copy()
            fill.putalpha(255)
        fill.alpha_composite(_boost_alpha(layer))
    return fill.convert("RGB")


def defringe(raw: bytes, source: bytes) -> bytes:
    """Remove the old background's colour from a cutout's edge band.

    The halo after background removal has two parts: semi-transparent edge
    pixels that still hold the old background's colour, and a thin rim of pixels
    the matting model judged SOLID although they are a mix of subject and
    background (a pale ring round fluffy edges shot on white). With the original
    image in hand both are fixable: estimate the local background colour B (from
    the pixels the matte removed) and the local subject colour F (from the solid
    interior), then for each pixel C near the edge solve C = a*F + (1-a)*B for
    the mixing fraction ``a``. Alpha only ever goes DOWN to that fraction, and
    the pixel's colour becomes the un-mixed subject colour, so the old
    background can't show on a new backdrop. Pixels where F and B are too alike
    to separate (a white beard shot on white) keep the matte's alpha.

    Needs Pillow >= 10.3 (ImageMath.lambda_eval); otherwise falls back to
    ``decontaminate`` (colour-only repair of the partial-alpha pixels)."""
    Image = _pil()
    if Image is None:
        return raw
    try:
        from PIL import ImageFilter, ImageMath

        if not hasattr(ImageMath, "lambda_eval"):
            return decontaminate(raw)
        img = Image.open(io.BytesIO(raw))
        img.load()
        if img.mode != "RGBA":
            return raw
        src = Image.open(io.BytesIO(source))
        src.load()
        src = src.convert("RGB")
        if src.size != img.size:
            src = src.resize(img.size, Image.LANCZOS)
        alpha = img.getchannel("A")
        w, h = img.size
        band_px = max(3, round(min(w, h) / 100))

        solid = alpha.point(lambda a: 255 if a >= _SOLID else 0)
        clear = alpha.point(lambda a: 255 if a <= 5 else 0)
        if solid.getextrema()[1] == 0 or clear.getextrema()[1] == 0:
            return raw
        # Pixels within band_px of the removed background — the only ones touched.
        near_clear = clear.filter(ImageFilter.BoxBlur(band_px)).point(
            lambda v: 255 if v > 0 else 0
        )
        band = ImageMath.lambda_eval(
            lambda x: x["convert"](x["min"](x["n"], 255 - x["c"]), "L"),
            n=near_clear,
            c=clear,
        )
        if band.getextrema()[1] == 0:
            return raw
        # Interior well away from the edge carries uncontaminated subject colour.
        core = solid.filter(ImageFilter.BoxBlur(band_px)).point(
            lambda v: 255 if v >= 254 else 0
        )
        if core.getextrema()[1] == 0:
            core = solid
        fg = _spread(src, core)
        bg = _spread(src, clear)

        cs, fs, bs = (im.convert("RGB").split() for im in (src, fg, bg))
        planes = {}
        for i, ch in enumerate("rgb"):
            planes["c" + ch] = cs[i].convert("F")
            planes["f" + ch] = fs[i].convert("F")
            planes["b" + ch] = bs[i].convert("F")
        planes["a"] = alpha.convert("F")

        # |F-B|^2 and the projection of (C-B) onto (F-B) → mixing fraction.
        den = ImageMath.lambda_eval(
            lambda x: (
                (x["fr"] - x["br"]) * (x["fr"] - x["br"])
                + (x["fg"] - x["bg"]) * (x["fg"] - x["bg"])
                + (x["fb"] - x["bb"]) * (x["fb"] - x["bb"])
            ),
            **planes,
        )
        num = ImageMath.lambda_eval(
            lambda x: (
                (x["cr"] - x["br"]) * (x["fr"] - x["br"])
                + (x["cg"] - x["bg"]) * (x["fg"] - x["bg"])
                + (x["cb"] - x["bb"]) * (x["fb"] - x["bb"])
            ),
            **planes,
        )
        # Trust the un-mixing only where subject and background colours are far
        # apart: none below 60 RGB units of separation, full above 110, ramped
        # in between (a hard cut leaves speckles where the two are borderline).
        lo, hi = 60.0 * 60.0, 110.0 * 110.0
        sep = ImageMath.lambda_eval(
            lambda x: x["convert"](
                x["max"](x["min"]((x["d"] - lo) / (hi - lo), 1.0), 0.0) * 255.0, "L"
            ),
            d=den,
        )
        # A pixel that IS the background colour is ambiguous — background the
        # matte missed, or a white beard on a white backdrop — and the matte's
        # call wins there: no correction below 16 units from B, full above 40.
        cb2 = ImageMath.lambda_eval(
            lambda x: (
                (x["cr"] - x["br"]) * (x["cr"] - x["br"])
                + (x["cg"] - x["bg"]) * (x["cg"] - x["bg"])
                + (x["cb"] - x["bb"]) * (x["cb"] - x["bb"])
            ),
            **planes,
        )
        lo2, hi2 = 16.0 * 16.0, 40.0 * 40.0
        distinct = ImageMath.lambda_eval(
            lambda x: x["convert"](
                x["max"](x["min"]((x["d"] - lo2) / (hi2 - lo2), 1.0), 0.0) * 255.0, "L"
            ),
            d=cb2,
        ).filter(ImageFilter.GaussianBlur(2))  # per-pixel noise → speckles
        frac = ImageMath.lambda_eval(
            lambda x: x["max"](x["min"](x["n"] / (x["d"] + 1.0), 1.0), 0.0),
            n=num,
            d=den,
        )
        new_a = ImageMath.lambda_eval(
            lambda x: x["min"](x["a"], x["f"] * 255.0), a=planes["a"], f=frac
        )
        # Un-mix colour: F' = B + (C-B)/a, blended toward the interior colour F
        # as a shrinks (1/a amplifies noise at the faint outer edge).
        out_bands = []
        for ch in "rgb":
            col = ImageMath.lambda_eval(
                lambda x: (
                    x["k"]
                    * x["max"](
                        x["min"](
                            x["b"] + (x["c"] - x["b"]) / x["max"](x["k"], 0.05), 255.0
                        ),
                        0.0,
                    )
                    + (1.0 - x["k"]) * x["f"]
                ),
                k=ImageMath.lambda_eval(lambda x: x["v"] / 255.0, v=new_a),
                b=planes["b" + ch],
                c=planes["c" + ch],
                f=planes["f" + ch],
            )
            out_bands.append(col.convert("L"))
        fixed = Image.merge("RGB", out_bands)
        # Soften the per-pixel estimate, but never above the matte's own alpha.
        soft_a = new_a.convert("L").filter(ImageFilter.GaussianBlur(1))
        fixed.putalpha(
            ImageMath.lambda_eval(
                lambda x: x["convert"](x["min"](x["s"], x["a"]), "L"), s=soft_a, a=alpha
            )
        )

        # Apply only inside the edge band AND where the colours were separable;
        # everywhere else keep the matting model's pixels, then repair the
        # colour of any remaining partial-alpha pixels.
        # Strength tapers from full at the matte edge to nothing at the band's
        # inner end, so there is no visible step where the band stops.
        taper = clear.filter(ImageFilter.GaussianBlur(band_px / 2))
        apply = ImageMath.lambda_eval(
            lambda x: x["convert"](
                x["min"](
                    x["min"](x["b"], x["s"]),
                    x["min"](x["min"](x["t"] * 3.0, 255.0), x["q"]),
                ),
                "L",
            ),
            b=band,
            s=sep,
            t=taper,
            q=distinct,
        )
        out = Image.open(io.BytesIO(decontaminate(raw))).convert("RGBA")
        out.paste(fixed, mask=apply)
        return _to_png(out)
    except Exception as e:  # noqa: BLE001 — never let a cosmetic pass fail the tool
        log.warning("[protobanana] defringe skipped: %s", e)
        return decontaminate(raw)


def _boost_alpha(layer):
    """A blurred layer's alpha is its support (how much solid colour reached
    the pixel). Steepen it so a layer wins wherever it has meaningful support
    and lets the coarser layer show only where it has almost none."""
    a = layer.getchannel("A").point(lambda v: min(255, v * 8))
    layer = layer.copy()
    layer.putalpha(a)
    return layer


# A pixel counts as "changed" when any channel moved by more than this —
# above PNG/lanczos round-trip noise, far below any visible edit.
_CHANGE_THRESHOLD = 8
# An edit that touched less than this fraction of pixels changed nothing
# (0.02% ≈ 200 px at 1MP: a real region edit changes thousands).
_UNCHANGED_FRACTION = 0.0002


def unchanged(before: bytes, after: bytes) -> bool:
    """True when ``after`` is (near-)pixel-identical to ``before``.

    Catches a region edit whose segmenter matched nothing (empty mask → the
    composite returns the input). Byte equality is checked first (no Pillow
    needed); otherwise the result is compared at the input's size and counts
    pixels that moved by more than a few levels. Returns False whenever it
    can't tell, so it never blocks a real result."""
    if before == after:
        return True
    Image = _pil()
    if Image is None:
        return False
    try:
        from PIL import ImageChops

        a = Image.open(io.BytesIO(before)).convert("RGB")
        b = Image.open(io.BytesIO(after)).convert("RGB")
        if b.size != a.size:
            b = b.resize(a.size, Image.LANCZOS)
        diff = ImageChops.difference(a, b).convert("L")
        hist = diff.histogram()
        moved = sum(hist[_CHANGE_THRESHOLD + 1 :])
        return moved < _UNCHANGED_FRACTION * a.size[0] * a.size[1]
    except Exception:  # noqa: BLE001 — a failed check must never fail the tool
        return False
