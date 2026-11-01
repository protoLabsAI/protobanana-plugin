import { test, expect, type Page } from "@playwright/test";
import type { CatalogEntry, HistoryRecord, JsonSchemaProp } from "../src/api";

// Layout regression (card: "an open edit composer scrolls the stage out of view
// at 720p; the stage must shrink instead"). Caught on camera 2026-11-01: with an
// edit composer open the Playground .canvas column grew taller than its box and
// scrolled, pushing the stage — its view toolbar and the image's top — under the
// view header. The fix makes the stage the single flexible row: it shrinks to a
// floor (and the lineage strip yields before the floor) so the column NEVER
// scrolls at any viewport >= 600px tall. These tests pin that invariant for all
// four edit composers, and assert the <480px aspect-ratio stage is untouched.

// A self-contained catalog so the composer renders its inline fields exactly as
// it ships — grounding (region), margins grid (outpaint), prompt + options row —
// without spawning Python (this is a pure browser-layout test).
const prop = (type = "string"): JsonSchemaProp => ({ type });
const op = (name: string, props: string[], required: string[]): CatalogEntry => ({
  op: name, label: name, route: `/op/${name}`,
  aliases: { draft: "protolabs/qwen-image", final: "protolabs/qwen-image" },
  default_tier: "final", inputs: { images: 1, mask: name === "inpaint", person: false },
  licence: { non_commercial: false }, typical_latency_s: 8,
  params: { type: "object", properties: Object.fromEntries(props.map((p) => [p, prop()])), required },
});
const catalog: CatalogEntry[] = [
  op("generate", ["prompt", "size", "negative_prompt", "seed"], ["prompt"]),
  op("edit", ["prompt", "image"], ["image", "prompt"]),
  op("region_edit", ["prompt", "image", "grounding"], ["image", "prompt", "grounding"]),
  op("inpaint", ["prompt", "image", "mask"], ["image", "mask"]),
  op("outpaint", ["prompt", "image", "left", "top", "right", "bottom"], ["image"]),
];

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#e8bb65"/><circle cx="320" cy="240" r="120" fill="#504550"/></svg>';

// root (generate) → middle (edit) → leaf (edit): a studio lineage so the strip
// renders (the strip is the last-resort yielder when even the floor won't fit).
const records: HistoryRecord[] = ["root", "middle", "leaf"].map((id, i) => ({
  media_id: id, parent_id: i ? ["root", "middle"][i - 1] : null, op: i ? "edit" : "generate",
  alias: "protolabs/qwen-image", params: { prompt: "A ceramic vase", seed: 42, ...(i ? { image: ["root", "middle"][i - 1] } : {}) },
  source: "studio", job_id: null, created: 1, starred: false, pruned: false,
}));

