"""Host-free guard for the image-capabilities skill doc.

The skill is prose that steers the agent's tool choice, so a regression here is
a wrong tool picked at runtime — not a crash a loaded-plugin test would catch.
The one behaviour this pins: when a seller wants their product kept exactly and
placed in a new scene, the skill must route to ``inpaint_image`` with the
cut-out as its own mask (pixel-exact subject), not ``edit_image`` (a re-render
that redraws the product). Seen twice on the demo profile picking different
tools for the same request.

Pure filesystem reads + regex (no PyYAML/jsonschema — not dev deps; the repo's
other doc-adjacent tests parse text the same way): no plugin load, no host.
"""

import re
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SKILL = PLUGIN_ROOT / "skills" / "image-capabilities" / "SKILL.md"


def _skill_text() -> str:
    return SKILL.read_text(encoding="utf-8")


def _frontmatter(text: str) -> str:
    """The YAML frontmatter block between the leading ``---`` fences."""
    m = re.match(r"(?s)\A---\n(.*?)\n---\n", text)
    assert m, "SKILL.md must open with a --- frontmatter block"
    return m.group(1)


def _recipe_section(text: str) -> str:
    """The body of the 'Stage a product without changing it' section (up to the
    next ``## `` heading)."""
    m = re.search(
        r"(?ms)^##\s+Stage a product without changing it\s*$(.*?)(?=^##\s|\Z)",
        text,
    )
    assert m, "SKILL.md has no 'Stage a product without changing it' recipe"
    return m.group(1)


def test_frontmatter_names_the_skill():
    """The skill still declares its name and a description so the host can load
    and surface it (guards against the edit clobbering the header)."""
    fm = _frontmatter(_skill_text())
    assert re.search(r"(?m)^name:\s*image-capabilities\s*$", fm)
    assert re.search(r"(?m)^description:\s*\S", fm), "frontmatter needs a description"


def test_recipe_routes_pixel_exact_staging_to_inpaint_with_cutout_mask():
    """r1: the recipe names inpaint_image with the cut-out as the mask, explains
    the transparent/opaque convention, and points at remove_background to make
    the cut-out when there isn't one."""
    recipe = _recipe_section(_skill_text())
    assert "inpaint_image" in recipe
    assert re.search(r"cut-?out", recipe), "recipe must mention the cut-out"
    assert "mask" in recipe, "recipe must say the cut-out is used as the mask"
    assert "remove_background" in recipe, "recipe must offer to cut out first"
    # The mask convention that makes this pixel-exact: transparent repaints the
    # background, opaque keeps the subject.
    assert "transparent" in recipe and "opaque" in recipe
    assert re.search(r"pixel[- ]for[- ]pixel", recipe)


def test_recipe_scopes_edit_image_to_accepted_subject_changes():
    """The recipe must say edit_image is a re-render — acceptable ONLY when the
    user accepts changes to the subject — so the agent doesn't reach for it when
    the product must be preserved."""
    recipe = _recipe_section(_skill_text())
    assert "edit_image" in recipe
    assert re.search(r"(?i)\bonly\b", recipe), "edit_image must be scoped with 'only'"
    # It is flagged as not identical / a redraw, not an equal alternative.
    assert re.search(r"(?i)re-?(render|draw|light)", recipe)


def test_recipe_notes_edge_touch_up():
    """A light edge touch-up is called out so the agent follows up on seams."""
    recipe = _recipe_section(_skill_text())
    assert re.search(r"(?i)edge", recipe)
    assert re.search(r"(?i)touch-?up|halo|seam", recipe)


def test_operation_table_has_a_pixel_exact_staging_row():
    """The quick-reference table carries the recipe too: a row that keeps the
    subject pixel-exact in a new scene and routes to inpaint_image."""
    text = _skill_text()
    rows = [ln for ln in text.splitlines() if ln.lstrip().startswith("|")]
    staging = [r for r in rows if "inpaint_image" in r and re.search(r"(?i)pixel-?exact", r)]
    assert staging, "operation table needs a pixel-exact staging row routing to inpaint_image"
    assert re.search(r"(?i)cut-?out", staging[0]), "the staging row names the cut-out as the mask"
