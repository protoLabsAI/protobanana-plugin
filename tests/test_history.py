"""Host-free tests for Studio S2: the shared history index, the gated history
routes (cursor + op/source/starred filters), star-as-copy surviving a prune, and
the invariant that a history write failure never makes a tool (or a job) raise.

Same shape as test_jobs: the gateway transport is stubbed and the routes run
through httpx's ASGI transport on one event loop. The core media store and its
retention pruning are faked with a tmp dir we control (``media_file`` is
monkeypatched), and the history index + starred copies live in an isolated tmp
data dir, so nothing touches the real host or the repo."""

import asyncio
import base64
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _png(color, size=(16, 16)) -> bytes:
    """A small solid-colour PNG (used so an edit's gateway result differs from
    its input and imaging.unchanged() doesn't short-circuit the tool)."""
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """A registered plugin whose history index + media store are isolated tmp
    dirs. ``save_media`` also writes the bytes into the fake store so
    ``media_file`` (monkeypatched to scan it) finds them — deleting a store file
    then simulates a ``media.retention_days`` prune."""
    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    # show_model off so _finish returns plain markdown (no multimodal host seam).
    reg = FakeRegistry({"show_model": False}, plugin_id="protobanana", plugin_dir=PLUGIN_ROOT)
    mod.register(reg)

    data = tmp_path / "data"
    store = tmp_path / "store"
    store.mkdir(parents=True, exist_ok=True)
    mod.history.configure(reg, data_dir=data)

    def media_file(mid):
        if not mid:
            return None
        for f in sorted(store.glob(f"{mid}.*")):
            if f.is_file():
                return f
        return None

    monkeypatch.setattr(mod.history, "media_file", media_file)

    orig_save = reg.save_media

    def save_media(raw, mime, meta=None):
        ref = orig_save(raw, mime, meta)
        (store / f"{ref.id}.png").write_bytes(raw)  # the store now holds the bytes
        return ref

    monkeypatch.setattr(reg, "save_media", save_media)
    return SimpleNamespace(mod=mod, reg=reg, store=store, data=data)


async def _task(mod, job_id):
    await mod.jobs._jobs[job_id]["_task"]


def _seed_history(env, specs):
    """Append records (media_id, op, source) with matching store bytes."""
    for mid, op, source in specs:
        (env.store / f"{mid}.png").write_bytes(PNG_1x1)
        env.mod.history.append({
            "media_id": mid, "parent_id": None, "op": op, "alias": "protolabs/x",
            "params": {"prompt": mid}, "source": source, "job_id": None,
            "created": 1000.0, "starred": False,
        })


# --------------------------------------------------- r1: agent writes a record


def test_agent_tool_writes_source_agent_record(env, monkeypatch):
    mod = env.mod

    async def fake_generate(model, prompt, size, **kw):
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    out = asyncio.run(mod.tools.generate_image.ainvoke({"prompt": "a red fox"}))
    assert not out.startswith("Error:") and "fake-media-1" in out

    page = mod.history.read()
    assert len(page["records"]) == 1
    rec = page["records"][0]
    assert rec["source"] == "agent" and rec["op"] == "generate"
    assert rec["media_id"] == "fake-media-1"
    assert rec["params"]["prompt"] == "a red fox"
    assert rec["alias"] == "protolabs/qwen-image"  # carried from meta["model"]
    assert rec["starred"] is False and rec["pruned"] is False


# ------------------------------------------------- r2: studio writes a record


def test_studio_job_writes_source_studio_record(env, monkeypatch):
    mod = env.mod

    async def fake_generate(model, prompt, size, **kw):
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "a banana", "seed": 7},
                                 parent_id="parent-xyz")
        await _task(mod, job_id)
        return job_id

    job_id = asyncio.run(scenario())
    rec = mod.history.read()["records"][0]
    assert rec["source"] == "studio" and rec["op"] == "generate"
    assert rec["parent_id"] == "parent-xyz"
    assert rec["alias"] == "protolabs/qwen-image"
    assert rec["params"] == {"prompt": "a banana", "seed": 7}
    assert rec["job_id"] == job_id


