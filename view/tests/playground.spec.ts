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

// A shared history index: root (generate) → middle (edit) → leaf (edit), all
// studio-sourced and unstarred. The fixture /history endpoint honours the op /
// source / starred query so the filter tests can assert tile counts.
const records: HistoryRecord[] = ["root", "middle", "leaf"].map((id, i) => ({
  media_id: id, parent_id: i ? ["root", "middle"][i - 1] : null, op: i ? "edit" : "generate",
  alias: "protolabs/qwen-image", params: { prompt: "A ceramic vase", seed: 42, ...(i ? { image: ["root", "middle"][i - 1] } : {}) },
  source: "studio", job_id: null, created: 1, starred: false, pruned: false,
}));

async function setup(page: Page, theme = "light", mode: "pending" | "timeout" = "pending", ops = catalog, historyRecords = records) {
  const requests: JobRequest[] = [];
  await page.addInitScript(() => {
    (window as any).pluginKit = {
      initPluginView: () => ({}),
      apiFetch: (path: string, init?: RequestInit) => fetch(`/fixture/${path}`, init),
    };
  });
  await page.route("**/_ds/**", route => route.fulfill({ body: "", contentType: "text/javascript" }));
  await page.route("**/fixture/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/catalog")) return route.fulfill({ json: { ops, source: "gateway" } });
    if (path.endsWith("/image")) return route.fulfill({ body: svg, contentType: "image/svg+xml" });
    if (path.endsWith("/history")) {
      let recs = historyRecords;
      const op = url.searchParams.get("op");
      const source = url.searchParams.get("source");
      const starred = url.searchParams.get("starred");
      if (op) recs = recs.filter(r => r.op === op);
      if (source) recs = recs.filter(r => r.source === source);
      if (starred === "true") recs = recs.filter(r => r.starred);
      return route.fulfill({ json: { records: recs, next_cursor: null } });
    }
    if (path.endsWith("/jobs")) { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { job_id: `job-${requests.length}` } }); }
    if (path.includes("/jobs/")) return route.fulfill({ json: { job_id: path.split("/").pop(), status: mode === "timeout" ? "failed" : "running", error_kind: "gateway_timeout", recoverable: true, hint: "The GPU may still be finishing.", queue_position: 0 } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`/?theme=${theme}`);
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  return requests;
}

const prompt = (page: Page) => page.getByLabel("Prompt", { exact: true });
const busDone = (page: Page, data: Record<string, unknown>) =>
  page.evaluate(d => window.postMessage({ type: "protoagent:event", topic: "protobanana.job.done", data: d }, "*"), data);

// Acceptance r4: api.ts is unchanged, so this verifies the view still waits for a
// late-arriving kit and never leaks a direct /api call.
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
  await page.route("**/_ds/plugin-kit.js", route => route.abort());
  await page.route("**/_ds/plugin-kit.css", route => route.fulfill({ body: "", contentType: "text/css" }));
  await page.route("**/api/plugins/protobanana/**", route => route.fulfill({ status: 404 }));
  await page.route("**/fixture/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/catalog")) return route.fulfill({ json: { ops: catalog, source: "gateway" } });
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

