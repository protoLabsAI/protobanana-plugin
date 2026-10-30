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

import pytest
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
    catalog — with its own form — and the seven static ops are still there."""
    mod, _ = _load()
    calls = []
    _install_gateway(monkeypatch, {"ops": [_upscale_op()], "workflows_hash": "wh-1"}, calls)

    out = asyncio.run(mod.catalog.build({}))

    assert out["source"] == "gateway" and out["stale"] is False
    ops = {e["op"]: e for e in out["ops"]}
    assert "upscale" in ops  # pickable with no plugin release
    assert ops["upscale"]["params"]["properties"]["scale"]["default"] == 2  # its form
    assert len(out["ops"]) == len(mod.catalog_static.OPS) + 1  # merged over the static seven, not replacing them
    assert calls == ["/protobanana/catalog"]


def test_gateway_entry_merges_aliases_but_keeps_static_form(monkeypatch):
    """A gateway entry for a built-in op corrects its aliases tier-by-tier, but
    the static schema stays the FLOOR for the form. The gateway's extra params
    (``guidance``) must NOT enter a built-in op's form: jobs._dispatch sends a
    built-in op through a hard-coded branch with fixed fields, so a form field
    the branch can't forward would be silently dropped. Static-only ops remain."""
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
    assert g["aliases"]["final"] == "protolabs/qwen-image-v2"  # gateway alias wins
    assert g["aliases"]["draft"] == TURBO_ALIAS
    # The gateway's added param never reaches a built-in op's form — the static
    # form is preserved intact, so the view shows only fields _dispatch sends.
    assert "guidance" not in g["params"]["properties"]
    assert g["params"] == mod.catalog_static.entry({}, "generate")["params"]
    assert any(e["op"] == "compose" for e in out["ops"])  # static-only op kept
    assert len(out["ops"]) == len(mod.catalog_static.OPS)


def test_builtin_op_renders_through_static_branch_on_gateway_alias(monkeypatch):
    """The blocking S6 finding, end-to-end: a gateway entry that adds a param to
    a built-in op must not change how that op renders. ``generate`` keeps its
    static form and still runs through jobs._dispatch's built-in branch on the
    gateway-corrected ``final`` alias — nothing the user set is silently dropped."""
    from test_jobs import PNG_1x1

    mod, _ = _load()
    gen = {"op": "generate",
           "aliases": {"final": "live-final", "draft": TURBO_ALIAS},
           "params": {"type": "object",
                      "properties": {"prompt": {"type": "string"},
                                     "guidance": {"type": "number", "default": 4}},
                      "required": ["prompt"]}}
    _install_gateway(monkeypatch, {"ops": [gen]}, [])
    rendered = []

    async def generate(model, prompt, size, **kwargs):
        rendered.append((model, prompt, kwargs.get("fields")))
        return PNG_1x1

    monkeypatch.setattr(mod.jobs.client, "generate", generate)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "a fox"})
        await mod.jobs._jobs[job_id]["_task"]
        assert mod.jobs.get_state(job_id)["status"] == "done"
        # Built-in branch: rendered on the gateway-corrected alias, no generic
        # ``fields`` path (the static form carries no extra gateway params).
        assert rendered == [("live-final", "a fox", None)]

    asyncio.run(scenario())


def test_merge_preserves_static_only_alias_tiers(monkeypatch):
    """Every tier in the static floor survives a partial gateway alias map."""
    mod, _ = _load()
    monkeypatch.setitem(mod.catalog_static._ALIASES["generate"], "realism", "gen_model")
    _install_gateway(monkeypatch, {"ops": [
        {"op": "generate", "aliases": {"final": "gw-final"}},
    ]}, [])
    out = asyncio.run(mod.catalog.build({}))
    entry = next(e for e in out["ops"] if e["op"] == "generate")
    assert entry["aliases"]["final"] == "gw-final"
    for tier in ("draft", "realism"):
        assert entry["aliases"][tier] == mod.catalog_static.entry({}, "generate")["aliases"][tier]