def test_agent_and_studio_share_one_index(env, monkeypatch):
    mod = env.mod

    async def fake_generate(model, prompt, size, **kw):
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)

    async def scenario():
        await mod.tools.generate_image.ainvoke({"prompt": "agent one"})
        await _task(mod, mod.jobs.submit("generate", {"prompt": "studio one"}))

    asyncio.run(scenario())
    sources = {r["source"] for r in mod.history.read()["records"]}
    assert sources == {"agent", "studio"}


# ------------------------------------- r3: cursor pagination + op/source/starred


def test_history_cursor_pagination(env):
    _seed_history(env, [
        ("m0", "generate", "studio"),
        ("m1", "edit", "studio"),
        ("m2", "generate", "agent"),
        ("m3", "edit", "agent"),
        ("m4", "generate", "studio"),
    ])
    p1 = env.mod.history.read(limit=2)
    assert [r["media_id"] for r in p1["records"]] == ["m4", "m3"]  # newest first
    assert p1["next_cursor"] is not None

    p2 = env.mod.history.read(limit=2, cursor=p1["next_cursor"])
    assert [r["media_id"] for r in p2["records"]] == ["m2", "m1"]

    p3 = env.mod.history.read(limit=2, cursor=p2["next_cursor"])
    assert [r["media_id"] for r in p3["records"]] == ["m0"]
    assert p3["next_cursor"] is None


def test_history_filters(env):
    _seed_history(env, [
        ("m0", "generate", "studio"),
        ("m1", "edit", "studio"),
        ("m2", "generate", "agent"),
        ("m3", "edit", "agent"),
        ("m4", "generate", "studio"),
    ])
    gen = {r["media_id"] for r in env.mod.history.read(op="generate")["records"]}
    assert gen == {"m0", "m2", "m4"}
    agent = {r["media_id"] for r in env.mod.history.read(source="agent")["records"]}
    assert agent == {"m2", "m3"}

    env.mod.history.star("m2")
    starred = [r["media_id"] for r in env.mod.history.read(starred=True)["records"]]
    assert starred == ["m2"]
    unstarred = {r["media_id"] for r in env.mod.history.read(starred=False)["records"]}
    assert "m2" not in unstarred and len(unstarred) == 4


# --------------------------------------------- r4: starred survives a prune


def test_starred_item_survives_forced_prune(env):
    _seed_history(env, [("keep", "generate", "studio")])
    assert env.mod.history.star("keep") is True

    # Forced media GC: the store original is gone.
    (env.store / "keep.png").unlink()

    rec = env.mod.history.read()["records"][0]
    assert rec["starred"] is True and rec["pruned"] is False  # served from the copy
    assert env.mod.history.image_bytes("keep") == PNG_1x1  # from the plugin-data copy


def test_unstarred_pruned_record_is_flagged(env):
    _seed_history(env, [("gone", "generate", "studio")])
    (env.store / "gone.png").unlink()  # pruned, never starred

    rec = env.mod.history.read()["records"][0]
    assert rec["pruned"] is True and rec["starred"] is False
    assert env.mod.history.image_bytes("gone") is None


def test_unstar_drops_the_copy(env):
    _seed_history(env, [("x", "generate", "studio")])
    env.mod.history.star("x")
    (env.store / "x.png").unlink()
    assert env.mod.history.image_bytes("x") == PNG_1x1  # copy serves it
    env.mod.history.unstar("x")
    rec = env.mod.history.read()["records"][0]
    assert rec["starred"] is False and rec["pruned"] is True
    assert env.mod.history.image_bytes("x") is None


# --------------------------------------------- r5: a locked seed reproduces


def test_locked_seed_resubmits_identical_params(env, monkeypatch):
    mod = env.mod
    seeds = []

    async def fake_generate(model, prompt, size, *, seed=None, negative_prompt=None):
        seeds.append(seed)
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)

    async def scenario():
        # Two submits of IDENTICAL params with a locked (>=0) seed → the gateway
        # gets the same seed both times, so the render reproduces (design S2).
        await _task(mod, mod.jobs.submit("generate", {"prompt": "fox", "seed": 12345}))
        await _task(mod, mod.jobs.submit("generate", {"prompt": "fox", "seed": 12345}))
        # A negative (unlocked) seed is "random" → None to the gateway.
        await _task(mod, mod.jobs.submit("generate", {"prompt": "fox", "seed": -1}))

    asyncio.run(scenario())
    assert seeds[0] == seeds[1] == 12345
    assert seeds[2] is None


