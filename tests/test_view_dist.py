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
    assert '/_ds/plugin-kit.js' in (SRC / 'api.ts').read_text()
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
    assert any(r == "/_ds/plugin-kit.js" for r in refs)  # preloaded as an ES module
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
    """The job bus topics, the plugin-relative endpoints, and the missing-job
    failure path all survive the build — so the committed bundle is the Studio
    wiring (including the poll's give-up path), not an empty shell."""
    js = "\n".join(p.read_text(encoding="utf-8") for p in (DIST / "assets").glob("*.js"))
    for needle in ("protobanana.job.done", "protobanana.job.failed", "catalog", "jobs", "job_missing"):
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


def test_app_poll_does_not_hang_on_a_missing_job():
    """Major regression guard (App.tsx poll): a 404 from GET /jobs/{id} — the
    in-memory store was wiped by a reload/restart, or the job was evicted — must
    NOT leave the view stuck in `pending` with Generate disabled. The poll bounds
    consecutive unreachable ticks and settles into a recoverable failure."""
    app = (SRC / "App.tsx").read_text(encoding="utf-8")
    # the give-up path exists and is recoverable (Retry re-runs the last request)
    assert "lostPhase" in app and "job_missing" in app, "no missing-job failure path in the poll"
    assert "recoverable: true" in app, "a lost job must be recoverable so the form re-enables"
    # a bound on consecutive misses, not the old silent `if (!st || settled) return;`
    assert re.search(r"MAX_STRIKES", app), "the poll has no bound on consecutive misses"
    assert not re.search(r"if \(!st \|\| settled\) return;", app), "the old silent-return bug is back"


def test_api_module_uses_the_plugin_kit_handshake():
    """api.ts is the single seam: it CALLS the kit's handshake (not merely names
    it) and exposes the slug-aware wrappers + the bus bridge the view depends on."""
    api = (SRC / "api.ts").read_text(encoding="utf-8")
    for fn in ("apiFetch", "apiUrl", "subscribe"):
        assert fn in api, f"api.ts does not reference the kit's {fn}"
    # the handshake is actually invoked, not just declared in the interface
    assert re.search(r"initPluginView\s*\(", api), "api.ts never calls initPluginView()"


def test_api_fetch_awaits_ready_before_selecting_transport():
    """Early history requests must not race the asynchronous kit handshake."""
    api = (SRC / "api.ts").read_text(encoding="utf-8")
    body = re.search(r"export async function apiFetch\([^\n]+\{\n(.*?)\n\}", api, re.S)
    assert body, "apiFetch wrapper is missing"
    # Ignore comments so mentioning await ready() alone cannot satisfy the guard.
    code = re.sub(r"/\*.*?\*/|//[^\n]*", "", body.group(1), flags=re.S)
    ready = re.search(r"\bawait\s+ready\(\)\s*;", code)
    assert ready, "apiFetch must await ready()"
    assert ready.end() < code.index("if (_kit.apiFetch)"), "transport selected before ready()"
    assert ready.end() < code.index("return fetch("), "standalone fetch runs before ready()"


def test_images_rail_preserves_studio_route():
    manifest = (PLUGIN_ROOT / "protoagent.plugin.yaml").read_text(encoding="utf-8")
    first_view = re.search(r"^views:\n(  - [^\n]+\n.*?)(?=^  - |^\S|\Z)", manifest, re.M | re.S)
    assert first_view, "manifest views are missing"
    fields = dict(re.findall(r"^\s+(?:- )?(\w+):\s*([^\n]+)", first_view.group(1), re.M))
    assert fields["label"] == "Images"
    assert fields["icon"] == "Images"
    assert fields["id"] == "studio"
    assert fields["path"] == "/plugins/protobanana/studio"


def test_committed_build_is_fresh_against_source():
    """Freshness guard (r6): distinctive string literals that live only in the
    view source must also appear in the committed bundle, so a source edit that
    was not rebuilt (a stale dist/) fails HERE instead of shipping. String
    literals survive Vite's minification — unlike renamed identifiers — so this
    actually compares the build against view/src, which the name has always
    promised. Also guards against a half-committed build (entry hash with no
    matching asset on disk)."""
    app = (SRC / "App.tsx").read_text(encoding="utf-8")
    api = (SRC / "api.ts").read_text(encoding="utf-8")
    js = "\n".join(p.read_text(encoding="utf-8") for p in (DIST / "assets").glob("*.js"))
    for needle in (
        "protobanana.job.done",
        "protobanana.job.failed",
        "job_missing",
        "Lost track of this render",
    ):
        assert needle in app or needle in api, f"test needle {needle!r} vanished from source"
        assert needle in js, f"stale dist/: {needle!r} is in the source but not the built bundle — rebuild view/"
    html = _index_html()
    entry = re.search(r'src="(\./assets/index-[^"]+\.js)"', html)
    assert entry, "no hashed entry in index.html"
    assert (DIST / entry.group(1).lstrip("./")).is_file()


def test_s6_catalog_banner_and_warnings_are_built():
    """Studio S6: the static-source banner and the alias-drift Settings hint are
    wired in the view source AND survive into the committed bundle — so a stale
    dist/ can't silently drop the fallback banner (acceptance r2) or the warnings
    (r3). Keyed on string literals, which outlast Vite's minification."""
    app = (SRC / "App.tsx").read_text(encoding="utf-8")
    api = (SRC / "api.ts").read_text(encoding="utf-8")
    js = "\n".join(p.read_text(encoding="utf-8") for p in (DIST / "assets").glob("*.js"))
    # the banner is driven by the catalog source + the warnings list
    assert "catalogSource" in app and "warnings" in app
    for field in ("source", "stale", "warnings"):
        assert field in api, f"api.ts Catalog payload drops {field!r}"
    for needle in ("built-in schema", "banner-stale", "banner-warn"):
        assert needle in app, f"S6 banner needle {needle!r} vanished from App.tsx"
        assert needle in js, f"stale dist/: {needle!r} missing from the built bundle — rebuild view/"


def test_reference_chip_is_built_and_uses_the_nonce_bound_bridge():
    chip = (DIST / "ref.html").read_text()
    assert chip == (VIEW / "public" / "ref.html").read_text()
    assert "protoComponent:openView" in chip
    assert "protoComponent:ready" in chip
    assert "protoComponent:init" in chip
    assert "protoComponent:bridgeResult" in chip
    assert "protobanana:focus" in chip
