# protobanana-plugin

Native image generation and editing for [protoAgent](https://github.com/protoLabsAI/protoAgent),
backed by the [protoBanana](https://github.com/protoLabsAI/protoBanana) gateway — self-hosted
ComfyUI workflows (Qwen-Image-2.1 / 2.1 Turbo, SAM 3 region edit, BiRefNet background
removal) behind LiteLLM.

The agent gets seven image tools; every result is persisted to the core media store, renders
inline in chat, and — on a vision model — is attached to the tool result so the agent can
**see** what it just made and iterate (generate → look → refine). Three more tools
(`list_pipelines`, `run_pipeline`, `save_pipeline`) run and author **pipelines** — saved,
re-runnable graphs that chain these operations (see `skills/pipelines/SKILL.md`).

| Tool | Route | Default alias (setting) | Use |
|---|---|---|---|
| `generate_image` | `/images/generations` | `protolabs/qwen-image` (`gen_model`); draft: `protolabs/qwen-image-2-1-turbo` (`fast_gen_model`) | Text-to-image — `draft: true` routes to the 8-step Qwen-Image-2.1 Turbo tier (~10s vs ~32s warm) for rapid prototyping |
| `edit_image` | `/images/edits` | `protolabs/qwen-image-edit` (`edit_model`); draft: `protolabs/qwen-image-edit-turbo` (`fast_edit_model`) | Global/semantic instruction edits — `draft: true` uses the Turbo editor (~10s vs ~38s) |
| `region_edit` | `/images/edits` (+`grounding`) | `protolabs/qwen-image-region-edit` (`region_model`) | Change one object (SAM 3 mask), leave the rest untouched |
| `remove_background` | `/images/edits` | `protolabs/qwen-image-bgremove` (`bgremove_model`) | Sticker/cutout on transparency (BiRefNet) |
| `compose_images` | `/chat/completions` | `protolabs/qwen-image-multiref` (`compose_model`) | Combine 2–10 references into one image (Qwen-Image-2.1 native multi-ref) |
| `outpaint_image` | `/images/edits` (+margins) | `protolabs/qwen-image-outpaint` (`outpaint_model`) | Extend the canvas |
| `inpaint_image` | `/images/edits` (+`mask_image`) | `protolabs/qwen-image-inpaint` (`inpaint_model`) | Paint or supply a source-sized alpha mask: transparent = edit, opaque = preserve. The mask rides a `mask_image` data-URL form field (the gateway's LiteLLM proxy drops an OpenAI `mask` file) |

## Install

```bash
protoagent plugin install https://github.com/protoLabsAI/protobanana-plugin
```

Pillow is used for the pixel fix-ups below. It ships with protoAgent core
(a hard dependency since v0.190.0) and inside the desktop app, so there is
nothing to install; it is still not declared in `requires_pip`, which keeps
the frozen **desktop app** able to install this plugin (protoAgent#1631). On
an older host without Pillow those steps are skipped.

Requires the gateway's `model_list` to expose protoBanana aliases (see
`protoagent.plugin.yaml` for the defaults — `protolabs/qwen-image` etc.; every alias is a
plugin setting). No extra pip deps, no extra network hosts: all traffic rides
`graph.sdk.gateway_client()` to the already-configured model gateway.

Built on protoAgent core seams [#1929](https://github.com/protoLabsAI/protoAgent/issues/1929)
(`registry.save_media`), [#1930](https://github.com/protoLabsAI/protoAgent/issues/1930)
(`multimodal_tool_result`), and [#1931](https://github.com/protoLabsAI/protoAgent/issues/1931)
(`gateway_client`) — the plugin itself is pure business logic.

## Notes

- **Identity**: `edit_image` keeps a person's likeness when restyling or restaging
  them, and `compose_images` places a person from one photo into another scene. Both
  run on Qwen-Image-2.1, which held likeness as well as or better than the Krea 2
  identity tool (and 3–4x faster), so `identity_edit` was dropped in 0.5.0.
- **Text in images** (posters, logos, signs) goes through `generate_image` — Qwen-Image-2.1
  renders quoted text accurately, so there is no separate typography tool (Ideogram 4
  was dropped in 0.3.0).
- **Transparent inputs**: the ComfyUI workflows drop alpha (transparent → black).
  Edit tools flatten a transparent input onto white before sending it;
  `edit_image` / `region_edit` then re-apply the input's transparency
  (`keep_transparency=false` keeps the filled-in backdrop instead, e.g. "put it on
  a beach"). `outpaint_image` and `compose_images` flatten only.
- **Sizes**: `generate_image` snaps `size` to a 16px grid (256–2048) and sends it as
  `width`/`height` too, because LiteLLM drops the standard `size` for custom
  providers (needs protoBanana#48 on the gateway). If the gateway still returns
  another size, the tool result says so. Edits keep the input's dimensions.
- **Cutouts**: `remove_background` strips the old background's colour from soft
  edges (the light halo around hair/fluff), using the original image to un-mix
  edge pixels. Alpha only ever goes down, and only near the edge.
- **Readable failures**: gateway 502/503/504/524 (Cloudflare's ~100s limit) come
  back as one plain sentence with retry guidance, never as an HTML page. A
  `region_edit` whose region wasn't found (result identical to the input) is
  reported as an error instead of "Done"; same for an `edit_image` no-op.
- `compose_images` has no size/aspect control (the gateway's multiref route takes
  none); reshape a composite with `outpaint_image`.
- `show_model: false` turns off attaching results to the model (text-only models degrade
  automatically either way; core caps attachments at 2 MiB/image).

## Versions

- **0.6.0** — protoBanana Studio Playground (Studio S1–S5): a background **job** API and
  completion events, the Studio console view with a shared history/gallery, a Playground
  running all single-image ops, mask painting with `inpaint_image`, and **Send to agent**
  plus `protobanana-ref` reference chips. Requires protoAgent **>= 0.223.0**.
- **0.5.0** — Krea `identity_edit` dropped (Qwen-Image-2.1 holds likeness as well, 3–4x
  faster); inpaint masks are sent as `mask_image`.
- **0.4.1** — readable gateway errors (502/503/504/524 as one plain sentence) and no-op
  edit detection (a `region_edit`/`edit_image` that didn't change the image is reported
  as an error).

## Tests

```bash
pip install -r requirements-dev.txt
ruff check .
python -m pytest tests/   # host-free — vendored testkit, stubbed gateway
```

CI (`.github/workflows/ci.yml`) runs the same on every PR.