def test_realism_renders_on_realism_alias_under_gateway_catalog(monkeypatch):
    """A gateway-only identity op renders using its own realism alias."""
    from test_jobs import PNG_1x1, _data_url

    mod, reg = _load()
    ident = {"op": "identity", "route": "/images/edits",
             "aliases": {"final": "gw-identity", "realism": "gw-realism"},
             "params": {"properties": {}, "required": []}}
    _install_gateway(monkeypatch, {"ops": [ident]}, [])
    rendered = []

    async def edit(alias, prompt, image, **kwargs):
        rendered.append(alias)
        return PNG_1x1

    monkeypatch.setattr(mod.jobs.client, "edit", edit)

    async def scenario():
        job_id = mod.jobs.submit(
            "identity", {"image": _data_url(PNG_1x1), "prompt": "her", "realism": True})
        await mod.jobs._jobs[job_id]["_task"]
        assert mod.jobs.get_state(job_id)["status"] == "done"
        assert mod.jobs.get_state(job_id)["alias"] == "gw-realism"
        assert rendered == ["gw-realism"]

    asyncio.run(scenario())


def test_unreachable_falls_back_to_static_stale(monkeypatch):
    """r2: gateway down → the static schema, source=static, stale=true, and no
    workflows_hash (there is no live catalog to hash)."""
    mod, _ = _load()
    _boom_gateway(monkeypatch)

    out = asyncio.run(mod.catalog.build({}))

    assert out["source"] == "static" and out["stale"] is True
    assert out["workflows_hash"] is None
    assert "gateway unreachable" in out["warnings"][0]
    assert out["ops"] == mod.catalog_static.build_catalog({})
    assert len(out["ops"]) == len(mod.catalog_static.OPS)


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
    """r2 end-to-end: the gateway is down → GET /catalog still returns the seven
    static ops with source=static and stale=true (the view's banner trigger)."""
    mod, reg = _load()
    _boom_gateway(monkeypatch)

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.get("/api/plugins/protobanana/catalog")
            assert r.status_code == 200
            body = r.json()
            assert body["source"] == "static" and body["stale"] is True
            assert len(body["ops"]) == len(mod.catalog_static.OPS)

    asyncio.run(scenario())


def test_gateway_only_operations_render_through_documented_routes(monkeypatch):
    import base64

    from test_jobs import PNG_1x1, _data_url

    for route in ('/images/edits', '/images/generations', '/chat/completions'):
        mod, reg = _load()
        entry = _upscale_op()
        entry['route'] = route
        entry['params']['properties']['images'] = {'type': 'array'}
        calls = []

        class Gateway:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, path):
                return _Resp({'ops': [entry]})

            async def post(self, path, **kwargs):
                calls.append((path, kwargs))
                encoded = base64.b64encode(PNG_1x1).decode()
                return _Resp({'data': [{'b64_json': encoded}], 'choices': [
                    {'message': {'content': f'data:image/png;base64,{encoded}'}}]})

        monkeypatch.setattr(sys.modules['graph.sdk'], 'gateway_client', lambda **kw: Gateway())

        async def scenario():
            async with await _client(_app(reg)) as ac:
                response = await ac.post('/api/plugins/protobanana/jobs', json={
                    'op': 'upscale', 'params': {'image': _data_url(PNG_1x1),
                                              'images': [_data_url(PNG_1x1)] * 2, 'scale': 4}})
                assert response.status_code == 202
                job_id = response.json()['job_id']
                await mod.jobs._jobs[job_id]['_task']
                assert mod.jobs.get_state(job_id)['status'] == 'done'
                assert reg.saved_media[-1][2]['alias'] == entry['aliases']['final']
                assert any(topic == 'protobanana.job.done' for topic, _ in reg.emitted)

        asyncio.run(scenario())
        path, request = calls[0]
        assert path == route
        payload = request.get('json', request.get('data'))
        assert payload['model'] == entry['aliases']['final']
        assert str(payload['scale']) == '4'


