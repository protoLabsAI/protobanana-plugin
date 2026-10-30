"""protoBanana Images plugin.

Image generation/editing tools backed by the protoBanana gateway (self-hosted
ComfyUI workflows behind LiteLLM). Every call goes through the host's model
gateway via ``graph.sdk.gateway_client()`` (#1931); every result is persisted
with ``registry.save_media()`` (#1929) and — when ``show_model`` is on —
attached to the tool result via ``multimodal_tool_result()`` (#1930) so a
vision model can look at what it just made.

register() wires: config → tools, the attachment-bridge middleware, and —
for protoBanana Studio (the console view) — the in-process job runner plus its
FastAPI router. The agent tools and the Studio share one code path (client.py)
and one media store; renders submitted from the view are jobs whose completion
arrives on the core event bus (protobanana.job.done|failed), so no request is
ever held open while a render runs.
"""


def register(registry) -> None:
    from pathlib import Path

    from . import history, jobs, middleware, pipelines, routes, tools

    tools.configure(registry)
    registry.register_tools(tools.get_tools())
    # Attachment bridge: user-attached images → media-store ids the model can
    # hand to the image tools (single or multiple attachments).
    registry.register_middleware(middleware.build_factory(registry))
    # Shared history index (one log for agent + Studio renders) in the plugin
    # data dir; configured before the tools and the job runner write to it.
    history.configure(registry)
    # Studio: the job runner reuses client.py + save_media + the event bus; the
    # router serves the public view page and the gated data routes.
    jobs.configure(registry)
    # S7 pipelines: the DAG runner reuses the same jobs/client path + save_media +
    # history + the event bus. Configured before the router/tools run it.
    pipelines.configure(registry)
    registry.register_late_tool_factory(pipelines.pipeline_tool_factory)
    # Ship the pipelines skill so the agent knows when to reach for run_pipeline
    # (guarded: older hosts without the seam just don't get the skill).
    if hasattr(registry, "register_skill_dir"):
        registry.register_skill_dir(Path(getattr(registry, "plugin_dir", ".") or ".") / "skills")
    # The router declares absolute paths (/plugins/protobanana/studio and
    # /api/plugins/protobanana/...), so mount it at the root: the default
    # prefix /plugins/<id> would double them and 404 every Studio route.
    registry.register_router(routes.build_router(registry), prefix="")
