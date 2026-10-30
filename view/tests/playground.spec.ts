import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { CatalogEntry, HistoryRecord, JobRequest } from "../src/api";

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
const records: HistoryRecord[] = ["root", "middle", "leaf"].map((id, i) => ({
  media_id: id, parent_id: i ? ["root", "middle"][i - 1] : null, op: i ? "edit" : "generate",
  alias: "protolabs/qwen-image", params: { prompt: "A ceramic vase", seed: 42, ...(i ? { image: ["root", "middle"][i - 1] } : {}) },
  source: "studio", job_id: null, created: 1, starred: false, pruned: false,
}));
async function setup(page: Page, theme = "light", mode = "pending") {
  const requests: JobRequest[] = [];
  await page.addInitScript(() => {
    (window as any).pluginKit = {
      initPluginView: () => ({}),
      apiFetch: (path: string, init?: RequestInit) => fetch(`/fixture/${path}`, init),
    };
  });
  await page.route("**/_ds/**", route => route.fulfill({ body: "", contentType: "text/javascript" }));
  await page.route("**/fixture/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/catalog")) return route.fulfill({ json: { ops: catalog } });
    if (path.endsWith("/image")) return route.fulfill({ body: svg, contentType: "image/svg+xml" });
    if (path.endsWith("/history")) return route.fulfill({ json: { records, next_cursor: null } });
    if (path.endsWith("/jobs")) { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { job_id: `job-${requests.length}` } }); }
    if (path.includes("/jobs/")) return route.fulfill({ json: { job_id: path.split("/").pop(), status: mode === "timeout" ? "failed" : "running", error_kind: "gateway_timeout", recoverable: true, hint: "The GPU may still be finishing.", queue_position: 0 } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`/?theme=${theme}`);
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  return requests;
}
async function fill(page: Page, entry: CatalogEntry) {
  for (const key of entry.params.required) {
    const schema = entry.params.properties[key];
    if (key === "image") await page.getByRole("textbox", { name: `${schema.title} reference`, exact: true }).fill("root");
    else if (schema.type === "array") {
      await page.getByRole("textbox", { name: "Reference 1 reference", exact: true }).fill("root");
      await page.getByRole("textbox", { name: "Reference 2 reference", exact: true }).fill("middle");
    } else await page.getByLabel(schema.title!, { exact: true }).fill(key === "prompt" ? "A ceramic vase in soft afternoon light" : "the vase");
  }
}
for (const theme of ["light", "dark", "mobile"]) {
  test(`${theme}: every single-image form submits and renders`, async ({ page }) => {
    if (theme === "mobile") await page.setViewportSize({ width: 390, height: 844 });
    const requests = await setup(page, theme === "mobile" ? "light" : theme);
    for (const entry of catalog.filter(e => e.op !== "inpaint")) {
      await page.getByLabel("Operation", { exact: true }).selectOption(entry.op);
      await fill(page, entry);
      if (entry.op === "identity") {
        await page.getByRole("textbox", { name: "Person ref reference", exact: true }).fill("middle");
        await page.getByLabel("Realism", { exact: true }).check();
      }
      if (entry.op === "outpaint") await page.getByLabel("Left", { exact: true }).fill("128");
      const dir = `../docs/screenshots/studio-s3/${theme}`;
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: `${dir}/${entry.op}.png`, fullPage: true });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const before = requests.length;
      await page.getByRole("button", { name: entry.label, exact: true }).click();
      await expect.poll(() => requests.length).toBe(before + 1);
      expect(requests.at(-1)?.op).toBe(entry.op);
      if (entry.params.required.includes("image")) expect(requests.at(-1)?.parent_id).toBe("root");
      await expect(page.getByText("Rendering…", { exact: true })).toBeVisible();
      await page.evaluate(({ id }) => window.postMessage({ type: "protoagent:event", topic: "protobanana.job.done", data: { job_id: `job-${id}`, media_id: "leaf", elapsed_s: 1 } }, "*"), { id: requests.length });
      await expect(page.getByAltText("Current result")).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    }
  });
}

test("middle-node branch is a sibling; compare supports slider, zoom and pan", async ({ page }) => {
  const requests = await setup(page);
  const lineage = page.getByRole("region", { name: "Lineage", exact: true });
  await expect(lineage.locator("ul ul ul")).toHaveCount(1);
  await lineage.getByRole("button", { name: "edit · middle", exact: true }).click();
  await expect(page.getByAltText("Parent image")).toBeVisible();
  await page.getByLabel("A/B comparison", { exact: true }).fill("25");
  await expect(page.getByAltText("Parent image")).toHaveCSS("clip-path", "inset(0px 75% 0px 0px)");
  await page.getByLabel("Zoom", { exact: true }).fill("2");
  const canvas = page.locator(".compare-viewport");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100); await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 130); await page.mouse.up();
  await expect(page.locator(".compare-images")).toHaveCSS("transform", "matrix(2, 0, 0, 2, 50, 30)");
  await lineage.getByRole("button", { name: "Branch / new seed", exact: true }).nth(1).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].parent_id).toBe("root");
  expect(requests[0].params.seed).not.toBe(42);
  expect(requests[0].params.image).toBe("root");
});

