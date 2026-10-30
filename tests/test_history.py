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
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


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
    app.include_router(reg.routers[-1][1])
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
