import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import type { CatalogEntry, HistoryRecord } from "../src/api";

// Read the real catalog: the browser fixture must evolve with the Python schema.
// PYTHON can select an isolated environment with requirements-dev.txt installed.
const catalog: CatalogEntry[] = JSON.parse(execFileSync(process.env.PYTHON || "python3", ["-c", `
import importlib, json, sys
from pathlib import Path
sys.path.insert(0, str(Path('../tests').resolve()))
from _plugin_testkit import load_plugin
p = load_plugin(Path('..').resolve(), 'protobanana')
c = importlib.import_module(p.__name__ + '.catalog_static')
print(json.dumps(c.build_catalog({})))
`], { encoding: "utf8" }));

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#e8bb65"/><circle cx="320" cy="240" r="120" fill="#504550"/></svg>';


const agent: HistoryRecord = {
  media_id: "agent-image", parent_id: null, op: "generate", alias: "protolabs/qwen-image",
  params: { prompt: "gnome" }, source: "agent", job_id: null, created: 1, starred: false, pruned: false,
};

async function setup(page: Page) {
  let rendered = false;
  let reads = 0;
  await page.addInitScript(() => {
    (window as any).pluginKit = {
      initPluginView: () => ({}),
      apiFetch: (path: string, init?: RequestInit) => fetch(`/fixture/${path}`, init),
    };
  });
  await page.route("**/_ds/**", route => route.fulfill({ body: "", contentType: "text/javascript" }));
  await page.route("**/fixture/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/catalog")) return route.fulfill({ json: { ops: catalog, source: "gateway" } });
    if (path.endsWith("/history")) {
      reads++;
      return route.fulfill({ json: { records: rendered ? [agent] : [], next_cursor: null } });
    }
    if (path.endsWith("/jobs")) return route.fulfill({ status: 202, json: { job_id: "view-job" } });
    if (path.includes("/jobs/")) return route.fulfill({ json: { job_id: "view-job", status: "running" } });
    return route.fulfill({ body: svg, contentType: "image/svg+xml" });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  return async () => {
    rendered = true;
    const before = reads;
    await page.evaluate(data => window.postMessage({ type: "protoagent:event", topic: "protobanana.agent.render", data }, "*"),
      { ...agent, url: "/api/plugins/protobanana/history/agent-image/image" });
    await expect.poll(() => reads).toBeGreaterThan(before + 1);
  };
}

test("idle agent render lands as current and refreshes History with its agent badge", async ({ page }) => {
  const emit = await setup(page);
  await emit();
  await expect(page.getByAltText("Current image")).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'History images' }).getByRole('option', { selected: true })).toHaveCount(1);
  await expect(page.locator(".g-tile").getByText("agent", { exact: false })).toBeVisible();
  await expect(page.getByText("Agent render added to History")).toHaveCount(0);
});

for (const busy of ["typed composer", "view job"] as const) {
  test(`${busy}: refresh History without landing, then Show lands the agent render`, async ({ page }) => {
    const emit = await setup(page);
    const prompt = page.getByLabel("Prompt", { exact: true });
    await prompt.fill("my unfinished edit");
    if (busy === "view job") {
      await page.getByRole("button", { name: "Generate", exact: true }).click();
      await prompt.fill("");
    }
    await emit();
    await expect(page.getByAltText("Current image")).toHaveCount(0);
    await expect(page.locator(".g-tile")).toHaveCount(1);
    await expect(page.getByText("Agent render added to History")).toBeVisible();
    if (busy === "typed composer") await expect(prompt).toHaveValue("my unfinished edit");
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(page.getByAltText("Current image")).toBeVisible();
    await expect(page.getByRole('listbox', { name: 'History images' }).getByRole('option', { selected: true })).toHaveCount(1);
    await expect(page.getByText("Agent render added to History")).toHaveCount(0);
  });
}

test("unsaved mask defers an agent render even with an empty composer", async ({ page }) => {
  const emit = await setup(page);
  await emit();
  await page.getByRole("button", { name: "Inpaint", exact: true }).click();
  const canvas = page.getByLabel("Mask canvas", { exact: true }).locator("canvas").first();
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await emit();
  await expect(page.getByText("Agent render added to History")).toBeVisible();
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByLabel("Mask canvas", { exact: true })).toHaveCount(0);
  await expect(page.getByAltText("Current image")).toBeVisible();
});

test("an unsaved upload defers an agent render and is not clobbered", async ({ page }) => {
  const emit = await setup(page);
  // A dropped/pasted/uploaded image lives only in the browser (a data: URL) with
  // NO History record, so an incoming agent render must not silently replace it.
  await page.setInputFiles('input[type="file"]', {
    name: "upload.png", mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64"),
  });
  const current = page.getByAltText("Current image");
  await expect(current).toHaveAttribute("src", /^data:/); // the upload is current
  await emit();
  await expect(page.getByText("Agent render added to History")).toBeVisible();
  await expect(current).toHaveAttribute("src", /^data:/); // still the upload, not the render
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByAltText("Current image")).not.toHaveAttribute("src", /^data:/);
  await expect(page.getByText("Agent render added to History")).toHaveCount(0);
});

test("typed outpaint margins also protect the composer", async ({ page }) => {
  const emit = await setup(page);
  await emit();
  await page.getByRole("button", { name: "Outpaint", exact: true }).click();
  await page.getByLabel("Left", { exact: true }).fill("64");
  await emit();
  await expect(page.getByText("Agent render added to History")).toBeVisible();
  await expect(page.getByLabel("Left", { exact: true })).toHaveValue("64");
});
