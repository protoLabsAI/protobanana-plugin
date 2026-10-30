"""Host-free tests for the 0.4.0 fixes: transparent inputs, honest sizes,
readable captions, and halo-free cutouts. The gateway is stubbed with fakes
that reproduce what the real ComfyUI workflows do to pixels (drop alpha,
rescale to their own grid, keep a pale rim solid in the matte)."""

import asyncio
import base64
import io
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw  # Pillow ships with protoAgent core

sys.path.insert(0, str(Path(__file__).parent))
from _plugin_testkit import FakeRegistry, install_host_stubs, load_plugin

install_host_stubs()
PLUGIN_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def plugin(monkeypatch):
    mod = load_plugin(PLUGIN_ROOT, "protobanana")
    reg = FakeRegistry({"show_model": False}, plugin_id="protobanana")
    mod.register(reg)
    return mod, reg


def run(coro):
    return asyncio.run(coro)


def png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def open_png(raw: bytes):
    img = Image.open(io.BytesIO(raw))
    img.load()
    return img


def data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode()


def cutout(size=(64, 48)) -> bytes:
    """A remove_background-style cutout: opaque red square, and fully
    transparent elsewhere with BLACK under the alpha (what BiRefNet writes)."""
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(img).rectangle((16, 12, 47, 35), fill=(200, 30, 30, 255))
    return png(img)


def comfy_rgb(raw: bytes) -> "Image.Image":
    """What ComfyUI's LoadImage hands the workflow: RGB, alpha dropped."""
    return open_png(raw).convert("RGB")  # RGBA→RGB keeps the colour under the alpha


# ------------------------------------------------------------- defect 1: RGBA


def test_prepare_flattens_transparency_onto_white(plugin):
    mod, _ = plugin
    prep = mod.imaging.prepare(cutout())
    assert prep.had_alpha and prep.size == (64, 48)
    sent = open_png(prep.data)
    assert sent.mode == "RGB"
    assert sent.getpixel((0, 0)) == (255, 255, 255)  # was black-under-alpha
    assert sent.getpixel((30, 20)) == (200, 30, 30)  # subject untouched


def test_prepare_passes_opaque_images_through_byte_for_byte(plugin):
    mod, _ = plugin
    raw = png(Image.new("RGB", (8, 8), (10, 20, 30)))
    assert mod.imaging.prepare(raw).data == raw
    solid_rgba = png(Image.new("RGBA", (8, 8), (10, 20, 30, 255)))
    prep = mod.imaging.prepare(solid_rgba)
    assert prep.data == solid_rgba and not prep.had_alpha


