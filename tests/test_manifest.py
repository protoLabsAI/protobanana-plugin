"""Host-free guard for the release marker (version bump to 0.6.0).

``protobanana-plugin 0.6.0`` is the marker that an install "contains Studio
S1–S5" (job API/view, history/gallery, Playground single-image ops, mask
painting + inpaint, Send to agent + reference chips). S4 and S5 landed after
the 0.5.0 bump without one of their own, so this test pins the manifest version
and its stated protoAgent floor, and checks the README Versions section says
the same — so a drift between the two fails here instead of shipping.

Pure filesystem reads + regex (no PyYAML — it is not a dev dep; the repo's
other manifest-adjacent tests parse text the same way): no plugin load, no host.
"""

import re
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = PLUGIN_ROOT / "protoagent.plugin.yaml"
README = PLUGIN_ROOT / "README.md"


def _manifest_scalar(key: str) -> str:
    """The first top-level ``key: value`` from the manifest (value unquoted)."""
    text = MANIFEST.read_text(encoding="utf-8")
    m = re.search(rf"(?m)^{re.escape(key)}:\s*(.+?)\s*$", text)
    assert m, f"manifest has no top-level {key!r}"
    return m.group(1).strip().strip("'\"")


def test_manifest_version_includes_studio_s1_to_s5():
    """r1: 0.6.0 is the Studio S1–S5 release marker (was 0.5.0, set between S3
    and S4), so every later version must be >= 0.6.0. An exact pin would break
    on each patch release."""
    version = tuple(int(p) for p in _manifest_scalar("version").split("."))
    assert version >= (0, 6, 0)


def test_manifest_keeps_protoagent_floor_0_223_0():
    """The S1–S5 floor is protoAgent >= 0.223.0; the bump must not move it."""
    assert _manifest_scalar("min_protoagent_version") == "0.223.0"


def test_readme_versions_section_covers_0_6_0_and_the_floor():
    """r2: the README Versions section names 0.6.0, ties it to Studio S1–S5,
    and states the protoAgent >= 0.223.0 requirement."""
    readme = README.read_text(encoding="utf-8")
    assert "## Versions" in readme, "README has no Versions section"
    # The Versions section sits before Tests (the card's placement).
    assert readme.index("## Versions") < readme.index("## Tests")
    versions = readme[readme.index("## Versions") : readme.index("## Tests")]
    assert "0.6.0" in versions
    assert re.search(r"S1[–\-]S5", versions), "0.6.0 bullet must name Studio S1–S5"
    assert re.search(r">=\s*0\.223\.0", versions), "0.6.0 bullet must state the protoAgent floor"
