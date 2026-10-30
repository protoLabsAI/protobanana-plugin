"""Host-free tests for Studio S1: the in-process job runner, error
classification, the static catalog, and the FastAPI routes.

The gateway transport (client.py) is stubbed; the routes are exercised through
httpx's ASGI transport in a single event loop, so a blocked render and the POST
that returned before it stay on one timeline (no threads). Media saves and bus
events are captured by the vendored FakeRegistry."""

import asyncio
import base64
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode()


def _transparent_png() -> bytes:
    """A 4x4 PNG with real transparency — used as an inpaint mask so a test can
    prove the region signal (the alpha channel) survives to the gateway."""
    import io

    from PIL import Image

    img = Image.new("RGBA", (4, 4), (255, 0, 0, 0))  # fully transparent red
    img.putpixel((0, 0), (255, 0, 0, 255))  # one opaque pixel → partial alpha
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _edit_recorder(store):
    """Stub for client.edit that records its call and returns a 1x1 PNG."""
    async def edit(model, prompt, image, *, fields=None, mask=None):
        store.append({"model": model, "prompt": prompt, "image": image,
                      "fields": dict(fields or {}), "mask": mask})
        return PNG_1x1
    return edit


def _load(config=None):
    """Fresh plugin + FakeRegistry (plugin_dir set so the view route resolves)."""
    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    reg = FakeRegistry(config or {}, plugin_id="protobanana", plugin_dir=PLUGIN_ROOT)
    mod.register(reg)
    return mod, reg


@pytest.fixture()
def plugin():
    return _load({})


def _status_error(status, text="boom"):
    import httpx

    req = httpx.Request("POST", "https://gw.example/v1/images/generations")
    resp = httpx.Response(status, text=text, request=req)
    return httpx.HTTPStatusError(str(status), request=req, response=resp)


async def _task(mod, job_id):
    """Await the background render task for one job (test-internal)."""
    await mod.jobs._jobs[job_id]["_task"]


# --------------------------------------------------------------- job runner


def test_submit_returns_before_render_finishes(plugin, monkeypatch):
    mod, _ = plugin
    gate = {}

    async def blocked(model, prompt, size, **kw):
        gate["ev"] = asyncio.Event()
        gate["started"] = True
        await gate["ev"].wait()
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", blocked)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "a red fox"})
        # The render has not even started — submit returned immediately (R1).
        assert isinstance(job_id, str) and job_id
        st = mod.jobs.get_state(job_id)
        assert st["status"] == "queued" and st["media_id"] is None
        # Let the task start and block inside the stubbed render.
        for _ in range(20):
            await asyncio.sleep(0)
            if gate.get("started"):
                break
        assert gate.get("started")
        assert mod.jobs.get_state(job_id)["status"] == "running"
        assert mod.jobs.get_state(job_id)["media_id"] is None
        gate["ev"].set()
        await _task(mod, job_id)
        assert mod.jobs.get_state(job_id)["status"] == "done"

    asyncio.run(scenario())


def test_done_saves_studio_media_and_publishes(plugin, monkeypatch):
    mod, reg = plugin

    async def fake_generate(model, prompt, size, **kw):
        assert model == "protolabs/qwen-image"  # final tier default
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "a red fox", "seed": 7},
                                 parent_id="parent-1")
        await _task(mod, job_id)
        st = mod.jobs.get_state(job_id)
        assert st["status"] == "done" and st["media_id"] == "fake-media-1"
        assert st["url"] == "/media/fake-media-1.png?sig=fake"
        assert isinstance(st["elapsed_s"], float)

        data, mime, meta = reg.saved_media[0]
        assert data == PNG_1x1 and mime == "image/png"
        assert meta == {"source": "studio", "op": "generate",
                        "alias": "protolabs/qwen-image",
                        "params": {"prompt": "a red fox", "seed": 7},
                        "parent_id": "parent-1", "job_id": job_id}

        done = [d for t, d in reg.emitted if t == "protobanana.job.done"]
        assert done and done[0]["media_id"] == "fake-media-1"
        assert done[0]["job_id"] == job_id and done[0]["op"] == "generate"
        assert done[0]["alias"] == "protolabs/qwen-image"
        assert "protobanana.job.failed" not in [t for t, _ in reg.emitted]

    asyncio.run(scenario())


