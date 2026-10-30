# protobanana-plugin

Native image generation and editing for [protoAgent](https://github.com/protoLabsAI/protoAgent),
backed by the [protoBanana](https://github.com/protoLabsAI/protoBanana) gateway — self-hosted
ComfyUI workflows (Qwen-Image-2.1, Krea 2 identity edit, SAM 3 region edit, BiRefNet)
behind LiteLLM.

The agent gets seven tools; every result is persisted to the core media store, renders
inline in chat, and — on a vision model — is attached to the tool result so the agent can
**see** what it just made and iterate (generate → look → refine).

| Tool | Route | Use |
|---|---|---|
| `generate_image` | `/images/generations` | Text-to-image — `draft: true` routes to the 8-step Qwen-Image-2.1 Turbo tier (~10s vs ~32s warm) for rapid prototyping |
| `edit_image` | `/images/edits` | Global/semantic instruction edits — `draft: true` uses the Turbo editor (~10s vs ~38s) |
| `identity_edit` | `/images/edits` (krea2 stems) | Face/identity-preserving edits — single-ref, or scene + person two-ref |
| `region_edit` | `/images/edits` (+`grounding`) | Change one object, leave the rest untouched |
| `remove_background` | `/images/edits` (bgremove) | Sticker/cutout on transparency |
| `compose_images` | `/chat/completions` (auto-route) | Combine 2–3 references into one image |
| `outpaint_image` | `/images/edits` (+margins) | Extend the canvas |

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

- **Identity edit ordering is load-bearing**: two-ref mode is `image_ref` = scene,
  `person_ref` = person. `grounding_px` (512–1536, default 768) trades edit adherence
  (lower) against facial likeness (higher).
- **Text in images** (posters, logos, signs) goes through `generate_image` — Qwen-Image-2.1
  renders quoted text accurately, so there is no separate typography tool (Ideogram 4
  was dropped in 0.3.0).
- **Transparent inputs**: the ComfyUI workflows drop alpha (transparent → black).
  Edit tools flatten a transparent input onto white before sending it;
  `edit_image` / `region_edit` then re-apply the input's transparency
  (`keep_transparency=false` keeps the filled-in backdrop instead, e.g. "put it on
  a beach"). `identity_edit`, `outpaint_image`, `compose_images` flatten only.
- **Sizes**: `generate_image` snaps `size` to a 16px grid (256–2048) and sends it as
  `width`/`height` too, because LiteLLM drops the standard `size` for custom
  providers (needs protoBanana#48 on the gateway). If the gateway still returns
  another size, the tool result says so. Edits keep the input's dimensions.
- **Cutouts**: `remove_background` strips the old background's colour from soft
  edges (the light halo around hair/fluff), using the original image to un-mix
  edge pixels. Alpha only ever goes down, and only near the edge.
- `show_model: false` turns off attaching results to the model (text-only models degrade
  automatically either way; core caps attachments at 2 MiB/image).

## Tests

```bash
python -m pytest tests/   # host-free — vendored testkit, stubbed gateway
```
