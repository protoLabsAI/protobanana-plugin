"""Live workflow inspector — fetch one alias's API-format workflow through the
gateway, for the read-only "Inspect workflow" drawer (Studio S10, this slice).

The backend (S10-BE, bd-og1b.5) exposes ``GET /v1/protobanana/workflows/<alias>``
behind the gateway, returning ``{workflow, stem, workflows_hash, slots}`` where
``workflow`` is the ComfyUI API-format graph (a flat ``{node_id: {class_type,
inputs}}`` map, plus a ``_doc`` string the loader strips). This module fetches it
over ``graph.sdk.gateway_client()`` — the ONLY transport, nothing else is
contacted (EGRESS ADR 0008; manifest ``capabilities.network: []``) — caches it
per ``(alias, workflows_hash)`` (a workflow graph is immutable for a given hash),
and attaches this plugin's ``comfy_ui_url`` config value (default ``""``) so the
view knows whether to show the "Open in ComfyUI" link.

Python NEVER fetches ``comfy_ui_url``, nor contacts ComfyUI in any way: the
GPL-3.0 ComfyUI frontend is never embedded, framed, proxied or bundled (studio.md
§2) — the only link-out is a new browser tab the operator opens themselves.

Host-free on import: ``graph.sdk`` is imported lazily inside the fetch, and the
rest is pure data, so pytest collects this module with no host.
"""

from __future__ import annotations

from urllib.parse import quote

# The per-alias workflow lives at GET /v1/protobanana/workflows/<alias>. Like
# catalog.py, gateway_client()'s base_url already carries the OpenAI ``/v1`` root
# (client.py posts to ``/images/generations``), so this path is ``/v1``-relative
# — the SAME merge yields ``/v1/protobanana/workflows/<alias>``.
_WORKFLOWS_PATH = "/protobanana/workflows"

# A SHORT timeout (not the 300 s render timeout): the inspector must never hang on
# a slow or absent gateway. Reuses the catalog fetch's short-timeout knob.
_DEFAULT_TIMEOUT_S = 5.0

# Cache keyed by (alias, workflows_hash). A workflow graph is immutable for a
# given workflows_hash, so once fetched it can be served without another gateway
# call; a new hash (the workflow set changed) is a fresh key, hence a refetch.
_cache: dict = {}


class WorkflowNotFound(Exception):
    """The gateway has no workflow for this alias (an unknown alias or a gateway
    404), as distinct from an unreachable gateway — the route maps THIS to a
    readable 404, and other failures to a 502."""


def reset_cache() -> None:
    """Drop the cached workflows (tests; a config reload)."""
    _cache.clear()


async def fetch_gateway_workflow(cfg: dict, alias: str) -> dict:
    """GET one alias's API-format workflow through the gateway. Raises
    :class:`WorkflowNotFound` on a gateway 404 and ``RuntimeError`` on any other
    failure (timeout, transport error, non-2xx, or a body without a ``workflow``
    map) so the route can answer with the right status."""
    from graph.sdk import gateway_client

    timeout = float(
        cfg.get("workflow_timeout_s", cfg.get("catalog_timeout_s", _DEFAULT_TIMEOUT_S))
    )
    # safe="" would percent-encode the slash in an alias like
    # ``protolabs/qwen-image``; the gateway route captures the alias as a path, so
    # keep slashes literal and quote only genuinely unsafe characters.
    path = f"{_WORKFLOWS_PATH}/{quote(alias, safe='/')}"
    async with gateway_client(timeout=timeout) as client:
        resp = await client.get(path)
        if getattr(resp, "status_code", 200) == 404:
            raise WorkflowNotFound(alias)
        resp.raise_for_status()
        body = resp.json()
    if not isinstance(body, dict) or not isinstance(body.get("workflow"), dict):
        raise RuntimeError(f"gateway workflow for {alias!r} has no workflow map")
    return body


def _normalize(body: dict) -> dict:
    """Keep only the fields the view consumes, with safe shapes. A sparse gateway
    response (missing ``stem``/``slots``) still renders — the graph comes from
    ``workflow`` and ``slots`` only adds highlighting."""
    workflow = body.get("workflow")
    slots = body.get("slots")
    return {
        "workflow": workflow if isinstance(workflow, dict) else {},
        "stem": body.get("stem"),
        "workflows_hash": body.get("workflows_hash"),
        "slots": slots if isinstance(slots, list) else [],
    }


async def get_workflow(cfg: dict, alias: str, workflows_hash: str | None = None) -> dict:
    """The workflow for ``alias``, cached per ``(alias, workflows_hash)`` and
    fetched through the gateway on a miss. This plugin's ``comfy_ui_url`` config
    (default ``""``) is attached FRESH each call — not cached — so toggling the
    link on/off takes effect without a cache flush. Raises
    :class:`WorkflowNotFound` for an unknown alias."""
    key = (alias, workflows_hash)
    payload = _cache.get(key)
    if payload is None:
        payload = _normalize(await fetch_gateway_workflow(cfg, alias))
        # Cache under the hash the gateway actually returned AND under the hash the
        # caller asked for (the catalog's current hash), so the next request — with
        # or without the query hint — is a hit with no second gateway call.
        _cache[(alias, payload.get("workflows_hash"))] = payload
        _cache[key] = payload
    return {**payload, "comfy_ui_url": str(cfg.get("comfy_ui_url", "") or "")}
