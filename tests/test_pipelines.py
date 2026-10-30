"""Host-free tests for Studio S7: the pipeline spec validator, the plugin-side
DAG runner, the step cache, the agent tools, and the pipeline routes.

Like the S1 job tests, the gateway transport (client.py) is stubbed and the
routes run through httpx's ASGI transport on a single event loop, so a run that
is still rendering and the POST that already returned stay on one timeline (no
threads). Media saves and bus events are captured by the vendored FakeRegistry;
saved pipelines + the history index are pointed at a tmp dir so nothing is
written beside the plugin.
"""

import asyncio
import base64
import hashlib
import io
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _solid_png(seed_text: str, size=(16, 16)) -> bytes:
    """A deterministic solid-colour PNG whose colour is derived from ``seed_text``
    — so a stubbed step's output varies with its prompt/params, which lets a test
    prove that a changed step's new bytes cascade into its downstream steps."""
    h = hashlib.sha256(seed_text.encode()).digest()
    img = Image.new("RGB", size, (h[0], h[1], h[2]))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode()


def _status_error(status, text="boom"):
    import httpx

    req = httpx.Request("POST", "https://gw.example/v1/images/edits")
    resp = httpx.Response(status, text=text, request=req)
    return httpx.HTTPStatusError(str(status), request=req, response=resp)


def _load(tmp_path=None, config=None):
    """Fresh plugin + FakeRegistry (plugin_dir=repo so the bundled starters in
    pipelines/ resolve); saved pipelines + history isolated to ``tmp_path``."""
    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    reg = FakeRegistry(config or {}, plugin_id="protobanana", plugin_dir=PLUGIN_ROOT)
    mod.register(reg)
    if tmp_path is not None:
        mod.history.configure(reg, data_dir=str(tmp_path))
        mod.pipelines.configure(reg, data_dir=str(tmp_path))
    mod.pipelines.reset_cache()
    return mod, reg


async def _run_task(mod, run_id):
    task = mod.pipelines._runs[run_id].get("_task")
    if task is not None:
        await task


# ---- a small inline chain used by the cache / resume tests ----------------
# generate -> edit -> edit. Each stubbed step's output depends on its prompt, so
# changing one step's prompt changes its bytes and everything downstream of it.
CHAIN = {
    "id": "chain3",
    "inputs": {"p": {"type": "text", "default": "red"},
               "q": {"type": "text", "default": "blue"}},
    "steps": [
        {"id": "a", "op": "generate", "params": {"prompt": "{{inputs.p}}", "size": "16x16"}},
        {"id": "b", "op": "edit", "image": "a", "params": {"prompt": "{{inputs.q}}"}},
        {"id": "c", "op": "edit", "image": "b", "params": {"prompt": "flatten"}},
    ],
    "output": "c",
}


def _chain_stubs(mod, monkeypatch):
    """Stub client.generate + client.edit to return deterministic colour PNGs and
    count calls. Returns the two call-count lists (gen, edit)."""
    gen, edit = [], []

    async def fake_generate(model, prompt, size, **kw):
        gen.append(prompt)
        return _solid_png("gen:" + prompt)

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        edit.append(prompt)
        # A real edit's output depends on BOTH the input image and the prompt, so
        # the stub does too — that is what makes a changed upstream output cascade
        # through the cache into every downstream step.
        return _solid_png("edit:" + prompt + ":" + hashlib.sha256(image).hexdigest()[:8])

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    monkeypatch.setattr(mod.client, "edit", fake_edit)
    return gen, edit


# ============================================================ r3: validation

def test_starters_validate():
    """The shipped starters all parse (YAML) and pass validation."""
    mod, _ = _load()
    for name in ("product-sticker", "portrait-restage", "outpaint-banner"):
        spec = mod.pipelines.load_pipeline(name)
        assert spec["id"] == name
        assert spec["steps"]


def test_rejects_cycle():
    mod, _ = _load()
    spec = {"id": "loop", "steps": [
        {"id": "a", "op": "edit", "image": "b", "params": {"prompt": "x"}},
        {"id": "b", "op": "edit", "image": "a", "params": {"prompt": "y"}},
    ], "output": "a"}
    with pytest.raises(mod.pipelines.SpecError) as e:
        mod.pipelines.validate(spec)
    assert "cycle" in str(e.value)


def test_rejects_unknown_op():
    mod, _ = _load()
    spec = {"id": "bad", "steps": [{"id": "s", "op": "frobnicate", "params": {}}]}
    with pytest.raises(mod.pipelines.SpecError) as e:
        mod.pipelines.validate(spec)
    assert "unknown op" in str(e.value) and "frobnicate" in str(e.value)


