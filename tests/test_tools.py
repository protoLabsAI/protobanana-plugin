"""Host-free tests — load the plugin via the vendored testkit, stub the gateway
transport, and assert the tool contract: save_media capture, inline-markdown
replies, the multimodal envelope, readable errors, and route-specific fields."""

import asyncio
import base64
import json
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
DATA_URL = "data:image/png;base64," + base64.b64encode(PNG_1x1).decode()
SENTINEL = "\x1e[multimodal-tool-v1]"


def fake_envelope(text, images):
    """Mirror graph.multimodal.multimodal_tool_result's envelope shape."""
    return SENTINEL + json.dumps({"text": text, "images": images})


@pytest.fixture()
def plugin(monkeypatch):
    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    reg = FakeRegistry({"show_model": True}, plugin_id="protobanana")
    mod.register(reg)
    monkeypatch.setattr(sys.modules["graph.sdk"], "multimodal_tool_result", fake_envelope, raising=False)
    return mod, reg


def run(coro):
    return asyncio.run(coro)


def test_register_wires_all_tools(plugin):
    _, reg = plugin
    names = {t.name for t in reg.tools}
    assert names == {"generate_image", "edit_image", "identity_edit", "region_edit",
                     "remove_background", "compose_images", "outpaint_image", "typography_image"}


def test_generate_saves_media_and_returns_envelope(plugin, monkeypatch):
    mod, reg = plugin

    async def fake_generate(model, prompt, size, **kw):
        assert model == "protolabs/qwen-image"
        assert size == "1024x1024"
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    out = run(mod.tools.generate_image.ainvoke({"prompt": "a red fox"}))
    assert out.startswith(SENTINEL)
    body = json.loads(out[len(SENTINEL):])
    assert "![a red fox](/media/fake-media-1.png?sig=fake)" in body["text"]
    assert "`fake-media-1`" in body["text"]
    assert body["images"][0]["b64"] == base64.b64encode(PNG_1x1).decode()
    (data, mime, meta) = reg.saved_media[0]
    assert data == PNG_1x1 and mime == "image/png" and meta["tool"] == "generate_image"


def test_show_model_off_returns_plain_markdown(monkeypatch):
    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    reg = FakeRegistry({"show_model": False}, plugin_id="protobanana")
    mod.register(reg)

    async def fake_generate(model, prompt, size, **kw):
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    out = run(mod.tools.generate_image.ainvoke({"prompt": "a red fox"}))
    assert not out.startswith(SENTINEL)
    assert "![a red fox](/media/fake-media-1.png?sig=fake)" in out


def test_gateway_failure_returns_readable_error(plugin, monkeypatch):
    mod, _ = plugin

    async def boom(*a, **kw):
        raise RuntimeError("gateway unreachable")

    monkeypatch.setattr(mod.client, "generate", boom)
    out = run(mod.tools.generate_image.ainvoke({"prompt": "a red fox"}))
    assert out.startswith("Error:") and "gateway unreachable" in out


def test_identity_edit_two_ref_sends_person_field(plugin, monkeypatch):
    mod, _ = plugin
    seen = {}

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        seen.update({"model": model, "fields": dict(fields or {}), "image": image})
        return PNG_1x1

    monkeypatch.setattr(mod.client, "edit", fake_edit)
    out = run(mod.tools.identity_edit.ainvoke({
        "image_ref": DATA_URL, "prompt": "place her on a beach",
        "person_ref": DATA_URL, "grounding_px": 1024,
    }))
    assert not out.startswith("Error:")
    assert seen["model"] == "protolabs/krea2-identity-edit"
    assert seen["image"] == PNG_1x1  # image_ref = scene rides the spec image slot
    assert seen["fields"]["person_image"].startswith("data:image/png;base64,")
    assert seen["fields"]["grounding_px"] == 1024


