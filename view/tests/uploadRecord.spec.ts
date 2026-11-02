import { test, expect, type Page } from "@playwright/test";
import type { HistoryRecord, JobRequest } from "../src/api";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const file = { name: "phone.png", mimeType: "image/png", buffer: png };
const upload: HistoryRecord = { media_id: "phone", parent_id: null, source: "upload", op: "upload", params: { filename: file.name }, alias: null, job_id: null, created: 1, starred: false, pruned: false };

async function setup(page: Page, fail = false) {
  const records: HistoryRecord[] = [];
  const jobs: JobRequest[] = [];
  let saves = 0;
  await page.addInitScript(() => {
    (window as any).pluginKit = { initPluginView: () => ({}), apiFetch: (p: string, init?: RequestInit) => fetch(`/fixture/${p}`, init) };
    (window as any).messages = [];
    window.addEventListener("message", e => { if (e.data.type === "protoagent:chat:compose") (window as any).messages.push(e.data); });
  });
  await page.route("**/_ds/**", r => r.fulfill({ body: "", contentType: "text/javascript" }));
  await page.route("**/fixture/**", async r => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith("/catalog")) return r.fulfill({ json: { source: "gateway", ops: ["generate", "edit"].map(op => ({ op, label: op, aliases: { final: "model" }, inputs: { images: op === "edit" ? 1 : 0 }, licence: {}, params: { properties: { prompt: { type: "string" }, ...(op === "edit" ? { image: { type: "string" } } : {}) }, required: ["prompt"] } })) } });
    if (path.endsWith("/uploads")) {
      saves++;
      if (fail) return r.fulfill({ status: 500, json: {} });
      records.push(upload);
      return r.fulfill({ json: upload });
    }
    if (path.endsWith("/history")) return r.fulfill({ json: { records, next_cursor: null } });
    if (path.endsWith("/image")) return r.fulfill({ body: png, contentType: "image/png" });
    if (path.endsWith("/star")) return r.fulfill({ json: { starred: true } });
    if (path.endsWith("/jobs")) { jobs.push(r.request().postDataJSON()); return r.fulfill({ status: 202, json: { job_id: "edit-job" } }); }
    if (path.includes("/jobs/")) return r.fulfill({ json: { job_id: "edit-job", status: "running" } });
    return r.fulfill({ json: {} });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  return { jobs, records, saves: () => saves };
}
const bar = (page: Page) => page.getByRole("toolbar", { name: "Image actions", exact: true });
const select = (page: Page) => page.locator('input[type="file"]').first().setInputFiles(file);

test("upload enables actions, reuses its record, and becomes an edit's lineage root", async ({ page }) => {
  const state = await setup(page);
  await select(page);
  const send = bar(page).getByRole("button", { name: "Send to agent", exact: true });
  await expect(send).toBeEnabled();
  expect(state.jobs).toHaveLength(0);
  await send.click();
  await expect.poll(() => page.evaluate(() => (window as any).messages[0]?.text)).toContain("Image phone (upload");
  await expect(bar(page).getByRole("button", { name: "Vary", exact: true })).toBeEnabled();
  await bar(page).getByRole("button", { name: "Star", exact: true }).click();
  await select(page);
  await expect(send).toBeEnabled();
  expect(state.saves()).toBe(1);
  await page.getByLabel("Prompt", { exact: true }).fill("Make the product blue");
  const tracking = page.waitForRequest("**/fixture/jobs/edit-job");
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  await tracking;
  await expect.poll(() => state.jobs.length).toBe(1);
  expect(state.jobs[0].parent_id).toBe("phone");
  expect(state.jobs[0].params.image).toBe("phone");
  state.records.unshift({ ...upload, media_id: "edited", parent_id: "phone", op: "edit", source: "studio" });
  await page.evaluate(() => window.postMessage({ type: "protoagent:event", topic: "protobanana.job.done", data: { job_id: "edit-job", media_id: "edited", url: null } }, "*"));
  const strip = page.getByRole("listbox", { name: "Image lineage" });
  await expect(strip.getByRole("option")).toHaveCount(2);
  await expect(strip.getByRole("option").first()).toHaveAccessibleName(/upload/i);
  await expect(strip.getByRole("option").last()).toHaveAccessibleName(/edit/i);
});