def test_rejects_dangling_ref():
    mod, _ = _load()
    spec = {"id": "dangle", "steps": [
        {"id": "s", "op": "edit", "image": "ghost", "params": {"prompt": "x"}},
    ]}
    with pytest.raises(mod.pipelines.SpecError) as e:
        mod.pipelines.validate(spec)
    assert "dangling ref" in str(e.value) and "ghost" in str(e.value)


def test_rejects_image_into_text_port():
    """An image input wired into a text parameter (prompt) is a port type
    mismatch — the design's 'an image into a text port'."""
    mod, _ = _load()
    spec = {"id": "mismatch", "inputs": {"pic": "image"}, "steps": [
        {"id": "g", "op": "generate", "params": {"prompt": "{{inputs.pic}}"}},
    ]}
    with pytest.raises(mod.pipelines.SpecError) as e:
        mod.pipelines.validate(spec)
    msg = str(e.value)
    assert "port type mismatch" in msg and "image" in msg and "text" in msg


def test_rejects_non_mapping_and_missing_image():
    mod, _ = _load()
    with pytest.raises(mod.pipelines.SpecError):
        mod.pipelines.validate("not a mapping")
    # edit needs an image port; omitting it is a readable structural error.
    spec = {"id": "noimg", "steps": [{"id": "e", "op": "edit", "params": {"prompt": "x"}}]}
    with pytest.raises(mod.pipelines.SpecError) as e:
        mod.pipelines.validate(spec)
    assert "missing required input" in str(e.value)


# ===================================================== r1: run via the tool

def test_run_pipeline_tool_runs_starter(tmp_path, monkeypatch):
    """r1: the agent runs a starter end to end via run_pipeline, stubbed gateway."""
    mod, reg = _load(tmp_path, config={"show_model": False})
    gen, edit = [], []

    async def fake_generate(model, prompt, size, **kw):
        gen.append(prompt)
        return PNG_1x1

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        edit.append(prompt)
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    monkeypatch.setattr(mod.client, "edit", fake_edit)

    out = asyncio.run(mod.tools.run_pipeline.ainvoke(
        {"name": "product-sticker", "inputs": {"subject": "a ceramic mug"}}))
    assert "Ran pipeline `product-sticker`" in out
    assert "Output saved as" in out
    # generate (gen) + region_edit + remove_background (both edits) = 3 gateway calls
    assert len(gen) == 1 and len(edit) == 2
    # a readable error is NOT what came back
    assert not out.startswith("Error")


def test_run_pipeline_unknown_name_is_readable():
    mod, _ = _load()
    out = asyncio.run(mod.tools.run_pipeline.ainvoke({"name": "nope", "inputs": {}}))
    assert out.startswith("Error:") and "nope" in out


def test_save_pipeline_tool_round_trips(tmp_path):
    mod, _ = _load(tmp_path)
    out = asyncio.run(mod.tools.save_pipeline.ainvoke({"spec": {
        "id": "mine", "steps": [{"id": "g", "op": "generate", "params": {"prompt": "a cat"}}],
    }}))
    assert "Saved pipeline `mine`" in out
    ids = {p["id"] for p in mod.pipelines.list_pipelines()}
    assert "mine" in ids
    # an invalid spec comes back as a readable error, not a raise
    bad = asyncio.run(mod.tools.save_pipeline.ainvoke({"spec": {
        "id": "bad", "steps": [{"id": "s", "op": "frobnicate"}]}}))
    assert bad.startswith("Error") and "frobnicate" in bad


def test_list_pipelines_tool_lists_starters(tmp_path):
    mod, _ = _load(tmp_path)
    out = asyncio.run(mod.tools.list_pipelines.ainvoke({}))
    for name in ("product-sticker", "portrait-restage", "outpaint-banner"):
        assert name in out


# ============================= r2: incremental re-run proves the step cache