# ------------- r1/r5 (blocking): agent records re-run from the Gallery ---------


def test_agent_image_records_are_rerunnable(env, monkeypatch):
    """The blocking finding: re-running an agent-made image record from the
    Gallery used to fail — record_agent dropped the image ref, so jobs._dispatch
    raised KeyError on params['image'] (and fed compose an empty list). Each
    agent image tool must now write a record whose params carry the input ref in
    jobs._dispatch's shape, so the Gallery re-run (op + params + alias) dispatches
    and completes."""
    mod = env.mod
    white, black = _png((255, 255, 255)), _png((0, 0, 0))

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        return black  # distinct from the white input → imaging.unchanged() is False

    async def fake_compose(model, prompt, images):
        assert images, "compose must receive its reference images, not an empty list"
        return black

    monkeypatch.setattr(mod.client, "edit", fake_edit)
    monkeypatch.setattr(mod.client, "chat_compose", fake_compose)

    src = _data_url(white)

    async def scenario():
        await mod.tools.edit_image.ainvoke({"image_ref": src, "prompt": "make it night"})
        await mod.tools.region_edit.ainvoke({"image_ref": src, "region": "the sky", "prompt": "red"})
        await mod.tools.remove_background.ainvoke({"image_ref": src})
        await mod.tools.compose_images.ainvoke({"image_refs": [src, src], "prompt": "combine"})
        await mod.tools.outpaint_image.ainvoke({"image_ref": src, "prompt": "more sky", "left": 64})

        by_op = {r["op"]: r for r in mod.history.read(limit=50)["records"]}
        assert set(by_op) >= {"edit", "region_edit",
                              "remove_background", "compose", "outpaint"}
        for op in ("edit", "region_edit", "remove_background", "outpaint"):
            assert by_op[op]["params"].get("image"), f"{op} record dropped its image ref"
        assert by_op["compose"]["params"].get("images"), "compose record kept no refs"

        # Re-run each agent record exactly as Gallery.rerun does: op + params +
        # the recorded alias. On ONE event loop so the per-operator lock binds to
        # it; sequential (await each task) so the single in-flight slot is free.
        for op, rec in by_op.items():
            jid = mod.jobs.submit(rec["op"], dict(rec["params"]), alias=rec["alias"])
            await _task(mod, jid)
            st = mod.jobs.get_state(jid)
            assert st["status"] == "done", f"re-run of {op} failed: {st}"

    asyncio.run(scenario())


def test_agent_record_lineage_and_seed(env):
    """record_agent derives parent_id from the input ref (a bare id or a /media/
    URL, the first of a compose list) and keeps the ref + seed in params — the
    agent-edit lineage and locked-seed re-run contract the round-1 review flagged
    as untested. Only the two meta-only keys (tool→op, model→alias) are stripped."""
    mod = env.mod
    mod.history.record_agent("child1", {
        "tool": "edit_image", "model": "protolabs/qwen-image-edit",
        "image": "parent-abc", "prompt": "night", "seed": 7, "keep_transparency": True,
    })
    mod.history.record_agent("child2", {
        "tool": "region_edit", "model": "protolabs/qwen-image-region-edit",
        "image": "/media/parent-def.png?sig=x", "region": "sky", "prompt": "red", "seed": -1,
    })
    mod.history.record_agent("child3", {
        "tool": "compose_images", "model": "protolabs/qwen-image-chat",
        "images": ["srcA", "srcB"], "prompt": "combine",
    })

    recs = {r["media_id"]: r for r in mod.history.read()["records"]}
    # the retired chat alias is remapped so a Gallery re-run still resolves
    assert recs["child3"]["alias"] == "protolabs/qwen-image-multiref"
    assert recs["child1"]["op"] == "edit" and recs["child1"]["alias"] == "protolabs/qwen-image-edit"
    assert recs["child1"]["parent_id"] == "parent-abc"      # lineage from the input ref
    assert recs["child1"]["params"]["image"] == "parent-abc"  # ref kept for re-run
    assert recs["child1"]["params"]["seed"] == 7              # locked seed carried
    assert "tool" not in recs["child1"]["params"] and "model" not in recs["child1"]["params"]
    assert recs["child2"]["parent_id"] == "parent-def"       # from the /media/ URL
    assert recs["child3"]["parent_id"] == "srcA"             # first compose ref
    assert recs["child3"]["params"]["images"] == ["srcA", "srcB"]