def test_region_edit_sends_grounding(plugin, monkeypatch):
    mod, _ = plugin
    seen = {}

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        seen.update({"model": model, "fields": dict(fields or {})})
        return PNG_1x1

    monkeypatch.setattr(mod.client, "edit", fake_edit)
    run(mod.tools.region_edit.ainvoke({"image_ref": DATA_URL, "region": "the red car",
                                       "prompt": "make it a blue truck"}))
    assert seen["model"] == "protolabs/qwen-image-region-edit"
    assert seen["fields"]["grounding"] == "the red car"


def test_compose_rejects_wrong_ref_count(plugin):
    mod, _ = plugin
    out = run(mod.tools.compose_images.ainvoke({"image_refs": [DATA_URL], "prompt": "combine"}))
    assert out.startswith("Error:") and "2–3" in out


def test_outpaint_requires_a_margin(plugin):
    mod, _ = plugin
    out = run(mod.tools.outpaint_image.ainvoke({"image_ref": DATA_URL, "prompt": "more sky"}))
    assert out.startswith("Error:")


def test_bad_image_ref_is_a_readable_error(plugin):
    mod, _ = plugin
    out = run(mod.tools.edit_image.ainvoke({"image_ref": "nope.png", "prompt": "brighter"}))
    assert out.startswith("Error:")


def test_generate_draft_uses_fast_model(plugin, monkeypatch):
    mod, _ = plugin
    seen = {}

    async def fake_generate(model, prompt, size, **kw):
        seen["model"] = model
        return PNG_1x1

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    run(mod.tools.generate_image.ainvoke({"prompt": "a quick concept", "draft": True}))
    assert seen["model"] == "protolabs/qwen-image-turbo"


def test_identity_edit_realism_uses_realism_model(plugin, monkeypatch):
    mod, _ = plugin
    seen = {}

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        seen["model"] = model
        return PNG_1x1

    monkeypatch.setattr(mod.client, "edit", fake_edit)
    run(mod.tools.identity_edit.ainvoke({"image_ref": DATA_URL,
                                         "prompt": "natural photo at the beach",
                                         "realism": True}))
    assert seen["model"] == "protolabs/krea2-identity-edit-realism"


def _mk_state():
    from langchain_core.messages import HumanMessage
    return {"messages": [HumanMessage(id="m1", content=[
        {"type": "text", "text": "remove the background of these"},
        {"type": "image_url", "image_url": {"url": DATA_URL}},
        {"type": "image_url", "image_url": {"url": DATA_URL}},
    ])]}


def test_attachment_bridge_saves_and_annotates(plugin):
    mod, reg = plugin
    assert len(reg.middlewares) == 1
    mw = reg.middlewares[0](object())  # factory(config)
    update = mw.before_model(_mk_state(), None)
    assert update is not None
    msg = update["messages"][0]
    assert msg.id == "m1"
    note = msg.content[-1]["text"]
    assert "image 1 = `fake-media-1`" in note and "image 2 = `fake-media-2`" in note
    assert len(reg.saved_media) == 2
    assert reg.saved_media[0][2]["source"] == "user_attachment"


def test_attachment_bridge_is_idempotent(plugin):
    mod, reg = plugin
    mw = reg.middlewares[0](object())
    state = _mk_state()
    first = mw.before_model(state, None)
    state["messages"] = first["messages"]
    assert mw.before_model(state, None) is None  # marker present → no-op
    assert len(reg.saved_media) == 2  # not re-saved


def test_attachment_bridge_skips_plain_text_and_idless(plugin):
    from langchain_core.messages import HumanMessage
    mod, reg = plugin
    mw = reg.middlewares[0](object())
    state = {"messages": [
        HumanMessage(id="t1", content="just text"),
        HumanMessage(id=None, content=[{"type": "image_url", "image_url": {"url": DATA_URL}}]),
    ]}
    assert mw.before_model(state, None) is None
    assert reg.saved_media == []