test("Vary uses the upload as an edit source", async ({ page }) => {
  const state = await setup(page);
  await select(page);
  await bar(page).getByRole("button", { name: "Vary", exact: true }).click();
  await expect.poll(() => state.jobs.length).toBe(1);
  expect(state.jobs[0]).toMatchObject({ op: "edit", parent_id: "phone", params: { image: "phone" } });
});

test("failed persistence keeps the upload usable and shows a toast", async ({ page }) => {
  const state = await setup(page, true);
  await select(page);
  await expect(page.getByRole("status").filter({ hasText: "Could not save upload" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Send to agent", exact: true })).toBeDisabled();
  await page.getByLabel("Prompt", { exact: true }).fill("Make it blue");
  const tracking = page.waitForRequest("**/fixture/jobs/edit-job");
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  await tracking;
  await expect.poll(() => state.jobs.length).toBe(1);
  expect(state.jobs[0].params.image).toMatch(/^data:image\/png/);
  expect(state.jobs[0].parent_id).toBeUndefined();
});

for (const method of ["drop", "paste"] as const) {
  test(`${method} persists the same image only once`, async ({ page }) => {
    const state = await setup(page);
    await page.evaluate(({ method, bytes }) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], "phone.png", { type: "image/png" }));
      const target = document.querySelector(".canvas")!;
      target.dispatchEvent(method === "drop"
        ? new DragEvent("drop", { bubbles: true, dataTransfer: data })
        : new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
    }, { method, bytes: [...png] });
    await expect(bar(page).getByRole("button", { name: "Send to agent", exact: true })).toBeEnabled();
    await select(page);
    await expect(bar(page).getByRole("button", { name: "Send to agent", exact: true })).toBeEnabled();
    expect(state.saves()).toBe(1);
    expect(state.jobs).toHaveLength(0);
  });
}

test("a late save cannot replace a new canvas", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/fixture/uploads?**", async r => { await held; await r.fulfill({ json: upload }); });
  const saving = page.waitForRequest("**/fixture/uploads?**");
  await select(page);
  await saving;
  await page.getByRole("button", { name: "+ New", exact: true }).click();
  const saved = page.waitForResponse("**/fixture/uploads?**");
  release();
  await saved;
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Image lineage" })).toHaveCount(0);
});

test("reselection shares an in-flight save", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  let saves = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/fixture/uploads?**", async r => {
    saves++;
    await held;
    await r.fulfill({ json: upload });
  });
  const saving = page.waitForRequest("**/fixture/uploads?**");
  await select(page);
  await saving;
  await select(page);
  release();
  await expect(bar(page).getByRole("button", { name: "Send to agent", exact: true })).toBeEnabled();
  expect(saves).toBe(1);
});

test("oversized uploads remain usable locally without a save request", async ({ page }) => {
  const state = await setup(page);
  await page.evaluate(bytes => {
    const data = new DataTransfer();
    const image = new File([new Uint8Array(bytes)], "large.png", { type: "image/png" });
    Object.defineProperty(image, "size", { value: 20 * 1024 * 1024 + 1 });
    data.items.add(image);
    document.querySelector(".canvas")!.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
  }, [...png]);
  await expect(page.getByRole("status").filter({ hasText: "20 MiB History limit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();
  expect(state.saves()).toBe(0);
});


test("an invalid save response keeps the local upload usable", async ({ page }) => {
  await setup(page);
  await page.route("**/fixture/uploads?**", r => r.fulfill({ json: {} }));
  await select(page);
  await expect(page.getByRole("status").filter({ hasText: "Could not save upload" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Send to agent", exact: true })).toBeDisabled();
});