# --------------------------------------- r6: a history write never raises


def test_history_write_failure_never_breaks_a_tool(env, monkeypatch):
    mod = env.mod

    async def fake_generate(model, prompt, size, **kw):
        return PNG_1x1

    def boom(*a, **kw):
        raise RuntimeError("disk full")

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    monkeypatch.setattr(mod.history, "append", boom)  # every record write explodes

    out = asyncio.run(mod.tools.generate_image.ainvoke({"prompt": "a red fox"}))
    assert not out.startswith("Error:")  # the tool still succeeds
    assert "fake-media-1" in out


def test_history_write_failure_never_breaks_a_job(env, monkeypatch):
    mod = env.mod

    async def fake_generate(model, prompt, size, **kw):
        return PNG_1x1

    def boom(*a, **kw):
        raise RuntimeError("disk full")

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    monkeypatch.setattr(mod.history, "append", boom)

    async def scenario():
        job_id = mod.jobs.submit("generate", {"prompt": "x"})
        await _task(mod, job_id)
        return mod.jobs.get_state(job_id)

    st = asyncio.run(scenario())
    assert st["status"] == "done" and st["media_id"] == "fake-media-1"
    assert "protobanana.job.done" in [t for t, _ in env.reg.emitted]


# ------------------------------------------------------------------ routes


def _app(reg):
    from fastapi import FastAPI

    app = FastAPI()
    # Mount exactly as core's registry does (graph/plugins/registry.py
    # register_router): a None prefix means the namespaced default
    # /plugins/<id>, so a router with absolute paths must pass prefix="".
    prefix, router = reg.routers[-1]
    app.include_router(router, prefix="/plugins/protobanana" if prefix is None else prefix)
    return app


async def _client(app):
    import httpx

    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://studio.test")


def test_history_route_paginates_and_filters(env):
    _seed_history(env, [
        ("m0", "generate", "studio"),
        ("m1", "edit", "studio"),
        ("m2", "generate", "agent"),
    ])

    async def scenario():
        async with await _client(_app(env.reg)) as ac:
            r = await ac.get("/api/plugins/protobanana/history?limit=2")
            assert r.status_code == 200
            body = r.json()
            assert [x["media_id"] for x in body["records"]] == ["m2", "m1"]
            assert body["next_cursor"] is not None

            r2 = await ac.get(f"/api/plugins/protobanana/history?limit=2&cursor={body['next_cursor']}")
            assert [x["media_id"] for x in r2.json()["records"]] == ["m0"]

            r3 = await ac.get("/api/plugins/protobanana/history?op=generate")
            assert {x["media_id"] for x in r3.json()["records"]} == {"m0", "m2"}

            r4 = await ac.get("/api/plugins/protobanana/history?source=agent")
            assert {x["media_id"] for x in r4.json()["records"]} == {"m2"}

    asyncio.run(scenario())


def test_star_route_makes_the_item_survive_a_prune(env):
    _seed_history(env, [("keep", "generate", "studio")])

    async def scenario():
        async with await _client(_app(env.reg)) as ac:
            r = await ac.post("/api/plugins/protobanana/history/keep/star")
            assert r.status_code == 200 and r.json()["starred"] is True

            # prune the store original
            (env.store / "keep.png").unlink()

            img = await ac.get("/api/plugins/protobanana/history/keep/image")
            assert img.status_code == 200 and img.content == PNG_1x1  # from the copy

            hist = await ac.get("/api/plugins/protobanana/history?starred=true")
            rec = hist.json()["records"][0]
            assert rec["media_id"] == "keep" and rec["pruned"] is False

            # unstar drops the copy → now pruned, image 404
            u = await ac.post("/api/plugins/protobanana/history/keep/unstar")
            assert u.status_code == 200 and u.json()["starred"] is False
            gone = await ac.get("/api/plugins/protobanana/history/keep/image")
            assert gone.status_code == 404

    asyncio.run(scenario())