// Criteria 1–3 (shell, empty→Generate→current+History, badge/queue, Apply edit),
// run in both themes as before.
for (const theme of ["light", "dark"]) {
  test(`${theme}: generating from an expired History selection starts a new root`, async ({ page }) => {
    const expired = { ...records[0], pruned: true };
    const requests = await setup(page, theme, "pending", catalog, [expired]);
    await page.getByRole("button", { name: /Pruned .* render/ }).click();
    await expect(page.getByText("This image expired", { exact: true })).toBeVisible();
    await expect(page.getByText("star images to keep them", { exact: true })).toBeVisible();
    await expect(page.getByAltText("Current image")).toHaveCount(0);
    await prompt(page).fill("A new ceramic vase");
    const tracking = page.waitForRequest(request => request.url().endsWith("/jobs/job-1") && request.method() === "GET");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].op).toBe("generate");
    expect(requests[0]).not.toHaveProperty("parent_id");
    expect(requests[0].params).not.toHaveProperty("image");

    // Editing the new result must still retain its input and lineage.
    await tracking; // The submit response has arrived and the bus listener is installed.
    await busDone(page, { job_id: "job-1", media_id: "new-root", elapsed_s: 3 });
    await page.getByRole("button", { name: "Apply edit", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].op).toBe("edit");
    expect(requests[1].params.image).toBe("new-root");
    expect(requests[1].parent_id).toBe("new-root");
  });

  for (const note of ["Research use only", ""]) {
    test(`${theme}: composer preserves catalog non-commercial disclosure (${note || "fallback"})`, async ({ page }) => {
      const ops = catalog.map(entry => ({
        ...entry,
        licence: { non_commercial: entry.op === "generate", note },
      }));
      await setup(page, theme, "pending", ops);
      const badge = page.getByRole("form", { name: "Composer" }).locator(".badge-nc");
      await expect(badge).toHaveText(`Non-commercial · ${note || "RMBG CC BY-NC"}`);
      await expect(badge).toBeVisible();
      // Selecting an image changes the active entry to the unrestricted editor.
      await page.locator(".g-tile").first().getByRole("button", { name: /render/ }).click();
      await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();
      await expect(badge).toHaveCount(0);
      await page.getByRole("button", { name: "+ New", exact: true }).click();
      await expect(badge).toBeVisible();
    });
  }

  test(`${theme}: non-commercial alias fallback follows the submitted quality alias`, async ({ page }) => {
    const ops = catalog.map(entry => ({
      ...entry,
      licence: { non_commercial: false },
      aliases: { final: "example/commercial", draft: "example/RMBG-editor" },
    }));
    const requests = await setup(page, theme, "pending", ops);
    const badge = page.locator(".composer .badge-nc");
    await expect(badge).toHaveCount(0);
    await page.getByRole("button", { name: /^Options:/ }).click();
    await page.getByRole("radio", { name: "Draft", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(badge).toHaveText("Non-commercial · RMBG CC BY-NC");
    await expect(badge).toBeVisible();
    await prompt(page).fill("A ceramic vase");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].alias).toBe("example/RMBG-editor");
    await page.getByRole("button", { name: /^Options:/ }).click();
    await page.getByRole("radio", { name: "Final", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(badge).toHaveCount(0);
  });

  test(`${theme}: shell, empty→generate→current+history, queue badge, apply edit`, async ({ page }) => {
    const requests = await setup(page, theme);

    // r1 — the §3 shell.
    await expect(page.getByRole("heading", { name: "Images", exact: true })).toBeVisible();
    await expect(page.getByText("protoBanana", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Playground", exact: true })).toHaveAttribute("aria-selected", "true");
    const pipelines = page.getByRole("tab", { name: "Pipelines", exact: true });
    await expect(pipelines).toBeDisabled();
    await expect(pipelines).toHaveAttribute("title", "Coming soon");
    await expect(page.getByRole("button", { name: "+ New", exact: true })).toBeVisible();
    await expect(page.locator(".history-col")).toBeVisible();
    await expect(page.getByRole("button", { name: "History", exact: true })).toHaveCount(0); // wide → no narrow button

    // r2 — empty state and the Generate verb.
    await expect(page.getByText("Describe an image to start", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
    mkdirSync(`../docs/screenshots/images-r1/${theme}`, { recursive: true });
    await page.screenshot({ path: `../docs/screenshots/images-r1/${theme}/empty.png`, fullPage: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Generate.
    await prompt(page).fill("A ceramic vase in soft afternoon light");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].op).toBe("generate");
    expect(requests[0]).not.toHaveProperty("parent_id");

    // r3 — render status on the canvas + rendering badge.
    await expect(page.getByText(/Rendering ·/)).toBeVisible();
    await expect(page.getByText(/^1 rendering$/)).toBeVisible();

    // Second submit queues; the badge counts both.
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.getByText(/^2 rendering$/)).toBeVisible();

    // The first result lands as the current image and History populates.
    await busDone(page, { job_id: "job-1", media_id: "leaf", elapsed_s: 3 });
    await expect(page.getByAltText("Current image")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();
    await expect(page.locator(".history-col .g-tile").first()).toBeVisible();
    await page.screenshot({ path: `../docs/screenshots/images-r1/${theme}/rendered.png`, fullPage: true });

    // Apply edit submits a whole-image edit against the current image.
    await prompt(page).fill("make the vase cobalt blue");
    await page.getByRole("button", { name: "Apply edit", exact: true }).click();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2].op).toBe("edit");
    expect(requests[2].params.image).toBe("leaf");
    expect(requests[2].parent_id).toBe("leaf");
  });
}

test("⌘/Ctrl+Enter submits from the composer", async ({ page }) => {
  const requests = await setup(page);
  await prompt(page).fill("A ceramic vase");
  await prompt(page).press("ControlOrMeta+Enter");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].op).toBe("generate");
});

test("empty state: upload, drop and paste load the current input", async ({ page }) => {
  await setup(page);
  await expect(page.getByText("Describe an image to start", { exact: true })).toBeVisible();

  // Upload (the Empty action drives the hidden file input).
  await page.locator('input[type="file"]').setInputFiles({ name: "src.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
  await expect(page.getByAltText("Current image")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();

  // + New returns to the empty state.
  await page.getByRole("button", { name: "+ New", exact: true }).click();
  await expect(page.getByText("Describe an image to start", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();

  // Drop anywhere on the canvas.
  await page.locator(".canvas").evaluate((el, image) => {
    const data = new DataTransfer(); data.items.add(new File([image], "p.svg", { type: "image/svg+xml" }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
  }, svg);
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "+ New", exact: true }).click();

  // Paste anywhere on the canvas.
  await page.locator(".canvas").evaluate((el, image) => {
    const data = new DataTransfer(); data.items.add(new File([image], "p.svg", { type: "image/svg+xml" }));
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
  }, svg);
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();
});

test("options popover maps aspect to WxH and the seed lock reproduces the seed", async ({ page }) => {
  const requests = await setup(page);
  await prompt(page).fill("A ceramic vase");
  await page.getByRole("button", { name: /Options/ }).click();
  await page.getByRole("radio", { name: "16:9", exact: true }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].params.size).toBe("1280x720");
  const seed = requests[0].params.seed;
  expect(typeof seed).toBe("number");

  // Lock the last seed; the next run reproduces it (and the aspect persists).
  await page.getByRole("button", { name: /Options/ }).click();
  await page.getByRole("button", { name: "Lock seed", exact: true }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].params.seed).toBe(seed);
  expect(requests[1].params.size).toBe("1280x720");
});

test("524 timeout shows the warning callout with Retry; Retry re-runs the same request", async ({ page }) => {
  const requests = await setup(page, "light", "timeout");
  await prompt(page).fill("A ceramic vase");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText("GPU busy — the gateway timed out", { exact: false })).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole("button", { name: "Edit prompt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toEqual(requests[1]);
});

test("a late bus result clears the 524 callout and lands the image", async ({ page }) => {
  await setup(page, "light", "timeout");
  await prompt(page).fill("A ceramic vase");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText("GPU busy — the gateway timed out", { exact: false })).toBeVisible({ timeout: 6000 });
  await busDone(page, { job_id: "job-1", media_id: "leaf", elapsed_s: 9 });
  await expect(page.getByText("GPU busy — the gateway timed out", { exact: false })).toHaveCount(0);
  await expect(page.getByAltText("Current image")).toBeVisible();
});

test("a lost job (404 from the store) offers Retry", async ({ page }) => {
  await setup(page);
  await page.route("**/fixture/jobs/job-1", route => route.fulfill({ status: 404 }));
  await prompt(page).fill("A ceramic vase");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText("Lost track of this render", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("a signed job result stays visible when the history image fetch fails", async ({ page }) => {
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await setup(page);
  // The signed result carries its own URL; the gated history image fetch 404s,
  // but the canvas uses the URL directly (poll backstop settles the job).
  await page.route("**/fixture/history/leaf/image", route => route.fulfill({ status: 404 }));
  await page.route("**/fixture/jobs/job-1", route =>
    route.fulfill({ json: { job_id: "job-1", status: "done", media_id: "leaf", url, elapsed_s: 7 } }));
  await prompt(page).fill("A ceramic vase");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByAltText("Current image")).toHaveAttribute("src", url, { timeout: 6000 });
});

test("the unreachable banner shows with Reload when the API is down", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).pluginKit = {
      initPluginView: () => ({}),
      apiFetch: () => Promise.resolve(new Response("", { status: 503 })),
    };
  });
  await page.route("**/_ds/**", route => route.fulfill({ body: "", contentType: "text/javascript" }));
  await page.goto("/?theme=light");
  const banner = page.getByRole("alert");
  await expect(banner).toContainText("Couldn't reach the Studio plugin");
  await expect(banner.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  // The raw error is tucked behind a Details disclosure, not shown by default.
  const detail = banner.locator(".banner-details code");
  await expect(detail).toBeHidden();
  await banner.getByText("Details", { exact: true }).click();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("503");
});

// Fix round (a): the gateway-unavailable fallback warning carries the raw httpx
// exception (and its URL). The static-catalog banner must show one plain
// sentence — no URL, no exception text — with the raw detail reachable only
// through a Details disclosure.
test("static-catalog banner hides the raw gateway error (and its URL) behind Details", async ({ page }) => {
  const rawError = "ConnectError: [Errno 61] Connection refused — https://www.python-httpx.org/exceptions/";
  await page.addInitScript(() => {
    (window as any).pluginKit = {
      initPluginView: () => ({}),
      apiFetch: (path: string, init?: RequestInit) => fetch(`/fixture/${path}`, init),
    };
  });
  await page.route("**/_ds/**", route => route.fulfill({ body: "", contentType: "text/javascript" }));
  await page.route("**/fixture/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/catalog")) return route.fulfill({ json: { ops: catalog, source: "static", stale: true, warnings: [`Gateway catalog unavailable: ${rawError}`] } });
    if (path.endsWith("/history")) return route.fulfill({ json: { records: [], next_cursor: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/?theme=light");

  const banner = page.locator(".banner-stale");
  await expect(banner).toBeVisible();

  // The visible copy is one plain sentence: no URL, no exception text.
  const line = (await banner.locator(".banner-line").innerText()).trim();
  expect(line).not.toMatch(/https?:\/\//);
  expect(line).not.toContain("ConnectError");
  expect(line).not.toContain("Gateway catalog unavailable");
  // Nothing in the banner leaks the URL / exception while the disclosure is shut.
  const shut = await banner.innerText();
  expect(shut).not.toMatch(/https?:\/\//);
  expect(shut).not.toContain("ConnectError");

  // The raw detail (with the URL) is reachable through the disclosure.
  const detail = banner.locator(".banner-details code");
  await expect(detail).toBeHidden();
  await banner.getByText("Details", { exact: true }).click();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("ConnectError");
  await expect(detail).toContainText("https://www.python-httpx.org");
});

for (const theme of ["light", "dark"]) {
  test(`${theme}: failures survive other completions and failures; actions affect only their job`, async ({ page }) => {
    const requests = await setup(page, theme);
    for (const text of ["First vase", "Second vase", "Third vase"]) {
      await prompt(page).fill(text);
      await page.getByRole("button", { name: "Generate", exact: true }).click();
    }
    await expect.poll(() => requests.length).toBe(3);
    await expect(page.locator(".rendering-badge")).toHaveText("3 rendering");

    const fail = (id: number, errorKind = "gateway_timeout") => page.evaluate(({ id, errorKind }) =>
      window.postMessage({ type: "protoagent:event", topic: "protobanana.job.failed",
        data: { job_id: `job-${id}`, error_kind: errorKind, recoverable: errorKind === "gateway_timeout",
          error: `Failure ${id}`, hint: `Details for render ${id}` } }, "*"), { id, errorKind });
    const first = page.getByRole("region", { name: "Failed render: First vase", exact: true });
    const second = page.getByRole("region", { name: "Failed render: Second vase", exact: true });

    await fail(1);
    await expect(first.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await busDone(page, { job_id: "job-3", media_id: "leaf" });
    await expect(page.getByAltText("Current image")).toBeVisible();
    await expect(page.locator(".rendering-badge")).toHaveText("1 rendering");
    await expect(first.getByRole("button", { name: "Edit prompt", exact: true })).toBeVisible();

    await fail(2, "invalid_input");
    await expect(second).toContainText("Details for render 2");
    await expect(second.getByRole("button", { name: "Copy details" })).toBeVisible();
    await expect(first).toContainText("GPU busy");
    await expect(page.locator(".rendering-badge")).toHaveCount(0);

    // Navigating the canvas must not discard unresolved job failures.
    await page.getByRole("button", { name: "+ New", exact: true }).click();
    await page.locator(".g-tile").first().getByRole("button", { name: /render/ }).click();
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();

    const retryTracking = page.waitForRequest("**/fixture/jobs/job-4");
    await first.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => requests.length).toBe(4);
    expect(requests[3]).toEqual(requests[0]);
    await expect(first).toHaveCount(0);
    await expect(second).toBeVisible();

    // Wait for tracking to start before delivering a bus event for the retry.
    await retryTracking;
    await fail(4);
    await expect(first).toBeVisible();
    await second.getByRole("button", { name: "Edit prompt", exact: true }).click();
    await expect(second).toHaveCount(0);
    await expect(prompt(page)).toBeFocused();
    await expect(first).toBeVisible();
    await first.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(first).toHaveCount(0);
  });

  test(`${theme}: late results clear only their matching failure`, async ({ page }) => {
    const requests = await setup(page, theme, "timeout");
    for (const text of ["First timeout", "Second timeout"]) {
      await prompt(page).fill(text);
      await page.getByRole("button", { name: "Generate", exact: true }).click();
    }
    await expect.poll(() => requests.length).toBe(2);
    const first = page.getByRole("region", { name: "Failed render: First timeout", exact: true });
    const second = page.getByRole("region", { name: "Failed render: Second timeout", exact: true });
    await expect(first).toBeVisible({ timeout: 6000 });
    await expect(second).toBeVisible({ timeout: 6000 });

    await busDone(page, { job_id: "unrelated-agent-job", media_id: "root" });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    await busDone(page, { job_id: "job-1", media_id: "leaf" });
    await expect(first).toHaveCount(0);
    await expect(page.getByAltText("Current image")).toBeVisible();
    await expect(second.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await busDone(page, { job_id: "job-2", media_id: "middle" });
    await expect(second).toHaveCount(0);
  });
}

test("History filter narrows by op, source and starred", async ({ page }) => {
  await setup(page);
  await expect(page.locator(".g-tile")).toHaveCount(3);
  await page.getByRole("button", { name: "Filter history", exact: true }).click();
  await page.getByLabel("Filter by operation", { exact: true }).selectOption("edit");
  await expect(page.locator(".g-tile")).toHaveCount(2);
  await page.getByLabel("Filter by operation", { exact: true }).selectOption("");
  await expect(page.locator(".g-tile")).toHaveCount(3);
  await page.getByRole("switch", { name: "Starred only", exact: true }).click();
  await expect(page.locator(".g-tile")).toHaveCount(0);
});

test("selecting a History thumb makes it the current image; pruned shows the expired Empty", async ({ page }) => {
  await setup(page);
  await page.locator(".g-tile").first().getByRole("button", { name: /render/ }).click();
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();
  await expect(page.getByAltText("Current image")).toBeVisible();
});

test("below 780px of the view's own width, History moves into a Drawer", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await setup(page);
  await expect(page.locator(".history-col")).toHaveCount(0);
  await expect(page.locator(".g-tile")).toHaveCount(0); // not mounted until the drawer opens
  await page.getByRole("button", { name: "History", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "History", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".g-tile")).toHaveCount(records.length);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "History", exact: true })).toHaveCount(0);
});

// Fix round (b): standalone at a wide viewport the 248px History column used to
// spill past the right edge, clipping the filter button and the third thumbnail
// column. It must stay fully inside the view at both wide and mid widths, with
// all three thumbnail columns on-screen.
for (const width of [1600, 1100]) {
  test(`History stays inside the view at ${width}px with all three thumbnail columns visible`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests = await setup(page);

    // Land a render so the canvas shows an image and History is populated.
    await prompt(page).fill("A ceramic vase");
    const tracking = page.waitForRequest(r => r.url().endsWith("/jobs/job-1") && r.method() === "GET");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    await tracking;
    await busDone(page, { job_id: "job-1", media_id: "leaf", elapsed_s: 3 });
    await expect(page.getByAltText("Current image")).toBeVisible();

    const view = page.locator(".images");
    const history = page.locator(".history-col");
    await expect(history).toBeVisible();
    await expect(history.locator(".g-tile")).toHaveCount(records.length);

    const viewBox = (await view.boundingBox())!;
    const historyBox = (await history.boundingBox())!;
    const viewRight = viewBox.x + viewBox.width;

    // The filter button and the History column's right edge stay inside the view.
    await expect(history.getByRole("button", { name: "Filter history", exact: true })).toBeInViewport();
    expect(historyBox.x + historyBox.width).toBeLessThanOrEqual(viewRight + 1);

    // All three thumbnail columns render inside the view — none clipped off-edge.
    const topRow = history.locator(".g-grid .g-tile");
    for (let i = 0; i < 3; i++) {
      const tile = topRow.nth(i);
      await expect(tile).toBeInViewport();
      const box = (await tile.boundingBox())!;
      expect(box.width).toBeGreaterThan(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewRight + 1);
    }

    // And no horizontal page scroll is introduced at any width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("§6 removed-outright controls are absent", async ({ page }) => {
  await setup(page);
  await expect(page.getByLabel("Operation", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Count", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Size", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Advanced alias override", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New seed", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset view", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Zoom", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Render queue" })).toHaveCount(0);
  await expect(page.getByText("Ready to render", { exact: false })).toHaveCount(0);
});

test("S5: a focus inbox message selects that image; unknown and spoofed ids are handled", async ({ page }) => {
  await setup(page);
  // A fresh dock mount whose host drains the inbox on ready.
  await page.addInitScript(() => {
    (window as any).pluginKit.initPluginView = () => {
      window.postMessage({ type: "protobanana:focus", focus: "middle" }, location.origin);
      return {};
    };
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();

  // A spoofed-source message is ignored; the current image stays.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "protobanana:focus", focus: "root" }, origin: location.origin, source: null,
  })));
  await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();

  // An unknown id surfaces an alert and leaves no current image.
  await page.evaluate(() => window.postMessage({ type: "protobanana:focus", focus: "older-image" }, location.origin));
  await expect(page.getByRole("alert")).toContainText("Image older-image is not in Studio history");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
});

test("S5: History tile sends a draft to the chat composer; composeText keeps the UTF-8 byte limit", async ({ page }) => {
  const requests = await setup(page);
  await page.evaluate(() => {
    (window as any).drafts = [];
    window.addEventListener("message", e => {
      if (e.data?.type === "protoagent:chat:compose") (window as any).drafts.push(e.data);
    });
  });
  await page.locator(".g-tile").first().getByRole("button", { name: "Send to agent", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).drafts.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).drafts[0])).toEqual({
    type: "protoagent:chat:compose", text: 'Image root (generate, seed 42, prompt "A ceramic vase"): ',
  });
  const long = await page.evaluate(async () => {
    const { composeText } = await import(/* @vite-ignore */ String("/src/api.ts"));
    return composeText({ media_id: "unicode-image", op: "generate", params: { seed: 99, prompt: "🍌漢".repeat(3000) } });
  });
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(4096);
  expect(long).toContain('Image unicode-image (generate, seed 99, prompt "');
  expect(long).not.toContain("�");
  expect(requests).toHaveLength(0);
  mkdirSync("../docs/screenshots/images-r1", { recursive: true });
  await page.screenshot({ path: "../docs/screenshots/images-r1/send-to-agent.png", fullPage: true });
});

test("S5: reference chip sends nonce-bound openView and falls back on older hosts", async ({ page }) => {
  await page.goto("/ref.html#pair=fixture");
  await page.evaluate(() => {
    (window as any).opens = [];
    window.addEventListener("message", e => {
      if (e.data?.type === "protoComponent:openView") (window as any).opens.push(e.data);
    });
    window.postMessage({ type: "protoComponent:init", nonce: "nonce-fixture", props: { media_id: "middle" } }, "*");
  });
  await expect(page.getByRole("button", { name: "Open in Studio" })).toBeEnabled();
  await page.getByRole("button", { name: "Open in Studio" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).opens.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).opens[0])).toEqual({
    type: "protoComponent:openView", cid: 1, nonce: "nonce-fixture", view: "studio",
    message: { type: "protobanana:focus", focus: "middle" },
  });
  await expect(page.getByRole("status")).toContainText("This host cannot open Studio from a chip");
  await expect(page.locator("code")).toHaveText("middle");
});