def test_rerun_one_changed_param_reruns_only_it_and_downstream(tmp_path, monkeypatch):
    mod, reg = _load(tmp_path)
    gen, edit = _chain_stubs(mod, monkeypatch)

    async def scenario():
        r1 = mod.pipelines.start_run(CHAIN, {"p": "red", "q": "blue"})
        await _run_task(mod, r1)
        st1 = mod.pipelines.get_run(r1)
        assert st1["status"] == "done"
        assert {n["status"] for n in st1["nodes"].values()} == {"done"}
        assert len(gen) == 1 and len(edit) == 2  # a, b, c all dispatched
        assert st1["cache_hits"] == 0

        # per-node + run bus events landed (ADR 0039)
        topics = [t for t, _ in reg.emitted]
        assert "protobanana.pipeline.node.started" in topics
        assert "protobanana.pipeline.node.done" in topics
        run_done = [d for t, d in reg.emitted if t == "protobanana.pipeline.run.done"]
        assert run_done and run_done[-1]["status"] == "done"

        # Re-run with ONLY q changed: a is unchanged (cache hit, not re-dispatched);
        # b changed → recompute; c is downstream of b → its input bytes changed →
        # recompute. So exactly b and c run again, a does not.
        r2 = mod.pipelines.start_run(CHAIN, {"p": "red", "q": "green"})
        await _run_task(mod, r2)
        st2 = mod.pipelines.get_run(r2)
        assert st2["status"] == "done"
        assert len(gen) == 1           # 'a' served from cache, generate NOT called again
        assert len(edit) == 4          # b + c dispatched again
        assert st2["nodes"]["a"]["cached"] is True
        assert st2["nodes"]["b"]["cached"] is False
        assert st2["nodes"]["c"]["cached"] is False
        assert st2["cache_hits"] == 1

    asyncio.run(scenario())


def test_changing_the_root_param_reruns_everything(tmp_path, monkeypatch):
    mod, _ = _load(tmp_path)
    gen, edit = _chain_stubs(mod, monkeypatch)

    async def scenario():
        await _run_task(mod, mod.pipelines.start_run(CHAIN, {"p": "red", "q": "blue"}))
        assert len(gen) == 1 and len(edit) == 2
        # Change the FIRST step's input: a recomputes, and because its output bytes
        # change, b and c (all downstream) recompute too — no cache hits.
        r2 = mod.pipelines.start_run(CHAIN, {"p": "teal", "q": "blue"})
        await _run_task(mod, r2)
        assert len(gen) == 2 and len(edit) == 4
        assert mod.pipelines.get_run(r2)["cache_hits"] == 0

    asyncio.run(scenario())


def test_workflows_hash_invalidates_the_cache(tmp_path, monkeypatch):
    """design R10: a changed gateway workflow (its workflows_hash) must invalidate
    the step cache even when op/alias/params/inputs are identical."""
    mod, _ = _load(tmp_path)
    gen, _edit = _chain_stubs(mod, monkeypatch)
    single = {"id": "one", "steps": [
        {"id": "a", "op": "generate", "params": {"prompt": "{{inputs.p}}", "size": "16x16"}}],
        "inputs": {"p": {"type": "text", "default": "red"}}, "output": "a"}

    hashes = iter(["hash-1", "hash-2"])

    async def fake_build(cfg):
        return {"ops": mod.catalog_static.build_catalog(cfg), "source": "gateway",
                "stale": False, "workflows_hash": next(hashes), "warnings": []}

    monkeypatch.setattr(mod.catalog, "build", fake_build)

    async def scenario():
        await _run_task(mod, mod.pipelines.start_run(single, {"p": "red"}))
        await _run_task(mod, mod.pipelines.start_run(single, {"p": "red"}))
        assert len(gen) == 2  # same params, but the workflows_hash changed → recompute

    asyncio.run(scenario())


# ================================================ r5: 524 recoverable + resume

def test_524_marks_only_that_node_recoverable_then_resumes(tmp_path, monkeypatch):
    mod, reg = _load(tmp_path)
    gen = []
    edit = []
    state = {"fail": True}

    async def fake_generate(model, prompt, size, **kw):
        gen.append(prompt)
        return _solid_png("gen:" + prompt)

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        edit.append(prompt)
        if state["fail"]:
            state["fail"] = False
            raise _status_error(524)
        return _solid_png("edit:" + prompt)

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    monkeypatch.setattr(mod.client, "edit", fake_edit)

    async def scenario():
        rid = mod.pipelines.start_run(CHAIN, {"p": "red", "q": "blue"})
        await _run_task(mod, rid)
        st = mod.pipelines.get_run(rid)
        assert st["status"] == "failed"
        # only the node that timed out is recoverable; the one before it is done,
        # the one after it never started.
        assert st["nodes"]["a"]["status"] == "done"
        assert st["nodes"]["b"]["status"] == "failed"
        assert st["nodes"]["b"]["recoverable"] is True
        assert st["nodes"]["b"]["error_kind"] == "gateway_timeout"
        assert st["nodes"]["c"]["status"] == "pending"
        assert len(gen) == 1 and len(edit) == 1

        failed = [d for t, d in reg.emitted if t == "protobanana.pipeline.node.failed"]
        assert failed and failed[-1]["step"] == "b" and failed[-1]["recoverable"] is True

        # Re-run from here: the finished 'a' is served from cache (generate not
        # called again), 'b' resumes (now succeeds) and 'c' follows.
        assert mod.pipelines.resume_run(rid) is True
        await _run_task(mod, rid)
        done = mod.pipelines.get_run(rid)
        assert done["status"] == "done"
        assert {n["status"] for n in done["nodes"].values()} == {"done"}
        assert len(gen) == 1           # 'a' not re-rendered on resume
        assert len(edit) == 3          # b (retry) + c
        assert done["output_media_id"]

    asyncio.run(scenario())


