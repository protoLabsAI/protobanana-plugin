"""protoBanana Images plugin.

Image generation/editing tools backed by the protoBanana gateway (self-hosted
ComfyUI workflows behind LiteLLM). Every call goes through the host's model
gateway via ``graph.sdk.gateway_client()`` (#1931); every result is persisted
with ``registry.save_media()`` (#1929) and — when ``show_model`` is on —
attached to the tool result via ``multimodal_tool_result()`` (#1930) so a
vision model can look at what it just made.

register() wires: config → tools. No routes, no surfaces — the core media
store serves the files and the chat markdown renders them.
"""


def register(registry) -> None:
    from . import middleware, tools

    tools.configure(registry)
    registry.register_tools(tools.get_tools())
    # Attachment bridge: user-attached images → media-store ids the model can
    # hand to the image tools (single or multiple attachments).
    registry.register_middleware(middleware.build_factory(registry))
