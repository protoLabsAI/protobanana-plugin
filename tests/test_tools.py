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
# PNG_1x1 is half-transparent red, so edit tools flatten it before sending;
# assertions about bytes passing through untouched use this opaque one.
PNG_OPAQUE = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)
OPAQUE_URL = "data:image/png;base64," + base64.b64encode(PNG_OPAQUE).decode()
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
    assert names == {"generate_image", "edit_image", "region_edit",
                     "remove_background", "compose_images", "outpaint_image", "inpaint_image"}


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
    assert out.startswith("Error:") and "2–10" in out
    out = run(mod.tools.compose_images.ainvoke({"image_refs": [DATA_URL] * 11, "prompt": "combine"}))
    assert out.startswith("Error:") and "got 11" in out


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
    assert seen["model"] == "protolabs/qwen-image-2-1-turbo"


def test_edit_draft_uses_fast_edit_model(plugin, monkeypatch):
    mod, _ = plugin
    seen = []

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        seen.append(model)
        return PNG_1x1

    monkeypatch.setattr(mod.client, "edit", fake_edit)
    run(mod.tools.edit_image.ainvoke({"image_ref": DATA_URL, "prompt": "make it night", "draft": True}))
    run(mod.tools.edit_image.ainvoke({"image_ref": DATA_URL, "prompt": "make it night"}))
    assert seen == ["protolabs/qwen-image-edit-turbo", "protolabs/qwen-image-edit"]


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


# ------------------------------------------------- gateway error readability


def _status_error(status, text, json_body=None):
    import httpx

    req = httpx.Request("POST", "https://gw.example/v1/images/edits")
    resp = httpx.Response(status, text=text, request=req) if json_body is None else \
        httpx.Response(status, json=json_body, request=req)
    return httpx.HTTPStatusError(f"{status}", request=req, response=resp)


CLOUDFLARE_524 = ("<!DOCTYPE html>\n<!--[if lt IE 7]> <html class=\"no-js ie6 oldie\" lang=\"en-US\"> "
                  "<![endif]-->\n<head><title>api.proto-labs.ai | 524: A timeout occurred</title>")


@pytest.mark.parametrize("status", [524, 502, 503, 504])
def test_gateway_html_errors_become_one_readable_line(plugin, monkeypatch, status):
    mod, _ = plugin

    async def boom(*a, **kw):
        raise _status_error(status, CLOUDFLARE_524)

    monkeypatch.setattr(mod.client, "generate", boom)
    out = run(mod.tools.generate_image.ainvoke({"prompt": "a red fox"}))
    assert out.startswith("Error:") and f"HTTP {status}" in out
    assert "<" not in out and "DOCTYPE" not in out and "\n" not in out
    assert "wait a minute" in out


def test_524_message_explains_the_100s_limit(plugin, monkeypatch):
    mod, _ = plugin

    async def boom(*a, **kw):
        raise _status_error(524, CLOUDFLARE_524)

    monkeypatch.setattr(mod.client, "edit", boom)
    out = run(mod.tools.region_edit.ainvoke({"image_ref": DATA_URL, "region": "x", "prompt": "y"}))
    assert "~100s" in out and "still be running" in out and "draft=true" in out


def test_other_html_error_bodies_are_dropped(plugin, monkeypatch):
    mod, _ = plugin

    async def boom(*a, **kw):
        raise _status_error(500, "<html><head><title>500</title></head><body>oops</body></html>")

    monkeypatch.setattr(mod.client, "generate", boom)
    out = run(mod.tools.generate_image.ainvoke({"prompt": "a red fox"}))
    assert out == "Error: gateway returned 500: no detail"


def test_json_error_detail_is_kept(plugin, monkeypatch):
    mod, _ = plugin

    async def boom(*a, **kw):
        raise _status_error(400, "", {"error": {"message": "invalid size '0x0'"}})

    monkeypatch.setattr(mod.client, "generate", boom)
    out = run(mod.tools.generate_image.ainvoke({"prompt": "a red fox"}))
    assert out == "Error: gateway returned 400: invalid size '0x0'"


@pytest.mark.parametrize("name,args", [
    ("generate_image", {"prompt": "fox"}),
    ("edit_image", {"image_ref": OPAQUE_URL, "prompt": "blue"}),
    ("region_edit", {"image_ref": OPAQUE_URL, "region": "fox", "prompt": "blue"}),
    ("remove_background", {"image_ref": OPAQUE_URL}),
    ("compose_images", {"image_refs": [OPAQUE_URL, OPAQUE_URL], "prompt": "combine"}),
    ("outpaint_image", {"image_ref": OPAQUE_URL, "prompt": "sky", "left": 64}),
    ("inpaint_image", {"image_ref": OPAQUE_URL, "mask_ref": DATA_URL, "prompt": "blue"}),
])
@pytest.mark.parametrize("show_model", [True, False])
def test_each_tool_attaches_reference_chip(plugin, monkeypatch, name, args, show_model):
    mod, reg = plugin
    mod.tools.CFG["show_model"] = show_model
    marker = "\x1e[component-v1]"
    monkeypatch.setattr(sys.modules["graph.sdk"], "encode_component",
                        lambda kind, props: marker + json.dumps({"component": kind, "props": props}),
                        raising=False)

    async def image(*args, **kwargs):
        import io
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGBA", (1, 1), (0, 0, 255, 255)).save(buf, format="PNG")
        return buf.getvalue()

    for method in ("generate", "edit", "chat_compose"):
        monkeypatch.setattr(mod.client, method, image)
    out = run(getattr(mod.tools, name).ainvoke(args))
    text = json.loads(out[len(SENTINEL):])["text"] if out.startswith(SENTINEL) else out
    payload = json.loads(text.split(marker)[1])
    assert payload == {"component": "protobanana-ref",
                       "props": {"media_id": f"fake-media-{len(reg.saved_media)}"}}
    assert reg.components["protobanana-ref"](payload["props"]) is None
    assert reg.component_frames["protobanana-ref"] == "studio/ref.html"


@pytest.mark.parametrize("props", [{}, {"media_id": "../bad"}, {"media_id": "x" * 201},
                                   {"media_id": 1}, {"media_id": "ok", "content": "no"}, None])
def test_reference_chip_rejects_non_pointer_props(plugin, props):
    _, reg = plugin
    assert reg.components["protobanana-ref"](props)


def test_client_edit_sends_mask_as_data_url_field(plugin, monkeypatch):
    """The gateway drops an OpenAI `mask` file before custom providers, so the
    mask must ride the `mask_image` form field (protoBanana #54)."""
    import httpx

    mod, _ = plugin
    seen = {}

    def handler(request):
        seen["body"] = request.content
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(PNG_1x1).decode()}]})

    monkeypatch.setattr(mod.client, "_client",
                        lambda: httpx.AsyncClient(base_url="http://gw", transport=httpx.MockTransport(handler)))
    run(mod.client.edit("m", "p", PNG_1x1, mask=b"MASKBYTES"))
    body = seen["body"]
    assert b'name="mask_image"' in body
    assert b"data:image/png;base64," + base64.b64encode(b"MASKBYTES") in body
    assert b'name="mask";' not in body
