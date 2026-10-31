import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CatalogEntry, HistoryRecord, WorkflowPayload } from "../src/api";
import {
  buildWorkflowGraph,
  slotFlags,
  wfMaxPerRow,
  workflowDoc,
  workflowLinks,
} from "../src/inspector/graph";

// Read the real static catalog (same pattern as the other specs) so the action
// bar / composer have ops; PYTHON can select a 3.12 env the plugin loads under.
const PY = process.env.PYTHON || "python3";
const catalog: CatalogEntry[] = JSON.parse(execFileSync(PY, ["-c", `
import importlib, json, sys
from pathlib import Path
sys.path.insert(0, str(Path('../tests').resolve()))
from _plugin_testkit import load_plugin
p = load_plugin(Path('..').resolve(), 'protobanana')
c = importlib.import_module(p.__name__ + '.catalog_static')
print(json.dumps(c.build_catalog({})))
`], { encoding: "utf8" }));

const kitCss = readFileSync(fileURLToPath(new URL("./fixtures/plugin-kit.generated.css", import.meta.url)), "utf8");

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#e8bb65"/><circle cx="320" cy="240" r="120" fill="#504550"/></svg>';

const ALIAS = "protolabs/qwen-image";
const WH = "sha256:wh1";

// Nine nodes across five dependency ranks exercise the drawer at realistic graph
// dimensions. The first rank holds FOUR loaders (EmptyLatentImage, two *Loaders,
// VAELoader) — wider than the 720px drawer at the 0.7 min zoom — so it also
// exercises the rank-wrapping (review item 3); plus the width/height slot label.
const WORKFLOW: Omit<WorkflowPayload, "comfy_ui_url"> = {
  workflow: {
    _doc: "Qwen-Image text-to-image. Prompt and seed are substituted per render.",
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "qwen" } },
    "10": { class_type: "VAELoader", inputs: { vae_name: "qwen" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024 } },
    "11": { class_type: "CLIPLoader", inputs: { clip_name: "qwen" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
    "3": { class_type: "KSampler", inputs: { seed: 0, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["10", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } },
  },
  stem: "qwen_image_2_1",
  workflows_hash: WH,
  slots: [{ node_id: "5", input: "width" }, { node_id: "5", input: "height" }, { node_id: "6", input: "text" }, { node_id: "3", input: "seed" }],
};

const records: HistoryRecord[] = [{
  media_id: "leaf", parent_id: null, op: "generate", alias: ALIAS,
  params: { prompt: "A ceramic vase", seed: 42 }, source: "studio",
  job_id: null, created: 1, starred: false, pruned: false,
}];

// =========================================================== unit (host-free)

test("edges are derived from API [node_id, out_idx] links, not from literals", () => {
  const links = workflowLinks(WORKFLOW.workflow);
  const set = new Set(links.map((l) => `${l.source}->${l.target}:${l.input}`));
  expect(set).toEqual(new Set([
    "4->6:clip", "4->3:model", "6->3:positive", "10->8:vae", "3->8:samples", "8->9:images", "4->7:clip", "7->3:negative", "5->3:latent_image",
  ]));
  // Literals (strings, numbers) and arrays that are NOT node refs yield no edge.
  const noEdges = workflowLinks({
    _doc: "x",
    a: { class_type: "N", inputs: { text: "hi", size: [512, 512], seed: 7, miss: ["99", 0] } },
  });
  expect(noEdges).toEqual([]); // size is a 2-array but "512" is no node id; "99" dangles
});

test("slot nodes and their substituted inputs are flagged", () => {
  const flags = slotFlags(WORKFLOW.slots);
  expect([...flags.nodeIds].sort()).toEqual(["3", "5", "6"]);
  expect(flags.inputsByNode["6"]).toEqual(["text"]);
  expect(flags.inputsByNode["3"]).toEqual(["seed"]);
  expect(slotFlags(undefined).nodeIds.size).toBe(0);
});

test("buildWorkflowGraph labels nodes by class_type, flags slots and lays out top→bottom", () => {
  // Default (unbounded canvas): no wrapping, one row per dependency rank.
  const { nodes, edges } = buildWorkflowGraph({ ...WORKFLOW, comfy_ui_url: "" });
  expect(nodes).toHaveLength(9);
  expect(edges).toHaveLength(9);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n.data as Record<string, unknown>]));
  expect(byId["3"].label).toBe("KSampler");
  expect(byId["9"].label).toBe("SaveImage");
  expect(byId["6"].isSlot).toBe(true);
  expect(byId["3"].isSlot).toBe(true);
  expect(byId["4"].isSlot).toBe(false);
  const positions = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
  for (const edge of edges) {
    expect(positions[edge.source].y).toBeLessThan(positions[edge.target].y);
  }
  // All four depth-0 loaders share the first rank; five ranks, five rows.
  for (const id of ["4", "5", "10", "11"]) expect(positions[id].y).toBe(24);
  expect(new Set(nodes.map((n) => n.position.y)).size).toBe(5);
  expect(positions["4"].x).not.toBe(positions["10"].x);
});