def test_draft_tier_and_alias_override(plugin, monkeypatch):
    mod, reg = plugin
    seen = []

    async def fake_generate(model, prompt, size, **kw):
        seen.append(model)
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)

    async def scenario():
        j1 = mod.jobs.submit("generate", {"prompt": "x"}, tier="draft")
        await _task(mod, j1)
        j2 = mod.jobs.submit("generate", {"prompt": "x"}, alias="protolabs/custom")
        await _task(mod, j2)
        assert seen == ["protolabs/qwen-image-2-1-turbo", "protolabs/custom"]
        assert reg.saved_media[1][2]["alias"] == "protolabs/custom"

    asyncio.run(scenario())


def test_524_is_recoverable_gateway_timeout(plugin, monkeypatch):
    mod, reg = plugin
    calls = []

    async def boom(*a, **kw):
        calls.append(1)
        raise _status_error(524)

    monkeypatch.setattr(mod.client, "generate", boom)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "x"})
        await _task(mod, job_id)
        st = mod.jobs.get_state(job_id)
        assert st["status"] == "failed"
        assert st["error_kind"] == "gateway_timeout" and st["recoverable"] is True
        assert "GPU" in st["hint"] and "retry" in st["hint"].lower()
        assert len(calls) == 1  # default: no auto-retry, so no stacked GPU job

        failed = [d for t, d in reg.emitted if t == "protobanana.job.failed"]
        assert failed and failed[0]["error_kind"] == "gateway_timeout"
        assert failed[0]["recoverable"] is True and failed[0]["job_id"] == job_id

    asyncio.run(scenario())


@pytest.mark.parametrize("status", [524, 504])
def test_gateway_timeout_retries_once_when_enabled(status, monkeypatch):
    mod, _ = _load({"studio_retry_on_524": True, "studio_retry_backoff_s": 0})
    calls = []

    async def boom(*a, **kw):
        calls.append(1)
        raise _status_error(status)

    monkeypatch.setattr(mod.client, "generate", boom)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "x"})
        await _task(mod, job_id)
        assert mod.jobs.get_state(job_id)["status"] == "failed"
        assert len(calls) == 2  # exactly one retry, then give up (no loop)

    asyncio.run(scenario())


def test_404_is_alias_missing(plugin, monkeypatch):
    mod, reg = plugin

    async def boom(*a, **kw):
        raise _status_error(404)

    monkeypatch.setattr(mod.client, "generate", boom)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "x"})
        await _task(mod, job_id)
        st = mod.jobs.get_state(job_id)
        assert st["status"] == "failed" and st["error_kind"] == "alias_missing"
        assert st["hint"] == "alias protolabs/qwen-image is missing from the gateway's model_list"
        failed = [d for t, d in reg.emitted if t == "protobanana.job.failed"]
        assert failed and failed[0]["error_kind"] == "alias_missing"

    asyncio.run(scenario())


def test_other_error_is_fatal(plugin, monkeypatch):
    mod, _ = plugin

    async def boom(*a, **kw):
        raise RuntimeError("gateway unreachable")

    monkeypatch.setattr(mod.client, "generate", boom)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "x"})
        await _task(mod, job_id)
        st = mod.jobs.get_state(job_id)
        assert st["status"] == "failed"
        assert st["error_kind"] == "error" and st["recoverable"] is False
        assert "gateway unreachable" in st["error"]

    asyncio.run(scenario())


def test_second_job_per_operator_queues(plugin, monkeypatch):
    mod, _ = plugin
    gate = {}

    async def blocked(model, prompt, size, **kw):
        gate.setdefault("ev", asyncio.Event())
        gate["first_started"] = True
        await gate["ev"].wait()
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", blocked)

    async def scenario():
        j1 = mod.jobs.submit("generate", {"prompt": "a"})
        for _ in range(20):
            await asyncio.sleep(0)
            if gate.get("first_started"):
                break
        # second submit for the same operator while the first holds the lock
        j2 = mod.jobs.submit("generate", {"prompt": "b"})
        await asyncio.sleep(0)
        s2 = mod.jobs.get_state(j2)
        assert s2["status"] == "queued" and s2["queue_position"] == 1
        # releasing the first lets the second run to completion
        gate["ev"].set()
        await _task(mod, j1)
        await _task(mod, j2)
        assert mod.jobs.get_state(j1)["status"] == "done"
        assert mod.jobs.get_state(j2)["status"] == "done"

    asyncio.run(scenario())


