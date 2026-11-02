"""Host-free guard for the image-capabilities skill doc.

The skill is prose that steers the agent's tool choice, so a regression here is
a wrong tool picked at runtime — not a crash a loaded-plugin test would catch.
Product staging should edit the original photo with Qwen, including white
background requests, and deliver the re-render without critiquing small
differences (flag only a clearly wrong product). BiRefNet cut-outs are reserved
for true transparency; inpainting around them retains rough edges on glossy
subjects.

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
    """The body of the 'Stage a product photo' section (up to the next ``## ``
    heading)."""
    m = re.search(
        r"(?ms)^##\s+Stage a product photo\s*$(.*?)(?=^##\s|\Z)",
        text,
    )
    assert m, "SKILL.md has no 'Stage a product photo' recipe"
    return m.group(1)


def test_frontmatter_names_the_skill():
    """The skill still declares its name and a description so the host can load
    and surface it (guards against the edit clobbering the header)."""
    fm = _frontmatter(_skill_text())
    assert re.search(r"(?m)^name:\s*image-capabilities\s*$", fm)
    assert re.search(r"(?m)^description:\s*\S", fm), "frontmatter needs a description"


def test_recipe_routes_product_staging_to_edit_on_original():
    """Product/listing and new-scene requests use the original, preserving identity."""
    recipe = " ".join(_recipe_section(_skill_text()).split()).lower()
    assert "`edit_image` (qwen-image-edit) on the **original photo**" in recipe
    for intent in ("product", "object", "shop", "listing", "new scene"):
        assert intent in recipe
    assert "keep the subject exactly the same" in recipe
    assert "white background" in recipe and "remove the background" in recipe
    assert "pure white seamless" in recipe and "soft natural shadow" in recipe


def test_recipe_delivers_re_renders_without_critique():
    """edit_image re-renders, but the agent delivers without listing differences.

    Operator call (2026-11-02): telling the user every time that the result isn't
    the exact pixels turned into paragraphs of shape/speckle critique after each
    listing photo. The skill still names the re-render, flags a clearly wrong
    product, and answers honestly when asked.
    """
    recipe = " ".join(_recipe_section(_skill_text()).split()).lower().replace("**", "")
    assert "full re-render" in recipe
    assert "redraws and re-lights the subject" in recipe
    assert "don't critique the result" in recipe
    assert "don't list differences" in recipe
    assert "clearly wrong" in recipe
    assert "answer honestly" in recipe
    assert "tell the user that" not in recipe


def test_recipe_reserves_background_removal_for_true_transparency():
    """Transparency still uses BiRefNet, with an explicit edge-quality caveat."""
    recipe = " ".join(_recipe_section(_skill_text()).split()).lower()
    assert "use `remove_background` only for **true transparency**" in recipe
    for use in ("sticker", "logo", "composite elsewhere"):
        assert use in recipe
    for caveat in ("warn", "birefnet", "glossy", "reflective", "fine-edged",
                   "glass", "ceramics", "hair", "fur", "rough edges"):
        assert caveat in recipe


def test_recipe_rejects_cutout_then_inpaint_staging():
    """Do not restore the old cut-out/mask staging route.

    The honesty words it once used ("pixel-for-pixel", "only when the user
    accepts changes") are deliberately NOT forbidden here — the re-render caveat
    needs them (see ``test_recipe_warns_edit_image_is_a_re_render``). Only the
    cut-out-as-mask plumbing is gone.
    """
    text = " ".join(_skill_text().split()).lower().replace("**", "")
    recipe = " ".join(_recipe_section(_skill_text()).split()).lower()
    assert "do not chain `remove_background` → `inpaint_image` to stage a product" in recipe
    for old_advice in (
        "cut-out as its own mask", "cut-out itself as the mask",
        "run `remove_background` first", "edges may need a light touch-up",
    ):
        assert old_advice not in text
    # Inpaint belongs only in the prohibition, not in staging steps.
    assert recipe.count("`inpaint_image`") == 1


def test_operation_table_routes_staging_and_transparency():
    """The quick reference agrees with the recipe's routing and edge caveat."""
    rows = [ln.lower() for ln in _skill_text().splitlines() if ln.startswith("|")]
    staging = next(r for r in rows if "product/object" in r)
    assert "`edit_image`" in staging and "original photo" in staging
    assert "keep the subject exactly the same" in staging
    assert "on white" in staging and "new scene" in staging
    assert "inpaint_image" not in staging
    transparency = next(r for r in rows if "`remove_background`" in r)
    for term in ("true transparency only", "sticker", "logo", "composite elsewhere",
                 "glossy", "reflective", "fine-edged", "rough edges", "birefnet"):
        assert term in transparency