def test_image_route_404_on_pruned_unstarred(env):
    _seed_history(env, [("gone", "generate", "studio")])
    (env.store / "gone.png").unlink()

    async def scenario():
        async with await _client(_app(env.reg)) as ac:
            r = await ac.get("/api/plugins/protobanana/history/gone/image")
            assert r.status_code == 404
            hist = await ac.get("/api/plugins/protobanana/history")
            assert hist.json()["records"][0]["pruned"] is True

    asyncio.run(scenario())


def test_star_route_404_when_nothing_to_copy(env):
    _seed_history(env, [("ghost", "generate", "studio")])
    (env.store / "ghost.png").unlink()  # no bytes to copy

    async def scenario():
        async with await _client(_app(env.reg)) as ac:
            r = await ac.post("/api/plugins/protobanana/history/ghost/star")
            assert r.status_code == 404

    asyncio.run(scenario())


def test_retired_identity_records_file_under_edit(env):
    """Krea identity_edit was retired; its old records stay filterable (and
    re-runnable) as plain edits — new writes AND records already in the log."""
    import json

    mod = env.mod
    assert mod.history._TOOL_OP["identity_edit"] == "edit"
    mod.history.record_agent("m-new", {"tool": "identity_edit", "image": "x"})
    with open(mod.history._history_file(), "a") as f:
        f.write(json.dumps({"op": "identity", "media_id": "m-old", "source": "studio",
                            "alias": "protolabs/krea2-identity-edit-realism",
                            "params": {"image": "x"}}) + "\n")
    ids = {r["media_id"] for r in mod.history.read(op="edit")["records"]}
    assert {"m-new", "m-old"} <= ids
    assert not mod.history.read(op="identity")["records"]
    old = next(r for r in mod.history.read(op="edit")["records"] if r["media_id"] == "m-old")
    assert old["alias"] == "protolabs/qwen-image-edit"  # re-run can't hit a retired alias


# ---------------------------------------- data-dir resolution (the reinstall fix)
# history.jsonl + the starred copies used to live in <plugin_dir>/.studio, INSIDE
# the installed plugin code dir, so every plugin update/reinstall wiped them.
# configure() now resolves the dir via the host SDK's per-instance plugin store
# (graph.sdk.plugin_store), which lives outside the code dir. These tests stub
# that SDK seam (injected into sys.modules) so they stay host-free.


def _load_history():
    """Load the plugin fresh and return its ``history`` submodule directly. The
    submodule only becomes an attribute of the package once register() runs its
    imports, and register() would call configure() for us — so import it on its
    own (its top level has no host imports) to exercise configure() in isolation."""
    import importlib

    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    return importlib.import_module(mod.__name__ + ".history")


def _record(media_id, **over):
    rec = {"media_id": media_id, "parent_id": None, "op": "generate",
           "alias": "protolabs/x", "params": {"prompt": media_id}, "source": "studio",
           "job_id": None, "created": 1000.0, "starred": False}
    rec.update(over)
    return rec


def _fake_sdk(store_path, calls):
    """A fake ``graph.sdk`` module whose ``plugin_store`` mirrors the real
    signature (``plugin_store(subdir="", *, plugin_id) -> Path``): it creates the
    dir, scoped to one path per instance, and records each ``plugin_id`` it got."""
    m = ModuleType("graph.sdk")

    def plugin_store(subdir="", *, plugin_id):
        calls.append(plugin_id)
        p = Path(store_path)
        if subdir:
            p = p / subdir
        p.mkdir(parents=True, exist_ok=True)
        return p

    m.plugin_store = plugin_store
    return m


def test_configure_resolves_dir_via_plugin_store(tmp_path, monkeypatch):
    hist = _load_history()
    store = tmp_path / "sdk-store"
    calls = []
    monkeypatch.setitem(sys.modules, "graph.sdk", _fake_sdk(store, calls))

    code = tmp_path / "code"
    reg = FakeRegistry(plugin_id="protobanana", plugin_dir=code)
    hist.configure(reg)

    assert hist._dir == store                 # the SDK store, not the code dir
    assert hist._dir != code / ".studio"
    assert calls == ["protobanana"]           # called with plugin_id=registry.plugin_id