test("a rank wider than the drawer wraps onto extra rows (no overflow on open)", () => {
  // wfMaxPerRow(720) == floor(720 / (280 * 0.7)) == 3, so the four-loader first
  // rank wraps into 3 + 1. The widest row never exceeds the cap, and every edge
  // still points downward (top→bottom preserved across the wrap).
  const cap = wfMaxPerRow(720);
  expect(cap).toBe(3);
  const { nodes, edges } = buildWorkflowGraph({ ...WORKFLOW, comfy_ui_url: "" }, cap);
  const positions = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
  const firstRank = ["4", "10", "5", "11"].map((id) => positions[id].y);
  expect(new Set(firstRank).size).toBe(2); // the four loaders now occupy two rows
  // No row holds more than the cap.
  const perRow: Record<number, number> = {};
  for (const n of nodes) perRow[n.position.y] = (perRow[n.position.y] || 0) + 1;
  for (const count of Object.values(perRow)) expect(count).toBeLessThanOrEqual(cap);
  for (const edge of edges) {
    expect(positions[edge.source].y).toBeLessThan(positions[edge.target].y);
  }
  // Narrower drawers wrap harder; a wide one leaves the rank intact; never < 1.
  expect(wfMaxPerRow(760)).toBe(3);
  expect(wfMaxPerRow(300)).toBe(1);
  expect(wfMaxPerRow(10)).toBe(1);
  expect(wfMaxPerRow(2000)).toBeGreaterThanOrEqual(4);
});

test("workflowDoc reads the _doc header and tolerates its absence", () => {
  expect(workflowDoc(WORKFLOW.workflow)).toContain("Qwen-Image");
  expect(workflowDoc({ "1": { class_type: "N" } })).toBe("");
  expect(workflowDoc(undefined)).toBe("");
});

test("the inspector sources use the pbx-* namespace, never the kit's pl-*", () => {
  const dir = fileURLToPath(new URL("../src/inspector", import.meta.url));
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const classTokens = (src: string) => stripComments(src).match(/(?<!-)\bpl-[a-zA-Z0-9-]+/g) ?? [];
  const files = readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const src = readFileSync(`${dir}/${name}`, "utf8");
    expect([...new Set(classTokens(src))], `inspector/${name} must not use the pl-* class namespace`).toEqual([]);
  }
});

// =================================================================== browser

