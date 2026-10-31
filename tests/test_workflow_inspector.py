"""Host-free tests for Studio S10: the workflow inspector route (workflows.py and
the ``GET /api/plugins/protobanana/workflows/{alias}`` route that serves it).

The per-alias workflow is fetched through ``graph.sdk.gateway_client()`` — the
ONLY transport (EGRESS ADR 0008; manifest ``capabilities.network: []``). Here
that client is a fake async context manager, so no backend or host is needed.
The route handler is driven DIRECTLY (not through an httpx ASGI transport) so the
"nothing but gateway_client" assertion can stand: httpx and requests are
monkeypatched to blow up on any use, proving the inspector path contacts nothing
else — in particular it never fetches ``comfy_ui_url`` or the ComfyUI host.

Covers: the route returns the payload for every stem in a fixture catalog (r1),
an unknown alias → a readable 404 (r3), gateway_client being the sole transport
(r3), ``comfy_ui_url`` defaulting to "" and never driving a call (r2), and the
(alias, workflows_hash) cache.
"""

import asyncio
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def _load(config=None):
    """Fresh plugin + FakeRegistry, with the workflow cache cleared so each test
    starts cold."""
    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    reg = FakeRegistry(config or {}, plugin_id="protobanana", plugin_dir=PLUGIN_ROOT)
    mod.register(reg)
    mod.workflows.reset_cache()
    return mod, reg


# ------------------------------------------------- a fixture "shipped" catalog
#
# One entry per workflow stem the inspector must render: a text-to-image graph, a
# single-image edit, and a background-remover. Each is a minimal ComfyUI
# API-format map ({node_id: {class_type, inputs}}) with a ``_doc`` key the drawer
# header shows, plus the substituted ``slots`` the view highlights.

