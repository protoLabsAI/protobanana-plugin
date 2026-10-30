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
async function setup(page: Page, theme = "light", mode = "pending", ops = catalog) {
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
    if (path.endsWith("/catalog")) return route.fulfill({ json: { ops } });
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

test("history waits for a late-arriving plugin kit", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => requests.push(request.url()));
  await page.addInitScript(() => {
    (window as any).kitCalls = [];
    (window as any).historyErrorSeen = false;
    new MutationObserver(() => {
      if (document.body?.textContent?.includes("Could not load history")) {
        (window as any).historyErrorSeen = true;
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
    setTimeout(() => {
      (window as any).pluginKit = {
        initPluginView: () => ({}),
        apiFetch: (path: string, init?: RequestInit) => {
          (window as any).kitCalls.push(path);
          return fetch(`/fixture/${path}`, init);
        },
      };
    }, 400);
  });
  // Force the module import to fail so ready() waits for the late global kit.
  await page.route("**/_ds/plugin-kit.js", route => route.abort());
  await page.route("**/_ds/plugin-kit.css", route => route.fulfill({ body: "", contentType: "text/css" }));
  await page.route("**/api/plugins/protobanana/**", route => route.fulfill({ status: 404 }));
  await page.route("**/fixture/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/catalog")) return route.fulfill({ json: { ops: catalog } });
    if (path.endsWith("/history")) return route.fulfill({ json: { records, next_cursor: null } });
    return route.fulfill({ body: svg, contentType: "image/svg+xml" });
  });
  await page.goto("/plugins/protobanana/studio");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  expect(requests.filter(url => url.includes("api/plugins/protobanana/"))).toEqual([]);
  await expect(page.locator(".g-tile")).toHaveCount(records.length);
  await expect(page.getByText("Could not load history", { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).historyErrorSeen)).toBe(false);
  const dataRequests = requests.filter(url => /\/(history|catalog)([/?]|$)/.test(new URL(url).pathname));
  expect(dataRequests.some(url => new URL(url).pathname === "/fixture/history")).toBe(true);
  expect(dataRequests.some(url => new URL(url).pathname === "/fixture/catalog")).toBe(true);
  const kitCalls: string[] = await page.evaluate(() => (window as any).kitCalls);
  expect(dataRequests.map(url => new URL(url).pathname + new URL(url).search).sort())
    .toEqual(kitCalls.map(path => `/fixture/${path}`).sort());
});

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
  // The badge must render on the DEFAULT alias path: the op is marked CC BY-NC in
  // the catalog, not detected from the alias name (which is protolabs/qwen-image-bgremove).
  await expect(page.getByText("Non-commercial · RMBG-2.0 is CC BY-NC", { exact: true })).toBeVisible();
  await page.getByText("Advanced alias override", { exact: true }).click();
  await page.getByLabel("Alias override", { exact: true }).fill("protolabs/qwen-image-bgremove-rmbg");
  await expect(page.getByText("Non-commercial · RMBG-2.0 is CC BY-NC", { exact: true })).toBeVisible();
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