def test_jobs_ring_is_bounded(plugin):
    mod, _ = plugin
    for i in range(mod.jobs._MAX_JOBS + 25):
        mod.jobs._remember({"job_id": f"j{i}", "status": "done"})
    assert len(mod.jobs._jobs) == mod.jobs._MAX_JOBS


def test_save_media_failure_publishes_failed(plugin, monkeypatch):
    """A save_media that raises must still fail the job and publish job.failed —
    the render succeeded, so without this the job would hang 'running' forever."""
    mod, reg = plugin

    async def ok_generate(model, prompt, size, **kw):
        return PNG_1x1

    def boom_save(*a, **kw):
        raise RuntimeError("media store full")

    monkeypatch.setattr(mod.client, "generate", ok_generate)
    monkeypatch.setattr(reg, "save_media", boom_save)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "x"})
        await _task(mod, job_id)
        st = mod.jobs.get_state(job_id)
        assert st["status"] == "failed"
        assert st["error_kind"] == "error" and st["recoverable"] is False
        assert "media store full" in st["error"]
        failed = [d for t, d in reg.emitted if t == "protobanana.job.failed"]
        assert failed and failed[0]["job_id"] == job_id
        assert "protobanana.job.done" not in [t for t, _ in reg.emitted]

    asyncio.run(scenario())


# ------------------------------------------------------------- dispatch paths


def test_generate_snaps_and_clamps_size(plugin, monkeypatch):
    """Studio generate snaps to the 16px grid and clamps to 256–2048 (and takes
    a × separator) exactly as the agent tool, not the raw user string."""
    mod, _ = plugin
    seen = {}

    async def fake_generate(model, prompt, size, **kw):
        seen["size"] = size
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)

    async def scenario():
        await _task(mod, mod.jobs.submit("generate", {"prompt": "x", "size": "1000×1000"}))
        assert seen["size"] == "1008x1008"  # 1000 → nearest multiple of 16, × ok
        await _task(mod, mod.jobs.submit("generate", {"prompt": "x", "size": "50x5000"}))
        assert seen["size"] == "256x2048"  # clamped to the 256–2048 bounds

    asyncio.run(scenario())


def test_edit_forwards_negative_prompt(plugin, monkeypatch):
    mod, _ = plugin
    calls = []
    monkeypatch.setattr(mod.client, "edit", _edit_recorder(calls))

    async def scenario():
        await _task(mod, mod.jobs.submit(
            "edit", {"image": _data_url(PNG_1x1), "prompt": "make it night",
                     "negative_prompt": "blurry", "seed": 3}))
        assert calls and calls[0]["fields"]["negative_prompt"] == "blurry"
        assert calls[0]["fields"]["seed"] == 3

    asyncio.run(scenario())


def test_inpaint_mask_keeps_transparency(plugin, monkeypatch):
    """The inpaint mask reaches the gateway with its alpha intact (transparent =
    the region to edit); it must NOT be flattened onto white like the base image."""
    import io

    from PIL import Image

    mod, _ = plugin
    calls = []
    monkeypatch.setattr(mod.client, "edit", _edit_recorder(calls))

    async def scenario():
        await _task(mod, mod.jobs.submit(
            "inpaint", {"image": _data_url(PNG_1x1), "mask": _data_url(_transparent_png()),
                        "prompt": "a cat", "negative_prompt": "dog"}))
        rec = calls[0]
        assert rec["mask"] is not None
        mask_img = Image.open(io.BytesIO(rec["mask"]))
        assert mask_img.mode == "RGBA"  # alpha preserved, not flattened to RGB
        assert mask_img.getchannel("A").getextrema()[0] == 0  # still transparent
        # the base image, by contrast, is flattened (no alpha carried through)
        assert Image.open(io.BytesIO(rec["image"])).mode in ("RGB", "P", "L")
        assert rec["fields"]["negative_prompt"] == "dog"

    asyncio.run(scenario())


