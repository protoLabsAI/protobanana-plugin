"""Live catalog — fetch protoBanana's param/alias catalog through the gateway.

Studio S6 (design §5.2 item 1, §5.3 R5, §6 S6). The backend (bd-og1b.2) exposes
``GET /v1/protobanana/catalog`` behind the gateway; this module fetches it over
``graph.sdk.gateway_client()`` — the ONLY transport, nothing else is contacted
(EGRESS ADR 0008; manifest ``capabilities.network: []``) — caches it briefly,
and merges it OVER the static schema in ``catalog_static.py`` so the Studio keeps
working, on the built-in schema, when the gateway is down.

What :func:`build` hands the route (and thence the view):

- ``ops``            the catalog, gateway entries merged over the static ones —
  a new op/alias the gateway added shows up with its form and needs no plugin
  release (acceptance r1);
- ``source``         ``"gateway"`` when the live catalog was reached, else
  ``"static"``;
- ``stale``          ``True`` when we fell back to the static schema because the
  gateway was unreachable (acceptance r2);
- ``workflows_hash`` the gateway's workflow-set hash, so S7 can key its step
  cache on it (design R10);
- ``warnings``       readable notes — notably a configured alias the gateway
  doesn't know (the ``qwen-image-2-1-turbo`` / ``qwen-image-turbo`` drift,
  design R5 / acceptance r3). The plugin's alias settings are DEFAULTS validated
  against the live catalog, not the source of truth.

Host-free on import: ``graph.sdk`` is imported lazily inside the fetch, and the
merge/validation is pure data, so pytest collects this module with no host.
"""

from __future__ import annotations

import time

from . import catalog_static

# The gateway catalog lives at GET /v1/protobanana/catalog. gateway_client()'s
# base_url already carries the OpenAI ``/v1`` root (client.py posts to
# ``/images/generations``, not ``/v1/images/generations``), so this path is
# ``/v1``-relative exactly like every other call in client.py — the SAME merge
# yields ``/v1/protobanana/catalog``.
_CATALOG_PATH = "/protobanana/catalog"

# A SHORT timeout: the catalog is a tiny JSON blob and the Studio must never hang
# on a slow or absent gateway — it falls back to the static schema instead. This
# is deliberately NOT the 300 s render timeout.
_DEFAULT_TIMEOUT_S = 5.0

# Cache the live catalog briefly so the picker/forms don't refetch on every
# /catalog hit, while still picking up a gateway change within a session.
_DEFAULT_TTL_S = 60.0

# monotonic timestamp + payload of the last SUCCESSFUL fetch; data None = cold.
_cache: dict = {"at": 0.0, "data": None}


def reset_cache() -> None:
    """Drop the cached catalog (tests; a config reload)."""
    _cache["at"] = 0.0
    _cache["data"] = None


async def fetch_gateway_catalog(cfg: dict) -> dict:
    """GET the live catalog through the gateway. Raises on any failure (timeout,
    transport error, non-2xx, or a body with no ``ops`` list) so the caller can
    fall back to the static schema."""
    from graph.sdk import gateway_client

    timeout = float(cfg.get("catalog_timeout_s", _DEFAULT_TIMEOUT_S))
    async with gateway_client(timeout=timeout) as client:
        resp = await client.get(_CATALOG_PATH)
        resp.raise_for_status()
        body = resp.json()
    if isinstance(body, dict) and "ops" not in body and isinstance(body.get("aliases"), list):
        body = {**body, "ops": _alias_entries(body["aliases"])}
    if not isinstance(body, dict) or not isinstance(body.get("ops"), list):
        raise RuntimeError(f"gateway catalog has no ops list: {str(body)[:200]}")
    return body


def _alias_entries(entries: list) -> list:
    """Adapt the backend v1 per-alias records to Studio's operation picker.

    Keep each alias's own schema and licence, including multiple aliases in the
    same tier. These entries execute by their documented gateway route.
    """
    result = []
    defaults = {}
    names = {"gen": "generate", "bgremove": "remove_background", "multiref": "compose"}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("alias"), str):
            continue
        alias = entry["alias"]
        op = entry.get("op", "workflow")
        tier = entry.get("tier") or "final"
        studio_op = names.get(op, op)
        if studio_op in catalog_static.OPS:
            defaults.setdefault(studio_op, {}).setdefault(tier, alias)
        result.append({**entry, "op": f"{op}:{alias}", "label": alias,
                       "aliases": {tier: alias, "final": alias}, "default_tier": tier})
    # Refresh the built-in forms' aliases as well, retaining their specialised
    # input widgets and image processing. Per-alias entries above expose the full
    # backend schema and variants independently.
    return [{"op": op, "aliases": aliases} for op, aliases in defaults.items()] + result


async def _live_catalog(cfg: dict) -> dict:
    """The cached live catalog, refetched when the TTL lapses. Raises if the
    gateway can't be reached AND the cache is cold/expired."""
    ttl = float(cfg.get("catalog_ttl_s", _DEFAULT_TTL_S))
    data = _cache["data"]
    if data is not None and (time.monotonic() - _cache["at"]) < ttl:
        return data
    body = await fetch_gateway_catalog(cfg)
    _cache["at"] = time.monotonic()
    _cache["data"] = body
    return body


