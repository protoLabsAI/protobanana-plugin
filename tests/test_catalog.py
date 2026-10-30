"""Host-free tests for Studio S6: the live catalog (catalog.py) and the
/catalog route that serves it.

The live catalog is fetched through ``graph.sdk.gateway_client()`` — the ONLY
transport (EGRESS ADR 0008; manifest ``network: []``). Here that client is a
fake async context manager, so no backend or host is needed; the route is driven
through httpx's ASGI transport exactly like test_jobs. Covers: a gateway alias
appearing with no plugin change (r1), the static fallback with ``stale`` when the
gateway is unreachable (r2), a configured alias the gateway doesn't know raising
a readable warning (r3), gateway_client being the sole transport (r4), the
TTL cache, and the ``workflows_hash`` S7 keys its cache on.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()

PLUGIN_ROOT = Path(__file__).resolve().parents[1]

# The plugin's documented fast-generate default — the alias the gateway's docs
# renamed to ``protolabs/qwen-image-turbo`` (design §1.1 / R5). The drift the
# catalog endpoint is here to surface.
DRIFT_ALIAS = "protolabs/qwen-image-2-1-turbo"
TURBO_ALIAS = "protolabs/qwen-image-turbo"


def _load(config=None):
    """Fresh plugin + FakeRegistry, with the live-catalog cache cleared so each
    test starts cold."""
    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    reg = FakeRegistry(config or {}, plugin_id="protobanana", plugin_dir=PLUGIN_ROOT)
    mod.register(reg)
    mod.catalog.reset_cache()
    return mod, reg


# --------------------------------------------------------------- fake gateway


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self._status = status

    def raise_for_status(self):
        if self._status >= 400:
            raise RuntimeError(f"gateway HTTP {self._status}")

    def json(self):
        return self._payload


def _install_gateway(monkeypatch, payload, calls, *, status=200, inits=None):
    """Point graph.sdk.gateway_client at a fake async client that records every
    GET path (and the ctor kwargs, if ``inits`` is given) and returns ``payload``."""
    class _Gateway:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, path, **kw):
            calls.append(path)
            return _Resp(payload, status)

    def factory(**kw):
        if inits is not None:
            inits.append(kw)
        return _Gateway()

    monkeypatch.setattr(sys.modules["graph.sdk"], "gateway_client", factory)


def _boom_gateway(monkeypatch):
    """A gateway_client that is simply unreachable (raises on construction)."""
    def boom(**kw):
        raise RuntimeError("gateway unreachable")

    monkeypatch.setattr(sys.modules["graph.sdk"], "gateway_client", boom)


def _upscale_op():
    """A brand-new op/alias the gateway added — the plugin has never heard of it."""
    return {
        "op": "upscale",
        "label": "Upscale",
        "route": "/images/edits",
        "aliases": {"final": "protolabs/qwen-image-upscale"},
        "default_tier": "final",
        "inputs": {"images": 1, "mask": False, "person": False},
        "licence": {"non_commercial": False},
        "typical_latency_s": 18,
        "params": {"type": "object",
                   "properties": {"image": {"type": "string", "title": "Image"},
                                  "scale": {"type": "integer", "title": "Scale", "default": 2}},
                   "required": ["image"]},
    }


# ------------------------------------------------------------ catalog.build()


def test_gateway_alias_appears_without_a_plugin_change(monkeypatch):
    """r1: a new op/alias added to the gateway catalog shows up in the merged
    catalog — with its own form — and the eight static ops are still there."""
    mod, _ = _load()
    calls = []
    _install_gateway(monkeypatch, {"ops": [_upscale_op()], "workflows_hash": "wh-1"}, calls)

    out = asyncio.run(mod.catalog.build({}))

    assert out["source"] == "gateway" and out["stale"] is False
    ops = {e["op"]: e for e in out["ops"]}
    assert "upscale" in ops  # pickable with no plugin release
    assert ops["upscale"]["params"]["properties"]["scale"]["default"] == 2  # its form
    assert len(out["ops"]) == 9  # merged over the static eight, not replacing them
    assert calls == ["/protobanana/catalog"]


def test_gateway_entry_merges_over_static(monkeypatch):
    """A gateway entry for an existing op wins field-by-field over the static
    one, while static-only ops remain (the static schema is the floor)."""
    mod, _ = _load()
    gen = {"op": "generate",
           "aliases": {"final": "protolabs/qwen-image-v2", "draft": TURBO_ALIAS},
           "params": {"type": "object",
                      "properties": {"prompt": {"type": "string"},
                                     "guidance": {"type": "number", "default": 4}},
                      "required": ["prompt"]}}
    _install_gateway(monkeypatch, {"ops": [gen]}, [])

    out = asyncio.run(mod.catalog.build({}))

    g = next(e for e in out["ops"] if e["op"] == "generate")
    assert g["aliases"]["final"] == "protolabs/qwen-image-v2"  # gateway wins
    assert g["params"]["properties"]["guidance"]["default"] == 4  # gateway form
    assert any(e["op"] == "compose" for e in out["ops"])  # static-only op kept
    assert len(out["ops"]) == 8


def test_unreachable_falls_back_to_static_stale(monkeypatch):
    """r2: gateway down → the static schema, source=static, stale=true, and no
    workflows_hash (there is no live catalog to hash)."""
    mod, _ = _load()
    _boom_gateway(monkeypatch)

    out = asyncio.run(mod.catalog.build({}))

    assert out["source"] == "static" and out["stale"] is True
    assert out["workflows_hash"] is None and out["warnings"] == []
    assert out["ops"] == mod.catalog_static.build_catalog({})
    assert len(out["ops"]) == 8


def test_http_error_falls_back_to_static(monkeypatch):
    """A non-2xx response is a failure like any other → static fallback."""
    mod, _ = _load()
    _install_gateway(monkeypatch, {"ops": []}, [], status=503)

    out = asyncio.run(mod.catalog.build({}))

    assert out["source"] == "static" and out["stale"] is True


def test_malformed_catalog_falls_back_to_static(monkeypatch):
    """A body with no ops list can't drive the forms → treat as unreachable."""
    mod, _ = _load()
    _install_gateway(monkeypatch, {"unexpected": True}, [])

    out = asyncio.run(mod.catalog.build({}))

    assert out["source"] == "static" and out["stale"] is True