def _fake_rgb_editor(seen, out_size=None):
    """Mimic the Qwen edit workflows: alpha dropped, output rescaled."""

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        seen["image"] = image
        img = comfy_rgb(image)
        # a real edit changes something: paint a small block at 25% in
        w, h = img.size
        ImageDraw.Draw(img).rectangle((w // 4, h // 4, w // 4 + w // 10, h // 4 + h // 10), fill=(0, 200, 0))
        if out_size:
            img = img.resize(out_size)
        return png(img)

    return fake_edit


def test_edit_image_on_cutout_sends_white_and_restores_alpha(plugin, monkeypatch):
    mod, reg = plugin
    seen = {}
    monkeypatch.setattr(mod.client, "edit", _fake_rgb_editor(seen))
    out = run(
        mod.tools.edit_image.ainvoke(
            {"image_ref": data_url(cutout()), "prompt": "make it blue"}
        )
    )
    assert not out.startswith("Error:"), out
    sent = open_png(seen["image"])
    assert sent.mode == "RGB" and sent.getpixel((0, 0)) == (255, 255, 255)
    result = open_png(reg.saved_media[-1][0])
    assert result.mode == "RGBA"
    assert result.getpixel((0, 0))[3] == 0  # transparent stays transparent
    assert result.getpixel((30, 20))[3] == 255  # subject stays opaque
    assert "transparency re-applied" in out


def test_edit_image_keep_transparency_false_keeps_the_filled_backdrop(
    plugin, monkeypatch
):
    mod, reg = plugin
    monkeypatch.setattr(mod.client, "edit", _fake_rgb_editor({}))
    run(
        mod.tools.edit_image.ainvoke(
            {
                "image_ref": data_url(cutout()),
                "prompt": "add a beach",
                "keep_transparency": False,
            }
        )
    )
    result = open_png(reg.saved_media[-1][0])
    assert result.mode == "RGB"
    assert result.getpixel((0, 0)) == (255, 255, 255)  # white, never black


def test_region_edit_on_cutout_never_returns_black(plugin, monkeypatch):
    mod, reg = plugin
    seen = {}
    monkeypatch.setattr(mod.client, "edit", _fake_rgb_editor(seen))
    run(
        mod.tools.region_edit.ainvoke(
            {
                "image_ref": data_url(cutout()),
                "region": "the panel",
                "prompt": "plain white background",
            }
        )
    )
    assert open_png(seen["image"]).getpixel((0, 0)) == (255, 255, 255)
    result = open_png(reg.saved_media[-1][0])
    assert result.getpixel((0, 0))[3] == 0


def test_outpaint_flattens_but_does_not_restore(plugin, monkeypatch):
    mod, reg = plugin
    seen = {}
    monkeypatch.setattr(mod.client, "edit", _fake_rgb_editor(seen))
    run(
        mod.tools.outpaint_image.ainvoke({"image_ref": data_url(cutout()), "right": 64})
    )
    assert open_png(seen["image"]).getpixel((0, 0)) == (255, 255, 255)


def test_compose_flattens_each_reference(plugin, monkeypatch):
    mod, _ = plugin
    seen = []

    async def fake_compose(model, prompt, images):
        seen.extend(images)
        return png(Image.new("RGB", (8, 8)))

    monkeypatch.setattr(mod.client, "chat_compose", fake_compose)
    run(
        mod.tools.compose_images.ainvoke(
            {"image_refs": [data_url(cutout())] * 2, "prompt": "both"}
        )
    )
    assert all(open_png(b).getpixel((0, 0)) == (255, 255, 255) for b in seen)


# ------------------------------------------------------------ defect 2: size


def test_snap_size(plugin):
    mod, _ = plugin
    snap = mod.tools._snap_size
    assert snap("1024x1024") == (1024, 1024)
    assert snap(" 1000 X 700 ") == (1008, 704)
    assert snap("100x9000") == (256, 2048)
    with pytest.raises(ValueError):
        snap("big")


def test_generate_sends_width_height_and_reports_a_mismatch(plugin, monkeypatch):
    mod, _ = plugin
    seen = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            raw = png(
                Image.new("RGB", (1216, 832))
            )  # what the gateway did before the fix
            return {"data": [{"b64_json": base64.b64encode(raw).decode()}]}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, path, json=None, **kw):
            seen.update(json)
            return FakeResp()

    monkeypatch.setattr(mod.client, "_client", FakeClient)
    out = run(
        mod.tools.generate_image.ainvoke(
            {"prompt": "a wide-eyed owl", "size": "1024x1024"}
        )
    )
    assert seen["size"] == "1024x1024"
    assert (seen["width"], seen["height"]) == (
        1024,
        1024,
    )  # survives LiteLLM's param filter
    assert "1216x832 image" in out
    assert "requested 1024x1024 but the gateway returned 1216x832" in out


def test_generate_matching_size_has_no_note(plugin, monkeypatch):
    mod, _ = plugin

    async def fake_generate(model, prompt, size, **kw):
        w, h = (int(v) for v in size.split("x"))
        return png(Image.new("RGB", (w, h)))

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    out = run(mod.tools.generate_image.ainvoke({"prompt": "owl", "size": "768x1344"}))
    assert "768x1344 image" in out and "Note:" not in out


def test_edit_result_is_scaled_back_to_the_input_size(plugin, monkeypatch):
    mod, reg = plugin
    src = png(Image.new("RGB", (1216, 832), (40, 90, 160)))
    # qwen_image_edit_2_1 rescales to its own ~1MP grid: 1216x832 → 1248x832
    monkeypatch.setattr(mod.client, "edit", _fake_rgb_editor({}, out_size=(1248, 832)))
    out = run(
        mod.tools.edit_image.ainvoke({"image_ref": data_url(src), "prompt": "night"})
    )
    assert open_png(reg.saved_media[-1][0]).size == (1216, 832)
    assert "1216x832 image" in out and "Note:" not in out


def test_edit_with_a_genuinely_new_shape_is_not_distorted(plugin, monkeypatch):
    mod, reg = plugin
    src = png(Image.new("RGB", (1216, 832)))
    monkeypatch.setattr(mod.client, "edit", _fake_rgb_editor({}, out_size=(1024, 1024)))
    out = run(
        mod.tools.edit_image.ainvoke(
            {"image_ref": data_url(src), "prompt": "square it"}
        )
    )
    assert open_png(reg.saved_media[-1][0]).size == (1024, 1024)
    assert "the input was 1216x832 but the gateway returned 1024x1024" in out


# --------------------------------------------------------- defect 3: captions


@pytest.mark.parametrize(
    "prompt, expected",
    [
        ("a red fox", "a red fox"),
        (
            (
                "A small garden gnome with a pointy red hat and fluffy white beard sitting in the "
                "crowd stands at an NBA basketball game, frantically stuffing a giant cotton candy"
            ),
            "A small garden gnome with a pointy red hat and fluffy white beard sitting…",
        ),
        (
            "Vintage art-deco jazz poster, portrait orientation. Deep midnight blue background",
            "Vintage art-deco jazz poster, portrait orientation",
        ),
        ("Logo [draft] for a café", "Logo (draft) for a café"),
    ],
)
def test_caption_is_short_and_ends_on_a_word(plugin, prompt, expected):
    mod, _ = plugin
    cap = mod.tools._caption(prompt)
    assert cap == expected
    assert len(cap) <= mod.tools._CAPTION_MAX


def test_caption_never_ends_mid_word_or_on_a_dangling_word(plugin):
    mod, _ = plugin
    for n in range(40, 200, 7):
        text = ("the quick brown fox jumps over the lazy dog in the park " * 5)[:n]
        cap = mod.tools._caption(text)
        assert len(cap) <= mod.tools._CAPTION_MAX
        if cap.endswith("…"):
            last = cap[:-1].split()[-1]
            assert last in text.split()  # a whole word, not a fragment
            assert last.lower() not in mod.tools._DANGLING


def test_caption_prefix_counts_toward_the_limit(plugin):
    mod, _ = plugin
    cap = mod.tools._caption(
        "turn the whole sky into a swirling starry night like a famous "
        "post-impressionist painting",
        "Edit: ",
    )
    assert cap.startswith("Edit: turn the whole sky") and cap.endswith("…")
    assert len(cap) <= mod.tools._CAPTION_MAX


def test_tool_markdown_uses_the_clean_caption(plugin, monkeypatch):
    mod, _ = plugin

    async def fake_generate(model, prompt, size, **kw):
        return png(Image.new("RGB", (1024, 1024)))

    monkeypatch.setattr(mod.client, "generate", fake_generate)
    long = (
        "Cute cartoon illustration of a chubby little garden gnome with a big floppy red hat "
        "and fluffy white beard, sitting in the stands at a basketball game"
    )
    out = run(mod.tools.generate_image.ainvoke({"prompt": long}))
    assert (
        "![Cute cartoon illustration of a chubby little garden gnome with a big floppy red…]("
        in out
    )


# ------------------------------------------------------------ defect 4: halo


def _halo_scene():
    """A blue disc photographed on white with a 3px pale rim (subject mixed with
    the white backdrop), and the matte a BiRefNet-style model returns: the rim
    counted as SOLID, colours premultiplied at the soft edge."""
    size = (96, 96)
    src = Image.new("RGB", size, (252, 252, 252))
    d = ImageDraw.Draw(src)
    d.ellipse((18, 18, 77, 77), fill=(180, 225, 245))  # pale rim (blue + white mix)
    d.ellipse((21, 21, 74, 74), fill=(60, 170, 220))  # true subject colour
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse((18, 18, 77, 77), fill=255)
    cut = src.copy()
    cut.putalpha(mask)
    return png(src), png(cut)


def test_remove_background_strips_the_pale_rim(plugin, monkeypatch):
    mod, reg = plugin
    src, cut = _halo_scene()
    monkeypatch.setattr(mod.client, "edit", lambda *a, **k: _async(cut))
    out = run(mod.tools.remove_background.ainvoke({"image_ref": data_url(src)}))
    assert "![Cutout, background removed](" in out
    before, after = open_png(cut), open_png(reg.saved_media[-1][0])
    rim, centre = (19, 48), (48, 48)
    assert after.getpixel(rim)[3] < 200  # rim no longer solid
    assert after.getpixel(centre) == before.getpixel(centre)  # interior untouched
    assert after.getpixel((2, 2))[3] == 0
    a0, a1 = before.getchannel("A"), after.getchannel("A")
    assert all(
        x1 <= x0 for x0, x1 in zip(a0.tobytes(), a1.tobytes())
    )  # alpha never grows


def test_defringe_leaves_a_white_subject_on_white_alone(plugin):
    mod, _ = plugin
    size = (96, 96)
    src = Image.new("RGB", size, (252, 252, 252))
    ImageDraw.Draw(src).ellipse(
        (18, 18, 77, 77), fill=(245, 245, 245)
    )  # white beard on white
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse((18, 18, 77, 77), fill=255)
    cut = src.copy()
    cut.putalpha(mask)
    out = open_png(mod.imaging.defringe(png(cut), png(src)))
    assert out.getchannel("A").tobytes() == mask.tobytes()


def test_imaging_is_a_no_op_without_pillow(plugin, monkeypatch):
    mod, _ = plugin
    monkeypatch.setattr(mod.imaging, "_pil", lambda: None)
    raw = cutout()
    assert mod.imaging.prepare(raw).data == raw
    assert mod.imaging.defringe(raw, raw) == raw
    assert mod.imaging.finish_edit(raw, mod.imaging.Prepared(raw, (64, 48))) == raw


async def _async(value):
    return value


# ------------------------------------------------- 0.4.1: QA run follow-ups


def test_region_edit_that_changes_nothing_is_an_error(plugin, monkeypatch):
    """SAM matched nothing → empty mask → the composite returns the input."""
    mod, reg = plugin
    src = png(Image.new("RGB", (64, 48), (10, 120, 200)))

    async def noop_edit(model, prompt, image, *, fields=None, mask=None):
        return png(comfy_rgb(image))  # re-encoded, but pixel-identical

    monkeypatch.setattr(mod.client, "edit", noop_edit)
    out = run(mod.tools.region_edit.ainvoke({"image_ref": data_url(src), "region": "the unicorn",
                                             "prompt": "make it gold"}))
    assert out.startswith("Error: region_edit changed nothing")
    assert "'the unicorn'" in out and "edit_image" in out
    assert reg.saved_media == []  # nothing saved, nothing reported as Done


def test_edit_image_that_changes_nothing_is_an_error(plugin, monkeypatch):
    mod, reg = plugin
    src = png(Image.new("RGB", (64, 48), (10, 120, 200)))

    async def noop_edit(model, prompt, image, *, fields=None, mask=None):
        return image  # byte-identical

    monkeypatch.setattr(mod.client, "edit", noop_edit)
    out = run(mod.tools.edit_image.ainvoke({"image_ref": data_url(src), "prompt": "x"}))
    assert out.startswith("Error: edit_image returned the image unchanged")
    assert reg.saved_media == []


def test_unchanged_tolerates_round_trip_noise_but_sees_small_edits(plugin):
    mod, _ = plugin
    base = Image.new("RGB", (400, 300), (100, 100, 100))
    noisy = base.copy()
    noisy.putpixel((5, 5), (104, 97, 103))  # ±4 levels: codec/resample noise
    assert mod.imaging.unchanged(png(base), png(noisy))
    edited = base.copy()
    ImageDraw.Draw(edited).rectangle((10, 10, 29, 29), fill=(250, 0, 0))  # 400 px of 120k
    assert not mod.imaging.unchanged(png(base), png(edited))
    # a result at another size is compared at the input's size
    assert mod.imaging.unchanged(png(base), png(base.resize((420, 315))))


def test_compose_docstring_states_no_aspect_control(plugin):
    mod, _ = plugin
    assert "NO size or aspect-ratio control" in mod.tools.compose_images.description


def test_outpaint_caption_is_short(plugin, monkeypatch):
    mod, _ = plugin

    async def fake_edit(model, prompt, image, *, fields=None, mask=None):
        return png(Image.new("RGB", (96, 48)))

    monkeypatch.setattr(mod.client, "edit", fake_edit)
    fill = ("continue the solid flat deep midnight blue background, empty, no text, no objects, "
            "seamless with the existing gradient and lighting on the right side")
    out = run(mod.tools.outpaint_image.ainvoke({"image_ref": data_url(cutout()), "prompt": fill,
                                                "right": 32}))
    assert "![Extended: continue the solid flat deep midnight blue background](" in out


def test_size_clamp_covers_extreme_requests(plugin):
    """QA asked for 10000x50 — clamped to the renderable range, not passed on."""
    mod, _ = plugin
    assert mod.tools._snap_size("10000x50") == (2048, 256)