@pytest.mark.parametrize("valid_person", [True, False])
def test_gateway_only_edit_prepares_person_reference_and_finishes(monkeypatch, valid_person):
    import base64
    from io import BytesIO

    from PIL import Image
    from test_jobs import PNG_1x1, _data_url, _transparent_png

    mod, reg = _load()
    entry = _upscale_op()
    entry["params"]["properties"]["person_image"] = {"type": "string"}
    _install_gateway(monkeypatch, {"ops": [entry]}, [])
    calls = []

    async def edit(alias, prompt, image, *, fields, mask):
        calls.append(alias)
        prefix, encoded = fields["person_image"].split(",", 1)
        assert prefix == "data:image/png;base64"
        with Image.open(BytesIO(base64.b64decode(encoded))) as person:
            assert person.convert("RGB").getpixel((1, 1)) == (255, 255, 255)
        return PNG_1x1

    monkeypatch.setattr(mod.jobs.client, "edit", edit)

    async def scenario():
        person = _data_url(_transparent_png()) if valid_person else "data:image/png;base64,a"
        job_id = mod.jobs.submit("upscale", {"image": _data_url(PNG_1x1),
                                              "person_image": person})
        await mod.jobs._jobs[job_id]["_task"]
        status = "done" if valid_person else "failed"
        assert mod.jobs.get_state(job_id)["status"] == status
        assert [topic for topic, _ in reg.emitted] == [f"protobanana.job.{status}"]
        assert calls == ([entry["aliases"]["final"]] if valid_person else [])

    asyncio.run(scenario())


def test_displayed_gateway_alias_is_rendered_and_override_wins(monkeypatch):
    from test_jobs import PNG_1x1

    mod, reg = _load({'fast_gen_model': DRIFT_ALIAS})
    _install_gateway(monkeypatch, {'ops': [
        {'op': 'generate', 'aliases': {'draft': TURBO_ALIAS, 'final': 'live-final'}}]}, [])
    rendered = []

    async def generate(model, *args, **kwargs):
        rendered.append(model)
        return PNG_1x1

    monkeypatch.setattr(mod.jobs.client, 'generate', generate)

    async def scenario():
        catalog = await mod.catalog.build(reg.config)
        displayed = next(e for e in catalog['ops'] if e['op'] == 'generate')['aliases']['draft']
        for override in (None, displayed, 'manual-model'):
            job_id = mod.jobs.submit('generate', {'prompt': 'fox'}, tier='draft', alias=override)
            await mod.jobs._jobs[job_id]['_task']
            assert mod.jobs.get_state(job_id)['status'] == 'done'
        assert rendered == [displayed, displayed, 'manual-model']

    asyncio.run(scenario())


def test_backend_v1_alias_records_keep_distinct_forms(monkeypatch):
    mod, _ = _load()
    entry = _upscale_op()
    entries = [{**entry, 'alias': alias, 'tier': 'final'} for alias in ('upscale-v1', 'upscale-v2')]
    entries[1]['params'] = {'properties': {'strength': {'type': 'number'}}}
    _install_gateway(monkeypatch, {'version': 1, 'aliases': entries, 'workflows_hash': 'v1'}, [])
    result = asyncio.run(mod.catalog.build({}))
    assert result['source'] == 'gateway'
    assert result['workflows_hash'] == 'v1'
    ops = {e['op']: e for e in result['ops']}
    assert ops['upscale:upscale-v1']['aliases']['final'] == 'upscale-v1'
    assert 'strength' in ops['upscale:upscale-v2']['params']['properties']
    assert ops['upscale:upscale-v2']['params']['required'] == []