async function setup(page: Page) {
  await page.addInitScript(() => {
    (window as any).pluginKit = {
      initPluginView: () => ({}),
      apiFetch: (path: string, init?: RequestInit) => fetch(`/fixture/${path}`, init),
    };
  });
  await page.route("**/_ds/**", route => route.fulfill({ body: "", contentType: "text/javascript" }));
  await page.route("**/fixture/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/catalog")) return route.fulfill({ json: { ops: catalog, source: "gateway" } });
    if (path.endsWith("/image")) return route.fulfill({ body: svg, contentType: "image/svg+xml" });
    if (path.endsWith("/history")) return route.fulfill({ json: { records, next_cursor: null } });
    if (path.endsWith("/jobs")) return route.fulfill({ status: 202, json: { job_id: "job-1" } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/?theme=light");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
}

const bar = (page: Page) => page.getByRole("toolbar", { name: "Image actions", exact: true });
const prompt = (page: Page) => page.getByLabel("Prompt", { exact: true });
// A paragraph that overflows the fixed-height prompt textarea — the "long
// instruction typed" from the bug report (its caret-scroll is what dragged the
// whole column when the column was allowed to overflow).
const LONG = "Make the gnome's hat a deep cobalt blue with gold trim, keep the ceramic glaze, soften the background bokeh, and add a faint warm rim light from the upper left while preserving every other detail of the original composition exactly as it is. ".repeat(3);

// Open each contextual composer by its action-bar verb; wait for the mode-local
// field so the measurement runs after the composer has laid out.
async function openComposer(page: Page, mode: "edit" | "region" | "inpaint" | "outpaint") {
  await bar(page).getByRole("button", { name: mode === "edit" ? "Edit" : mode[0].toUpperCase() + mode.slice(1), exact: true }).click();
  if (mode === "region") await page.getByLabel("What to change?", { exact: true }).fill("the gnome's hat");
  if (mode === "inpaint") {
    const canvas = page.getByLabel("Mask canvas", { exact: true }).locator("canvas").first();
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
  }
  if (mode === "outpaint") {
    await expect(page.getByRole("group", { name: "Outpaint margins", exact: true })).toBeVisible();
    await page.getByLabel("Bottom", { exact: true }).fill("128");
  }
  await prompt(page).fill(LONG);
}

// Everything the assertions need, read in one pass against the live layout.
async function geometry(page: Page) {
  return page.evaluate(() => {
    const q = (s: string) => document.querySelector(s) as HTMLElement | null;
    const r = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
    const canvas = q(".canvas")!;
    const stage = q(".stage")!;
    const header = r(q(".images-header"))!;
    const toolbar = r(q(".view-toolbar"));
    const vp = r(q(".stage-viewport"));
    const sr = stage.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    return {
      scrollH: canvas.scrollHeight, clientH: canvas.clientHeight,
      canvasBottom: cr.bottom,
      stageTop: sr.top, stageBottom: sr.bottom, stageH: sr.height,
      headerBottom: header.bottom,
      toolbar: toolbar && { top: toolbar.top, bottom: toolbar.bottom },
      viewport: vp && { top: vp.top, bottom: vp.bottom },
    };
  });
}

// Core guarantee, exercised at the filmed 1280x720 and at the tightest viewport
// the card promises to hold (600px tall). Edit, Region, Inpaint, Outpaint.
for (const height of [720, 600]) {
  for (const mode of ["region", "edit", "inpaint", "outpaint"] as const) {
    test(`1280x${height}: ${mode} composer open — the canvas column does not scroll and the stage stays below the header`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height });
      await setup(page);
      await page.locator(".g-tile").nth(0).getByRole("option", { name: /render/ }).click();
      await expect(bar(page)).toBeVisible();
      await openComposer(page, mode);
      // The composer is on screen and the form is the expected one.
      await expect(page.getByRole("form", { name: "Composer", exact: true })).toBeVisible();

      const g = await geometry(page);

      // 1. The Playground column does not scroll (acceptance r1, criterion 1).
      expect(g.scrollH).toBeLessThanOrEqual(g.clientH + 1);
      // 2. The stage top stays at or below the view header's bottom (criterion 2).
      expect(g.stageTop).toBeGreaterThanOrEqual(g.headerBottom - 1);
      // 3. The stage absorbed the squeeze down to its floor, not past it: it is
      //    still a usable viewport (>= ~140px) and fully inside the column.
      expect(g.stageH).toBeGreaterThanOrEqual(139);
      expect(g.stageBottom).toBeLessThanOrEqual(g.canvasBottom + 1);
      // 4. The floating view toolbar is fully visible inside the column.
      expect(g.toolbar).not.toBeNull();
      expect(g.toolbar!.top).toBeGreaterThanOrEqual(g.headerBottom - 1);
      expect(g.toolbar!.bottom).toBeLessThanOrEqual(g.canvasBottom + 1);
      // 5. The image viewport is fitted within the (shrunk) stage, top and bottom.
      expect(g.viewport).not.toBeNull();
      expect(g.viewport!.top).toBeGreaterThanOrEqual(g.stageTop - 1);
      expect(g.viewport!.bottom).toBeLessThanOrEqual(g.stageBottom + 1);
    });
  }
}

// The <480px container layout is unchanged (acceptance: criterion 4). There the
// stage is a fixed 1:1 aspect box (flex: none) driven purely by container width,
// NOT the flexible shrink-to-floor row — so the shrink fix must not leak into it.
// The rule applies to the stage element whether or not an image is selected.
test("below 480px the stage keeps its 1:1 aspect-ratio box (shrink-to-floor does not leak in)", async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 800 });
  await setup(page);
  const stage = page.locator(".stage");
  await expect(stage).toBeVisible();
  const style = await stage.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { aspect: cs.aspectRatio.replace(/\s/g, ""), grow: cs.flexGrow, minH: cs.minHeight };
  });
  // The <480 rule: aspect-ratio 1/1, flex: none (grow 0), min-height 0 — not the
  // >=480 shrink row (flex-grow 1, min-height 140px).
  expect(style.aspect).toBe("1/1");
  expect(style.grow).toBe("0");
  expect(style.minH).toBe("0px");
  // A square stage: width ≈ height (the aspect-ratio box, not a 140px floor row).
  const b = (await stage.boundingBox())!;
  expect(Math.abs(b.width - b.height)).toBeLessThanOrEqual(2);
});
