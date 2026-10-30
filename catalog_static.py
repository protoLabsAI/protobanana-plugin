"""Static param schema — the stand-in for the S6 catalog endpoint.

The Studio view renders every operation form from data rather than hardcoding
it. Until protoBanana ships ``GET /v1/protobanana/catalog`` behind the gateway
(design §5.2, S6), the plugin carries this static mirror of the alias/param
table in design §1.2. One entry per op (generate, edit, inpaint, region_edit,
identity, outpaint, remove_background, compose), each with:

- ``aliases``: the gateway alias per quality tier (``draft`` / ``final``),
  defaulting from the plugin config (``gen_model`` etc.) so settings stay the
  source of truth while the catalog is static;
- ``params``: a JSON Schema the view turns into typed form controls;
- ``inputs``: input arity (image count, mask, person ref);
- ``licence``: flags such as RMBG being CC BY-NC (non-commercial);
- ``typical_latency_s``: used by the queue strip to show honest elapsed time.

Host-free: this module reads a plain config dict and builds plain data, so the
runner (``jobs.py``) and the catalog route (``routes.py``) share one source of
truth with no host present.
"""

from __future__ import annotations

# Model sizes snap to a 16px grid within 256–2048 (see tools._snap_size); the
# view clamps the WxH control to the same bounds.
_SIZE_MIN, _SIZE_MAX, _SIZE_STEP = 256, 2048, 16

# ``op`` → tier → (config key, literal default). The literal default mirrors
# tools._DEFAULTS so the catalog resolves a real alias even when a test's
# config omits the key (and when the static schema is used host-free). Ops with
# no distilled "draft" variant point both tiers at the same alias.
_ALIASES: dict[str, dict[str, tuple[str | None, str]]] = {
    "generate": {
        "draft": ("fast_gen_model", "protolabs/qwen-image-2-1-turbo"),
        "final": ("gen_model", "protolabs/qwen-image"),
    },
    "edit": {
        "draft": ("fast_edit_model", "protolabs/qwen-image-edit-turbo"),
        "final": ("edit_model", "protolabs/qwen-image-edit"),
    },
    "inpaint": {
        # No plugin config key yet (design §1.1 gap); the gateway stem is fixed.
        "draft": (None, "protolabs/qwen-image-inpaint"),
        "final": (None, "protolabs/qwen-image-inpaint"),
    },
    "region_edit": {
        "draft": ("region_model", "protolabs/qwen-image-region-edit"),
        "final": ("region_model", "protolabs/qwen-image-region-edit"),
    },
    "identity": {
        "draft": ("identity_model", "protolabs/krea2-identity-edit"),
        "final": ("identity_model", "protolabs/krea2-identity-edit"),
        # realism-LoRA variant — not a tier, but a selectable alias (design §1.2).
        "realism": ("realism_identity_model", "protolabs/krea2-identity-edit-realism"),
    },
    "outpaint": {
        "draft": ("outpaint_model", "protolabs/qwen-image-outpaint"),
        "final": ("outpaint_model", "protolabs/qwen-image-outpaint"),
    },
    "remove_background": {
        "draft": ("bgremove_model", "protolabs/qwen-image-bgremove"),
        "final": ("bgremove_model", "protolabs/qwen-image-bgremove"),
    },
    "compose": {
        "draft": ("chat_model", "protolabs/qwen-image-chat"),
        "final": ("chat_model", "protolabs/qwen-image-chat"),
    },
}

# The order Studio shows ops in (design §3.1 left column). Also fixes the set of
# ops the catalog route returns.
OPS = ["generate", "edit", "inpaint", "region_edit", "identity", "outpaint",
       "remove_background", "compose"]

_PROMPT = {"type": "string", "title": "Prompt"}
_NEGATIVE = {"type": "string", "title": "Negative prompt", "default": ""}
_SEED = {"type": "integer", "title": "Seed", "default": -1,
         "description": "Fixed seed for reproducibility; -1 = random."}
_SIZE = {"type": "string", "title": "Size", "default": "1024x1024",
         "pattern": r"^\d+\s*[x×*]\s*\d+$",
         "description": f"WxH, snapped to a multiple of {_SIZE_STEP} within "
                        f"{_SIZE_MIN}–{_SIZE_MAX}."}


def _schema(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required}