# ============================================= persistence + history replay

def test_media_save_failure_is_terminal_and_resumable(tmp_path, monkeypatch):
    mod, reg = _load(tmp_path, config={"show_model": False})
    gen, edit = _chain_stubs(mod, monkeypatch)
    mod.pipelines.save_pipeline(CHAIN)
    save = reg.save_media

    def fail_second_output(raw, mime, meta):
        if meta.get("step") == "b":
            raise OSError("media disk full")
        return save(raw, mime, meta)

    monkeypatch.setattr(reg, "save_media", fail_second_output)

    async def scenario():
        out = await mod.tools.run_pipeline.ainvoke({"name": "chain3", "inputs": {}})
        assert out.startswith("Error:") and "media disk full" in out
        assert "Output saved as" not in out
        st = mod.pipelines.recent_runs()[0]
        rid = st["run_id"]
        # Await directly as well: the background task must not have raised.
        await _run_task(mod, rid)
        assert st["status"] == "failed"
        assert [st["nodes"][s]["status"] for s in ("a", "b", "c")] == [
            "done", "failed", "pending"]
        assert st["nodes"]["b"]["media_id"] is None
        assert len(mod.pipelines._cache) == 1
        assert len(mod.history.read()["records"]) == 1
        failed = [d for t, d in reg.emitted if t == "protobanana.pipeline.node.failed"]
        assert len(failed) == 1 and failed[0]["step"] == "b"
        assert reg.emitted[-1][0] == "protobanana.pipeline.run.done"
        assert reg.emitted[-1][1]["status"] == "failed"

        monkeypatch.setattr(reg, "save_media", save)
        assert mod.pipelines.resume_run(rid, from_step="b")
        await _run_task(mod, rid)
        assert mod.pipelines.get_run(rid)["status"] == "done"
        assert len(gen) == 1 and len(edit) == 3
        assert len(mod.history.read()["records"]) == 3

    asyncio.run(scenario())


@pytest.mark.parametrize("op", [
    "edit", "region_edit", "outpaint", "remove_background", "inpaint", "compose",
])
def test_pipeline_history_can_replay_as_job(tmp_path, monkeypatch, op):
    mod, reg = _load(tmp_path)
    _chain_stubs(mod, monkeypatch)
    calls = []

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        calls.append((image, mask))
        return _solid_png("edited")

    async def fake_compose(model, prompt, images):
        calls.append(images)
        return _solid_png("composed")

    monkeypatch.setattr(mod.client, "edit", fake_edit)
    monkeypatch.setattr(mod.client, "chat_compose", fake_compose)
    # FakeRegistry captures saves but has no media store; resolve its ids from
    # the captured bytes while leaving real data URL resolution in place.
    resolve = mod.tools._resolve_image

    def resolve_saved(ref):
        if ref.startswith("fake-media-"):
            return reg.saved_media[int(ref.rsplit("-", 1)[1]) - 1][0]
        return resolve(ref)

    monkeypatch.setattr(mod.tools, "_resolve_image", resolve_saved)
    external = _data_url(_solid_png("external"))
    mask_buf = io.BytesIO()
    Image.new("RGBA", (16, 16), (0, 0, 0, 0)).save(mask_buf, format="PNG")
    mask_ref = _data_url(mask_buf.getvalue())
    step = {"id": "result", "op": op, "params": {"prompt": "change", "seed": 17}}
    if op == "compose":
        step["images"] = ["root", "inputs.photo", "photo"]
    else:
        step["image"] = "root"
    if op == "inpaint":
        step["mask"] = "inputs.mask"
    spec = {"id": "replay", "inputs": {
        "photo": {"type": "image", "default": external}, "mask": "mask"},
        "steps": [{"id": "root", "op": "generate", "params": {"prompt": "root"}}, step]}

    async def scenario():
        # Run twice with a changed leaf so its parent is also exercised as a
        # cache hit. Both history records must reference the saved parent id.
        for prompt in ("change", "change again"):
            step["params"]["prompt"] = prompt
            rid = mod.pipelines.start_run(spec, {"mask": mask_ref})
            await _run_task(mod, rid)
            st = mod.pipelines.get_run(rid)
            assert st["status"] == "done"
            assert st["cache_hits"] == (prompt == "change again")
            rec = mod.history.read(source="pipeline")["records"][0]
            params = rec["params"]
            assert params["prompt"] == prompt and params["seed"] == 17
            root_id = st["nodes"]["root"]["media_id"]
            assert rec["parent_id"] == root_id
            assert rec["pipeline_run_id"] == rid
            if op == "compose":
                assert params["images"] == [root_id, external, external]
            else:
                assert params["image"] == root_id
            if op == "inpaint":
                assert params["mask"] == mask_ref
            assert reg.saved_media[-1][2]["params"] == params
            original_call = calls[-1]
            # Gallery passes a copy of rec.params into the normal job path.
            await mod.jobs._dispatch({"op": rec["op"], "alias": rec["alias"],
                                      "params": dict(params)})
            assert calls[-1] == original_call

    asyncio.run(scenario())