def test_invalid_gateway_entries_do_not_break_forms(monkeypatch):
    mod, _ = _load()
    bad = _upscale_op()
    del bad['params']
    _install_gateway(monkeypatch, {'ops': [bad, {'op': 'generate', 'params': {}}]}, [])
    result = asyncio.run(mod.catalog.build({}))
    assert result['ops'] == mod.catalog_static.build_catalog({})


def test_v1_catalog_job_returns_before_catalog_fetch_and_renders(monkeypatch):
    from test_jobs import PNG_1x1, _data_url

    mod, reg = _load()
    entry = {**_upscale_op(), 'alias': 'gateway-upscale', 'tier': 'final'}
    calls = []

    async def scenario():
        release = asyncio.Event()
        started = asyncio.Event()

        async def fetch(cfg):
            started.set()
            await release.wait()
            return {'ops': mod.catalog._alias_entries([entry])}

        async def edit(alias, prompt, image, **kwargs):
            calls.append((alias, kwargs['fields']))
            return PNG_1x1

        monkeypatch.setattr(mod.catalog, 'fetch_gateway_catalog', fetch)
        monkeypatch.setattr(mod.jobs.client, 'edit', edit)
        async with await _client(_app(reg)) as ac:
            response = await asyncio.wait_for(ac.post('/api/plugins/protobanana/jobs', json={
                'op': 'upscale:gateway-upscale',
                'params': {'image': _data_url(PNG_1x1), 'scale': 3}}), timeout=1)
            assert response.status_code == 202
            job_id = response.json()['job_id']
            await asyncio.wait_for(started.wait(), timeout=1)
            assert not calls
            release.set()
            await mod.jobs._jobs[job_id]['_task']
            assert mod.jobs.get_state(job_id)['status'] == 'done'
            assert calls == [('gateway-upscale', {'scale': 3})]

    asyncio.run(scenario())


def test_backend_v1_updates_builtin_alias_defaults(monkeypatch):
    mod, _ = _load()
    _install_gateway(monkeypatch, {'aliases': [
        {'op': 'gen', 'alias': TURBO_ALIAS, 'tier': 'draft',
         'route': '/images/generations', 'params': {'properties': {}}},
        {'op': 'gen', 'alias': 'live-final', 'tier': 'final',
         'route': '/images/generations', 'params': {'properties': {}}},
    ]}, [])
    result = asyncio.run(mod.catalog.build({'fast_gen_model': DRIFT_ALIAS}))
    gen = next(e for e in result['ops'] if e['op'] == 'generate')
    assert gen['aliases'] == {'draft': TURBO_ALIAS, 'final': 'live-final'}
    assert any(DRIFT_ALIAS in warning for warning in result['warnings'])


@pytest.mark.parametrize("field,value", [
    ("route", []), ("route", "/unknown"), ("op", {}), ("op", ""),
    ("aliases", {"final": 42}), ("aliases", []), ("aliases", {"": "alias"}),
    ("params", []), ("params.properties", {"scale": None}),
    ("params.required", {}), ("params.required", [42]),
    ("label", 42), ("tier", []),
    *[(field, None) for field in ("op", "route", "aliases", "params",
                                "params.properties", "params.required", "label", "tier")],
])
def test_malformed_entries_are_dropped_before_merge(monkeypatch, field, value):
    mod, reg = _load()
    bad = _upscale_op()
    bad["op"] = "broken"
    if "." in field:
        parent, key = field.split(".")
        bad[parent][key] = value
    else:
        bad[field] = value
    _install_gateway(monkeypatch, {"ops": [bad, _upscale_op()]}, [])
    merge = mod.catalog._merge_ops

    def checked_merge(static, entries):
        assert [e["op"] for e in entries] == ["upscale"]
        return merge(static, entries)

    monkeypatch.setattr(mod.catalog, "_merge_ops", checked_merge)

    async def scenario():
        async with await _client(_app(reg)) as ac:
            response = await ac.get("/api/plugins/protobanana/catalog")
            assert response.status_code == 200
            result = response.json()
        assert result["source"] == "gateway"
        assert len(result["ops"]) == len(mod.catalog_static.OPS) + 1
        warnings = [w for w in result["warnings"] if "Dropped gateway op" in w]
        assert len(warnings) == 1
        assert field in warnings[0] and repr(bad["op"]) in warnings[0]
        assert mod.catalog._cache["data"] is None

    asyncio.run(scenario())


