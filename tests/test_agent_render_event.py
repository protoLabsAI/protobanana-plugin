"""Every agent image operation announces its persisted render, best-effort."""

import asyncio

import pytest

from test_tools import OPAQUE_URL, DATA_URL, PLUGIN_ROOT
from _plugin_testkit import FakeRegistry, load_plugin


@pytest.mark.parametrize("name,op,args", [
    ("generate_image", "generate", {"prompt": "fox"}),
    ("edit_image", "edit", {"image_ref": "parent", "prompt": "blue"}),
    ("region_edit", "region_edit", {"image_ref": "parent", "region": "fox", "prompt": "blue"}),
    ("remove_background", "remove_background", {"image_ref": "parent"}),
    ("compose_images", "compose", {"image_refs": ["parent", OPAQUE_URL], "prompt": "combine"}),
    ("outpaint_image", "outpaint", {"image_ref": "parent", "prompt": "sky", "left": 64}),
    ("inpaint_image", "inpaint", {"image_ref": "parent", "mask_ref": DATA_URL, "prompt": "blue"}),
])
@pytest.mark.parametrize("bus_fails", [False, True])
def test_agent_render_event(tmp_path, monkeypatch, caplog, name, op, args, bus_fails):
    import io
    from PIL import Image

    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    reg = FakeRegistry({"show_model": False}, plugin_id="protobanana")
    mod.register(reg)
    mod.history.configure(reg, data_dir=tmp_path)
    resolve = mod.tools._resolve_image
    monkeypatch.setattr(mod.tools, "_resolve_image", lambda ref: resolve(OPAQUE_URL if ref == "parent" else ref))

    async def render(*args, **kwargs):
        buf = io.BytesIO()
        Image.new("RGBA", (1, 1), (0, 0, 255, 255)).save(buf, format="PNG")
        return buf.getvalue()

    for method in ("generate", "edit", "chat_compose"):
        monkeypatch.setattr(mod.client, method, render)

    def emit(topic, payload):
        # The index must already contain this exact record when listeners run.
        record = mod.history.read()["records"][0]
        assert topic == "protobanana.agent.render"
        assert payload == {
            "media_id": record["media_id"],
            "url": f'/api/plugins/protobanana/history/{record["media_id"]}/image',
            "op": op, "parent_id": None if op == "generate" else "parent",
            "alias": record["alias"], "created": record["created"],
        }
        reg.emitted.append((topic, payload))
        if bus_fails:
            raise RuntimeError("bus unavailable")

    monkeypatch.setattr(reg, "emit", emit)
    result = asyncio.run(getattr(mod.tools, name).ainvoke(args))
    assert result.startswith("Done")
    assert len(reg.emitted) == 1
    if bus_fails:
        assert "failed to publish protobanana.agent.render" in caplog.text