# One param JSON Schema per op, mirroring the design §1.2 table. ``image`` /
# ``mask`` / ``person_image`` carry image references (media id, /media/ URL,
# data URL, or path), resolved by the runner exactly as the tools resolve them.
_PARAMS: dict[str, dict] = {
    "generate": _schema({
        "prompt": _PROMPT,
        "negative_prompt": _NEGATIVE,
        "size": _SIZE,
        "seed": _SEED,
        "n": {"type": "integer", "title": "Count", "default": 1, "minimum": 1, "maximum": 4},
    }, ["prompt"]),
    "edit": _schema({
        "image": {"type": "string", "title": "Image", "description": "Image reference to edit."},
        "prompt": _PROMPT,
        "negative_prompt": _NEGATIVE,
        "seed": _SEED,
    }, ["image", "prompt"]),
    "inpaint": _schema({
        "image": {"type": "string", "title": "Image"},
        "mask": {"type": "string", "title": "Mask",
                 "description": "PNG where transparent = the region to edit."},
        "prompt": _PROMPT,
        "negative_prompt": _NEGATIVE,
        "seed": _SEED,
    }, ["image", "mask", "prompt"]),
    "region_edit": _schema({
        "image": {"type": "string", "title": "Image"},
        "grounding": {"type": "string", "title": "Region",
                      "description": "Short noun phrase for the region (SAM 3 → mask), "
                                     "e.g. \"the red car\"."},
        "prompt": _PROMPT,
        "seed": _SEED,
    }, ["image", "grounding", "prompt"]),
    "identity": _schema({
        "image": {"type": "string", "title": "Scene / photo",
                  "description": "The scene (two-ref) or the person's photo (single-ref)."},
        "person_image": {"type": "string", "title": "Person ref",
                         "description": "Two-ref mode: the person to place into the scene."},
        "prompt": _PROMPT,
        "grounding_px": {"type": "integer", "title": "Grounding px", "default": 0,
                         "minimum": 512, "maximum": 1536,
                         "description": "0 = default 768. Higher favours facial likeness."},
        "seed": _SEED,
        "realism": {"type": "boolean", "title": "Realism", "default": False,
                    "description": "Realism-LoRA variant for photographic portraits."},
    }, ["image", "prompt"]),
    "outpaint": _schema({
        "image": {"type": "string", "title": "Image"},
        "prompt": {"type": "string", "title": "Prompt", "default": "",
                   "description": "What the new areas should contain (empty = continue the scene)."},
        "left": {"type": "integer", "title": "Left", "default": 0, "minimum": 0},
        "top": {"type": "integer", "title": "Top", "default": 0, "minimum": 0},
        "right": {"type": "integer", "title": "Right", "default": 0, "minimum": 0},
        "bottom": {"type": "integer", "title": "Bottom", "default": 0, "minimum": 0},
        "seed": _SEED,
    }, ["image"]),
    "remove_background": _schema({
        "image": {"type": "string", "title": "Image"},
    }, ["image"]),
    "compose": _schema({
        "images": {"type": "array", "title": "References", "items": {"type": "string"},
                   "minItems": 2, "maxItems": 3,
                   "description": "2–3 reference images to combine."},
        "prompt": _PROMPT,
    }, ["images", "prompt"]),
}

# Human labels + routing/latency/licence metadata mirroring design §1.2.
_META: dict[str, dict] = {
    "generate": {"label": "Generate", "route": "/images/generations",
                 "inputs": {"images": 0, "mask": False, "person": False},
                 "typical_latency_s": 32},
    "edit": {"label": "Edit", "route": "/images/edits",
             "inputs": {"images": 1, "mask": False, "person": False},
             "typical_latency_s": 38},
    "inpaint": {"label": "Inpaint", "route": "/images/edits",
                "inputs": {"images": 1, "mask": True, "person": False},
                "typical_latency_s": 38},
    "region_edit": {"label": "Region edit", "route": "/images/edits",
                    "inputs": {"images": 1, "mask": False, "person": False},
                    "typical_latency_s": 40},
    "identity": {"label": "Identity", "route": "/images/edits",
                 "inputs": {"images": 1, "mask": False, "person": True},
                 "typical_latency_s": 40},
    "outpaint": {"label": "Outpaint", "route": "/images/edits",
                 "inputs": {"images": 1, "mask": False, "person": False},
                 "typical_latency_s": 38},
    "remove_background": {"label": "Remove background", "route": "/images/edits",
                          "inputs": {"images": 1, "mask": False, "person": False},
                          "typical_latency_s": 12,
                          # RMBG-2.0 is CC BY-NC (design §1.2, R9).
                          "licence": {"non_commercial": True,
                                      "note": "RMBG-2.0 is CC BY-NC"}},
    "compose": {"label": "Compose", "route": "/chat/completions",
                "inputs": {"images": 3, "mask": False, "person": False},
                "typical_latency_s": 40},
}


def alias_for(cfg: dict, op: str, tier: str = "final", override: str | None = None) -> str | None:
    """Resolve the gateway alias for ``op`` at ``tier``.

    An explicit ``override`` (the view's "advanced alias" field) wins; otherwise
    the plugin config value for the tier's key, falling back to the literal
    default. Returns ``None`` for an unknown op so the runner can fail readably.
    """
    if override:
        return override
    tiers = _ALIASES.get(op)
    if not tiers:
        return None
    key, default = tiers.get(tier) or tiers["final"]
    if key:
        val = cfg.get(key)
        if val:
            return val
    return default


def entry(cfg: dict, op: str) -> dict | None:
    """The catalog entry for one op, with aliases resolved from ``cfg``."""
    if op not in _META:
        return None
    meta = _META[op]
    aliases = {tier: alias_for(cfg, op, tier) for tier in _ALIASES[op]}
    out = {
        "op": op,
        "label": meta["label"],
        "route": meta["route"],
        "aliases": aliases,
        "default_tier": "final",
        "inputs": meta["inputs"],
        "licence": meta.get("licence", {"non_commercial": False}),
        "typical_latency_s": meta["typical_latency_s"],
        "params": _PARAMS[op],
    }
    return out


def build_catalog(cfg: dict | None = None) -> list[dict]:
    """The full static catalog: one entry per op, in display order."""
    cfg = cfg or {}
    return [entry(cfg, op) for op in OPS]