@pytest.mark.parametrize("entry", [None, {}, {"op": "generate"}])
def test_missing_aliases_and_null_entries_are_rejected(monkeypatch, entry):
    mod, _ = _load()
    _install_gateway(monkeypatch, {"ops": [entry, _upscale_op()]}, [])
    result = asyncio.run(mod.catalog.build({}))
    assert len(result["ops"]) == len(mod.catalog_static.OPS) + 1
    assert any("Dropped gateway op" in w for w in result["warnings"])
    assert mod.catalog._cache["data"] is None


@pytest.mark.parametrize("op,tier", [("generate", "realism"), ("generate", "draft")])
def test_partial_tier_preserves_static_alias(monkeypatch, op, tier):
    mod, _ = _load()
    monkeypatch.setitem(mod.catalog_static._ALIASES[op], "realism", "gen_model")
    _install_gateway(monkeypatch, {"ops": [{"op": op, "aliases": {"final": "live"}}]}, [])
    result = asyncio.run(mod.catalog.build({}))
    entry = next(e for e in result["ops"] if e["op"] == op)
    assert entry["aliases"]["final"] == "live"
    assert entry["aliases"][tier] == mod.catalog_static.entry({}, op)["aliases"][tier]


@pytest.mark.parametrize("failure", ["_merge_ops", "_alias_warnings"])
def test_build_failure_returns_static_and_route_never_500(monkeypatch, failure):
    mod, reg = _load()
    _install_gateway(monkeypatch, {"ops": [_upscale_op()]}, [])

    def boom(*args):
        raise RuntimeError("catalog processing failed")

    monkeypatch.setattr(mod.catalog, failure, boom)

    async def scenario():
        result = await mod.catalog.build({})
        assert result["source"] == "static" and result["stale"] is True
        assert result["ops"] == mod.catalog_static.build_catalog({})
        assert "catalog processing failed" in result["warnings"][0]
        assert mod.catalog._cache["data"] is None
        async with await _client(_app(reg)) as ac:
            response = await ac.get("/api/plugins/protobanana/catalog")
            assert response.status_code == 200
            assert response.json() == result
        # The gateway-only operation is absent from the fallback; fail terminally.
        job_id = mod.jobs.submit("upscale", {})
        await mod.jobs._jobs[job_id]["_task"]
        assert mod.jobs.get_state(job_id)["status"] == "failed"
        assert [topic for topic, _ in reg.emitted] == ["protobanana.job.failed"]

    asyncio.run(scenario())


def test_unexpected_build_exception_fails_job(monkeypatch):
    mod, reg = _load()

    async def boom(*args):
        raise RuntimeError("unexpected build failure")

    monkeypatch.setattr(mod.catalog, "build", boom)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "fox"})
        await mod.jobs._jobs[job_id]["_task"]
        assert mod.jobs.get_state(job_id)["status"] == "failed"
        assert [topic for topic, _ in reg.emitted] == ["protobanana.job.failed"]
        assert "unexpected build failure" in reg.emitted[0][1]["error"]

    asyncio.run(scenario())


@pytest.mark.parametrize("payload", [None, {"ops": None}, {"ops": [{"op": "bad"}]}])
def test_bad_payload_is_not_cached(monkeypatch, payload):
    mod, _ = _load()
    calls = []
    _install_gateway(monkeypatch, payload, calls)
    asyncio.run(mod.catalog.build({}))
    assert mod.catalog._cache["data"] is None
    _install_gateway(monkeypatch, {"ops": [_upscale_op()]}, calls)
    result = asyncio.run(mod.catalog.build({}))
    assert len(calls) == 2
    assert any(e["op"] == "upscale" for e in result["ops"])
    assert mod.catalog._cache["data"]["ops"] == [_upscale_op()]


