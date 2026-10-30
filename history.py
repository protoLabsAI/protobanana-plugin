"""Plugin-owned, append-only history index + a starred-copy store.

One index serves BOTH surfaces (design §3.1, §4): the agent tools write a
record with ``source="agent"`` (``tools._finish``) and Studio jobs write one
with ``source="studio"`` when they complete (``jobs._run``). Records only point
at media ids — the bytes stay in the core media store — so there is no need for
a core media-list API (design §3.1). Each record is::

    {media_id, parent_id, op, alias, params, source, job_id, created, starred}

**Append-only.** The log (``history.jsonl``) is never rewritten; a record's line
is its stable cursor. Starring does NOT mutate the log — it COPIES the media
bytes into ``starred/<media_id>.<ext>`` under the plugin data dir, and the
copy's existence IS the authoritative starred signal (one local signal, read
back the same way everywhere). That copy also lets the gallery keep showing the
image after ``media.retention_days`` prunes the store original (design R4): the
image route serves the store bytes when present, else the starred copy.

A record whose store original was pruned and that is NOT starred comes back
flagged ``pruned: true`` so the gallery renders a "pruned" tile, never a broken
image.

**Never raises.** Tools return readable strings and must not die on a bad write
(``tools.py`` contract); every write path here swallows and logs its own
exceptions, so a history failure can never break a tool call or a job.

Host-free: the only host dependency (``infra.media`` for the store location) is
imported lazily inside :func:`media_file`, which tests monkeypatch.
"""

from __future__ import annotations

import json
import logging
import shutil
import time
from pathlib import Path

log = logging.getLogger(__name__)

# The directory the index + starred copies live under. Set by configure(); None
# until then, in which case every write no-ops (logged) and every read is empty.
_dir: Path | None = None

# Bound the read scan so a long-lived index can't make one request read an
# unbounded file (design: "reads are bounded and take a cursor").
_MAX_SCAN = 5000
_DEFAULT_LIMIT = 48
_MAX_LIMIT = 200

# Agent tool name (meta["tool"]) → Studio op name, so an agent render and a
# Studio render of the same operation share one op filter in the gallery.
_TOOL_OP = {
    "generate_image": "generate",
    "edit_image": "edit",
    "identity_edit": "identity",
    "region_edit": "region_edit",
    "remove_background": "remove_background",
    "compose_images": "compose",
    "outpaint_image": "outpaint",
    "inpaint_image": "inpaint",
}


def configure(registry, data_dir=None) -> None:
    """Resolve and remember the plugin data dir (index + starred copies).

    Prefers a host-provided scoped data dir if the registry exposes one, else
    falls back to a dot-dir beside the plugin code (``plugin_dir`` is the seam
    the view route already relies on). ``data_dir`` overrides both (tests)."""
    global _dir
    _dir = Path(data_dir) if data_dir is not None else _resolve_dir(registry)


def _resolve_dir(registry) -> Path:
    for name in ("plugin_data_dir", "data_dir", "state_dir"):
        val = getattr(registry, name, None)
        if callable(val):
            try:
                val = val()
            except Exception:  # noqa: BLE001 - a bad host seam must not break register()
                val = None
        if val:
            return Path(val)
    base = Path(getattr(registry, "plugin_dir", ".") or ".")
    return base / ".studio"


def _history_file() -> Path | None:
    return None if _dir is None else _dir / "history.jsonl"


def _starred_dir() -> Path | None:
    return None if _dir is None else _dir / "starred"


# ------------------------------------------------------------- media lookups

def media_file(media_id: str) -> Path | None:
    """The store original's path for ``media_id``, or ``None`` if it was pruned.

    Mirrors ``tools._resolve_image``'s bare-id branch (ignore the ``.json``
    provenance sidecar and dotfiles). The host seam is imported lazily so this
    module stays host-free on import; tests monkeypatch this function directly.
    """
    if not media_id:
        return None
    try:
        from infra.media import media_dir
    except Exception:  # noqa: BLE001 - no host (import-time) → treat as pruned
        return None
    try:
        for f in sorted(media_dir().glob(f"{media_id}.*")):
            if f.suffix != ".json" and not f.name.startswith("."):
                return f
    except Exception:  # noqa: BLE001 - a store read error must not crash a request
        log.exception("[protobanana] media_file lookup failed for %s", media_id)
    return None


