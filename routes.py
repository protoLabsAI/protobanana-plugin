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


def page_base_href(page_path: str, request_path: str) -> str:
    """Relative ``<base>`` href that makes the bundle's own ``./assets/...`` URLs
    resolve under ``{page}/assets/...`` — where :func:`studio_asset` serves them —
    whatever request path the page was reached by.

    The view is declared at ``/plugins/protobanana/studio`` (no trailing slash —
    the manifest view path), so a browser resolves the bundle's relative
    ``./assets/x`` against the PARENT dir (``/plugins/protobanana/``), landing on
    ``/plugins/protobanana/assets/x`` which no route serves (the bundle 404s and
    the iframe stays blank). Pointing ``<base>`` at the page's own last segment
    pulls resolution back under the page. The href is RELATIVE on purpose: the
    fleet proxy serves the page under a per-member slug prefix the backend never
    sees, and a relative base keeps that prefix where a root-absolute one drops it.

    - reached WITHOUT a trailing slash → ``"studio/"`` (document base dir is the
      parent, so name the page to descend into it);
    - reached WITH a trailing slash → ``"./"`` (base dir is already the page).
    """
    name = page_path.rstrip("/").rsplit("/", 1)[-1]
    return "./" if request_path.endswith("/") else f"{name}/"


def with_base_href(html: str, href: str) -> str:
    """Insert ``<base href=...>`` as the first child of ``<head>`` so it governs
    the relative asset URLs that follow it; root-absolute ``/_ds/...`` kit URLs
    are unaffected. Returns the html unchanged if it carries no ``<head>``."""
    marker = "<head>"
    i = html.find(marker)
    if i == -1:
        return html
    at = i + len(marker)
    return f'{html[:at]}\n    <base href="{href}">{html[at:]}'


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
    from fastapi import APIRouter, HTTPException, Request
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
    # Serve the page at the manifest path AND at its trailing-slash form: the
    # host opens the no-slash path, but a <base> is injected per-request so the
    # bundle's relative ./assets/ URLs resolve under {_PAGE}/assets either way
    # (see page_base_href) — the fix for the bundle 404ing one dir too high.
    @router.get(_PAGE)
    @router.get(f"{_PAGE}/")
    async def studio_page(request: Request):  # noqa: ANN202
        index = view_dir / "index.html"
        if not index.is_file():
            raise HTTPException(status_code=404, detail="Studio view not built")
        html = with_base_href(
            index.read_text(encoding="utf-8"),
            page_base_href(_PAGE, request.url.path),
        )
        return HTMLResponse(html)

    @router.get(f"{_PAGE}/assets/{{asset:path}}")
    async def studio_asset(asset: str):  # noqa: ANN202
        target = safe_asset(view_dir, asset)
        if target is None:
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(target)

    return router
