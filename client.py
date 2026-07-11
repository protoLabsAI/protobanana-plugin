"""Gateway transport — every request rides ``graph.sdk.gateway_client()``.

Three call shapes, matching how protoBanana dispatches:

- ``generate``  → POST /images/generations (JSON) — gen + typography (Ideogram)
- ``edit``      → POST /images/edits (multipart) — edit / identity / region /
  bgremove / outpaint. The endpoint is single-image by OpenAI spec, so extra
  refs and knobs ride extra form fields (``person_image`` data URL,
  ``grounding_px``, ``grounding``, outpaint margins) exactly like the OpenAI
  SDK's ``extra_body`` does.
- ``chat_compose`` → POST /chat/completions on the auto-routing chat alias —
  the only channel that accepts 2–3 reference images (multiref).

Raises httpx errors / RuntimeError; tools translate to readable strings.
"""

from __future__ import annotations

import base64
import re

_cfg: dict = {}

_DATA_URL_RE = re.compile(r"data:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)")


def configure(cfg: dict) -> None:
    _cfg.clear()
    _cfg.update(cfg)


def _client():
    from graph.sdk import gateway_client

    return gateway_client(timeout=float(_cfg.get("timeout_s", 300)))


def _first_b64(payload: dict) -> bytes:
    data = (payload.get("data") or [{}])[0].get("b64_json") or ""
    if not data:
        raise RuntimeError(f"gateway returned no image data: {str(payload)[:200]}")
    return base64.b64decode(data)


async def generate(model: str, prompt: str, size: str, *, seed: int | None = None,
                   negative_prompt: str | None = None) -> bytes:
    payload: dict = {"model": model, "prompt": prompt, "size": size, "n": 1,
                     "response_format": "b64_json"}
    if seed is not None:
        payload["seed"] = seed
    if negative_prompt:
        payload["negative_prompt"] = negative_prompt
    async with _client() as client:
        resp = await client.post("/images/generations", json=payload)
        resp.raise_for_status()
        return _first_b64(resp.json())


async def edit(model: str, prompt: str, image: bytes, *, fields: dict | None = None,
               mask: bytes | None = None) -> bytes:
    form: dict = {"model": model, "prompt": prompt, "response_format": "b64_json"}
    for key, value in (fields or {}).items():
        if value is not None:
            form[key] = str(value)
    files = [("image", ("image.png", image, "image/png"))]
    if mask is not None:
        files.append(("mask", ("mask.png", mask, "image/png")))
    async with _client() as client:
        resp = await client.post("/images/edits", data=form, files=files)
        resp.raise_for_status()
        return _first_b64(resp.json())


async def chat_compose(model: str, prompt: str, images: list[bytes]) -> bytes:
    content: list[dict] = [{"type": "text", "text": prompt}]
    for raw in images:
        b64 = base64.b64encode(raw).decode()
        content.append({"type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64}"}})
    payload = {"model": model, "messages": [{"role": "user", "content": content}]}
    async with _client() as client:
        resp = await client.post("/chat/completions", json=payload)
        resp.raise_for_status()
        text = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content") or ""
    match = _DATA_URL_RE.search(text)
    if not match:
        raise RuntimeError(f"chat route returned no image: {text[:200]}")
    return base64.b64decode(match.group(1))
