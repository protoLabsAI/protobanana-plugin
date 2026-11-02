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
    # The result tells the agent the product is the input's own pixels (measured),
    # so it doesn't read the photo's colour cast as a change and switch tools.
    assert "Verified: the whole product is copied from the original photo pixel-for-pixel" in out
    assert "checked: the product area matches the input pixel-for-pixel" in out
    assert "don't retry, switch tools or report it as changed" in out
    assert "% of the image" not in out  # a share read as "only part of the product"
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


@pytest.mark.parametrize('status,message', [
    (404, 'alias missing'),
    (400, 'Invalid model name passed in model=custom/bgswap'),
])
def test_missing_alias_uses_legacy_editor_with_honest_provenance(plugin, monkeypatch, status, message):
    import io

    from PIL import Image

    mod, reg, calls = plugin
    mod.tools.CFG.update(bgswap_model='custom/bgswap', edit_model='custom/edit')
    buf = io.BytesIO()
    Image.new('RGB', (1, 1), 'blue').save(buf, format='PNG')
    rendered = buf.getvalue()

    class Gateway:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, path, **kwargs):
            calls.append((path, kwargs))
            request = httpx.Request('POST', 'https://gateway.example' + path)
            if kwargs['data']['model'] == 'custom/bgswap':
                return httpx.Response(status, text=message, request=request)
            return httpx.Response(200, request=request, json={
                'data': [{'b64_json': base64.b64encode(rendered).decode()}],
            })

    monkeypatch.setattr(sys.modules['graph.sdk'], 'gateway_client', lambda **kw: Gateway())
    out = asyncio.run(mod.tools.stage_product.ainvoke({
        'image_ref': IMAGE, 'scene': 'wooden table', 'subject': 'the mug', 'seed': 42,
    }))
    assert len(calls) == 2
    assert all(path == '/images/edits' for path, _ in calls)
    form = calls[1][1]['data']
    assert form['model'] == 'custom/edit'
    assert form['seed'] == '42'
    assert 'the mug' in form['prompt'] and 'wooden table' in form['prompt']
    assert 'grounding' not in form
    assert calls[1][1]['files'] == calls[0][1]['files']
    assert 'may change the product' in out and '![Staged:' in out
    assert '\x1e[component-v1]' in out
    assert reg.saved_media[-1][2]['model'] == 'custom/edit'
    assert not mod.history.read(op='stage_product')['records']
    record = mod.history.read(op='edit')['records'][0]
    assert record['alias'] == 'custom/edit'
    assert record['params']['prompt'] == form['prompt']
    assert record['params']['keep_transparency'] is False

    async def rerun():
        job_id = mod.jobs.submit('edit', record['params'], alias=record['alias'])
        await mod.jobs._jobs[job_id]['_task']
        assert mod.jobs.get_state(job_id)['status'] == 'done'

    asyncio.run(rerun())
    assert calls[2] == calls[1]


@pytest.mark.parametrize('status,message', [
    (400, 'invalid grounding'), (401, 'unauthorized'), (403, 'forbidden'),
    (429, 'rate limited'), (500, 'backend failed'), (524, 'timeout'),
])
def test_other_failures_do_not_fallback(plugin, monkeypatch, status, message):
    mod, reg, _ = plugin
    calls = []

    async def fail(*args, **kwargs):
        calls.append(args)
        httpx.Response(status, text=message, request=httpx.Request(
            'POST', 'https://gateway.example/images/edits')).raise_for_status()

    monkeypatch.setattr(mod.client, 'edit', fail)
    out = asyncio.run(mod.tools.stage_product.ainvoke({'image_ref': IMAGE, 'scene': 'studio'}))
    assert out.startswith('Error:')
    assert len(calls) == 1
    assert not reg.saved_media


@pytest.mark.parametrize('scene', [None, '', '  ', 42])
def test_pipeline_requires_scene_at_save_time(plugin, scene):
    mod, _, _ = plugin
    params = {} if scene is None else {'scene': scene}
    out = asyncio.run(mod.tools.save_pipeline.ainvoke({'spec': {
        'id': 'missing-scene', 'inputs': {'photo': 'image'},
        'steps': [{'id': 'stage', 'op': 'stage_product', 'image': 'photo', 'params': params}],
    }}))
    assert out.startswith('Error:') and 'scene' in out


def test_subject_not_found_is_a_clear_error_not_a_new_object(plugin, monkeypatch):
    """SAM found nothing for the phrase: the whole photo came back regenerated. Refuse it."""
    import io

    from PIL import Image

    mod, reg, _ = plugin

    def png(color):
        buf = io.BytesIO()
        Image.new("RGB", (32, 32), color).save(buf, format="PNG")
        return buf.getvalue()

    photo, regenerated = png((120, 140, 90)), png((250, 250, 250))

    class Gateway:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, path, **kwargs):
            return httpx.Response(
                200, json={"data": [{"b64_json": base64.b64encode(regenerated).decode()}]},
                request=httpx.Request("POST", "https://gateway.example" + path),
            )

    monkeypatch.setattr(sys.modules["graph.sdk"], "gateway_client", lambda **kw: Gateway())
    saved_before = len(reg.saved_media)
    out = asyncio.run(mod.tools.stage_product.ainvoke(
        {"image_ref": "data:image/png;base64," + base64.b64encode(photo).decode(),
         "scene": "white studio", "subject": "the product"}))
    assert out.startswith("Error: couldn't find 'the product' in the photo")
    assert "the mug" in out
    assert len(reg.saved_media) == saved_before  # nothing saved

    async def job():
        job_id = mod.jobs.submit("stage_product", {
            "image": "data:image/png;base64," + base64.b64encode(photo).decode(),
            "scene": "white studio", "subject": "the product"}, alias="protolabs/qwen-image-bgswap")
        await mod.jobs._jobs[job_id]["_task"]
        return mod.jobs.get_state(job_id)

    st = asyncio.run(job())
    assert st["status"] == "failed"
    assert "couldn't find 'the product'" in st["error"]