def test_identity_realism_selects_realism_alias(plugin, monkeypatch):
    """The identity Realism checkbox switches to realism_identity_model, matching
    tools.identity_edit — tier/override alone never reaches the realism model."""
    mod, reg = plugin
    calls = []
    monkeypatch.setattr(mod.client, "edit", _edit_recorder(calls))

    async def scenario():
        j1 = mod.jobs.submit("identity", {"image": _data_url(PNG_1x1), "prompt": "her",
                                          "realism": True})
        await _task(mod, j1)
        assert mod.jobs.get_state(j1)["alias"] == "protolabs/krea2-identity-edit-realism"
        assert calls[0]["model"] == "protolabs/krea2-identity-edit-realism"
        assert reg.saved_media[0][2]["alias"] == "protolabs/krea2-identity-edit-realism"

        j2 = mod.jobs.submit("identity", {"image": _data_url(PNG_1x1), "prompt": "her"})
        await _task(mod, j2)
        assert mod.jobs.get_state(j2)["alias"] == "protolabs/krea2-identity-edit"

        # an explicit alias override still wins over the checkbox
        j3 = mod.jobs.submit("identity", {"image": _data_url(PNG_1x1), "prompt": "her",
                                          "realism": True}, alias="protolabs/custom")
        await _task(mod, j3)
        assert mod.jobs.get_state(j3)["alias"] == "protolabs/custom"

    asyncio.run(scenario())


def test_region_edit_and_outpaint_dispatch(plugin, monkeypatch):
    mod, _ = plugin
    calls = []
    monkeypatch.setattr(mod.client, "edit", _edit_recorder(calls))

    async def scenario():
        await _task(mod, mod.jobs.submit(
            "region_edit", {"image": _data_url(PNG_1x1), "grounding": "the red car",
                            "prompt": "blue", "seed": 1}))
        assert calls[0]["model"] == "protolabs/qwen-image-region-edit"
        assert calls[0]["fields"]["grounding"] == "the red car"

        await _task(mod, mod.jobs.submit(
            "outpaint", {"image": _data_url(PNG_1x1), "left": 64, "right": 64}))
        assert calls[1]["model"] == "protolabs/qwen-image-outpaint"
        assert calls[1]["fields"]["left"] == 64 and calls[1]["fields"]["bottom"] == 0

    asyncio.run(scenario())


def test_remove_background_and_compose_dispatch(plugin, monkeypatch):
    mod, _ = plugin
    edits = []
    composes = []
    monkeypatch.setattr(mod.client, "edit", _edit_recorder(edits))

    async def fake_compose(model, prompt, images):
        composes.append({"model": model, "prompt": prompt, "n": len(images)})
        return PNG_1x1

    monkeypatch.setattr(mod.client, "chat_compose", fake_compose)

    async def scenario():
        await _task(mod, mod.jobs.submit("remove_background", {"image": _data_url(PNG_1x1)}))
        assert edits[0]["model"] == "protolabs/qwen-image-bgremove"
        assert edits[0]["prompt"] == "remove background"

        await _task(mod, mod.jobs.submit(
            "compose", {"images": [_data_url(PNG_1x1), _data_url(PNG_1x1)], "prompt": "combine"}))
        assert composes[0]["model"] == "protolabs/qwen-image-chat" and composes[0]["n"] == 2

    asyncio.run(scenario())


# ----------------------------------------------------------------- catalog


def test_catalog_has_all_eight_ops(plugin):
    mod, _ = plugin
    cat = mod.catalog_static.build_catalog({})
    assert len(cat) == 8
    assert {e["op"] for e in cat} == {
        "generate", "edit", "inpaint", "region_edit", "identity",
        "outpaint", "remove_background", "compose"}
    gen = next(e for e in cat if e["op"] == "generate")
    assert gen["aliases"]["final"] == "protolabs/qwen-image"
    assert gen["aliases"]["draft"] == "protolabs/qwen-image-2-1-turbo"
    assert "prompt" in gen["params"]["properties"]
    assert gen["params"]["required"] == ["prompt"]
    rmbg = next(e for e in cat if e["op"] == "remove_background")
    assert rmbg["licence"]["non_commercial"] is True  # RMBG is CC BY-NC


