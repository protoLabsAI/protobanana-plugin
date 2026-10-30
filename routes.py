"""FastAPI router for protoBanana Studio — page public, data gated (ADR 0026/0038).

Two prefixes, declared together but gated differently (the public page prefix
is listed in the manifest's ``public_paths``; everything else is gated):

- ``/plugins/protobanana/studio``                      the view's HTML (public)
- ``/plugins/protobanana/studio/assets/<file>``        its built assets (public)
- ``/api/plugins/protobanana/jobs``        POST a render, GET recent (gated)
- ``/api/plugins/protobanana/jobs/<id>``   GET one job's state (gated)
- ``/api/plugins/protobanana/catalog``     GET the static param schema (gated)

No route holds a request open while a render runs: ``POST /jobs`` returns a
``job_id`` in well under a second (it never awaits the render; completion
arrives on the event bus), keeping every request clear of the fleet proxy's
20 s read lane (design R1). FastAPI is imported lazily so merely importing this
module stays host-free.

NOTE: this module intentionally does NOT use ``from __future__ import
annotations``. FastAPI resolves a handler's parameter types from the handler's
module globals; with stringized annotations it could not see the request model
and FastAPI/pydantic are lazily imported inside ``build_router`` (host-free
import). Evaluating annotations eagerly keeps the real classes on the handlers.
"""

from pathlib import Path

from . import catalog_static, jobs

_API = "/api/plugins/protobanana"
_PAGE = "/plugins/protobanana/studio"


def _view_dir(registry) -> Path:
    """The committed Vite build dir inside the plugin (``view/dist``)."""
    base = Path(getattr(registry, "plugin_dir", ".") or ".")
    return base / "view" / "dist"


def safe_asset(view_dir: Path, rel: str) -> Path | None:
    """Resolve ``rel`` under ``view_dir/assets`` or return ``None``.

    Path-traversal safe: the candidate is resolved and must stay inside the
    assets dir, and must be an existing regular file. ``..`` segments, absolute
    paths, and symlinks that escape all return ``None`` (→ 404).
    """
    assets = (Path(view_dir) / "assets").resolve()
    try:
        target = (assets / rel).resolve()
    except (OSError, ValueError):
        return None
    if not target.is_relative_to(assets):
        return None
    if not target.is_file():
        return None
    return target


def build_router(registry):
    """Build the Studio APIRouter. Call at register() time (imports FastAPI)."""
    from fastapi import APIRouter, HTTPException
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
    from pydantic import BaseModel

    router = APIRouter()
    view_dir = _view_dir(registry)

    class JobRequest(BaseModel):
        op: str
        params: dict = {}
        parent_id: str | None = None
        tier: str = "final"
        alias: str | None = None
        operator: str = "default"

    # ---- gated data routes -------------------------------------------------
    @router.post(f"{_API}/jobs")
    async def create_job(req: JobRequest):  # noqa: ANN202
        """Queue a render; respond with its id without awaiting the render."""
        job_id = jobs.submit(req.op, req.params, parent_id=req.parent_id,
                             operator=req.operator, tier=req.tier, alias=req.alias)
        return JSONResponse({"job_id": job_id}, status_code=202)

    @router.get(f"{_API}/jobs")
    async def list_jobs(limit: int = 50):  # noqa: ANN202
        return {"jobs": jobs.recent(limit)}

    @router.get(f"{_API}/jobs/{{job_id}}")
    async def get_job(job_id: str):  # noqa: ANN202
        state = jobs.get_state(job_id)
        if state is None:
            raise HTTPException(status_code=404, detail="unknown job")
        return state

    @router.get(f"{_API}/catalog")
    async def get_catalog():  # noqa: ANN202
        cfg = dict(getattr(registry, "live_config", lambda: registry.config)() or {})
        return {"ops": catalog_static.build_catalog(cfg)}

    # ---- public page + assets ---------------------------------------------
    @router.get(_PAGE)
    async def studio_page():  # noqa: ANN202
        index = view_dir / "index.html"
        if not index.is_file():
            raise HTTPException(status_code=404, detail="Studio view not built")
        return HTMLResponse(index.read_text(encoding="utf-8"))

    @router.get(f"{_PAGE}/assets/{{asset:path}}")
    async def studio_asset(asset: str):  # noqa: ANN202
        target = safe_asset(view_dir, asset)
        if target is None:
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(target)

    return router