# =================================================== r4: routes + survival

def _app(reg):
    from fastapi import FastAPI

    app = FastAPI()
    prefix, router = reg.routers[-1]
    app.include_router(router, prefix="/plugins/protobanana" if prefix is None else prefix)
    return app


async def _client(app):
    import httpx

    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://studio.test")


def test_post_run_returns_run_id_without_waiting_and_state_survives(tmp_path, monkeypatch):
    mod, reg = _load(tmp_path)
    gate = {}

    async def blocked(model, prompt, size, **kw):
        gate["ev"] = asyncio.Event()
        gate["started"] = True
        await gate["ev"].wait()
        return PNG_1x1

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", blocked)
    monkeypatch.setattr(mod.client, "edit", fake_edit)

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.post("/api/plugins/protobanana/pipelines/product-sticker/run",
                              json={"inputs": {"subject": "a mug"}})
            assert r.status_code == 202
            run_id = r.json()["run_id"]
            assert run_id
            # the first step is still blocked — the POST already returned
            for _ in range(20):
                await asyncio.sleep(0)
                if gate.get("started"):
                    break
            assert gate.get("started")
            r2 = await ac.get(f"/api/plugins/protobanana/runs/{run_id}")
            assert r2.status_code == 200
            assert r2.json()["status"] in ("queued", "running")
            assert set(r2.json()["nodes"]) == {"gen", "fix", "cut"}

            # survives a view reload: a brand-new client reads the same server-side
            # state back by id, with no run held open.
            async with await _client(_app(reg)) as ac2:
                r3 = await ac2.get(f"/api/plugins/protobanana/runs/{run_id}")
                assert r3.status_code == 200
                assert r3.json()["run_id"] == run_id

            gate["ev"].set()
            await _run_task(mod, run_id)
            r4 = await ac.get(f"/api/plugins/protobanana/runs/{run_id}")
            assert r4.json()["status"] == "done"
            assert r4.json()["output_media_id"]

    asyncio.run(scenario())


def test_runs_unknown_is_404(tmp_path):
    mod, reg = _load(tmp_path)

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.get("/api/plugins/protobanana/runs/does-not-exist")
            assert r.status_code == 404

    asyncio.run(scenario())


def test_pipelines_list_and_save_routes(tmp_path):
    mod, reg = _load(tmp_path)

    async def scenario():
        async with await _client(_app(reg)) as ac:
            r = await ac.get("/api/plugins/protobanana/pipelines")
            assert r.status_code == 200
            ids = {p["id"] for p in r.json()["pipelines"]}
            assert {"product-sticker", "portrait-restage", "outpaint-banner"} <= ids

            # invalid spec → 400 with the readable reason
            bad = await ac.post("/api/plugins/protobanana/pipelines",
                                json={"id": "x", "steps": [{"id": "s", "op": "frobnicate"}]})
            assert bad.status_code == 400 and "unknown op" in bad.json()["detail"]

            # valid spec saves, then shows up as a saved pipeline
            ok = await ac.post("/api/plugins/protobanana/pipelines", json={
                "id": "saved-one",
                "steps": [{"id": "g", "op": "generate", "params": {"prompt": "a cat"}}]})
            assert ok.status_code == 200 and ok.json()["id"] == "saved-one"
            again = await ac.get("/api/plugins/protobanana/pipelines")
            saved = {p["id"]: p for p in again.json()["pipelines"]}
            assert saved["saved-one"]["source"] == "saved"

    asyncio.run(scenario())
