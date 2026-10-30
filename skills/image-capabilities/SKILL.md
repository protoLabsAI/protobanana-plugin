---
name: image-capabilities
description: When the user asks what you can do with images — generate, edit, retouch, combine, extend, cut out, inpaint — or asks about limits, speed, sizes, masks, text in images, keeping a face, or why something isn't possible. Use it to answer accurately and to pick the right image tool.
---

# Image capabilities (protoBanana)

You make and edit images with seven tools. Everything runs on self-hosted
models through the protoBanana gateway: **Qwen-Image-2.1** (and its 8-step
**Turbo** tier) for generating and editing, **SAM 3** to find a region from
words, and **BiRefNet** for background removal. Every result is saved to the
media store and shown inline, and you can see it to check your work.

| The user wants… | Tool | Typical time |
|---|---|---|
| A new image from a description | `generate_image` | ~30s, `draft=true` ~10s |
| A whole-image change ("make it night", "watercolor", restage a person) | `edit_image` | ~38s, `draft=true` ~10s |
| One named thing changed, rest untouched ("make **his shirt** red") | `region_edit` | ~45s |
| An exact area repainted, given a mask | `inpaint_image` | ~40s |
| A bigger canvas / different shape | `outpaint_image` | ~40s |
| A sticker / cutout on transparency | `remove_background` | ~3s |
| Several images combined into one (2–10 refs) | `compose_images` | ~45s |

The first request after the GPU has been idle or switched tasks can take
~30s longer while models load.

## What to tell users

- **Text in images works.** Posters, signs, logos, title cards: put the exact
  words in double quotes in the prompt.
- **Faces and likeness hold.** `edit_image` keeps a person's identity when
  restyling or restaging them. To put a person from one photo into another
  photo's scene, use `compose_images` with both and name them by position:
  "the woman from <image1> sitting at the café in <image2>".
- **Drafts.** Offer `draft=true` while the user is exploring; re-run the
  chosen one without it for the final.
- **Sizes.** `generate_image` takes 256–2048 px per side (snapped to multiples
  of 16). Edits keep the input's size. `compose_images` has no size or aspect
  control; outpaint the result to change its shape.
- **Seeds.** Pass the same seed to reproduce a result, or a new seed when an
  edit comes back garbled.

## Masks (inpaint)

You can't draw a mask. Choose by what the user can tell you:
- They can **name** the area ("the sky", "the logo on the mug") → `region_edit`.
- They have a **mask image** (attached, or from an earlier result) →
  `inpaint_image`. It must be the same size as the image: transparent = edit,
  or black-and-white with white = edit.
- They want a **freehand** area → send them to the **Studio** (the Studio
  icon in the console's left rail), where the Inpaint operation has a mask painter.

## Studio

The Studio is the console view for hands-on image work: a playground for
every operation, a mask painter, and a shared gallery of everything you and
the user have made, where any result can be re-run or tweaked. Each image you
make carries a chip that opens it there. Suggest it when the user wants to
compare variations, paint a mask, or browse past results.

## Not available

- **Video or animation** — images only.
- **A separate "identity" or "typography" tool** — retired; `edit_image`,
  `compose_images` and quoted text in `generate_image` cover both.
- **More than 10 reference images** in one compose.
- **Training or custom styles (LoRAs)** — describe the style in the prompt
  instead, or compose with a reference image of it.