@pytest.mark.parametrize("field,value", [
    ("op", {}), ("route", []), ("alias", None), ("tier", []),
    ("params", None), ("label", None),
])
def test_bad_per_alias_record_does_not_hide_valid_records(monkeypatch, field, value):
    mod, _ = _load()
    good = {**_upscale_op(), "alias": "upscale-live", "tier": "final"}
    bad = {**good, field: value}
    _install_gateway(monkeypatch, {"aliases": [bad, good]}, [])
    result = asyncio.run(mod.catalog.build({}))
    assert result["source"] == "gateway"
    assert any(e["op"] == "upscale:upscale-live" for e in result["ops"])
    warnings = [w for w in result["warnings"] if "Dropped gateway op" in w]
    assert len(warnings) == 1 and field in warnings[0]
    assert mod.catalog._cache["data"] is None


def test_cache_stores_normalized_ops_and_expires(monkeypatch):
    mod, _ = _load()
    entry = {**_upscale_op(), "alias": "upscale-live", "tier": "final"}
    del entry["params"]["required"]
    calls = []
    now = [100.0]
    monkeypatch.setattr(mod.catalog.time, "monotonic", lambda: now[0])
    _install_gateway(monkeypatch, {"aliases": [entry]}, calls)
    first = asyncio.run(mod.catalog.build({}))
    cached = mod.catalog._cache["data"]
    assert cached["ops"][0]["params"]["required"] == []
    assert cached["aliases"] == ["upscale-live"]
    now[0] += 61
    assert asyncio.run(mod.catalog.build({})) == first
    assert asyncio.run(mod.catalog.build({})) == first
    assert len(calls) == 2


# ------------------------------------------- gateway-primary jobs resolution
#
# Operator authority decision (2026-10-30): the merged snapshot from
# catalog.build() is the ONE source of truth. jobs.submit / _run resolve the
# alias and validate the op through it; catalog_static is only the floor build()
# falls back to when the gateway is down. These pin that jobs.py no longer
# resolves or validates through catalog_static directly.


def test_submit_defers_alias_resolution_to_the_snapshot(monkeypatch):
    """A built-in submit with no override carries NO resolved alias while queued —
    submit does not touch catalog_static. The alias fills in from the gateway
    snapshot only once _run reads it, so the gateway's alias is what renders."""
    from test_jobs import PNG_1x1

    mod, _ = _load()
    _install_gateway(monkeypatch, {"ops": [
        {"op": "generate", "aliases": {"final": "live-final", "draft": TURBO_ALIAS}}]}, [])
    rendered = []

    async def generate(model, *a, **kw):
        rendered.append(model)
        return PNG_1x1

    monkeypatch.setattr(mod.jobs.client, "generate", generate)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "a fox"})
        # Not resolved via the static catalog at submit time (no cfg default
        # leaks through); the snapshot resolves it when the job starts.
        assert mod.jobs.get_state(job_id)["alias"] is None
        await mod.jobs._jobs[job_id]["_task"]
        assert mod.jobs.get_state(job_id)["status"] == "done"
        assert mod.jobs.get_state(job_id)["alias"] == "live-final"
        assert rendered == ["live-final"]

    asyncio.run(scenario())


