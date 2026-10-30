"""S9a: late pipeline tools and other-plugin pipelines, without a host."""

import asyncio
import copy
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import httpx
import pytest
import yaml
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).parent))
from test_pipelines import _chain_stubs, _load

SPEC = {
    "id": "test-render",
    "description": "Render a product image.",
    "expose_as_tool": True,
    "inputs": {
        "prompt": "text", "image": "image", "mask": "mask",
        "count": "int", "seed": {"type": "seed", "default": 7},
        "style": {"type": "text", "default": "studio", "description": "Visual style"},
    },
    "steps": [{"id": "gen", "op": "generate", "params": {"prompt": "{{inputs.prompt}}"}}],
    "output": "gen",
}


def test_factory_schema_and_refresh(tmp_path):
    mod, reg = _load(tmp_path)
    assert reg.late_tool_factories == [mod.pipelines.pipeline_tool_factory]
    factory = reg.late_tool_factories[0]
    spec = copy.deepcopy(SPEC)
    mod.pipelines.save_pipeline(spec)
    tool, = factory(reg.tools, {})
    assert tool.name == "pipeline_test_render"
    assert tool.description == SPEC["description"]
    schema = tool.args_schema.model_json_schema()
    assert {k: v["type"] for k, v in schema["properties"].items()} == {
        "prompt": "string", "image": "string", "mask": "string", "count": "integer",
        "seed": "integer", "style": "string",
    }
    assert set(schema["required"]) == {"prompt", "image", "mask", "count"}
    assert schema["properties"]["seed"]["default"] == 7
    assert schema["properties"]["style"]["description"] == "Visual style"
    spec["expose_as_tool"] = False
    mod.pipelines.save_pipeline(spec)
    assert factory(reg.tools, {}) == []
    spec["expose_as_tool"] = True
    mod.pipelines.save_pipeline(spec)
    assert len(factory(reg.tools, {})) == 1
    (tmp_path / "pipelines" / "test-render.json").unlink()
    assert factory(reg.tools, {}) == []


def test_tool_invokes_runner_and_publishes(tmp_path, monkeypatch):
    mod, reg = _load(tmp_path, {"show_model": False})
    gen, _ = _chain_stubs(mod, monkeypatch)
    mod.pipelines.save_pipeline(SPEC)
    assert ("protobanana.pipeline.saved", {
        "id": SPEC["id"], "pipeline_id": SPEC["id"], "source": "saved",
    }) in reg.emitted
    tool, = reg.late_tool_factories[0](reg.tools, {})
    result = asyncio.run(tool.ainvoke({"prompt": "a hat", "image": "media-id",
                                      "mask": "mask-id", "count": 1}))
    assert gen == ["a hat"]
    assert "![test-render output](" in result
    done = [d for t, d in reg.emitted if t == "protobanana.pipeline.run.done"]
    assert len(done) == 1
    assert done[0]["pipeline_id"] == SPEC["id"]
    assert done[0]["run_id"] == mod.pipelines.recent_runs()[0]["run_id"]
    assert done[0]["output_media_ids"] == [mod.pipelines.recent_runs()[0]["output_media_id"]]
    assert asyncio.run(tool.ainvoke({})).startswith("Error:")

    async def broken(*args, **kwargs):
        raise RuntimeError("gateway unavailable")

    mod.pipelines.reset_cache()
    monkeypatch.setattr(mod.client, "generate", broken)
    result = asyncio.run(tool.ainvoke({"prompt": "a hat", "image": "media-id",
                                      "mask": "mask-id", "count": 1}))
    assert result.startswith("Error:")
    assert reg.emitted[-1][1]["output_media_ids"] == []


def _ship(monkeypatch, tmp_path, spec):
    root = tmp_path / "other-plugin"
    directory = root / "pipelines"
    directory.mkdir(parents=True)
    # The declared id, not the filename, identifies the pipeline.
    (directory / "recipe.yaml").write_text(yaml.safe_dump(spec))
    installer = ModuleType("graph.plugins.installer")
    loader = ModuleType("graph.plugins.loader")
    installer.loader_roots = lambda: [tmp_path]

    def discover(roots):
        assert roots == [tmp_path]
        return [SimpleNamespace(id="campaign", path=root)]

    loader.discover_plugins = discover
    monkeypatch.setitem(sys.modules, installer.__name__, installer)
    monkeypatch.setitem(sys.modules, loader.__name__, loader)
    return directory