test("inpaint painter exports source-size alpha and supports undo, erase, invert and feather", async ({ page }) => {
  const requests = await setup(page);
  await page.getByLabel("Operation", { exact: true }).selectOption("inpaint");
  await page.getByRole("textbox", { name: "Image reference", exact: true }).fill("root");
  const canvas = page.getByLabel("Mask canvas").locator("canvas");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const paint = async (x: number, y: number) => {
    await page.mouse.move(box.x + x, box.y + y); await page.mouse.down();
    await page.mouse.move(box.x + x + 20, box.y + y, { steps: 5 }); await page.mouse.up();
  };
  const pixels = async () => page.getByRole("textbox", { name: "Mask reference", exact: true }).evaluate(async (el: HTMLInputElement) => {
    const img = new Image(); img.src = el.value; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d")!; ctx.drawImage(img, 0, 0);
    return { width: c.width, height: c.height,
      center: ctx.getImageData(320, 240, 1, 1).data[3],
      corner: ctx.getImageData(0, 0, 1, 1).data[3],
      soft: Array.from(ctx.getImageData(0, 0, c.width, c.height).data).filter((v, i) => i % 4 === 3 && v > 0 && v < 255).length };
  });
  await paint(150, 112.5);
  expect(await pixels()).toMatchObject({ width: 640, height: 480, center: 0, corner: 255 });
  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  await paint(150, 112.5);
  expect((await pixels()).center).toBe(255);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await pixels()).center).toBe(0);
  await page.getByRole("button", { name: "Invert", exact: true }).click();
  expect(await pixels()).toMatchObject({ center: 255, corner: 0 });
  await page.getByRole("button", { name: "Clear mask", exact: true }).click();
  expect(await pixels()).toMatchObject({ center: 255, corner: 255 });
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.getByLabel("Brush size", { exact: true }).fill("100");
  await page.getByLabel("Feather", { exact: true }).fill("10");
  await paint(150, 112.5);
  expect((await pixels()).soft).toBeGreaterThan(0);
  await page.getByLabel("Prompt", { exact: true }).fill("A pink ceramic vase");
  mkdirSync("../docs/screenshots/studio-s4", { recursive: true });
  await page.screenshot({ path: "../docs/screenshots/studio-s4/inpaint.png", fullPage: true });
  await page.getByRole("button", { name: "Inpaint", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].params.mask).toMatch(/^data:image\/png/);
  await expect(page.getByText("Rendering…", { exact: true })).toBeVisible();
  await page.evaluate(() => window.postMessage({ type: "protoagent:event", topic: "protobanana.job.done",
    data: { job_id: "job-1", media_id: "leaf", elapsed_s: 1 } }, "*"));
  await expect(page.getByAltText("Current result")).toBeVisible();
});

test('S5: gallery and current image compose drafts with UTF-8 byte limits', async ({ page }) => {
  const requests = await setup(page);
  await page.evaluate(() => {
    (window as any).drafts = [];
    window.addEventListener('message', e => {
      if (e.data?.type === 'protoagent:chat:compose') (window as any).drafts.push(e.data);
    });
  });
  await page.locator('.g-tile').first().getByRole('button', { name: 'Send to agent' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).drafts.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).drafts[0])).toEqual({
    type: 'protoagent:chat:compose', text: 'Image root (generate, seed 42, prompt "A ceramic vase"): ',
  });
  await page.getByRole('button', { name: 'edit · middle', exact: true }).click();
  await page.locator('.meta-row').getByRole('button', { name: 'Send to agent' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).drafts.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).drafts[1].text)).toContain('Image middle (edit, seed 42');
  const long = await page.evaluate(async () => {
    const { composeText } = await import(/* @vite-ignore */ String('/src/api.ts'));
    return composeText({ media_id: 'unicode-image', op: 'generate', params: { seed: 99, prompt: '🍌漢'.repeat(3000) } });
  });
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(4096);
  expect(long).toContain('Image unicode-image (generate, seed 99, prompt "');
  expect(long).not.toContain('\ufffd');
  expect(requests).toHaveLength(0);
  await expect.poll(() => page.locator('.pane.right').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  mkdirSync('../docs/screenshots/studio-s5', { recursive: true });
  await page.screenshot({ path: '../docs/screenshots/studio-s5/send-to-agent.png', fullPage: true });
});

test('S5: inbox delivered during ready focuses history; unknown and spoofed IDs are handled', async ({ page }) => {
  await setup(page);
  // Simulate a fresh dock mount whose host drains the inbox on ready.
  await page.addInitScript(() => {
    (window as any).pluginKit.initPluginView = () => {
      window.postMessage({ type: 'protobanana:focus', focus: 'middle' }, location.origin);
      return {};
    };
  });
  await page.reload();
  await expect(page.getByText('Current: edit · middle', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'protobanana:focus', focus: 'root' }, origin: location.origin, source: null,
  })));
  await expect(page.getByText('Current: edit · middle', { exact: true })).toBeVisible();
  await page.evaluate(() => window.postMessage({ type: 'protobanana:focus', focus: 'older-image' }, location.origin));
  await expect(page.getByRole('alert')).toContainText('Image older-image is not in Studio history');
  await expect(page.locator('.meta-row')).toHaveCount(0);
  await page.screenshot({ path: '../docs/screenshots/studio-s5/missing-image.png', fullPage: true });
});