def _merge_ops(static_ops: list, gateway_ops: list) -> list:
    """Gateway entries OVER the static ones, keyed by ``op``.

    A gateway op merges onto its static counterpart (gateway keys win, so the
    static entry backstops any field the gateway omits); the ``aliases`` map is
    merged tier-by-tier, NOT replaced, so a tier the gateway leaves out survives
    from the static schema. A static-only op is kept (additive — the static
    schema is the floor); a gateway-only op is appended (a new op/alias the
    gateway added — acceptance r1). Display order is the static order, with any
    gateway-only ops after it.
    """
    by_op: dict = {}
    order: list = []
    for e in static_ops:
        if isinstance(e, dict) and e.get("op"):
            by_op[e["op"]] = e
            order.append(e["op"])
    for e in gateway_ops:
        if not isinstance(e, dict) or not isinstance(e.get("op"), str) or not e["op"]:
            continue
        op = e["op"]
        static_entry = by_op.get(op, {})
        merged = dict(static_entry)
        merged.update({k: v for k, v in e.items() if v is not None})
        # Deep-merge the alias map rather than replace it wholesale: a gateway op
        # only carries the tiers it knows, so a tier it omits — identity's
        # ``realism`` variant, an op's ``draft`` — must survive from the static
        # schema (the gateway still wins on the tiers it DOES send). Without this,
        # jobs._run's ``aliases.get("realism")`` would miss and silently render
        # the Realism checkbox on the plain identity model.
        base_aliases = static_entry.get("aliases")
        gw_aliases = e.get("aliases")
        if isinstance(base_aliases, dict) and isinstance(gw_aliases, dict):
            merged["aliases"] = {**base_aliases,
                                 **{k: v for k, v in gw_aliases.items() if v}}
        schema = merged.get("params")
        aliases = merged.get("aliases")
        if (not isinstance(schema, dict) or not isinstance(schema.get("properties"), dict)
                or not all(isinstance(v, dict) for v in schema["properties"].values())
                or not isinstance(schema.get("required", []), list)
                or not isinstance(aliases, dict) or not aliases
                or not all(isinstance(v, str) and v for v in aliases.values())
                or merged.get("route") not in {
                    "/images/generations", "/images/edits", "/chat/completions"}):
            continue
        merged["params"] = {**schema, "required": schema.get("required", [])}
        merged.setdefault("label", op)
        if op not in by_op:
            order.append(op)
        by_op[op] = merged
    return [by_op[op] for op in order]


def _known_aliases(gateway: dict) -> set:
    """The gateway's known alias set — an explicit top-level ``aliases`` list
    (the model_list) if present, plus every alias named by a gateway op entry, so
    validation works whichever shape the backend ships."""
    known: set = set()
    for a in gateway.get("aliases") or []:
        if isinstance(a, str):
            known.add(a)
    for e in gateway.get("ops") or []:
        if isinstance(e, dict):
            aliases = e.get("aliases")
            for v in (aliases.values() if isinstance(aliases, dict) else []):
                if isinstance(v, str):
                    known.add(v)
    return known


def _alias_warnings(static_ops: list, known: set) -> list:
    """One readable warning per configured alias the gateway doesn't recognise.

    The plugin's alias settings are defaults validated against the live catalog
    (design R5): an alias the catalog can't resolve is likely renamed or removed
    on the gateway. This is the drift the card calls out — a configured
    ``protolabs/qwen-image-2-1-turbo`` against a catalog that only knows
    ``protolabs/qwen-image-turbo`` surfaces here with a "did you mean" hint.
    """
    import difflib

    used: dict = {}
    for e in static_ops:
        op = e.get("op")
        for tier, alias in (e.get("aliases") or {}).items():
            if isinstance(alias, str) and alias:
                used.setdefault(alias, []).append(f"{op}/{tier}")
    warnings: list = []
    for alias in sorted(used):
        if alias in known:
            continue
        where = ", ".join(used[alias])
        suggestion = difflib.get_close_matches(alias, sorted(known), n=1)
        hint = f" — did you mean {suggestion[0]!r}?" if suggestion else ""
        warnings.append(
            f"Configured alias {alias!r} ({where}) is not in the gateway "
            f"catalog{hint}"
        )
    return warnings


async def build(cfg: dict | None = None) -> dict:
    """Assemble the Studio catalog: the gateway catalog merged over the static
    schema, or the static schema alone (``source=static``, ``stale=True``) when
    the gateway can't be reached."""
    cfg = cfg or {}
    static_ops = catalog_static.build_catalog(cfg)
    try:
        gateway = await _live_catalog(cfg)
    except Exception:
        return {
            "ops": static_ops,
            "source": "static",
            "stale": True,
            "workflows_hash": None,
            "warnings": [],
        }
    return {
        "ops": _merge_ops(static_ops, gateway.get("ops") or []),
        "source": "gateway",
        "stale": False,
        "workflows_hash": gateway.get("workflows_hash"),
        "warnings": _alias_warnings(static_ops, _known_aliases(gateway)),
    }