def test_configured_alias_missing_from_catalog_warns(monkeypatch):
    """r3: the plugin's default fast_gen_model (qwen-image-2-1-turbo) is NOT in a
    catalog that knows qwen-image-turbo → exactly one readable warning naming the
    alias, where it's used, and the likely rename."""
    mod, _ = _load()
    static = mod.catalog_static.build_catalog({})
    configured = {a for e in static for a in e["aliases"].values() if a}
    assert DRIFT_ALIAS in configured  # the plugin ships this default today
    # The gateway knows every configured alias except the drift one, plus the
    # correct turbo alias it was renamed to.
    known = sorted((configured - {DRIFT_ALIAS}) | {TURBO_ALIAS})
    _install_gateway(monkeypatch, {"ops": [], "aliases": known, "workflows_hash": "wh"}, [])

    out = asyncio.run(mod.catalog.build({}))

    assert out["source"] == "gateway"
    assert len(out["warnings"]) == 1
    warning = out["warnings"][0]
    assert DRIFT_ALIAS in warning
    assert "generate/draft" in warning  # where the alias is used
    assert "did you mean" in warning and TURBO_ALIAS in warning  # the rename hint


def test_no_warnings_when_every_alias_is_known(monkeypatch):
    """When the catalog knows all configured aliases, there is nothing to warn."""
    mod, _ = _load()
    configured = sorted({a for e in mod.catalog_static.build_catalog({})
                         for a in e["aliases"].values() if a})
    _install_gateway(monkeypatch, {"ops": [], "aliases": configured}, [])

    out = asyncio.run(mod.catalog.build({}))

    assert out["warnings"] == []


def test_workflows_hash_surfaces_for_s7(monkeypatch):
    """The gateway's workflow-set hash rides through so S7 can key its step cache
    on it (design R10)."""
    mod, _ = _load()
    _install_gateway(monkeypatch, {"ops": [], "workflows_hash": "sha256:abc123"}, [])

    out = asyncio.run(mod.catalog.build({}))

    assert out["workflows_hash"] == "sha256:abc123"


# ------------------------------------------------------- only gateway_client