def test_catalog_aliases_follow_config(plugin):
    mod, _ = plugin
    cat = mod.catalog_static.build_catalog({"gen_model": "protolabs/my-gen"})
    gen = next(e for e in cat if e["op"] == "generate")
    assert gen["aliases"]["final"] == "protolabs/my-gen"


def test_catalog_defaults_come_from_tools_defaults(plugin):
    """The catalog's literal fallbacks are tools._DEFAULTS, not a copy — so a
    default changed in tools.py can't leave the catalog on a stale alias."""
    mod, _ = plugin
    cat = mod.catalog_static.build_catalog({})
    ident = next(e for e in cat if e["op"] == "identity")
    assert ident["aliases"]["final"] == mod.tools._DEFAULTS["identity_model"]
    assert ident["aliases"]["realism"] == mod.tools._DEFAULTS["realism_identity_model"]


def test_identity_grounding_px_schema_is_valid(plugin):
    """The documented default must satisfy its own minimum/maximum, or any form
    built from the catalog rejects the default value."""
    mod, _ = plugin
    cat = mod.catalog_static.build_catalog({})
    gp = next(e for e in cat if e["op"] == "identity")["params"]["properties"]["grounding_px"]
    assert gp["minimum"] <= gp["default"] <= gp["maximum"]


# -------------------------------------------------------------- asset guard


def test_asset_route_refuses_traversal(plugin, tmp_path):
    mod, _ = plugin
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "app.js").write_text("ok", encoding="utf-8")
    (tmp_path / "secret").write_text("nope", encoding="utf-8")

    # a real file inside assets resolves
    assert mod.routes.safe_asset(tmp_path, "app.js") == (assets / "app.js").resolve()
    # traversal, absolute, and missing all refuse
    assert mod.routes.safe_asset(tmp_path, "../secret") is None
    assert mod.routes.safe_asset(tmp_path, "../../etc/passwd") is None
    assert mod.routes.safe_asset(tmp_path, "/etc/passwd") is None
    assert mod.routes.safe_asset(tmp_path, "missing.js") is None


# ------------------------------------------------------------------ routes


def _app(reg):
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(reg.routers[-1][1])
    return app


async def _client(app):
    import httpx

    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://studio.test")


def test_post_jobs_responds_while_render_blocked(plugin, monkeypatch):
    mod, reg = plugin
    gate = {}

    async def blocked(model, prompt, size, **kw):
        gate["ev"] = asyncio.Event()
        gate["started"] = True
        await gate["ev"].wait()
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", blocked)

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.post("/api/plugins/protobanana/jobs",
                              json={"op": "generate", "params": {"prompt": "x"}})
            assert r.status_code == 202
            job_id = r.json()["job_id"]
            assert job_id
            # the render is still blocked — the request already returned
            for _ in range(20):
                await asyncio.sleep(0)
                if gate.get("started"):
                    break
            assert gate.get("started")
            r2 = await ac.get(f"/api/plugins/protobanana/jobs/{job_id}")
            assert r2.status_code == 200
            assert r2.json()["status"] in ("queued", "running")
            assert r2.json()["media_id"] is None
            gate["ev"].set()
            await _task(mod, job_id)
            r3 = await ac.get(f"/api/plugins/protobanana/jobs/{job_id}")
            assert r3.json()["status"] == "done"

    asyncio.run(scenario())


def test_catalog_route_returns_eight_ops(plugin):
    mod, reg = plugin

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.get("/api/plugins/protobanana/catalog")
            assert r.status_code == 200
            assert len(r.json()["ops"]) == 8

    asyncio.run(scenario())


def test_get_unknown_job_is_404(plugin):
    mod, reg = plugin

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.get("/api/plugins/protobanana/jobs/does-not-exist")
            assert r.status_code == 404

    asyncio.run(scenario())


