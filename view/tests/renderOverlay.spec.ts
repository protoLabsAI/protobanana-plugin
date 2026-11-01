import { test, expect, type Page } from "@playwright/test";
import type { CatalogEntry, HistoryRecord, JsonSchemaProp } from "../src/api";

// Render-overlay form regression (card bd-i6yr). Filmed in the brandLaunch clip 2
// final (2026-11-01, 1280x720): with a Region edit composer open the stage is at
// its shrunk height (~163px, bd-lltr/#45) and the centred RenderOverlay card
// covered almost the whole stage for the full ~45s render, leaving only a sliver
// of the image. The fix: when the stage viewport is short (<260px) the overlay
// becomes a COMPACT strip pinned to the stage's bottom edge (<=~40px), so the
// dimmed image stays visible above it. Above the threshold it stays today's card.
// These tests pin the strip geometry (bounding boxes), the card form on a tall
// stage, the honest text + working Stop, the determinate→indeterminate Progress,
// and that the zoom toolbar never overlaps the strip.

// A self-contained catalog so the composer renders its inline fields as it ships
// without spawning Python (a pure browser-layout test). typical_latency_s is 1 so
// the Progress crosses into its indeterminate (past-typical) phase within a second
// or two instead of the real ~25s.
const prop = (type = "string"): JsonSchemaProp => ({ type });
const op = (name: string, props: string[], required: string[]): CatalogEntry => ({
  op: name, label: name, route: `/op/${name}`,
  aliases: { draft: "protolabs/qwen-image", final: "protolabs/qwen-image" },
  default_tier: "final", inputs: { images: 1, mask: name === "inpaint", person: false },
  licence: { non_commercial: false }, typical_latency_s: 1,
  params: { type: "object", properties: Object.fromEntries(props.map((p) => [p, prop()])), required },
});
const catalog: CatalogEntry[] = [
  op("generate", ["prompt", "size", "negative_prompt", "seed"], ["prompt"]),
  op("edit", ["prompt", "image"], ["image", "prompt"]),
  op("region_edit", ["prompt", "image", "grounding"], ["image", "prompt", "grounding"]),
];

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#e8bb65"/><circle cx="320" cy="240" r="120" fill="#504550"/></svg>';

const records: HistoryRecord[] = ["root", "middle", "leaf"].map((id, i) => ({
  media_id: id, parent_id: i ? ["root", "middle"][i - 1] : null, op: i ? "edit" : "generate",
  alias: "protolabs/qwen-image", params: { prompt: "A ceramic vase", seed: 42, ...(i ? { image: ["root", "middle"][i - 1] } : {}) },
  source: "studio", job_id: null, created: 1, starred: false, pruned: false,
}));