async function setup(page: Page, opts: { theme?: string; comfyUrl?: string } = {}) {
  const theme = opts.theme || "light";
  await page.addInitScript(() => {
    (window as any).pluginKit = {
      initPluginView: () => ({}),
      apiFetch: (path: string, init?: RequestInit) => fetch(`/fixture/${path}`, init),
    };
  });
  await page.route("**/_ds/plugin-kit.css", (route) => route.fulfill({ body: kitCss, contentType: "text/css" }));
  await page.route("**/_ds/plugin-kit.js", (route) => route.fulfill({ body: "", contentType: "text/javascript" }));
  await page.route("**/fixture/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/catalog")) {
      return route.fulfill({ json: { ops: catalog, source: "gateway", stale: false, workflows_hash: WH, warnings: [] } });
    }
    if (path.endsWith("/image")) return route.fulfill({ body: svg, contentType: "image/svg+xml" });
    if (path.endsWith("/history")) return route.fulfill({ json: { records, next_cursor: null } });
    if (path.includes("/workflows/")) {
      const alias = decodeURIComponent(path.split("/workflows/")[1] || "");
      if (alias === ALIAS) return route.fulfill({ json: { ...WORKFLOW, comfy_ui_url: opts.comfyUrl ?? "" } });
      return route.fulfill({ status: 404, json: { detail: `unknown workflow alias '${alias}'` } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`/?theme=${theme}`);
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
}

const drawer = (page: Page) => page.getByRole("dialog", { name: /^Workflow:/ });
const inspectBtn = (page: Page) => page.getByRole("button", { name: "Inspect workflow", exact: true });

// Make a history thumb the current image. Wide: the History column is present;
// narrow (<780px): History is a right drawer opened from a header button.
async function selectImage(page: Page) {
  const narrowBtn = page.getByRole("button", { name: "History", exact: true });
  if (await narrowBtn.count()) {
    await narrowBtn.click();
    await page.locator(".g-thumb").first().click();
  } else {
    await page.locator(".history-col .g-thumb").first().click();
  }
  await expect(page.getByLabel("Image viewport", { exact: true })).toBeVisible();
}

// current image → open the info popover → Inspect workflow → the drawer.
async function openDrawer(page: Page) {
  await selectImage(page);
  await page.getByRole("button", { name: "Image info", exact: true }).click();
  await expect(inspectBtn(page)).toBeEnabled();
  await inspectBtn(page).click();
  await expect(drawer(page)).toBeVisible();
}

test("the drawer renders the workflow read-only: class_type nodes, API edges, flagged slots, _doc header", async ({ page }) => {
  await setup(page);
  await openDrawer(page);
  // _doc as the header.
  await expect(drawer(page)).toContainText("Qwen-Image text-to-image");
  // one node per class_type, labelled by class_type.
  await expect(page.locator(".pbx-wf-node")).toHaveCount(9);
  await expect(page.locator(".pbx-wf-node-title").filter({ hasText: "KSampler" })).toBeVisible();
  // slots flagged (not by colour alone — a data flag and a visible "slot" tag).
  await expect(page.locator('.pbx-wf-node[data-slot="true"]')).toHaveCount(3);
  await expect(page.locator('.pbx-wf-node[data-node-id="6"][data-slot="true"]')).toHaveCount(1);
  await expect(page.locator(".pbx-wf-slot-tag").first()).toContainText("slot");
  // edges derived from the API links.
  await expect(page.locator(".react-flow__edge")).toHaveCount(9);
});

for (const width of [1440, 760]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme} @ ${width}: drawer, graph, popover and tooltip stay inside the view with no scrollbars`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setup(page, { theme, comfyUrl: "http://comfy.local:8188" });
      await openDrawer(page);
      await expect(page.locator(".pbx-wf-node").first()).toBeVisible();

      const within = (b: { x: number; y: number; width: number; height: number }, pad = 1) => {
        expect(b.x).toBeGreaterThanOrEqual(-pad);
        expect(b.y).toBeGreaterThanOrEqual(-pad);
        expect(b.x + b.width).toBeLessThanOrEqual(width + pad);
        expect(b.y + b.height).toBeLessThanOrEqual(900 + pad);
      };

      // The Drawer stays inside the view; the page itself doesn't gain a scrollbar.
      const dBox = (await page.locator(".pbx-wf-drawer").boundingBox())!;
      within(dBox);
      expect(dBox.width).toBeCloseTo(width < 780 ? width : Math.min(720, width / 2), 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // The graph stays inside the Drawer body, and the body has no scrollbars.
      const body = page.locator(".pbx-wf-body");
      const bb = (await body.boundingBox())!;
      const flow = (await page.locator(".pbx-wf-flow .react-flow").boundingBox())!;
      expect(flow.x).toBeGreaterThanOrEqual(bb.x - 1);
      expect(flow.y).toBeGreaterThanOrEqual(bb.y - 1);
      expect(flow.x + flow.width).toBeLessThanOrEqual(bb.x + bb.width + 1);
      expect(flow.y + flow.height).toBeLessThanOrEqual(bb.y + bb.height + 1);
      const overflow = await body.evaluate((el) => getComputedStyle(el).overflow);
      expect(overflow).toBe("hidden");
      const noScroll = await body.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
      expect(noScroll).toBe(true);

      // The info popover doesn't overflow the view.
      within((await page.locator(".image-info").boundingBox())!);

      // Review item 3: EVERY node's bounding box stays horizontally inside the
      // Drawer. The first rank (four loaders) is wider than the Drawer at the
      // 0.7 min zoom, so without wrapping its edge nodes would be clipped left
      // and right. Poll so the check runs once the fit transform has settled.
      const assertNodesInsideDrawer = async () => {
        await expect.poll(async () => {
          const boxes = await page.locator(".pbx-wf-node").evaluateAll((els) =>
            els.map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right }; }));
          return boxes.length === 9
            && boxes.every((b) => b.l >= dBox.x - 1 && b.r <= dBox.x + dBox.width + 1);
        }).toBe(true);
      };

      // Measure screen text after xyflow finishes its initial fit, and after Fit.
      const assertReadable = async () => {
        await expect.poll(async () => page.locator(".pbx-wf-flow .react-flow__viewport").evaluate((el) =>
          new DOMMatrixReadOnly(getComputedStyle(el).transform).a,
        )).toBeGreaterThanOrEqual(0.7);
        for (const [selector, minimum] of [
          [".pbx-wf-node-title", 12], [".pbx-wf-slot-tag", 11],
        ] as const) {
          const sizes = await page.locator(selector).evaluateAll((els) => els.map((el) => {
            const viewport = el.closest(".react-flow__viewport")!;
            const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
            return parseFloat(getComputedStyle(el).fontSize) * zoom;
          }));
          expect(sizes.length).toBeGreaterThan(0);
          for (const size of sizes) expect(size).toBeGreaterThanOrEqual(minimum);
        }
      };
      await assertReadable();
      await assertNodesInsideDrawer();
      await page.getByRole("button", { name: "Fit workflow to view", exact: true }).click();
      await assertReadable();
      await assertNodesInsideDrawer();

      // Both the floating toolbar and the header Close tooltip must be visible
      // and fully inside the viewport (do not silently skip missing tooltips).
      for (const label of ["Fit workflow to view", "Close workflow inspector"]) {
        const wrap = page.locator(`.pbx-wf .pbx-tooltip-wrap:has(button[aria-label="${label}"])`);
        await wrap.locator("button").hover();
        await expect(wrap.getByRole("tooltip")).toBeVisible();
        within((await wrap.getByRole("tooltip").boundingBox())!);
      }

      mkdirSync("../docs/screenshots/images-s10", { recursive: true });
      await page.screenshot({
        path: `../docs/screenshots/images-s10/${theme}${width === 1440 ? "" : "-760"}.png`,
      });
    });
  }
}

test("the Open in ComfyUI link shows only when comfy_ui_url is set", async ({ page }) => {
  await setup(page, { comfyUrl: "" });
  await openDrawer(page);
  await expect(page.locator(".pbx-wf-node").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Open in ComfyUI/ })).toHaveCount(0);
});

test("the Open in ComfyUI link is a safe new-tab link (target _blank, rel noopener noreferrer)", async ({ page }) => {
  await setup(page, { comfyUrl: "http://comfy.local:8188" });
  await openDrawer(page);
  const link = page.getByRole("link", { name: /Open in ComfyUI/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("href", "http://comfy.local:8188");
});

test("opening and closing the drawer returns focus to the Inspect trigger (close button and Esc)", async ({ page }) => {
  await setup(page);
  await openDrawer(page);
  // Close via the close button → focus returns to the trigger, which is still mounted.
  await page.getByRole("button", { name: "Close workflow inspector", exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(inspectBtn(page)).toBeFocused();
  // Re-open, then close via Esc → same focus return.
  await inspectBtn(page).click();
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(inspectBtn(page)).toBeFocused();
});

test("Esc on the drawer does not leave the Inpaint mode, and Playground zoom still works after", async ({ page }) => {
  await setup(page);
  await selectImage(page);

  // Enter Inpaint mode (a mode Chip / leave button appears).
  const bar = page.getByRole("toolbar", { name: "Image actions", exact: true });
  await bar.getByRole("button", { name: "Inpaint", exact: true }).click();
  await expect(page.getByRole("button", { name: "Leave Inpaint mode", exact: true })).toBeVisible();

  // Open the inspector and dismiss it with Esc.
  const infoBtn = page.getByRole("button", { name: "Image info", exact: true });
  await infoBtn.click();
  await inspectBtn(page).click();
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);

  // The mode survived — the drawer's Esc closed only the drawer, not the mode
  // (the capture-phase handler keeps Esc scoped while the drawer is up).
  await expect(page.getByRole("button", { name: "Leave Inpaint mode", exact: true })).toBeVisible();

  // Close the info popover (toggle), then a plain Esc leaves the mode as before —
  // proving the drawer's Esc handler was fully removed on close (no leak).
  await infoBtn.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Leave Inpaint mode", exact: true })).toHaveCount(0);

  // Playground stage zoom / Fit still respond.
  const pct = page.getByRole("button", { name: "Zoom to 100%", exact: true });
  const before = await pct.textContent();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(async () => (await pct.textContent()) !== before).toBe(true);
  await page.getByRole("button", { name: "Fit to stage", exact: true }).click();
});

test("Esc on the drawer does not leave the Outpaint mode either", async ({ page }) => {
  await setup(page);
  await selectImage(page);
  const bar = page.getByRole("toolbar", { name: "Image actions", exact: true });
  await bar.getByRole("button", { name: "Outpaint", exact: true }).click();
  await expect(page.getByRole("button", { name: "Leave Outpaint mode", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Image info", exact: true }).click();
  await inspectBtn(page).click();
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  // The Outpaint mode (its margin handles / numeric inputs) survives the drawer.
  await expect(page.getByRole("button", { name: "Leave Outpaint mode", exact: true })).toBeVisible();
});

test("opening and closing the drawer does not disturb the Pipelines tab", async ({ page }) => {
  await setup(page);
  await openDrawer(page);
  await page.getByRole("button", { name: "Close workflow inspector", exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  // The Pipelines tab still swaps in its own xyflow canvas.
  await page.getByRole("tab", { name: "Pipelines", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add node", exact: true })).toBeVisible();
  // Back to Playground and the Inspect flow still works.
  await page.getByRole("tab", { name: "Playground", exact: true }).click();
  await expect(page.getByRole("button", { name: "Image info", exact: true })).toBeVisible();
});