test("524 offers retry; cancel ignores late completions and permits another job", async ({ page }) => {
  const requests = await setup(page, "light", "timeout");
  await fill(page, catalog[0]);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 6000 });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toEqual(requests[1]);
  await expect(page.getByText(/s elapsed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveAttribute("title", /cannot interrupt ComfyUI/);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => window.postMessage({ type: "protoagent:event", topic: "protobanana.job.done", data: { job_id: "job-2", media_id: "leaf" } }, "*"));
  await expect(page.getByAltText("Current result")).toHaveCount(0);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
});

test("inputs, aliases, multiple jobs, outpaint handles and single-ref identity", async ({ page }) => {
  const requests = await setup(page);
  await page.getByLabel("Operation", { exact: true }).selectOption("identity");
  await page.getByLabel("Pick Scene / photo from gallery", { exact: true }).selectOption("root");
  await page.getByLabel("Prompt", { exact: true }).fill("Portrait in a garden");
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].params.person_image).toBe("");
  await page.getByLabel("Operation", { exact: true }).selectOption("remove_background");
  await page.getByText("Advanced alias override", { exact: true }).click();
  await page.getByLabel("Alias override", { exact: true }).fill("protolabs/qwen-image-bgremove-rmbg");
  await expect(page.getByText("Non-commercial · RMBG CC BY-NC", { exact: true })).toBeVisible();
  await page.getByLabel("Upload Image", { exact: true }).setInputFiles({ name: "source.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
  await expect(page.getByRole("textbox", { name: "Image reference", exact: true })).toHaveValue(/^data:image/);
  await page.getByRole("button", { name: "Remove background", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(2);
  expect(requests[1].alias).toContain("rmbg");
  await page.getByLabel("Operation", { exact: true }).selectOption("outpaint");
  await page.getByLabel("Pick Image from gallery", { exact: true }).selectOption("root");
  await expect(page.getByAltText("Outpaint source")).toBeVisible();
  const box = (await page.getByLabel("Drag right margin", { exact: true }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2); await page.mouse.up();
  expect(Number(await page.getByLabel("Right", { exact: true }).inputValue())).toBeGreaterThan(0);
});

test("use current, paste and drop populate distinct image slots", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "edit · middle", exact: true }).click();
  await page.getByLabel("Operation", { exact: true }).selectOption("identity");
  await page.getByRole("group", { name: "Scene / photo", exact: true }).getByRole("button", { name: "Use current", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Scene / photo reference", exact: true })).toHaveValue("middle");
  const person = page.getByRole("group", { name: "Person ref", exact: true });
  await person.evaluate((el, image) => {
    const data = new DataTransfer(); data.items.add(new File([image], "portrait.svg", { type: "image/svg+xml" }));
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
  }, svg);
  await expect(page.getByRole("textbox", { name: "Person ref reference", exact: true })).toHaveValue(/^data:image/);
  await person.getByRole("button", { name: "Clear", exact: true }).click();
  await person.evaluate((el, image) => {
    const data = new DataTransfer(); data.items.add(new File([image], "portrait.svg", { type: "image/svg+xml" }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
  }, svg);
  await expect(page.getByRole("textbox", { name: "Person ref reference", exact: true })).toHaveValue(/^data:image/);
  await expect(page.getByRole("textbox", { name: "Scene / photo reference", exact: true })).toHaveValue("middle");
});

test("cancel during submit prevents late response from starting tracking", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let posted = false;
  let polls = 0;
  await page.route("**/fixture/jobs", async route => {
    posted = true; await gate;
    await route.fulfill({ status: 202, json: { job_id: "abandoned" } });
  });
  await page.route("**/fixture/jobs/abandoned", async route => { polls++; await route.fulfill({ json: { status: "done", media_id: "leaf" } }); });
  await fill(page, catalog[0]);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => posted).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  release();
  await page.clock.install();
  await page.clock.runFor(6000);
  expect(polls).toBe(0);
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(page.getByAltText("Current result")).toHaveCount(0);
});

test("polling recovers a missed bus event and missing jobs offer retry", async ({ page }) => {
  await setup(page);
  await page.route("**/fixture/jobs/job-1", route => route.fulfill({ json: { job_id: "job-1", status: "done", media_id: "leaf", elapsed_s: 2 } }));
  await fill(page, catalog[0]);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByAltText("Current result")).toBeVisible({ timeout: 6000 });
  await page.route("**/fixture/jobs/job-2", route => route.fulfill({ status: 404 }));
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Lost track of this render/)).toBeVisible();
});

test("a signed job result remains visible when history image retrieval fails", async ({ page }) => {
  const requests = await setup(page);
  await page.route("**/fixture/history/leaf/image", route => route.fulfill({ status: 404 }));
  await fill(page, catalog[0]);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByText("Rendering…", { exact: true })).toBeVisible();
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.evaluate(url => window.postMessage({ type: "protoagent:event", topic: "protobanana.job.done", data: { job_id: "job-1", media_id: "leaf", url, elapsed_s: 7 } }, "*"), url);
  await expect(page.getByAltText("Current result")).toHaveAttribute("src", url);
  await expect(page.getByText("done in 7s", { exact: true })).toBeVisible();
});
