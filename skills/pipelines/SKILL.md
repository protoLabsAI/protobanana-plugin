---
name: protobanana-pipelines
description: >-
  Run and author protoBanana image pipelines — saved, re-runnable recipes that
  chain several image operations (generate, edit, region edit, background
  removal, compose, outpaint) into one deterministic result. Use when the user
  wants a repeatable multi-step image (a product sticker, a restaged portrait, a
  widened banner), asks to "run"/"save" a pipeline, or describes the same
  sequence of edits they'll want again.
---

# protoBanana image pipelines

A **pipeline** is a small saved graph of protoBanana image operations. Each step
runs one gateway call and hands its image to the next step; the whole thing is
re-runnable, and unchanged steps are served from a cache, so re-running after one
tweak only redoes what changed and everything downstream of it.

Reach for a pipeline (instead of calling the single image tools one at a time)
when the work is a **repeatable sequence** — the user will want to run the same
recipe again with different inputs, or they described a multi-step result ("make
a die-cut product sticker", "restage this headshot in a new scene", "extend this
art into a wide banner").

## Tools

- **`list_pipelines()`** — see what's available (shipped starters and anything
  saved). Each line shows the id, the inputs it expects, and the step count. Call
  this first so you use a real id and pass the right inputs.
- **`run_pipeline(name, inputs)`** — run one end to end and get back the final
  image (plus its media id, which you can feed to the single image tools to edit
  further). `inputs` is a mapping of the pipeline's declared inputs to values:
  plain text for text inputs, and an image reference (a media id, a `/media/`
  URL, a data URL, or a path) for image inputs. Inputs with a default may be
  omitted.
- **`save_pipeline(spec)`** — validate and save a new pipeline so it can be run
  later. The spec is checked before saving; an invalid one (a cycle, an unknown
  op, a reference to nothing, or an image wired into a text port) comes back as a
  readable error, not a saved-but-broken pipeline.

## Starters that ship with the plugin

- **`product-sticker`** — generate a product shot, clean up its label with a
  region edit, then cut out the background. Inputs: `subject` (text), `style`
  (text, optional).
- **`portrait-restage`** — restage a person's photo into a new scene while
  keeping their likeness. Inputs: `photo` (image), `scene` (text, optional).
- **`outpaint-banner`** — widen an image into a banner by extending its left and
  right edges. Inputs: `art` (image), `prompt` (text, optional).

## The spec shape

```yaml
id: product-sticker
inputs:
  subject: text
  style: { type: text, default: "studio product shot" }
steps:
  - { id: gen, op: generate,          params: { prompt: "{{inputs.subject}}, {{inputs.style}}", size: 1024x1024 } }
  - { id: fix, op: region_edit, image: gen, params: { grounding: "the label", prompt: "clean white label" } }
  - { id: cut, op: remove_background, image: fix }
output: cut
```

- **`inputs`** — each is a type (`text`, `image`, `mask`, `int`, `seed`) or a
  `{ type, default }` mapping. Reference an input inside a text param with
  `{{inputs.NAME}}`.
- **`steps`** — each has an `id`, an `op` (one of generate, edit, inpaint,
  region_edit, outpaint, remove_background, compose), optional `image` / `mask` /
  `images` **ref ports** (each naming an earlier step id or a declared image
  input), and `params` (the op's scalar knobs: prompt, grounding, size, seed, …).
- **`output`** — the step id whose image is the pipeline's result (defaults to
  the last step).

## Recoverable timeouts

If a step returns a gateway timeout (HTTP 524), the ComfyUI job is still running
on the GPU, so the step is marked recoverable and the run stops there — it is
**not** an error to retry in a loop. Just run the pipeline again: the finished
steps are served from the cache, so the re-run resumes from the step that timed
out.
