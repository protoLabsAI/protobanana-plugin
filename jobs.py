"""In-process Studio job runner.

A route submits a render and gets a ``job_id`` back at once (R1): no request is
ever held open while a render runs, so nothing hits the fleet proxy's 20 s read
lane. The render runs in a background asyncio task that calls the SAME
``client.py`` functions the agent tools use — one code path, no new HTTP code —
then persists the result with ``registry.save_media(raw, "image/png", meta)``
and announces completion on the core event bus (ADR 0039) via the registry's
publish seam:

- ``protobanana.job.done``   ``{job_id, media_id, url, op, alias, elapsed_s}``
- ``protobanana.job.failed`` ``{job_id, error, error_kind, recoverable, hint}``

Job state is kept in memory, bounded to the last 200 jobs, and readable by id.
One in-flight Studio job per operator by default; a second submit queues
(design R2/R3). A gateway timeout (HTTP 524 — Cloudflare cuts the request at
~100 s, protoBanana#52 — or 504) is classified recoverable: the ComfyUI job
keeps running on the GPU, so the runner does NOT retry in a loop. It makes at
most ONE automatic retry, after a backoff, and only when ``studio_retry_on_524``
is set (default false, so we don't stack GPU jobs).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import OrderedDict
from typing import NamedTuple

from . import catalog, client

log = logging.getLogger(__name__)

_MAX_JOBS = 200

_registry = None
_cfg: dict = {}
# job_id -> state dict (internal; _public() strips the asyncio task).
_jobs: "OrderedDict[str, dict]" = OrderedDict()
# operator -> asyncio.Lock enforcing one in-flight job each (a second submit
# waits on the lock, i.e. queues).
_locks: dict[str, asyncio.Lock] = {}

_PUBLIC_FIELDS = ("job_id", "op", "alias", "tier", "status", "media_id", "url",
                  "error", "error_kind", "recoverable", "hint", "parent_id",
                  "operator", "created", "elapsed_s", "queue_position")


def configure(registry) -> None:
    """Store the registry (save_media + event bus) and a merged config snapshot."""
    global _registry
    _registry = registry
    _cfg.clear()
    _cfg.update({k: v for k, v in dict(getattr(registry, "config", {}) or {}).items()
                 if v is not None})


# ---------------------------------------------------------------- error kinds

class Failure(NamedTuple):
    error: str
    error_kind: str
    recoverable: bool
    hint: str


_RETRY_HINT = ("the render may still be finishing on the GPU — retry or re-run in "
               "a minute; the original ComfyUI job keeps running")


def classify(exc: Exception, alias: str | None = None) -> Failure:
    """Map an exception to the job's failure shape.

    A 524/504 (or an httpx timeout) is a recoverable ``gateway_timeout`` — the
    GPU job keeps running behind Cloudflare's ~100 s cap (protoBanana#52), so it
    is NOT a fatal or alias error. A 404 on the alias is ``alias_missing`` with a
    readable "missing from the gateway" hint. Everything else is a fatal
    ``error``.
    """
    try:
        import httpx
    except ImportError:  # pragma: no cover - httpx is a core dep
        httpx = None

    if httpx is not None and isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (524, 504):
            return Failure(f"gateway timeout (HTTP {status})", "gateway_timeout", True, _RETRY_HINT)
        if status == 404:
            return Failure(
                f"gateway returned 404 for alias {alias!r}", "alias_missing", False,
                f"alias {alias} is missing from the gateway's model_list")
        return Failure(f"gateway returned {status}", "error", False, "")
    if httpx is not None and isinstance(exc, httpx.TimeoutException):
        return Failure("gateway timed out", "gateway_timeout", True, _RETRY_HINT)
    return Failure(f"{type(exc).__name__}: {exc}", "error", False, "")


# ----------------------------------------------------------------- job state

def _public(st: dict) -> dict:
    return {k: st.get(k) for k in _PUBLIC_FIELDS}


def get_state(job_id: str) -> dict | None:
    """The readable state of one job, or ``None`` if unknown."""
    st = _jobs.get(job_id)
    return _public(st) if st is not None else None


def recent(limit: int = 50) -> list[dict]:
    """Recent jobs, newest first (bounded by the in-memory ring)."""
    items = [_public(st) for st in _jobs.values()]
    items.reverse()
    return items[: max(0, int(limit))]


def _remember(st: dict) -> None:
    _jobs[st["job_id"]] = st
    while len(_jobs) > _MAX_JOBS:
        _jobs.popitem(last=False)


def _lock_for(operator: str) -> asyncio.Lock:
    lock = _locks.get(operator)
    if lock is None:
        lock = asyncio.Lock()
        _locks[operator] = lock
    return lock


# --------------------------------------------------------------- the runner

def submit(op: str, params: dict | None = None, parent_id: str | None = None, *,
           operator: str = "default", tier: str = "final", alias: str | None = None) -> str:
    """Queue a render and return its ``job_id`` immediately.

    Returns at once (never awaits the render); the background task does the
    gateway call, the save, and the bus event. Requires a running event loop
    (routes run under one; tests wrap in ``asyncio.run``).
    """
    params = dict(params or {})
    tier = tier or "final"
    override = alias or params.get("alias")
    job_id = uuid.uuid4().hex
    locked = _lock_for(operator).locked()
    st = {
        "job_id": job_id,
        "op": op,
        # Gateway-primary: the alias is resolved from the merged snapshot in _run,
        # the one source of truth (catalog.build()). An explicit override is shown
        # at once; otherwise it fills in the moment the job starts.
        "alias": override,
        "tier": tier,
        "params": params,
        "parent_id": parent_id,
        "operator": operator,
        "status": "queued",
        "media_id": None,
        "url": None,
        "error": None,
        "error_kind": None,
        "recoverable": None,
        "hint": None,
        "created": time.time(),
        "elapsed_s": None,
        # 1 means "one job already in flight for this operator" — an honest
        # starting position for the queue strip (R2/R3).
        "queue_position": 1 if locked else 0,
        "_task": None,
        "_override": override,
    }
    _remember(st)
    st["_task"] = asyncio.ensure_future(_run(job_id))
    return job_id


async def _run(job_id: str) -> None:
    st = _jobs.get(job_id)
    if st is None:  # pragma: no cover - evicted before it ran
        return
    # One in-flight job per operator: a second submit waits here (queued) until
    # the first releases the lock.
    async with _lock_for(st["operator"]):
        st["status"] = "running"
        st["queue_position"] = 0
        started = time.monotonic()
        attempts = 0
        while True:
            attempts += 1
            try:
                if attempts == 1:
                    # Gateway-primary: the merged snapshot from catalog.build() is
                    # the ONE source of truth — it resolves the alias AND validates
                    # the op. catalog_static is only the floor build() falls back to
                    # when the gateway is down. Resolving here (not in submit) keeps
                    # POST /jobs instant on a cold catalog; and because build() runs
                    # INSIDE this try, any failure from it marks the job failed
                    # rather than wedging it in 'running' with no terminal event.
                    snapshot = await catalog.build(_cfg)
                    entry = next((e for e in snapshot["ops"] if e.get("op") == st["op"]), None)
                    if entry is None:
                        raise ValueError(f"unknown op {st['op']!r} — not in the catalog")
                    st["_catalog_entry"] = entry
                    if not st["_override"]:
                        tier = "realism" if st["op"] == "identity" and st["params"].get("realism") else st["tier"]
                        st["alias"] = entry["aliases"].get(tier) or entry["aliases"].get("final")
                # The gateway call AND the persist both live inside the try: if
                # save_media raises, the task must still mark the job failed and
                # publish job.failed, or the Studio view waits forever.
                raw = await _dispatch(st)
                meta = {"source": "studio", "op": st["op"], "alias": st.get("alias"),
                        "params": st["params"], "parent_id": st.get("parent_id"),
                        "job_id": job_id}
                ref = _registry.save_media(raw, "image/png", meta)
            except Exception as exc:  # noqa: BLE001 - classified into a job result
                fail = classify(exc, alias=st.get("alias"))
                retry_on = bool(_cfg.get("studio_retry_on_524"))
                if fail.error_kind == "gateway_timeout" and retry_on and attempts == 1:
                    log.info("[protobanana] job %s gateway timeout — one retry after backoff", job_id)
                    await asyncio.sleep(float(_cfg.get("studio_retry_backoff_s", 2.0)))
                    continue
                st.update(status="failed", error=fail.error, error_kind=fail.error_kind,
                          recoverable=fail.recoverable, hint=fail.hint,
                          elapsed_s=round(time.monotonic() - started, 2))
                _publish("protobanana.job.failed", {
                    "job_id": job_id, "error": fail.error, "error_kind": fail.error_kind,
                    "recoverable": fail.recoverable, "hint": fail.hint,
                    "op": st["op"], "alias": st.get("alias"),
                })
                return
            # success
            elapsed = round(time.monotonic() - started, 2)
            st.update(status="done", media_id=ref.id, url=getattr(ref, "url", None),
                      elapsed_s=elapsed)
            # Shared history (design §3.1/§4): record this Studio render with its
            # parent_id / op / alias / params so it joins the gallery alongside
            # agent renders. Best-effort (record_studio never raises), written
            # before the bus event so the gallery's refresh sees it.
            from . import history
            history.record_studio(st, ref.id)
            _publish("protobanana.job.done", {
                "job_id": job_id, "media_id": ref.id, "url": getattr(ref, "url", None),
                "op": st["op"], "alias": st.get("alias"), "elapsed_s": elapsed,
            })
            return


def _catalog_person_data_url(ref: str) -> str:
    """Person ref → data URL small enough for the gateway's multipart cap.

    The LiteLLM proxy rejects any non-file form part over 1024KB, and the
    person ref rides a text field (data URL) because /v1/images/edits is
    single-image by spec. The server caps the person ref to ~1MP anyway, so
    shrinking client-side loses nothing."""
    import base64

    raw = _image(ref)
    b64 = base64.b64encode(raw).decode()
    if len(b64) <= 900_000:
        return "data:image/png;base64," + b64
    try:
        import io

        from PIL import Image

        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((1024, 1024))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except ImportError:
        raise ValueError(
            "person reference exceeds the gateway's 1MB form-part cap and Pillow "
            "isn't installed to shrink it — run: protoagent plugin install-deps protobanana"
        )


async def _dispatch(st: dict) -> bytes:
    """Run one gateway call for the op — the SAME client.py functions the tools
    use. Returns the rendered PNG bytes."""
    from . import imaging, tools
    op = st["op"]
    params = st["params"]
    alias = st["alias"]
    if alias is None:
        raise ValueError(f"no alias for op {op!r} — unknown operation")
    seed = _seed(params.get("seed"))

    # Built-in ops render through a hard-coded branch with op-specific imaging and
    # fixed fields. The snapshot keeps their static form as the floor, so a
    # gateway-added param can never reach a branch that would silently drop it; the
    # alias was already resolved from the snapshot in _run. These op names are
    # exactly catalog_static.OPS — any other op is gateway-only (below).
    if op == "generate":
        if params.get("n", 1) != 1:
            raise ValueError("Studio supports one image per job (n must be 1).")
        # Snap to the 16px grid and clamp to 256–2048 (accepting ×/* separators)
        # exactly as tools.generate_image does, so the gateway gets a size it can
        # honour instead of guessing one from the prompt (client.py comment).
        w, h = tools._snap_size(params.get("size") or _cfg.get("default_size") or "1024x1024")
        return await client.generate(alias, params.get("prompt", ""), f"{w}x{h}", seed=seed,
                                     negative_prompt=params.get("negative_prompt") or None)
    if op == "remove_background":
        prep = imaging.prepare(tools._resolve_image(params["image"]))
        raw = await client.edit(alias, "remove background", prep.data)
        return imaging.defringe(raw, prep.data)
    if op == "compose":
        refs = [r for r in (params.get("images") or params.get("image_refs") or []) if str(r).strip()]
        if not 2 <= len(refs) <= 10:
            raise ValueError("Compose requires 2–10 reference images.")
        return await client.chat_compose(alias, params.get("prompt", ""),
                                         [_image(r) for r in refs])
    if op in ("edit", "inpaint", "region_edit", "outpaint"):
        # The built-in /images/edits family, each with op-specific form fields.
        prep = imaging.prepare(tools._resolve_image(params["image"]))
        image = prep.data
        if op == "edit":
            raw = await client.edit(alias, params.get("prompt", ""), image,
                                    fields={"seed": seed,
                                             "negative_prompt": params.get("negative_prompt") or None})
            return imaging.finish_edit(raw, prep,
                                       keep_transparency=params.get("keep_transparency", True))
        if op == "inpaint":
            # The mask's transparency IS the signal (transparent = the region to
            # edit), so it must NOT go through _image()/imaging.prepare, which
            # flattens alpha onto white — that would erase the region mark. Resolve
            # it with its alpha intact.
            mask = st.get("_mask")
            if mask is None:
                mask = imaging.validate_mask(tools._resolve_image(params["mask"]), image)
                ref = _registry.save_media(mask, "image/png",
                                           {"op": "mask", "image": params["image"],
                                            "polarity": "transparent=edit"})
                params["mask"] = ref.id
                st["_mask"] = mask
            return await client.edit(alias, params.get("prompt", ""), image,
                                     fields={"seed": seed,
                                             "negative_prompt": params.get("negative_prompt") or None},
                                     mask=mask)
        if op == "region_edit":
            raw = await client.edit(alias, params.get("prompt", ""), image,
                                    fields={"grounding": params.get("grounding") or params.get("region"),
                                             "seed": seed})
            return imaging.finish_edit(raw, prep,
                                       keep_transparency=params.get("keep_transparency", True))
        # outpaint
        margins = {k: int(params.get(k) or 0) for k in ("left", "top", "right", "bottom")}
        return await client.edit(alias, params.get("prompt") or "extend the scene", image,
                                 fields={**margins, "seed": seed})

    # A gateway-only op: dispatch by the snapshot entry's declared route (generic
    # field-forwarding). _run validated the op against the snapshot, and
    # _normalize_entry only admits routes this path can dispatch, so the picker and
    # the runner agree by construction.
    entry = st.get("_catalog_entry")
    if entry is None:
        raise ValueError(f"unknown op {op!r}")
    fields = {k: v for k, v in params.items()
              if k in entry["params"]["properties"]
              and k not in {"alias", "model", "response_format", "prompt", "image",
                            "mask", "person_image", "images", "image_refs"}}
    if "seed" in fields:
        fields["seed"] = seed
    route = entry["route"]
    if route == "/images/generations":
        if params.get("n", 1) != 1:
            raise ValueError("Studio supports one image per job (n must be 1).")
        size = fields.pop("size", None) or _cfg.get("default_size") or "1024x1024"
        return await client.generate(alias, params.get("prompt", ""), size, fields=fields)
    if route == "/images/edits":
        if params.get("person_image"):
            fields["person_image"] = _catalog_person_data_url(params["person_image"])
        return await client.edit(alias, params.get("prompt", ""), _image(params["image"]),
                                 fields=fields,
                                 mask=_mask(params["mask"]) if params.get("mask") else None)
    if route == "/chat/completions":
        refs = params.get("images") or params.get("image_refs") or []
        return await client.chat_compose(alias, params.get("prompt", ""),
                                         [_image(r) for r in refs], fields=fields)
    raise ValueError(f"unsupported catalog route {route!r}")


def _seed(value) -> int | None:
    if value is None:
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def _image(ref: str) -> bytes:
    """Resolve + prepare an image reference exactly as the tools do (one code
    path): flatten transparency onto white so ComfyUI's LoadImage keeps it."""
    from . import imaging, tools
    return imaging.prepare(tools._resolve_image(ref)).data


def _mask(ref: str) -> bytes:
    """Resolve an inpaint mask WITHOUT flattening its transparency.

    The mask's alpha is the region signal (transparent = the region to edit),
    so — unlike _image() — it must not be composited onto white. Re-encode to a
    lossless PNG with the alpha kept, whatever format the reference arrived in,
    so the gateway always gets a PNG mask that still carries the region mark."""
    from . import imaging, tools
    return imaging.to_png(tools._resolve_image(ref))


def _publish(topic: str, data: dict) -> None:
    """Announce on the core event bus via the registry's publish seam (ADR 0039).
    A background task must not die on a bad bus call, so failures are logged."""
    try:
        _registry.emit(topic, data)
    except Exception:  # noqa: BLE001 - best-effort notification
        log.exception("[protobanana] failed to publish %s", topic)