def test_shipped_pipeline_read_only_in_tools_and_routes(tmp_path, monkeypatch):
    mod, reg = _load(tmp_path / "data")
    directory = _ship(monkeypatch, tmp_path, SPEC)
    rows = {p["id"]: p for p in mod.pipelines.list_pipelines()}
    assert rows[SPEC["id"]]["source"] == "campaign"
    assert rows[SPEC["id"]]["read_only"] is True
    assert mod.pipelines.load_pipeline(SPEC["id"]) == SPEC
    assert reg.late_tool_factories[0](reg.tools, {})[0].name == "pipeline_test_render"
    with pytest.raises(mod.pipelines.SpecError, match="read-only"):
        mod.pipelines.save_pipeline(SPEC)
    assert not reg.emitted
    app = FastAPI()
    app.include_router(mod.routes.build_router(reg))

    async def request():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                    base_url="http://test") as client:
            response = await client.post("/api/plugins/protobanana/pipelines", json=SPEC)
            assert response.status_code == 400
            assert "read-only" in response.text

    asyncio.run(request())
    duplicate = {**SPEC, "id": "editable-copy"}
    assert mod.pipelines.save_pipeline(duplicate)["source"] == "saved"
    (directory / "recipe.yaml").unlink()
    assert [t.name for t in reg.late_tool_factories[0](reg.tools, {})] == ["pipeline_editable_copy"]


def test_collisions_and_factory_errors_are_isolated(tmp_path, caplog, monkeypatch):
    mod, reg = _load(tmp_path)
    mod.pipelines.save_pipeline(SPEC)
    mod.pipelines.save_pipeline({**SPEC, "id": "test_render"})
    factory = reg.late_tool_factories[0]
    assert len(factory(reg.tools, {})) == 1
    assert "colliding" in caplog.text
    assert factory([SimpleNamespace(name="pipeline_test_render")], {}) == []
    # A malformed marked spec must not prevent the healthy one being built.
    (tmp_path / "pipelines" / "test-render.json").write_text(json.dumps({
        **SPEC, "output": "missing",
    }))
    assert len(factory(reg.tools, {})) == 1
    assert "could not build pipeline tool" in caplog.text

    def broken():
        raise RuntimeError("unreadable storage")

    monkeypatch.setattr(mod.pipelines, "list_pipelines", broken)
    assert factory(reg.tools, {}) == []
    assert "pipeline tool factory failed" in caplog.text


def test_manifest_events_and_version():
    manifest = yaml.safe_load((Path(__file__).resolve().parents[1] / "protoagent.plugin.yaml").read_text())
    assert {"protobanana.pipeline.saved", "protobanana.pipeline.run.done"} <= set(manifest["emits"])
    assert manifest["version"] == "0.7.0"
    assert manifest["capabilities"]["network"] == []


def test_discovery_without_host_and_with_bad_shipped_file(tmp_path, monkeypatch, caplog):
    mod, _ = _load(tmp_path / "data")
    monkeypatch.setitem(sys.modules, "graph.plugins.installer", None)
    assert list(mod.pipelines._shipped_pipelines()) == []
    directory = _ship(monkeypatch, tmp_path, SPEC)
    (directory / "broken.yaml").write_text("steps: [")
    assert [(source, spec["id"]) for source, spec in mod.pipelines._shipped_pipelines()] == [
        ("campaign", SPEC["id"]),
    ]
    assert "could not load shipped pipeline" in caplog.text


def test_saved_pipeline_still_shadows_own_starter(tmp_path):
    mod, reg = _load(tmp_path)
    starter = mod.pipelines.load_pipeline("product-sticker")
    starter.update(expose_as_tool=True, description="My customised starter")
    mod.pipelines.save_pipeline(starter)
    tool, = reg.late_tool_factories[0](reg.tools, {})
    assert tool.description == "My customised starter"
    assert tool.name == "pipeline_product_sticker"
    row = next(p for p in mod.pipelines.list_pipelines() if p["id"] == "product-sticker")
    assert row["source"] == "saved"
    assert row["read_only"] is False