def test_studio_page_serves_index_html(plugin):
    mod, reg = plugin

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.get("/plugins/protobanana/studio")
            assert r.status_code == 200
            assert "protoBanana Studio" in r.text
            assert "/_ds/plugin-kit.js" in r.text

    asyncio.run(scenario())


@pytest.mark.parametrize("op", ["edit", "region_edit", "identity"])
@pytest.mark.parametrize("keep_transparency", [None, True, False])
def test_studio_edit_restores_size_and_expected_alpha(plugin, monkeypatch, op, keep_transparency):
    import io

    from PIL import Image

    mod, reg = plugin

    async def fake_edit(model, prompt, image, **kw):
        sent = Image.open(io.BytesIO(image))
        assert sent.mode == "RGB"
        assert sent.getpixel((3, 3)) == (255, 255, 255)
        buf = io.BytesIO()
        Image.new("RGB", (8, 8), (0, 0, 255)).save(buf, format="PNG")
        return buf.getvalue()

    monkeypatch.setattr(mod.client, "edit", fake_edit)

    async def scenario():
        params = {"image": _data_url(_transparent_png()), "prompt": "blue",
                  "grounding": "subject"}
        if keep_transparency is not None:
            params["keep_transparency"] = keep_transparency
        job_id = mod.jobs.submit(op, params)
        await _task(mod, job_id)
        assert mod.jobs.get_state(job_id)["status"] == "done"
        result = Image.open(io.BytesIO(reg.saved_media[-1][0]))
        assert result.size == (4, 4)
        if op != "identity" and keep_transparency is not False:
            assert result.mode == "RGBA"
            assert result.getpixel((3, 3))[3] == 0
            assert result.getpixel((0, 0))[3] == 255
        else:
            assert result.mode == "RGB"
        assert reg.emitted[-1][0] == "protobanana.job.done"

    asyncio.run(scenario())


def test_studio_remove_background_defringes_saved_cutout(plugin, monkeypatch):
    import io

    from PIL import Image, ImageDraw

    mod, reg = plugin

    def png(image):
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()

    source = Image.new("RGB", (96, 96), (252, 252, 252))
    draw = ImageDraw.Draw(source)
    draw.ellipse((18, 18, 77, 77), fill=(180, 225, 245))
    draw.ellipse((21, 21, 74, 74), fill=(60, 170, 220))
    mask = Image.new("L", source.size, 0)
    ImageDraw.Draw(mask).ellipse((18, 18, 77, 77), fill=255)
    cutout = source.copy()
    cutout.putalpha(mask)

    async def fake_edit(model, prompt, image, **kw):
        assert image == png(source)
        return png(cutout)

    monkeypatch.setattr(mod.client, "edit", fake_edit)

    async def scenario():
        job_id = mod.jobs.submit("remove_background", {"image": _data_url(png(source))})
        await _task(mod, job_id)
        assert mod.jobs.get_state(job_id)["status"] == "done"
        result = Image.open(io.BytesIO(reg.saved_media[-1][0]))
        assert result.getpixel((19, 48))[3] < 200
        assert result.getpixel((48, 48)) == cutout.getpixel((48, 48))
        assert result.getpixel((2, 2))[3] == 0

    asyncio.run(scenario())


def test_generate_count_matches_single_image_contract(plugin, monkeypatch):
    mod, reg = plugin
    count = mod.catalog_static.entry({}, "generate")["params"]["properties"]["n"]
    assert count["const"] == count["minimum"] == count["maximum"] == count["default"] == 1
    calls = []

    async def fake_generate(*args, **kwargs):
        calls.append(args)
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "fox", "n": 2})
        await _task(mod, job_id)
        state = mod.jobs.get_state(job_id)
        assert state["status"] == "failed"
        assert "n must be 1" in state["error"]
        assert not calls and not reg.saved_media
        assert reg.emitted[-1][0] == "protobanana.job.failed"

        job_id = mod.jobs.submit("generate", {"prompt": "fox", "n": 1})
        await _task(mod, job_id)
        assert mod.jobs.get_state(job_id)["status"] == "done"
        assert len(calls) == len(reg.saved_media) == 1

    asyncio.run(scenario())