def test_records_and_stars_survive_a_reinstall(tmp_path, monkeypatch):
    """A record + a starred copy written before a reinstall (new plugin_dir, same
    SDK store because the plugin_id is unchanged) are still read back after."""
    hist = _load_history()
    store = tmp_path / "sdk-store"
    monkeypatch.setitem(sys.modules, "graph.sdk", _fake_sdk(store, []))

    media = tmp_path / "media"
    media.mkdir()
    (media / "keep.png").write_bytes(PNG_1x1)

    def media_file(mid):
        if not mid:
            return None
        for f in sorted(media.glob(f"{mid}.*")):
            if f.is_file():
                return f
        return None

    monkeypatch.setattr(hist, "media_file", media_file)

    hist.configure(FakeRegistry(plugin_id="protobanana", plugin_dir=tmp_path / "code-v1"))
    hist.append(_record("keep"))
    assert hist.star("keep") is True

    # Reinstall: the code dir is replaced (new plugin_dir) but the SDK store is the
    # same, so configure() lands on the same data dir.
    hist.configure(FakeRegistry(plugin_id="protobanana", plugin_dir=tmp_path / "code-v2"))

    recs = hist.read()["records"]
    assert [r["media_id"] for r in recs] == ["keep"]
    assert recs[0]["starred"] is True and recs[0]["pruned"] is False


def test_configure_migrates_legacy_studio_dir(tmp_path, monkeypatch):
    """A pre-fix <plugin_dir>/.studio/history.jsonl + starred file are COPIED into
    an empty SDK store on configure; the legacy files are left in place."""
    hist = _load_history()
    store = tmp_path / "sdk-store"
    monkeypatch.setitem(sys.modules, "graph.sdk", _fake_sdk(store, []))

    code = tmp_path / "code"
    legacy = code / ".studio"
    (legacy / "starred").mkdir(parents=True)
    (legacy / "history.jsonl").write_text(json.dumps(_record("old1")) + "\n", encoding="utf-8")
    (legacy / "starred" / "old1.png").write_bytes(PNG_1x1)

    hist.configure(FakeRegistry(plugin_id="protobanana", plugin_dir=code))

    assert (store / "history.jsonl").is_file()                     # copied in
    assert (store / "starred" / "old1.png").read_bytes() == PNG_1x1
    assert (legacy / "history.jsonl").is_file()                    # legacy NOT deleted
    assert (legacy / "starred" / "old1.png").is_file()
    assert [r["media_id"] for r in hist.read()["records"]] == ["old1"]


def test_configure_does_not_overwrite_existing_store_history(tmp_path, monkeypatch):
    """An existing store history.jsonl is never overwritten or merged on migration."""
    hist = _load_history()
    store = tmp_path / "sdk-store"
    store.mkdir()
    (store / "history.jsonl").write_text(json.dumps(_record("store1")) + "\n", encoding="utf-8")
    monkeypatch.setitem(sys.modules, "graph.sdk", _fake_sdk(store, []))

    code = tmp_path / "code"
    legacy = code / ".studio"
    legacy.mkdir(parents=True)
    (legacy / "history.jsonl").write_text(json.dumps(_record("old1")) + "\n", encoding="utf-8")

    hist.configure(FakeRegistry(plugin_id="protobanana", plugin_dir=code))

    assert [r["media_id"] for r in hist.read()["records"]] == ["store1"]  # no merge


def test_sdk_unavailable_falls_back_to_legacy(tmp_path, monkeypatch):
    """If graph.sdk can't be imported (old host / no host), configure() falls back
    to <plugin_dir>/.studio and never raises; data_dir= still overrides."""
    hist = _load_history()
    monkeypatch.setitem(sys.modules, "graph.sdk", None)  # import raises ModuleNotFoundError

    code = tmp_path / "code"
    reg = FakeRegistry(plugin_id="protobanana", plugin_dir=code)
    hist.configure(reg)  # must not raise
    assert hist._dir == code / ".studio"

    explicit = tmp_path / "explicit"
    hist.configure(reg, data_dir=explicit)  # data_dir wins even with no SDK
    assert hist._dir == explicit