def test_op_absent_from_a_reachable_catalog_fails_the_job(monkeypatch):
    """_run validates the op through the snapshot: an op the (reachable) gateway
    catalog doesn't carry is rejected with a terminal job.failed, never left
    wedged in 'running'."""
    mod, reg = _load()
    _install_gateway(monkeypatch, {"ops": [_upscale_op()]}, [])  # healthy, but no "ghost"

    async def scenario():
        job_id = mod.jobs.submit("ghost", {})
        await mod.jobs._jobs[job_id]["_task"]
        st = mod.jobs.get_state(job_id)
        assert st["status"] == "failed"
        assert "not in the catalog" in st["error"]
        assert [t for t, _ in reg.emitted] == ["protobanana.job.failed"]

    asyncio.run(scenario())


def test_jobs_resolves_through_snapshot_not_catalog_static():
    """Gateway-primary architecture guard: jobs.py builds the merged snapshot and
    resolves/validates through it — it no longer calls catalog_static.alias_for
    or catalog_static.entry (the static calls the operator decision removed)."""
    src = (PLUGIN_ROOT / "jobs.py").read_text(encoding="utf-8")
    assert "catalog.build(" in src
    assert "catalog_static.alias_for" not in src
    assert "catalog_static.entry" not in src


@pytest.mark.parametrize("op,config_key,tier", [
    ("generate", "gen_model", "final"),
    ("generate", "fast_gen_model", "draft"),
    ("edit", "edit_model", "final"),
    ("edit", "fast_edit_model", "draft"),
])
def test_known_configured_alias_is_fallback_to_gateway_default(monkeypatch, op, config_key, tier):
    """Operator decision: being known does not make a config alias the live default.

    The picker and actual render agree, explicit overrides still work, and a
    gateway outage restores the user's configured alias.
    """
    from test_jobs import PNG_1x1, _data_url

    configured = "configured-model"
    mod, reg = _load({config_key: configured})
    alternate = _upscale_op()
    alternate["aliases"] = {"final": configured}
    _install_gateway(monkeypatch, {"ops": [
        {"op": op, "aliases": {tier: "gateway-default"}}, alternate,
    ]}, [])
    rendered = []

    async def render(alias, *args, **kwargs):
        rendered.append(alias)
        return PNG_1x1

    monkeypatch.setattr(mod.jobs.client, "generate", render)
    monkeypatch.setattr(mod.jobs.client, "edit", render)

    async def scenario():
        async with await _client(_app(reg)) as ac:
            response = await ac.get("/api/plugins/protobanana/catalog")
            assert response.status_code == 200
            snapshot = response.json()
        entry = next(e for e in snapshot["ops"] if e["op"] == op)
        assert entry["aliases"][tier] == "gateway-default"
        assert not any(configured in warning for warning in snapshot["warnings"])
        for offline, override, expected in [
            (False, None, "gateway-default"),
            (False, configured, configured),
            (True, None, configured),
        ]:
            if offline:
                mod.catalog.reset_cache()
                _boom_gateway(monkeypatch)
            job_id = mod.jobs.submit(op, {"prompt": "fox", "image": _data_url(PNG_1x1)},
                                     tier=tier, alias=override)
            await mod.jobs._jobs[job_id]["_task"]
            state = mod.jobs.get_state(job_id)
            assert state["status"] == "done"
            assert state["alias"] == expected
            assert rendered[-1] == expected

    asyncio.run(scenario())


def test_unsupported_route_is_neither_pickable_nor_renderable(monkeypatch):
    mod, reg = _load()
    entry = {**_upscale_op(), "route": "/unsupported"}
    _install_gateway(monkeypatch, {"ops": [entry]}, [])

    async def scenario():
        snapshot = await mod.catalog.build({})
        assert not any(e["op"] == "upscale" for e in snapshot["ops"])
        job_id = mod.jobs.submit("upscale", {}, alias="manual-override")
        await mod.jobs._jobs[job_id]["_task"]
        assert mod.jobs.get_state(job_id)["status"] == "failed"
        assert "not in the catalog" in mod.jobs.get_state(job_id)["error"]
        assert [topic for topic, _ in reg.emitted] == ["protobanana.job.failed"]
        assert not reg.saved_media

    asyncio.run(scenario())