def test_catalog_source_imports_no_other_http_client():
    """r4 (static half): catalog.py's transport is gateway_client and nothing
    else — no httpx/requests/aiohttp/urllib/socket import sneaks a second egress."""
    src = (PLUGIN_ROOT / "catalog.py").read_text(encoding="utf-8")
    assert "gateway_client" in src
    import_lines = [ln.strip() for ln in src.splitlines()
                    if ln.strip().startswith(("import ", "from "))]
    forbidden = ("httpx", "requests", "aiohttp", "urllib", "http.client", "socket")
    for ln in import_lines:
        assert not any(tok in ln for tok in forbidden), \
            f"catalog.py imports a non-gateway transport: {ln!r}"


def test_gateway_client_is_the_only_transport_with_a_short_timeout(monkeypatch):
    """r4 (behavioral half): build() reaches the backend ONLY through
    gateway_client, hits exactly /protobanana/catalog, and uses the short catalog
    timeout — never the 300 s render timeout."""
    mod, _ = _load()
    calls, inits = [], []
    _install_gateway(monkeypatch, {"ops": [], "workflows_hash": "h"}, calls,
                     inits=inits)

    asyncio.run(mod.catalog.build({"catalog_timeout_s": 3}))

    assert calls == ["/protobanana/catalog"]  # the one and only request
    assert inits and inits[0].get("timeout") == 3.0  # short, configurable timeout


def test_default_timeout_is_short_not_the_render_timeout(monkeypatch):
    """With no override the catalog uses its own short default, not timeout_s."""
    mod, _ = _load({"timeout_s": 300})
    inits = []
    _install_gateway(monkeypatch, {"ops": []}, [], inits=inits)

    asyncio.run(mod.catalog.build({"timeout_s": 300}))

    assert inits and 0 < inits[0]["timeout"] <= 30  # nowhere near 300 s


# ------------------------------------------------------------------- caching


def test_catalog_is_cached_within_ttl_and_refetched_after_reset(monkeypatch):
    """A successful fetch is cached for the TTL (one request across two builds);
    reset_cache forces a refetch."""
    mod, _ = _load()
    calls = []
    _install_gateway(monkeypatch, {"ops": [], "workflows_hash": "h"}, calls)

    asyncio.run(mod.catalog.build({}))
    asyncio.run(mod.catalog.build({}))
    assert calls == ["/protobanana/catalog"]  # second build served from cache

    mod.catalog.reset_cache()
    asyncio.run(mod.catalog.build({}))
    assert len(calls) == 2  # cold again → refetched


def test_zero_ttl_refetches_every_build(monkeypatch):
    """A zero TTL disables the cache: each build fetches afresh."""
    mod, _ = _load()
    calls = []
    _install_gateway(monkeypatch, {"ops": []}, calls)

    asyncio.run(mod.catalog.build({"catalog_ttl_s": 0}))
    asyncio.run(mod.catalog.build({"catalog_ttl_s": 0}))

    assert len(calls) == 2


# ------------------------------------------------------------------- routes


def _app(reg):
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(reg.routers[-1][1])
    return app


async def _client(app):
    import httpx

    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://studio.test")


def test_catalog_route_serves_gateway_source(monkeypatch):
    """r1 end-to-end: GET /catalog surfaces source=gateway, the workflows_hash,
    and the new gateway op in the list the Studio picker is built from."""
    mod, reg = _load()
    _install_gateway(monkeypatch, {"ops": [_upscale_op()], "aliases": [],
                                   "workflows_hash": "wh"}, [])

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.get("/api/plugins/protobanana/catalog")
            assert r.status_code == 200
            body = r.json()
            assert body["source"] == "gateway" and body["stale"] is False
            assert body["workflows_hash"] == "wh"
            assert any(e["op"] == "upscale" for e in body["ops"])
            assert isinstance(body["warnings"], list)

    asyncio.run(scenario())


def test_catalog_route_falls_back_when_unreachable(monkeypatch):
    """r2 end-to-end: the gateway is down → GET /catalog still returns the eight
    static ops with source=static and stale=true (the view's banner trigger)."""
    mod, reg = _load()
    _boom_gateway(monkeypatch)

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.get("/api/plugins/protobanana/catalog")
            assert r.status_code == 200
            body = r.json()
            assert body["source"] == "static" and body["stale"] is True
            assert len(body["ops"]) == 8

    asyncio.run(scenario())