test('S5: reference chip sends nonce-bound openView and falls back on older hosts', async ({ page }) => {
  await page.goto('/ref.html#pair=fixture');
  await page.evaluate(() => {
    (window as any).opens = [];
    window.addEventListener('message', e => {
      if (e.data?.type === 'protoComponent:openView') (window as any).opens.push(e.data);
    });
    window.postMessage({ type: 'protoComponent:init', nonce: 'nonce-fixture', props: { media_id: 'middle' } }, '*');
  });
  await expect(page.getByRole('button', { name: 'Open in Studio' })).toBeEnabled();
  await page.screenshot({ path: '../docs/screenshots/studio-s5/chip.png' });
  await page.getByRole('button', { name: 'Open in Studio' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).opens.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).opens[0])).toEqual({
    type: 'protoComponent:openView', cid: 1, nonce: 'nonce-fixture', view: 'studio',
    message: { type: 'protobanana:focus', focus: 'middle' },
  });
  await expect(page.getByRole('status')).toContainText('This host cannot open Studio from a chip');
  await expect(page.locator('code')).toHaveText('middle');
  await page.screenshot({ path: '../docs/screenshots/studio-s5/chip-fallback.png' });
});

test('S5: real kit module handshake preserves an early inbox message through a fleet prefix', async ({ page }) => {
  const dataPaths: string[] = [];
  await page.route('**/_ds/plugin-kit.css', route => route.fulfill({ body: '', contentType: 'text/css' }));
  await page.route('**/_ds/plugin-kit.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export function initPluginView(callback) {
      window.postMessage({ type: 'protobanana:focus', focus: 'middle' }, location.origin);
      setTimeout(() => callback({ theme: 'dark' }), 20);
    }
    export function apiFetch(path, init) { return fetch('/agents/test' + path, init); }
    export function apiUrl(path) { return '/agents/test' + path; }
  ` }));
  await page.route('**/agents/test/api/plugins/protobanana/**', route => {
    const path = new URL(route.request().url()).pathname;
    dataPaths.push(path);
    if (path.endsWith('/catalog')) return route.fulfill({ json: { ops: catalog } });
    if (path.endsWith('/history')) return route.fulfill({ json: { records, next_cursor: null } });
    return route.fulfill({ body: svg, contentType: 'image/svg+xml' });
  });
  await page.goto('/agents/test/plugins/protobanana/studio');
  await expect(page.getByText('Current: edit · middle', { exact: true })).toBeVisible();
  await expect(page.getByAltText('Current result')).toBeVisible();
  expect(dataPaths).toContain('/agents/test/api/plugins/protobanana/history');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});


test("S6: gateway aliases shown by the form are pinned on submission", async ({ page }) => {
  const live = catalog.map(entry => entry.op === "generate" ? {
    ...entry, aliases: { final: "gateway-final", draft: "gateway-turbo" },
  } : entry);
  const requests = await setup(page, "light", "pending", live);
  await fill(page, live[0]);
  await page.getByRole("button", { name: "Draft", exact: true }).click();
  await expect(page.locator("form small.desc").first()).toHaveText("gateway-turbo");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].alias).toBe("gateway-turbo");
});

test("S6: gateway-only operation renders its form and submits its alias", async ({ page }) => {
  const extra: CatalogEntry = { ...catalog[0], op: "upscale", label: "Upscale",
    aliases: { final: "gateway-upscale" }, params: { type: "object",
      properties: { scale: { type: "integer", title: "Scale", default: 2 } }, required: [] } };
  const requests = await setup(page, "light", "pending", [...catalog, extra]);
  await page.getByLabel("Operation", { exact: true }).selectOption("upscale");
  await page.getByLabel("Scale", { exact: true }).fill("4");
  await page.getByRole("button", { name: "Upscale", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ op: "upscale", alias: "gateway-upscale", params: { scale: 4 } });
});