test("S6: the gateway alias the composer resolves is pinned on submission", async ({ page }) => {
  const live = catalog.map(entry => entry.op === "generate" ? {
    ...entry, aliases: { final: "gateway-final", draft: "gateway-turbo" },
  } : entry);
  const requests = await setup(page, "light", "pending", live);
  await prompt(page).fill("A ceramic vase");
  await page.getByRole("button", { name: /Options/ }).click();
  await page.getByRole("radio", { name: "Draft", exact: true }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].tier).toBe("draft");
  expect(requests[0].alias).toBe("gateway-turbo");
});

// ===========================================================================
// Images view R2: the action bar — edit verbs as actions on the current image
// (design §3 / §4.3 / §5 / §8 / §10). Each verb submits its op with the current
// image as both input and parent_id; contextual modes show a Chip and leave on
// Esc; narrow collapses the overflow verbs into a More menu.
// ===========================================================================

// Select a History thumb so it becomes the current image (the action bar shows).
const pickTile = (page: Page, index: number) =>
  page.locator(".g-tile").nth(index).getByRole("button", { name: /render/ }).click();
const bar = (page: Page) => page.getByRole("toolbar", { name: "Image actions", exact: true });

for (const theme of ["light", "dark"]) {
  test(`${theme}: action bar is a role=toolbar with named verbs and arrow-key roving focus`, async ({ page }) => {
    await setup(page, theme);
    await pickTile(page, 0);
    await expect(bar(page)).toBeVisible();
    for (const name of ["Vary", "Edit", "Region", "Inpaint", "Outpaint", "Remove BG", "Compose", "Star", "Download", "Send to agent"]) {
      await expect(bar(page).getByRole("button", { name, exact: true })).toBeVisible();
    }
    const vary = bar(page).getByRole("button", { name: "Vary", exact: true });
    await vary.focus();
    await expect(vary).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(bar(page).getByRole("button", { name: "Edit", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(bar(page).getByRole("button", { name: "Region", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(bar(page).getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  });

  test(`${theme}: Vary, Region and Remove BG submit their op with the current image as input and parent_id`, async ({ page }) => {
    const ops = catalog.map(e => e.op === "remove_background"
      ? { ...e, licence: { non_commercial: true, note: "RMBG-2.0 is CC BY-NC" } } : e);
    const requests = await setup(page, theme, "pending", ops);
    await pickTile(page, 0); // root: a generate, seed 42

    // Vary: same params, a NEW seed, recorded as a child of the current image.
    await bar(page).getByRole("button", { name: "Vary", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].op).toBe("generate");
    expect(requests[0].parent_id).toBe("root");
    expect(requests[0].params.prompt).toBe("A ceramic vase");
    expect(typeof requests[0].params.seed).toBe("number");
    expect(requests[0].params.seed).not.toBe(42);

    // Region: the "What to change?" grounding field appears and rides the op.
    await bar(page).getByRole("button", { name: "Region", exact: true }).click();
    await page.getByLabel("What to change?", { exact: true }).fill("the vase");
    await prompt(page).fill("make it cobalt blue");
    await page.getByRole("button", { name: "Apply edit", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].op).toBe("region_edit");
    expect(requests[1].params.grounding).toBe("the vase");
    expect(requests[1].params.image).toBe("root");
    expect(requests[1].parent_id).toBe("root");

    // Remove BG: one click, no prompt, and the catalog non-commercial badge shows.
    await expect(bar(page).locator(".action-bar-nc")).toContainText("Non-commercial");
    await bar(page).getByRole("button", { name: "Remove BG", exact: true }).click();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2].op).toBe("remove_background");
    expect(requests[2].params.image).toBe("root");
    expect(requests[2].parent_id).toBe("root");
    expect(requests[2].params).not.toHaveProperty("prompt");
  });

  test(`${theme}: Inpaint paints a source-size mask that the op submits`, async ({ page }) => {
    const requests = await setup(page, theme);
    await pickTile(page, 0); // root is 640x480
    await bar(page).getByRole("button", { name: "Inpaint", exact: true }).click();
    const canvas = page.getByLabel("Mask canvas", { exact: true }).locator("canvas").first();
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await prompt(page).fill("a bunch of daisies");
    await page.getByRole("button", { name: "Apply edit", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].op).toBe("inpaint");
    expect(requests[0].params.image).toBe("root");
    expect(requests[0].parent_id).toBe("root");
    const mask = requests[0].params.mask as string;
    expect(mask).toMatch(/^data:image\/png/);
    const dims = await page.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d")!; ctx.drawImage(img, 0, 0);
      return { width: c.width, height: c.height,
        center: ctx.getImageData(320, 240, 1, 1).data[3], corner: ctx.getImageData(0, 0, 1, 1).data[3] };
    }, mask);
    // Painted region exports transparent (edit), unpainted exports opaque (preserve).
    expect(dims).toMatchObject({ width: 640, height: 480, center: 0, corner: 255 });
  });

  test(`${theme}: Outpaint margins are editable numbers and match the handle drag`, async ({ page }) => {
    const requests = await setup(page, theme);
    await pickTile(page, 0);
    await bar(page).getByRole("button", { name: "Outpaint", exact: true }).click();
    const source = page.getByAltText("Outpaint source");
    await expect(source).toBeVisible();
    await expect.poll(() => source.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    const handle = page.getByRole("button", { name: "Drag right margin", exact: true });
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 48, hb.y + hb.height / 2, { steps: 4 });
    await page.mouse.up();
    const right = page.getByLabel("Right", { exact: true });
    const dragged = Number(await right.inputValue());
    expect(dragged).toBeGreaterThan(0);
    // The numeric inputs are the WCAG 2.5.7 dragging alternative — type one too.
    await page.getByLabel("Top", { exact: true }).fill("32");
    await page.getByRole("button", { name: "Apply edit", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].op).toBe("outpaint");
    expect(requests[0].params.image).toBe("root");
    expect(requests[0].parent_id).toBe("root");
    expect(requests[0].params.right).toBe(dragged);
    expect(requests[0].params.top).toBe(32);
  });

  test(`${theme}: Compose fills a reference slot from History and submits the image set`, async ({ page }) => {
    const requests = await setup(page, theme);
    await pickTile(page, 2); // leaf is the current image
    await bar(page).getByRole("button", { name: "Compose", exact: true }).click();
    await expect(page.getByRole("button", { name: "Leave Compose mode", exact: true })).toBeVisible();
    const picker = page.getByLabel("Pick reference 1 from history", { exact: true });
    await expect(picker).toContainText("root");
    await picker.selectOption("root");
    await prompt(page).fill("blend them together");
    await page.getByRole("button", { name: "Apply edit", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].op).toBe("compose");
    expect(requests[0].params.images).toContain("leaf"); // the current image
    expect(requests[0].params.images).toContain("root");  // the picked reference
    expect(requests[0].parent_id).toBe("leaf");
  });

  test(`${theme}: a contextual mode shows a Chip and leaves on × and on Esc`, async ({ page }) => {
    const requests = await setup(page, theme);
    await pickTile(page, 0);

    // The × on the chip leaves the mode.
    await bar(page).getByRole("button", { name: "Region", exact: true }).click();
    const leaveRegion = page.getByRole("button", { name: "Leave Region mode", exact: true });
    await expect(leaveRegion).toBeVisible();
    await expect(page.getByLabel("What to change?", { exact: true })).toBeVisible();
    await leaveRegion.click();
    await expect(page.getByRole("button", { name: "Leave Region mode", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("What to change?", { exact: true })).toHaveCount(0);

    // Esc also leaves the mode.
    await bar(page).getByRole("button", { name: "Inpaint", exact: true }).click();
    await expect(page.getByRole("button", { name: "Leave Inpaint mode", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Leave Inpaint mode", exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(0);
  });
}

test("below 780px the action bar moves Outpaint, Remove BG and Compose into More", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  const requests = await setup(page);
  await prompt(page).fill("A ceramic vase");
  const tracking = page.waitForRequest(r => r.url().endsWith("/jobs/job-1") && r.method() === "GET");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await tracking;
  await busDone(page, { job_id: "job-1", media_id: "leaf", elapsed_s: 2 });
  await expect(page.getByAltText("Current image")).toBeVisible();

  const t = bar(page);
  await expect(t).toBeVisible();
  // The four primaries stay at top level; the rest collapse into More.
  await expect(t.getByRole("button", { name: "Region", exact: true })).toBeVisible();
  await expect(t.getByRole("button", { name: "Inpaint", exact: true })).toBeVisible();
  await expect(t.getByRole("button", { name: "Outpaint", exact: true })).toHaveCount(0);
  await expect(t.getByRole("button", { name: "Remove BG", exact: true })).toHaveCount(0);
  await expect(t.getByRole("button", { name: "Compose", exact: true })).toHaveCount(0);
  await t.getByRole("button", { name: "More actions", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Outpaint", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Remove BG", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Compose", exact: true })).toBeVisible();
});

test("Send to agent confirms with a toast", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).drafts = [];
    window.addEventListener("message", (e) => {
      if ((e as MessageEvent).data?.type === "protoagent:chat:compose") (window as any).drafts.push((e as MessageEvent).data);
    });
  });
  await pickTile(page, 0);
  await bar(page).getByRole("button", { name: "Send to agent", exact: true }).click();
  await expect(page.getByText("Added to chat composer", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).drafts.length)).toBe(1);
});

test("§6: the per-slot free-text media reference field is gone", async ({ page }) => {
  await setup(page);
  await pickTile(page, 2);
  // No free-text media-reference inputs survive anywhere.
  await expect(page.getByPlaceholder("enter a media reference", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /reference$/ })).toHaveCount(0);
  // Compose uses a compact dropzone (upload / From History…), not a text field.
  await bar(page).getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.getByLabel("Pick reference 1 from history", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /reference/i })).toHaveCount(0);
});
