"""Agent-visible routing guidance must survive LangChain's tool decoration."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def registered_tools():
    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    reg = FakeRegistry(plugin_id="protobanana")
    mod.register(reg)
    return {tool.name: tool for tool in reg.tools}


@pytest.mark.parametrize("name", ["remove_background", "edit_image", "stage_product"])
def test_tool_has_plain_docstring(registered_tools, name):
    tool = registered_tools[name]
    # The decorated object's __doc__ belongs to StructuredTool; check the
    # original coroutine so an f-string cannot masquerade as a docstring.
    assert tool.coroutine.__doc__ is not None
    assert tool.coroutine.__doc__.strip()
    assert tool.description.strip()
    assert " ".join(tool.description.split()) == " ".join(tool.coroutine.__doc__.split())


def test_remove_background_requires_transparency(registered_tools):
    description = " ".join(registered_tools["remove_background"].description.split())
    assert "Use ONLY when the user needs real transparency" in description
    assert "a sticker, a logo, or a cut-out to composite elsewhere" in description
    assert "product or object photo on a white background or in a new scene" in description
    assert "call stage_product on the ORIGINAL photo instead" in description
    assert "don't cut out first" in description
    assert "rough edges on glossy, reflective or fine-edged subjects" in description


def test_edit_image_routes_product_photos_to_stage_product(registered_tools):
    description = " ".join(registered_tools["edit_image"].description.split())
    assert ("For product or listing photos where the product must stay exactly as "
            "photographed, use stage_product instead.") in description


def test_same_design_new_shape_routes_to_outpaint(registered_tools):
    """'A square version of the same design' must outpaint the existing image, not regenerate it."""
    gen = " ".join(registered_tools["generate_image"].description.split())
    out = " ".join(registered_tools["outpaint_image"].description.split())
    assert "Use outpaint_image on the existing image instead" in gen
    assert "SAME design in another shape or size" in out
    assert "top 288, bottom 288" in out