// The in-flight render never settles: GET /jobs/{id} stays "running" and no bus
// done event is posted, so the overlay persists for the whole test.
async function setup(page: Page) {
  const requests: Record<string, unknown>[] = [];
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
    if (path.endsWith("/jobs")) { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { job_id: `job-${requests.length}` } }); }
    if (path.includes("/jobs/")) return route.fulfill({ json: { job_id: path.split("/").pop(), status: "running", queue_position: 0 } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/?theme=light");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  return requests;
}

const bar = (page: Page) => page.getByRole("toolbar", { name: "Image actions", exact: true });
const prompt = (page: Page) => page.getByLabel("Prompt", { exact: true });
const pickImage = (page: Page) => page.locator(".g-tile").nth(0).getByRole("option", { name: /render/ }).click();

// Rects for the pieces the assertions compare, in one live read.
async function geometry(page: Page) {
  return page.evaluate(() => {
    const r = (el: Element | null) => (el ? (({ top, bottom, left, right, height, width }) =>
      ({ top, bottom, left, right, height, width }))(el.getBoundingClientRect()) : null);
    return {
      viewport: r(document.querySelector(".stage-viewport")),
      strip: r(document.querySelector(".render-strip")),
      card: r(document.querySelector(".render-overlay")),
      toolbar: r(document.querySelector(".view-toolbar")),
    };
  });
}

test("1280x720: Region open, render in flight — a compact strip pins to the stage bottom and leaves the image visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const requests = await setup(page);

  await pickImage(page);
  await bar(page).getByRole("button", { name: "Region", exact: true }).click();
  await page.getByLabel("What to change?", { exact: true }).fill("the gnome's hat");
  await prompt(page).fill("make it cobalt blue");
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].op).toBe("region_edit");

  // The compact strip is up (NOT the centred card) and the dimmed image shows.
  const strip = page.locator(".render-strip");
  await expect(strip).toBeVisible();
  await expect(page.locator(".render-overlay")).toHaveCount(0);
  await expect(page.locator(".stage-img.is-dimmed")).toBeVisible();
  await expect(page.locator(".view-toolbar")).toBeVisible();

  const g = await geometry(page);
  expect(g.viewport).not.toBeNull();
  expect(g.strip).not.toBeNull();
  expect(g.toolbar).not.toBeNull();

  // The stage really is short (the trigger for the compact form).
  expect(g.viewport!.height).toBeLessThan(260);
  // The strip is at most about 40px tall.
  expect(g.strip!.height).toBeLessThanOrEqual(42);
  // It is pinned to the bottom edge of the stage viewport.
  expect(Math.abs(g.strip!.bottom - g.viewport!.bottom)).toBeLessThanOrEqual(2);
  // At least 75% of the stage viewport height shows the (dimmed) image above it.
  const imageVisible = g.strip!.top - g.viewport!.top;
  expect(imageVisible / g.viewport!.height).toBeGreaterThanOrEqual(0.75);
  // The zoom toolbar (top of the stage) never overlaps the strip (bottom).
  expect(g.toolbar!.bottom).toBeLessThanOrEqual(g.strip!.top + 1);
});

test("tall stage: render in flight shows the same centred card as today (above the 260px threshold)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const requests = await setup(page);

  // No edit composer is opened, so the stage keeps its full height.
  await pickImage(page);
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();
  await prompt(page).fill("make it cobalt blue");
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);

  const card = page.locator(".render-overlay");
  await expect(card).toBeVisible();
  await expect(page.locator(".render-strip")).toHaveCount(0);

  const g = await geometry(page);
  expect(g.viewport!.height).toBeGreaterThanOrEqual(260);
  // The card is the bottom-centred box, not a full-bleed bottom strip.
  expect(g.card!.width).toBeLessThan(g.viewport!.width);
});

test("the strip shows the honest elapsed/typical text, a working Stop, an indeterminate Progress past typical, and the cold note as a title (not a row)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const requests = await setup(page);

  await pickImage(page);
  await bar(page).getByRole("button", { name: "Region", exact: true }).click();
  await page.getByLabel("What to change?", { exact: true }).fill("the gnome's hat");
  await prompt(page).fill("make it cobalt blue");
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);

  const strip = page.locator(".render-strip");
  await expect(strip).toBeVisible();

  // Same honest text as the card.
  await expect(strip.getByText(/Rendering · \d+s · usually ~1s/)).toBeVisible();

  // The Progress is present and turns indeterminate once elapsed passes typical
  // (1s here) — the same determinate→indeterminate behaviour as the card.
  const progress = strip.getByRole("progressbar", { name: "Render progress" });
  await expect(progress).toBeVisible();
  await expect(progress).toHaveClass(/pbx-progress--indet/, { timeout: 6000 });

  // The cold-load note is a title on the text (past 1.5× typical), NOT a second
  // row, so the strip stays one line tall.
  await expect(strip.locator(".render-overlay-cold")).toHaveCount(0);
  await expect.poll(async () => strip.locator(".render-overlay-text").getAttribute("title"))
    .toContain("Model is loading");

  // Stop works: it tears down the in-flight render, so the strip disappears.
  await strip.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(strip).toHaveCount(0);
});
