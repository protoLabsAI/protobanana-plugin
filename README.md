# protobanana-plugin

Native image generation and editing for [protoAgent](https://github.com/protoLabsAI/protoAgent),
backed by the [protoBanana](https://github.com/protoLabsAI/protoBanana) gateway — self-hosted
ComfyUI workflows (Qwen-Image, Krea 2 identity edit, Ideogram 4, SAM 3 region edit, BiRefNet)
behind LiteLLM.

The agent gets eight tools; every result is persisted to the core media store, renders
inline in chat, and — on a vision model — is attached to the tool result so the agent can
**see** what it just made and iterate (generate → look → refine).

| Tool | Route | Use |
|---|---|---|
| `generate_image` | `/images/generations` | Text-to-image — `draft: true` routes to the 4-step Lightning tier (~10s vs ~32s warm) for rapid prototyping |
| `edit_image` | `/images/edits` | Global/semantic instruction edits |
| `identity_edit` | `/images/edits` (krea2 stems) | Face/identity-preserving edits — single-ref, or scene + person two-ref |
| `region_edit` | `/images/edits` (+`grounding`) | Change one object, leave the rest untouched |
| `remove_background` | `/images/edits` (bgremove) | Sticker/cutout on transparency |
| `compose_images` | `/chat/completions` (auto-route) | Combine 2–3 references into one image |
| `outpaint_image` | `/images/edits` (+margins) | Extend the canvas |
| `typography_image` | `/images/generations` (ideogram) | Posters/logos with accurate text |

## Install

```bash
protoagent plugin install https://github.com/protoLabsAI/protobanana-plugin
```

Optional: `pillow` enables automatic shrinking of oversized two-ref person
references (the gateway caps multipart form parts at 1MB). Server installs:
`uv pip install pillow` in the agent venv. Without it, everything works except
two-ref identity edits with person refs over ~0.7MB, which return a readable
error. Not declared in `requires_pip` so the frozen **desktop app** can install
this plugin (protoAgent#1631).

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
- **Typography (Ideogram 4)** has a built-in stochastic safety refusal that returns a flat
  gray card. The plugin deliberately does **not** auto-retry refusals; reword or ask the user.
- `show_model: false` turns off attaching results to the model (text-only models degrade
  automatically either way; core caps attachments at 2 MiB/image).

## Tests

```bash
python -m pytest tests/   # host-free — vendored testkit, stubbed gateway
```
