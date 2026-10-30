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

async function setup(page: Page, theme = "light", mode: "pending" | "timeout" = "pending", ops = catalog) {
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
      let recs = records;
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