FIXTURE_WORKFLOWS = {
    "protolabs/qwen-image": {
        "workflow": {
            "_doc": "Qwen-Image text-to-image. Prompt and seed are substituted per render.",
            "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "qwen.safetensors"}},
            "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["4", 1]}},
            "3": {"class_type": "KSampler", "inputs": {"seed": 0, "model": ["4", 0], "positive": ["6", 0], "latent_image": ["5", 0]}},
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
            "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
        },
        "stem": "qwen_image",
        "workflows_hash": "sha256:wh1",
        "slots": [{"node_id": "6", "input": "text"}, {"node_id": "3", "input": "seed"}],
    },
    "protolabs/qwen-image-edit": {
        "workflow": {
            "_doc": "Qwen-Image single-image instruction edit.",
            "1": {"class_type": "LoadImage", "inputs": {"image": "input.png"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": ""}},
            "3": {"class_type": "KSampler", "inputs": {"seed": 0, "positive": ["2", 0], "latent_image": ["1", 0]}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
        },
        "stem": "qwen_image_edit",
        "workflows_hash": "sha256:wh1",
        "slots": [{"node_id": "1", "input": "image"}, {"node_id": "2", "input": "text"}],
    },
    "protolabs/qwen-image-bgremove": {
        "workflow": {
            "_doc": "RMBG background removal (non-commercial).",
            "1": {"class_type": "LoadImage", "inputs": {"image": "input.png"}},
            "2": {"class_type": "RMBG", "inputs": {"image": ["1", 0]}},
            "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
        },
        "stem": "rmbg",
        "workflows_hash": "sha256:wh1",
        "slots": [{"node_id": "1", "input": "image"}],
    },
}


# --------------------------------------------------------------- fake gateway


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"gateway HTTP {self.status_code}")

    def json(self):
        return self._payload


def _install_gateway(monkeypatch, mapping, calls, *, inits=None):
    """Point graph.sdk.gateway_client at a fake async client that records every GET
    path (and the ctor kwargs, if ``inits`` is given) and serves ``mapping`` by
    alias — an alias absent from the mapping comes back as a gateway 404."""
    class _Gateway:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, path, **kw):
            calls.append(path)
            alias = path.split("/protobanana/workflows/", 1)[-1]
            if alias in mapping:
                return _Resp(mapping[alias], 200)
            return _Resp({"detail": "unknown alias"}, 404)

    def factory(**kw):
        if inits is not None:
            inits.append(kw)
        return _Gateway()

    monkeypatch.setattr(sys.modules["graph.sdk"], "gateway_client", factory)


def _forbid_other_transports(monkeypatch):
    """Make httpx and requests blow up on any use, so a call outside the stubbed
    gateway_client fails LOUDLY (the egress guard, ADR 0008). requests may not be
    installed host-free, so a fake stand-in is wired in to catch an import+use."""
    import httpx

    def boom(*a, **k):
        raise AssertionError("egress outside gateway_client() — ADR 0008 violated")

    monkeypatch.setattr(httpx, "AsyncClient", boom)
    monkeypatch.setattr(httpx, "Client", boom)
    fake_requests = types.ModuleType("requests")
    for name in ("get", "post", "put", "delete", "head", "patch", "request"):
        setattr(fake_requests, name, boom)
    fake_requests.Session = boom
    monkeypatch.setitem(sys.modules, "requests", fake_requests)


def _endpoint(router):
    """The workflow route's handler, pulled off the router so it can be awaited
    directly (no httpx ASGI transport — that keeps the egress guard honest)."""
    for route in router.routes:
        if "workflows/{alias" in getattr(route, "path", ""):
            return route.endpoint
    raise AssertionError("workflow inspector route is not registered")


# ------------------------------------------------------------- the route (r1)


def test_route_returns_payload_for_every_stem(monkeypatch):
    """r1: every shipped stem's workflow comes back whole — the API-format map
    (with _doc), the stem, the workflows_hash and the substituted slots."""
    mod, reg = _load()
    calls = []
    _install_gateway(monkeypatch, FIXTURE_WORKFLOWS, calls)
    _forbid_other_transports(monkeypatch)
    ep = _endpoint(reg.routers[-1][1])

    for alias, expected in FIXTURE_WORKFLOWS.items():
        mod.workflows.reset_cache()
        result = asyncio.run(ep(alias=alias, workflows_hash=expected["workflows_hash"]))
        assert result["workflow"] == expected["workflow"]
        assert result["stem"] == expected["stem"]
        assert result["workflows_hash"] == expected["workflows_hash"]
        assert result["slots"] == expected["slots"]
        assert result["comfy_ui_url"] == ""
        # the header doc + class_type labels the view renders are present
        assert result["workflow"]["_doc"]
        assert any(isinstance(v, dict) and v.get("class_type") for v in result["workflow"].values())

    assert calls == [f"/protobanana/workflows/{alias}" for alias in FIXTURE_WORKFLOWS]


# ------------------------------------------------------- unknown alias (r3)


def test_unknown_alias_returns_a_readable_404(monkeypatch):
    """r3: an alias the gateway doesn't know (its GET 404s) surfaces as a readable
    404 naming the alias — not a 500 and not an empty graph."""
    mod, reg = _load()
    _install_gateway(monkeypatch, FIXTURE_WORKFLOWS, [])
    _forbid_other_transports(monkeypatch)
    ep = _endpoint(reg.routers[-1][1])

    with pytest.raises(Exception) as excinfo:  # noqa: PT011 - assert on the raised HTTPException
        asyncio.run(ep(alias="protolabs/not-a-real-alias"))
    exc = excinfo.value
    assert getattr(exc, "status_code", None) == 404
    assert "not-a-real-alias" in str(getattr(exc, "detail", ""))


# ------------------------------------------- only gateway_client, no comfy (r2/r3)


def test_gateway_client_is_the_only_transport(monkeypatch):
    """r3: the inspector reaches exactly one place — the gateway's per-alias
    workflow path — through gateway_client, with httpx/requests forbidden."""
    mod, reg = _load()
    calls = []
    inits = []
    _install_gateway(monkeypatch, FIXTURE_WORKFLOWS, calls, inits=inits)
    _forbid_other_transports(monkeypatch)
    ep = _endpoint(reg.routers[-1][1])

    result = asyncio.run(ep(alias="protolabs/qwen-image", workflows_hash=None))
    assert result["stem"] == "qwen_image"
    assert calls == ["/protobanana/workflows/protolabs/qwen-image"]
    # a short timeout (never the 300 s render timeout), from the catalog knob
    assert inits and float(inits[0].get("timeout")) <= 10.0


def test_comfy_ui_url_defaults_empty_and_is_never_fetched(monkeypatch):
    """r2: with no comfy_ui_url configured the payload carries "" (the view shows
    no link), and the only egress is still the single workflow GET — the URL is
    data, never a fetch target."""
    mod, reg = _load()  # config has no comfy_ui_url → default ""
    calls = []
    _install_gateway(monkeypatch, FIXTURE_WORKFLOWS, calls)
    _forbid_other_transports(monkeypatch)
    ep = _endpoint(reg.routers[-1][1])

    result = asyncio.run(ep(alias="protolabs/qwen-image"))
    assert result["comfy_ui_url"] == ""
    assert calls == ["/protobanana/workflows/protolabs/qwen-image"]


def test_comfy_ui_url_passes_through_but_triggers_no_call(monkeypatch):
    """r2: a configured comfy_ui_url is echoed to the view (so the link shows) but
    Python never fetches it — the gateway is still hit exactly once."""
    mod, reg = _load({"comfy_ui_url": "http://comfy.local:8188"})
    calls = []
    _install_gateway(monkeypatch, FIXTURE_WORKFLOWS, calls)
    _forbid_other_transports(monkeypatch)
    ep = _endpoint(reg.routers[-1][1])

    result = asyncio.run(ep(alias="protolabs/qwen-image"))
    assert result["comfy_ui_url"] == "http://comfy.local:8188"
    assert calls == ["/protobanana/workflows/protolabs/qwen-image"]


# --------------------------------------------------------------- caching


def test_cache_keys_on_alias_and_workflows_hash(monkeypatch):
    """A workflow graph is immutable for a workflows_hash, so a repeat (alias,
    hash) is served from cache; a new hash (the workflow set changed) refetches."""
    mod, reg = _load()
    calls = []
    _install_gateway(monkeypatch, FIXTURE_WORKFLOWS, calls)
    ep = _endpoint(reg.routers[-1][1])

    asyncio.run(ep(alias="protolabs/qwen-image", workflows_hash="sha256:wh1"))
    asyncio.run(ep(alias="protolabs/qwen-image", workflows_hash="sha256:wh1"))
    assert len(calls) == 1  # second request served from cache

    asyncio.run(ep(alias="protolabs/qwen-image", workflows_hash="sha256:wh2"))
    assert len(calls) == 2  # a different hash is a fresh key → a refetch


# -------------------------------------------------- static source guard (r3)


def test_workflows_source_imports_no_other_http_client():
    """r3 (static half): workflows.py's transport is gateway_client and nothing
    else — no httpx/requests/aiohttp/urllib/socket import sneaks a second egress."""
    src = (PLUGIN_ROOT / "workflows.py").read_text(encoding="utf-8")
    assert "gateway_client" in src
    forbidden = ("import httpx", "import requests", "import aiohttp", "import urllib",
                 "http.client", "import socket", "comfy_ui_url)")
    for needle in forbidden:
        assert needle not in src, f"workflows.py must not {needle!r}"
    # comfy_ui_url is only ever read from config, never used to build a request.
    assert "comfy_ui_url" in src
