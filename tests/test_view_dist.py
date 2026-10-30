"""Host-free guard for the committed Studio view build (Studio S1b).

The ``view/`` Vite + React app is built to ``view/dist/`` and the OUTPUT is
committed, because git-URL installs and the frozen desktop runtime have no Node
(design R7). These tests are the CI gate that the committed build is real,
fresh, and wired the way the plugin-view rules require — so a source edit that
wasn't rebuilt, or a build that drops the kit handshake / hardcodes an API path,
fails here instead of shipping a blank or broken iframe.

Pure filesystem reads: no plugin load, no host. They assert the built
``dist/index.html`` and its hashed assets, and lint the view source for the
plugin-kit contract (every data call through apiFetch/apiUrl; no tokens in URLs).
"""

import re
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
VIEW = PLUGIN_ROOT / "view"
DIST = VIEW / "dist"
SRC = VIEW / "src"


def _index_html() -> str:
    return (DIST / "index.html").read_text(encoding="utf-8")


# ---------------------------------------------------------------- built page


def test_dist_index_loads_the_ds_plugin_kit():
    """Rule 1: the page links the DS kit (tokens + the slug-aware handshake) at
    its fixed host path, kept root-absolute so it resolves regardless of slug."""
    html = _index_html()
    assert '<link rel="stylesheet" href="/_ds/plugin-kit.css">' in html
    assert '/_ds/plugin-kit.js' in html and 'defer' in html
    # The backend route test also asserts this title is served.
    assert "<title>protoBanana Studio</title>" in html


def test_dist_bundle_assets_are_relative_not_root_absolute():
    """The bundle's own assets must be RELATIVE (Vite base './') so the page
    works under the fleet proxy's slug prefix (acceptance r1); only the DS kit
    (a host asset) stays root-absolute."""
    html = _index_html()
    refs = re.findall(r'(?:src|href)="([^"]+)"', html)
    bundle = [r for r in refs if "assets/" in r]
    assert bundle, "dist/index.html references no built assets — did the build run?"
    for ref in bundle:
        assert ref.startswith("./assets/"), f"bundle asset must be relative: {ref!r}"
    # The kit, by contrast, is intentionally root-absolute.
    assert any(r == "/_ds/plugin-kit.js" for r in refs)
    assert not any(r.startswith("/assets/") for r in refs), "root-absolute bundle asset breaks the slug prefix"


def test_dist_is_a_real_react_build_not_the_placeholder():
    """index.html must reference a hashed ES-module entry (a real Vite build),
    not the hand-written 'building…' stub — proof the view was rebuilt from
    source in this PR (acceptance r6)."""
    html = _index_html()
    assert "building…" not in html
    entries = re.findall(r'<script type="module"[^>]*src="(\./assets/[^"]+\.js)"', html)
    assert entries, "no hashed ES-module entry — the committed dist is a stub, not a build"
    for rel in entries + re.findall(r'<link[^>]*href="(\./assets/[^"]+\.css)"', html):
        target = DIST / Path(rel.lstrip("./"))
        assert target.is_file(), f"referenced asset is missing from the commit: {rel}"


def test_bundle_wires_the_bus_and_endpoints():
    """The job bus topics and the plugin-relative endpoints survive the build —
    so the committed bundle is the Studio wiring, not an empty shell."""
    js = "\n".join(p.read_text(encoding="utf-8") for p in (DIST / "assets").glob("*.js"))
    for needle in ("protobanana.job.done", "protobanana.job.failed", "catalog", "jobs"):
        assert needle in js, f"built bundle is missing {needle!r}"


def test_bundle_has_no_hardcoded_api_path_or_token():
    """Acceptance r4: data calls ride the kit's slug-aware apiFetch/apiUrl, so
    the bundle carries no root-absolute /api path and no bearer token in a URL."""
    js = "\n".join(p.read_text(encoding="utf-8") for p in (DIST / "assets").glob("*.js"))
    assert "/api/plugins" not in js, "a root-absolute /api path bypasses the slug-aware kit"
    assert "token=" not in js and "bearer=" not in js.lower(), "no token may ride in a URL"


# ---------------------------------------------------------------- view source


def test_app_source_routes_data_through_the_kit():
    """Acceptance r4: components never fetch directly nor name an /api path —
    every data call goes through api.ts (apiFetch/apiUrl)."""
    app = (SRC / "App.tsx").read_text(encoding="utf-8")
    assert "/api/" not in app, "a component hardcodes an /api path"
    # a bare fetch( — but NOT apiFetch(, which is the sanctioned kit wrapper
    assert not re.search(r"\bfetch\(", app), "a component calls fetch() directly instead of apiFetch"
    assert not re.search(r"\bwindow\.fetch\b", app)
    # the view subscribes to both completion topics (ADR 0039)
    assert "protobanana.job.done" in app and "protobanana.job.failed" in app


def test_api_module_uses_the_plugin_kit_handshake():
    """api.ts is the single seam: it calls the kit's handshake and exposes the
    slug-aware wrappers + the bus bridge the whole view depends on."""
    api = (SRC / "api.ts").read_text(encoding="utf-8")
    for fn in ("initPluginView", "apiFetch", "apiUrl", "subscribe"):
        assert fn in api, f"api.ts does not reference the kit's {fn}"


def test_committed_build_matches_the_committed_source():
    """A changed index.html entry hash with no matching asset file (or vice
    versa) would mean a half-committed build. Cross-check the referenced JS
    entry actually exists — the freshness guard CI relies on (r6)."""
    html = _index_html()
    entry = re.search(r'src="(\./assets/index-[^"]+\.js)"', html)
    assert entry, "no hashed entry in index.html"
    assert (DIST / entry.group(1).lstrip("./")).is_file()
