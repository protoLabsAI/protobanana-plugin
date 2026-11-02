"""Product staging preserves the gateway output and uses the background-only route."""

import asyncio
import base64
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()

ROOT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)
IMAGE = "data:image/png;base64," + base64.b64encode(PNG).decode()


@pytest.fixture()
def plugin(tmp_path, monkeypatch):
    mod = load_plugin(ROOT, "protobanana")
    reg = FakeRegistry({"show_model": False}, plugin_id="protobanana", plugin_dir=ROOT)
    mod.register(reg)
    mod.history.configure(reg, data_dir=tmp_path)
    mod.pipelines.configure(reg, data_dir=tmp_path)
    mod.pipelines.reset_cache()
    calls = []

    class Gateway:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, path, **kwargs):
            calls.append((path, kwargs))
            return httpx.Response(
                200, json={"data": [{"b64_json": base64.b64encode(PNG).decode()}]},
                request=httpx.Request("POST", "https://gateway.example" + path),
            )

    monkeypatch.setattr(sys.modules["graph.sdk"], "gateway_client", lambda **kw: Gateway())
    return mod, reg, calls


def test_registered_descriptions_route_product_photos(plugin):
    mod, reg, _ = plugin
    assert mod.tools.stage_product in reg.tools
    description = mod.tools.stage_product.description
    assert "shop and listing photos" in description
    assert "product's own pixels are kept" in description
    assert "only the background is generated" in description
    for tool in (mod.tools.edit_image, mod.tools.remove_background):
        assert "stage_product" in tool.description
    assert "Also the right tool for product" not in mod.tools.edit_image.description


@pytest.mark.parametrize("custom", [False, True])
def test_gateway_media_history_and_rerun(plugin, custom):
    mod, reg, calls = plugin
    alias = "custom/bgswap" if custom else "protolabs/qwen-image-bgswap"
    if custom:
        mod.tools.CFG["bgswap_model"] = alias
    args = {"image_ref": IMAGE, "scene": "white studio with a soft contact shadow"}
    if custom:
        args.update(subject="the mug", seed=42)
    out = asyncio.run(mod.tools.stage_product.ainvoke(args))
    path, request = calls[0]
    assert path == "/images/edits"
    assert request["data"] == {
        "model": alias, "prompt": args["scene"], "response_format": "b64_json",
        "grounding": "the mug" if custom else "the product",
        **({"seed": "42"} if custom else {}),
    }
    assert request["files"][0][1][1] == PNG
    # The bgswap result is saved verbatim, with no client-side re-render or masking.
    assert reg.saved_media[-1][0] == PNG
    assert reg.saved_media[-1][2]["tool"] == "stage_product"
    assert "![Staged:" in out and "/media/" in out
    assert "\x1e[component-v1]" in out
    record = mod.history.read(op="stage_product")["records"][0]
    assert record["parent_id"]
    assert record["alias"] == alias
    assert record["params"]["scene"] == args["scene"]
    assert record["params"]["subject"] == ("the mug" if custom else "the product")

    async def rerun():
        job_id = mod.jobs.submit("stage_product", record["params"], alias=alias,
                                 parent_id=record["parent_id"])
        await mod.jobs._jobs[job_id]["_task"]
        assert mod.jobs.get_state(job_id)["status"] == "done"

    asyncio.run(rerun())
    assert calls[1] == calls[0]
    assert any(name == "protobanana.job.done" for name, _ in reg.emitted)


def test_catalog_and_pipeline_execution(plugin):
    mod, reg, calls = plugin
    entry = mod.catalog_static.entry({}, "stage_product")
    assert entry in mod.catalog_static.build_catalog({})
    assert entry["typical_latency_s"] == 45
    assert entry["params"]["required"] == ["image", "scene"]
    assert entry["params"]["properties"]["subject"]["default"] == "the product"
    assert mod.catalog_static.alias_for({"bgswap_model": "custom/bg"}, "stage_product") == "custom/bg"
    spec = {
        "id": "stage-mug", "inputs": {"photo": "image"},
        "steps": [{"id": "stage", "op": "stage_product", "image": "photo",
                   "params": {"scene": "wooden table", "subject": "the mug", "seed": 7}}],
        "output": "stage",
    }
    saved = asyncio.run(mod.tools.save_pipeline.ainvoke({"spec": spec}))
    assert "Saved pipeline" in saved
    out = asyncio.run(mod.tools.run_pipeline.ainvoke(
        {"name": "stage-mug", "inputs": {"photo": IMAGE}}))
    assert "Output saved as" in out
    assert calls[0][0] == "/images/edits"
    assert calls[0][1]["data"]["grounding"] == "the mug"
    assert calls[0][1]["data"]["prompt"] == "wooden table"
    assert calls[0][1]["data"]["seed"] == "7"
    assert reg.saved_media[-1][0] == PNG
    assert mod.history.read(op="stage_product")["records"]


def test_gateway_failure_is_readable(plugin, monkeypatch):
    mod, _, _ = plugin

    async def missing(*args, **kwargs):
        request = httpx.Request("POST", "https://gateway.example/images/edits")
        response = httpx.Response(404, request=request)
        response.raise_for_status()

    monkeypatch.setattr(mod.client, "edit", missing)
    out = asyncio.run(mod.tools.stage_product.ainvoke({"image_ref": IMAGE, "scene": "studio"}))
    assert out.startswith("Error:") and "alias missing" in out
    invalid = asyncio.run(mod.tools.stage_product.ainvoke({"image_ref": "", "scene": "studio"}))
    assert invalid.startswith("Error:")