def starred_file(media_id: str) -> Path | None:
    """The starred-copy path for ``media_id`` (the authoritative starred signal),
    or ``None`` when the item is not starred."""
    sdir = _starred_dir()
    if sdir is None or not media_id:
        return None
    try:
        for f in sorted(sdir.glob(f"{media_id}.*")):
            if f.is_file():
                return f
    except Exception:  # noqa: BLE001
        pass
    return None


def is_starred(media_id: str) -> bool:
    return starred_file(media_id) is not None


def image_bytes(media_id: str) -> bytes | None:
    """Bytes for ``media_id``: the store original if present, else the starred
    copy (so the gallery keeps rendering a starred item after a prune), else
    ``None`` (a pruned, unstarred record — the gallery shows a pruned tile)."""
    src = media_file(media_id) or starred_file(media_id)
    if src is None:
        return None
    try:
        return src.read_bytes()
    except Exception:  # noqa: BLE001
        log.exception("[protobanana] could not read image bytes for %s", media_id)
        return None


# ------------------------------------------------------------------- writes

def append(record: dict) -> None:
    """Append one record to the JSONL log. Best-effort: logs and returns on any
    failure so a history write can never break a tool call or a job."""
    path = _history_file()
    if path is None:
        log.debug("[protobanana] history dir not configured — dropping record")
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, default=str) + "\n")
    except Exception:  # noqa: BLE001 - never raises into the caller
        log.exception("[protobanana] failed to append a history record")


def _media_id_of(ref) -> str | None:
    """Best-effort media id from an image reference the tools accepted (a bare
    id, a ``/media/<file>`` URL, a data URL, or a path) — for lineage parentage.
    Returns ``None`` when no clean id is recoverable (data URL / file path)."""
    if not isinstance(ref, str):
        return None
    ref = ref.strip()
    if not ref or ref.startswith("data:"):
        return None
    if "/media/" in ref:
        name = ref.split("/media/", 1)[1].split("?", 1)[0]
        return name.rsplit(".", 1)[0] or None
    if "/" not in ref:  # a bare media id (optionally with an extension)
        return ref.rsplit(".", 1)[0] or None
    return None


def _primary_ref(params: dict):
    """The input image reference a record was derived from — ``image`` for the
    single-input ops, else the first of a ``images``/``image_refs`` list (compose).
    Used for lineage and so the ref survives into the re-run params."""
    ref = params.get("image")
    if ref is None:
        refs = params.get("images") or params.get("image_refs")
        if isinstance(refs, (list, tuple)) and refs:
            ref = refs[0]
    return ref


def record_agent(media_id: str, meta: dict | None) -> None:
    """Write a ``source="agent"`` record from an agent tool's ``save_media``
    meta. Wrapped so a malformed meta (or a raising ``append``) can never
    propagate into the tool (tools never raise).

    The record's ``params`` is the agent meta minus the two meta-only keys
    (``tool`` → ``op``, ``model`` → ``alias``). Everything else — crucially the
    input image reference (``image``/``images``) and the ``seed`` — is KEPT, in
    the exact shape ``jobs._dispatch`` consumes, so a Gallery re-run of an agent
    record resubmits a working job (and a locked seed reproduces) instead of
    dying on a missing ``image`` (design §3.1 / S2)."""
    try:
        meta = dict(meta or {})
        tool = meta.get("tool") or ""
        params = {k: v for k, v in meta.items() if k not in ("tool", "model")}
        append({
            "media_id": media_id,
            "parent_id": _media_id_of(_primary_ref(params)),
            "op": _TOOL_OP.get(tool, tool or "unknown"),
            "alias": meta.get("model"),
            "params": params,
            "source": "agent",
            "job_id": None,
            "created": time.time(),
            "starred": False,
        })
    except Exception:  # noqa: BLE001 - a tool must never raise on history
        log.exception("[protobanana] record_agent failed")


