"""Inpaint contract at the gateway multipart boundary, without host services."""
import asyncio
import base64
import io
import sys
from pathlib import Path

import httpx
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()


def png(size=(32, 24), mode="RGBA", alpha=255):
    image = Image.new(mode, size, (255, 255, 255, alpha) if mode == "RGBA" else "white")
    if mode == "RGBA" and alpha != 255:
        image.putpixel((0, 0), (255, 255, 255, 255))
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def ref(raw):
    return "data:image/png;base64," + base64.b64encode(raw).decode()


@pytest.fixture
def plugin(tmp_path):
    root = Path(__file__).resolve().parents[1]
    mod = load_plugin(root, "protobanana")
    reg = FakeRegistry({"show_model": False}, plugin_id="protobanana", plugin_dir=root)
    mod.register(reg)
    mod.history.configure(reg, data_dir=tmp_path)
    return mod, reg


@pytest.mark.parametrize("surface", ["tool", "job"])
def test_multipart_and_saved_mask_lineage(plugin, monkeypatch, surface):
    mod, reg = plugin
    source, mask = png(), png(alpha=0)
    captured = []

    def gateway(request):
        if request.url.path == "/protobanana/catalog":
            return httpx.Response(503)
        captured.append(request)
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(source).decode()}]})

    monkeypatch.setattr(sys.modules["graph.sdk"], "gateway_client",
                        lambda **kw: httpx.AsyncClient(base_url="https://gateway.test",
                                                      transport=httpx.MockTransport(gateway)),
                        raising=False)

    async def scenario():
        if surface == "tool":
            result = await mod.tools.inpaint_image.ainvoke(
                {"image_ref": ref(source), "mask_ref": ref(mask), "prompt": "a flower", "seed": 42})
            assert "Done" in result
        else:
            job = mod.jobs.submit("inpaint", {"image": ref(source), "mask": ref(mask),
                                             "prompt": "a flower", "seed": 42})
            await mod.jobs._jobs[job]["_task"]
            assert mod.jobs.get_state(job)["status"] == "done"
        request = captured[0]
        assert request.url.path == "/images/edits"
        # The mask rides the mask_image data-URL field: the gateway drops an
        # OpenAI `mask` file before custom providers (protoBanana #54).
        assert b'name="mask_image"' in request.content
        assert b'name="mask";' not in request.content
        assert b'name="image"; filename="image.png"' in request.content
        assert base64.b64encode(mask) in request.content
        assert b"protolabs/qwen-image-inpaint" in request.content
        assert len(reg.saved_media) == 2
        saved = Image.open(io.BytesIO(reg.saved_media[0][0]))
        assert saved.size == (32, 24)
        assert saved.getpixel((0, 0))[3] == 255
        assert saved.getpixel((10, 10))[3] == 0
        record = mod.history.read()["records"][0]
        assert record["params"]["mask"] == "fake-media-1"
        assert record["media_id"] == "fake-media-2"

    asyncio.run(scenario())


@pytest.mark.parametrize("surface", ["tool", "job"])
def test_config_inpaint_model_routes_both_surfaces(tmp_path, monkeypatch, surface):
    # The agent tool and the Studio job/catalog must resolve the SAME model, so
    # overriding `inpaint_model` in config moves both — not just the tool.
    root = Path(__file__).resolve().parents[1]
    mod = load_plugin(root, "protobanana")
    custom = "protolabs/custom-inpaint-xyz"
    reg = FakeRegistry({"show_model": False, "inpaint_model": custom},
                       plugin_id="protobanana", plugin_dir=root)
    mod.register(reg)
    mod.history.configure(reg, data_dir=tmp_path)

    # The static catalog (Studio's source of truth) also reflects the override.
    assert mod.catalog_static.alias_for(reg.config, "inpaint", "final") == custom

    source, mask = png(), png(alpha=0)
    captured = []

    def gateway(request):
        if request.url.path == "/protobanana/catalog":
            return httpx.Response(503)
        captured.append(request)
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(source).decode()}]})

    monkeypatch.setattr(sys.modules["graph.sdk"], "gateway_client",
                        lambda **kw: httpx.AsyncClient(base_url="https://gateway.test",
                                                      transport=httpx.MockTransport(gateway)),
                        raising=False)

    async def scenario():
        if surface == "tool":
            result = await mod.tools.inpaint_image.ainvoke(
                {"image_ref": ref(source), "mask_ref": ref(mask), "prompt": "a flower"})
            assert "Done" in result
        else:
            job = mod.jobs.submit("inpaint", {"image": ref(source), "mask": ref(mask),
                                             "prompt": "a flower"})
            await mod.jobs._jobs[job]["_task"]
            assert mod.jobs.get_state(job)["status"] == "done"
        content = captured[0].content
        assert custom.encode() in content
        assert b"protolabs/qwen-image-inpaint" not in content

    asyncio.run(scenario())


@pytest.mark.parametrize("mask,message", [
    (png(size=(4, 4), alpha=0), "must match source"),
    (png(mode="RGB"), "transparent = edit"),
    (png(), "no edit region"),
    (b"broken", "Error"),
])
@pytest.mark.parametrize("surface", ["tool", "job"])
def test_invalid_mask_never_calls_gateway(plugin, monkeypatch, mask, message, surface):
    mod, reg = plugin

    async def forbidden(*args, **kwargs):
        pytest.fail("Invalid mask reached gateway")

    monkeypatch.setattr(mod.client, "edit", forbidden)

    async def scenario():
        if surface == "tool":
            error = await mod.tools.inpaint_image.ainvoke(
                {"image_ref": ref(png()), "mask_ref": ref(mask), "prompt": "flower"})
            assert error.startswith("Error:")
        else:
            job = mod.jobs.submit("inpaint", {"image": ref(png()), "mask": ref(mask)})
            await mod.jobs._jobs[job]["_task"]
            state = mod.jobs.get_state(job)
            assert state["status"] == "failed"
            error = state["error"]
        assert message in error
        assert not reg.saved_media

    asyncio.run(scenario())
