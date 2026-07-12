"""Attachment bridge — user-attached images become media ids tools can use.

Inbound vision gives the MODEL eyes on an attachment, but the image tools
take string references, and a model cannot echo megabytes of base64 back
out of its vision context into a tool argument. This middleware closes the
loop: before each model call it scans HumanMessages for data-URL image
parts, persists each to the core media store once, and appends a text part
naming the media ids — so "remove the background of this photo" works on a
plain attachment, single or multiple.

Idempotent by inspection: a bridged message carries MARKER in its text, so
tool-loop iterations and later turns skip it. Messages without an id are
left alone (the messages reducer would append instead of replace).
"""

from __future__ import annotations

import base64
import logging

log = logging.getLogger(__name__)

MARKER = "[attached-image refs]"


def build_factory(registry):
    """(config) -> AgentMiddleware factory closing over the plugin registry."""

    def factory(config):
        try:
            from langchain.agents.middleware import AgentMiddleware
            from langchain_core.messages import HumanMessage
        except ImportError:
            log.warning("[protobanana] langchain middleware unavailable; attachment bridge disabled")
            return None

        def bridge(state):
            updates = []
            for m in state.get("messages") or []:
                if not isinstance(m, HumanMessage) or not isinstance(m.content, list) or not m.id:
                    continue
                if any(isinstance(p, dict) and p.get("type") == "text" and MARKER in (p.get("text") or "")
                       for p in m.content):
                    continue  # already bridged
                ids = []
                for p in m.content:
                    if not (isinstance(p, dict) and p.get("type") == "image_url"):
                        continue
                    url = (p.get("image_url") or {}).get("url", "")
                    if not url.startswith("data:image/") or "," not in url:
                        continue
                    try:
                        header, b64 = url.split(",", 1)
                        mime = header.split(":", 1)[1].split(";", 1)[0] or "image/png"
                        ref = registry.save_media(base64.b64decode(b64), mime,
                                                  {"source": "user_attachment"})
                        ids.append(ref.id)
                    except Exception:  # noqa: BLE001 — one bad part must not kill the turn
                        log.exception("[protobanana] failed to persist an attached image")
                if ids:
                    listing = ", ".join(f"image {i} = `{mid}`" for i, mid in enumerate(ids, start=1))
                    note = {"type": "text",
                            "text": f"\n{MARKER} the user's attached image(s) are saved and can be "
                                    f"passed to image tools by media id: {listing}"}
                    updates.append(m.model_copy(update={"content": [*m.content, note]}))
            return {"messages": updates} if updates else None

        class AttachmentBridgeMiddleware(AgentMiddleware):
            """Persist attached images pre-model so tools can reference them."""

            def before_model(self, state, runtime):  # type: ignore[override]
                return bridge(state)

            async def abefore_model(self, state, runtime):  # type: ignore[override]
                return bridge(state)

        return AttachmentBridgeMiddleware()

    return factory