def record_studio(state: dict, media_id: str) -> None:
    """Write a ``source="studio"`` record from a completed job's state. Wrapped
    best-effort like :func:`record_agent`."""
    try:
        append({
            "media_id": media_id,
            "parent_id": state.get("parent_id"),
            "op": state.get("op"),
            "alias": state.get("alias"),
            "params": state.get("params") or {},
            "source": "studio",
            "job_id": state.get("job_id"),
            "created": time.time(),
            "starred": False,
        })
    except Exception:  # noqa: BLE001
        log.exception("[protobanana] record_studio failed")


# -------------------------------------------------------------- star / unstar

def star(media_id: str) -> bool:
    """Copy the store bytes into the plugin data dir so retention can't prune
    them (design R4). Returns True when the item is starred afterwards. If the
    original is already gone, an existing copy keeps it starred; with no bytes to
    copy it can't be starred, so returns False."""
    sdir = _starred_dir()
    if sdir is None or not media_id:
        return False
    src = media_file(media_id)
    if src is None:
        return starred_file(media_id) is not None
    try:
        sdir.mkdir(parents=True, exist_ok=True)
        dst = sdir / f"{media_id}{src.suffix or '.png'}"
        shutil.copyfile(src, dst)
        return True
    except Exception:  # noqa: BLE001
        log.exception("[protobanana] failed to star %s", media_id)
        return False


def unstar(media_id: str) -> bool:
    """Delete the starred copy (idempotent). Returns True when the item is not
    starred afterwards."""
    f = starred_file(media_id)
    if f is None:
        return True
    try:
        f.unlink()
        return True
    except Exception:  # noqa: BLE001
        log.exception("[protobanana] failed to unstar %s", media_id)
        return False


# ------------------------------------------------------------------- reads

def _load_tagged() -> list[dict]:
    """All records, each tagged with ``_seq`` (its stable line index). Scan is
    bounded to the last ``_MAX_SCAN`` lines; a malformed line is skipped."""
    path = _history_file()
    if path is None or not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:  # noqa: BLE001
        log.exception("[protobanana] failed to read the history log")
        return []
    out: list[dict] = []
    start = max(0, len(lines) - _MAX_SCAN)
    for i in range(start, len(lines)):
        line = lines[i].strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:  # noqa: BLE001 - tolerate a truncated/garbage line
            continue
        if isinstance(rec, dict):
            rec["_seq"] = i
            out.append(rec)
    return out


def _enrich(rec: dict) -> dict:
    """Overlay the live starred/pruned state (authoritative from the filesystem,
    not the log's write-time ``starred`` field)."""
    mid = rec.get("media_id")
    starred = is_starred(mid) if mid else False
    rec["starred"] = starred
    rec["pruned"] = bool(mid) and media_file(mid) is None and not starred
    if not mid:
        rec["pruned"] = True
    return rec


def read(*, cursor=None, op: str | None = None, source: str | None = None,
         starred: bool | None = None, limit: int = _DEFAULT_LIMIT) -> dict:
    """A bounded, newest-first page of history with a stable cursor.

    Filters by ``op``, ``source`` and ``starred``. The cursor is the ``_seq`` of
    the last item of the previous page; the next page returns records with a
    smaller ``_seq`` (the log is append-only, so a line index never shifts).
    Returns ``{"records": [...], "next_cursor": <seq|None>}``.
    """
    try:
        limit = max(1, min(_MAX_LIMIT, int(limit)))
    except (TypeError, ValueError):
        limit = _DEFAULT_LIMIT

    records = [_enrich(r) for r in _load_tagged()]

    def keep(r: dict) -> bool:
        if op and r.get("op") != op:
            return False
        if source and r.get("source") != source:
            return False
        if starred is not None and bool(r.get("starred")) != bool(starred):
            return False
        return True

    records = [r for r in records if keep(r)]
    records.sort(key=lambda r: r["_seq"], reverse=True)  # newest first

    if cursor is not None:
        try:
            c = int(cursor)
            records = [r for r in records if r["_seq"] < c]
        except (TypeError, ValueError):
            pass

    page = records[:limit]
    next_cursor = page[-1]["_seq"] if len(records) > limit and page else None
    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in page]
    return {"records": clean, "next_cursor": next_cursor}
