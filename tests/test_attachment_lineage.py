"""bd-s1el: an image a user attaches in CHAT joins the Images history/lineage.

A chat attachment is saved to the media store but never recorded in history, so
a chain started from a user's photo used to begin at the first edit with the
photo missing and the result parentless. When an image tool gets an input that
isn't already a history media item, it now records that input once as a source
item (``source="attachment"``, ``op="upload"``, no parent) and chains the result
to it, deduplicated by content hash.

Host-free, same shape as test_history/test_upload_record: the gateway edit is
faked, and the env fixture's media store + history index are isolated tmp dirs.
"""
import asyncio
import sys
import types

from test_history import _png
from test_history import env as history_env

# Reuse test_history's registered-plugin fixture (isolated media store + index).
env = history_env


def _fake_edit(env, monkeypatch, out: bytes):
    async def edit(model, prompt, image, *, fields=None, mask=None):
        return out
    monkeypatch.setattr(env.mod.client, "edit", edit)


def _cutout(env, image_ref: str) -> str:
    return asyncio.run(env.mod.tools.remove_background.ainvoke({"image_ref": image_ref}))


def _attachments(env):
    return env.mod.history.read(source="attachment")["records"]


def _agents(env):
    return env.mod.history.read(source="agent")["records"]


# r1: a non-history input (a temp file path) is recorded as a source item, and
# the result's parent_id is that item's media_id.
def test_file_path_input_records_a_source_and_chains_the_result(env, monkeypatch, tmp_path):
    photo, cut = _png((10, 20, 30)), _png((0, 0, 0))
    _fake_edit(env, monkeypatch, cut)
    path = tmp_path / "phone-photo.png"
    path.write_bytes(photo)

    out = _cutout(env, str(path))
    assert not out.startswith("Error:"), out

    sources = _attachments(env)
    assert len(sources) == 1
    src = sources[0]
    assert src["op"] == "upload" and src["parent_id"] is None
    assert src["params"]["filename"] == "phone-photo.png"  # filename when known
    assert env.mod.history.image_bytes(src["media_id"]) == photo  # the actual photo

    agent = _agents(env)[0]
    assert agent["op"] == "remove_background"
    assert agent["parent_id"] == src["media_id"]  # photo → cut-out


# r1 (dedup): the same bytes used again reuse the one source item.
def test_same_bytes_reuse_one_source_item(env, monkeypatch, tmp_path):
    photo, cut = _png((40, 50, 60)), _png((1, 1, 1))
    _fake_edit(env, monkeypatch, cut)
    # Two different paths, identical content → one source item by content hash.
    first, second = tmp_path / "a.png", tmp_path / "b.png"
    first.write_bytes(photo)
    second.write_bytes(photo)

    _cutout(env, str(first))
    _cutout(env, str(second))

    sources = _attachments(env)
    assert len(sources) == 1  # not recorded twice

    agents = _agents(env)
    assert len(agents) == 2
    assert {a["parent_id"] for a in agents} == {sources[0]["media_id"]}


# r1 (history id): a history media id as input behaves exactly as today — no new
# source item, and the parent is that id.
def test_history_media_id_input_adds_no_source_and_parents_to_it(env, monkeypatch):
    photo, cut = _png((70, 80, 90)), _png((2, 2, 2))
    _fake_edit(env, monkeypatch, cut)

    # Seed a history media item (bytes in the store, a record in the index) and
    # make a bare media id resolvable via the real _resolve_image bare-id branch.
    seed = env.reg.save_media(photo, "image/png", {"source": "upload"})
    env.mod.history.record_upload(seed.id, "seed.png")
    _install_infra_media(monkeypatch, env.store)

    out = _cutout(env, seed.id)
    assert not out.startswith("Error:"), out

    assert _attachments(env) == []  # nothing new recorded as a source
    agent = _agents(env)[0]
    assert agent["op"] == "remove_background"
    assert agent["parent_id"] == seed.id  # parent is the history id, unchanged


def _install_infra_media(monkeypatch, store):
    """Make ``tools._resolve_image`` resolve a bare media id / /media/ URL from
    the env's fake store, the way the real host's ``infra.media`` would — the
    host-free testkit stubs graph.* but not infra.media (host tool tests use data
    URLs, which don't touch it)."""
    infra = sys.modules.get("infra") or types.ModuleType("infra")
    media = types.ModuleType("infra.media")
    media.media_dir = lambda: store

    def resolve_media(name):
        base = name.rsplit(".", 1)[0]
        for f in sorted(store.glob(f"{base}.*")):
            if f.is_file() and f.suffix != ".json":
                return (f, "image/png")
        return None

    media.resolve_media = resolve_media
    monkeypatch.setitem(sys.modules, "infra", infra)
    monkeypatch.setitem(sys.modules, "infra.media", media)
    monkeypatch.setattr(infra, "media", media, raising=False)
