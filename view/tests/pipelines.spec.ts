import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CatalogEntry } from "../src/api";
import {
  connectionAllowed,
  graphToSpec,
  inputNodeId,
  makeOpNode,
  OUT_HANDLE,
  paramHandle,
  paramPortType,
  parseSpecText,
  specToGraph,
  type GEdge,
  type GNode,
  type OpNodeData,
  type Spec,
} from "../src/pipelines/pipelines";

// Read the real static catalog (same pattern as playground.spec.ts): the browser
// fixture + the round-trip test evolve with the Python schema.
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

// Run a spec through the REAL pipelines.validate, host-free (SpecError prints as a
// readable message). Returns {ok, error}. The spec is piped on stdin so quoting
// stays clean; we parse the LAST stdout line in case load_plugin logs above it.
function validateSpec(spec: Spec | Record<string, unknown>): { ok: boolean; error: string } {
  const out = execFileSync(PY, ["-c", `
import importlib, json, sys
from pathlib import Path
sys.path.insert(0, str(Path('../tests').resolve()))
from _plugin_testkit import load_plugin
p = load_plugin(Path('..').resolve(), 'protobanana')
pl = importlib.import_module(p.__name__ + '.pipelines')
spec = json.loads(sys.stdin.read())
try:
    pl.validate(spec); print(json.dumps({"ok": True, "error": ""}))
except pl.SpecError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`], { input: JSON.stringify(spec), encoding: "utf8" });
  const line = out.trim().split("\n").filter(Boolean).pop() || "{}";
  return JSON.parse(line);
}

const entry = (op: string) => catalog.find((e) => e.op === op)!;

// A node box is at most 240px wide and ~300px tall; assert an auto-layout leaves
// no two boxes intersecting (the review's overlap finding), which also proves the
// column/row pitches keep the required >=60px / >=32px gaps.
const NODE_W = 240;
const NODE_H = 320;
function assertNoOverlap(nodes: GNode[]) {
  for (const [i, a] of nodes.entries()) {
    for (const b of nodes.slice(i + 1)) {
      const sep = a.position.x + NODE_W <= b.position.x || b.position.x + NODE_W <= a.position.x
        || a.position.y + NODE_H <= b.position.y || b.position.y + NODE_H <= a.position.y;
      expect(sep, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
}

// gen → region edit → bgremove → compose (the acceptance r2 flow), with a text
// input promoted into the generate prompt — exercises BOTH wiring mechanisms
// (ref ports and templated params) and ui.positions.
function buildChain(): { nodes: GNode[]; edges: GEdge[] } {
  const gen = makeOpNode(entry("generate"), { x: 40, y: 40 }, "gen");
  const region = makeOpNode(entry("region_edit"), { x: 300, y: 40 }, "region");
  const bg = makeOpNode(entry("remove_background"), { x: 560, y: 40 }, "bg");
  const comp = makeOpNode(entry("compose"), { x: 820, y: 40 }, "comp");
  (gen.data as OpNodeData).promoted = ["prompt"];
  (region.data as OpNodeData).params = { ...(region.data as OpNodeData).params, grounding: "the sky", prompt: "make it blue" };
  (comp.data as OpNodeData).params = { ...(comp.data as OpNodeData).params, prompt: "combine them" };
  const subject: GNode = { id: inputNodeId("subject"), position: { x: 20, y: 300 }, data: { kind: "input", name: "subject", inputType: "text" } };
  const edges: GEdge[] = [
    { id: "e1", source: inputNodeId("subject"), sourceHandle: OUT_HANDLE, target: "gen", targetHandle: paramHandle("prompt") },
    { id: "e2", source: "gen", sourceHandle: OUT_HANDLE, target: "region", targetHandle: "image" },
    { id: "e3", source: "region", sourceHandle: OUT_HANDLE, target: "bg", targetHandle: "image" },
    { id: "e4", source: "bg", sourceHandle: OUT_HANDLE, target: "comp", targetHandle: "images" },
    { id: "e5", source: "gen", sourceHandle: OUT_HANDLE, target: "comp", targetHandle: "images" },
  ];
  return { nodes: [subject, gen, region, bg, comp], edges };
}

// ======================================================================= unit

test("port types refuse a mismatched connection (image → text), mirroring validate", () => {
  // image output ↔ image/image_list ref ports: allowed.
  expect(connectionAllowed("image", { kind: "ref", type: "image" })).toBe(true);
  expect(connectionAllowed("image", { kind: "ref", type: "image_list" })).toBe(true);
  // image → a text param port: REFUSED (the card's example).
  expect(connectionAllowed("image", { kind: "param", type: "text" })).toBe(false);
  // image → a mask ref port: refused (only a mask feeds a mask).
  expect(connectionAllowed("image", { kind: "ref", type: "mask" })).toBe(false);
  expect(connectionAllowed("mask", { kind: "ref", type: "mask" })).toBe(true);
  // scalars into scalar ports: allowed; image/mask into a seed/int port: refused.
  expect(connectionAllowed("text", { kind: "param", type: "text" })).toBe(true);
  expect(connectionAllowed("seed", { kind: "param", type: "seed" })).toBe(true);
  expect(connectionAllowed("image", { kind: "param", type: "seed" })).toBe(false);
  expect(connectionAllowed("mask", { kind: "param", type: "text" })).toBe(false);
  // param port types mirror pipelines.py _param_port_type.
  expect(paramPortType("seed")).toBe("seed");
  expect(paramPortType("prompt", { type: "string" })).toBe("text");
  expect(paramPortType("left", { type: "integer" })).toBe("int");
});

test("round trip canvas graph → spec → graph preserves steps, refs and ui.positions", () => {
  const g0 = buildChain();
  const spec = graphToSpec(g0.nodes, g0.edges, { id: "chain", name: "Chain" });

  // Steps, inputs, output and positions are all on the spec.
  expect(spec.steps.map((s) => s.id).sort()).toEqual(["bg", "comp", "gen", "region"]);
  expect(spec.inputs).toEqual({ subject: "text" });
  expect(spec.output).toBe("comp");
  const genStep = spec.steps.find((s) => s.id === "gen")!;
  expect(genStep.params?.prompt).toBe("{{inputs.subject}}");
  expect(spec.steps.find((s) => s.id === "region")!.image).toBe("gen");
  expect(spec.steps.find((s) => s.id === "comp")!.images).toEqual(["bg", "gen"]);
  expect(spec.ui?.positions?.["region"]).toEqual({ x: 300, y: 40 });
  expect(spec.ui?.positions?.[inputNodeId("subject")]).toEqual({ x: 20, y: 300 });

  // Re-hydrate and compare node identity, positions and the edge set.
  const g1 = specToGraph(spec, catalog);
  const norm = (g: { nodes: GNode[]; edges: GEdge[] }) => ({
    nodes: Object.fromEntries(g.nodes.map((n) => [n.id, n.data.kind === "op"
      ? `op:${(n.data as OpNodeData).op}` : `input:${n.data.inputType}`])),
    positions: Object.fromEntries(g.nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])),
    edges: [...g.edges.map((e) => `${e.source}|${e.target}|${e.targetHandle}`)].sort(),
  });
  const a = norm(g0);
  const b = norm(g1);
  expect(b.nodes).toEqual(a.nodes);
  expect(b.positions).toEqual(a.positions);
  expect(b.edges).toEqual(a.edges);
});

// Review item 6 (the pure-logic half): a spec that positions only SOME nodes —
// the bundled YAMLs place op steps (as [x,y] tuples) but not the declared input
// nodes — is laid out from scratch, inputs in the first column, left→right, with
// no overlap. (The browser half asserts the same after fitView.)
test("specToGraph auto-lays-out when ui.positions is incomplete; inputs lead, no overlap", () => {
  const spec: Spec = {
    id: "sticker", name: "Sticker",
    inputs: { subject: "text", style: { type: "text", default: "studio" } },
    steps: [
      { id: "gen", op: "generate", params: { prompt: "{{inputs.subject}}, {{inputs.style}}" } },
      { id: "fix", op: "region_edit", image: "gen", params: { grounding: "the label" } },
      { id: "cut", op: "remove_background", image: "fix" },
    ],
    output: "cut",
    // op steps positioned as YAML [x,y] tuples; the two input nodes have none.
    ui: { positions: { gen: [0, 0], fix: [260, 0], cut: [520, 0] } as unknown as Record<string, { x: number; y: number }> },
  };
  const { nodes } = specToGraph(spec, catalog);
  expect(nodes).toHaveLength(5);
  const at = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
  // Auto-layout ran — the op nodes are NOT left at the spec's raw tuple.
  expect(at["gen"]).not.toEqual({ x: 0, y: 0 });
  // Input nodes occupy the leftmost column; the op chain marches left→right.
  const minX = Math.min(...nodes.map((n) => n.position.x));
  expect(at[inputNodeId("subject")].x).toBe(minX);
  expect(at[inputNodeId("style")].x).toBe(minX);
  expect(at["gen"].x).toBeLessThan(at["fix"].x);
  expect(at["fix"].x).toBeLessThan(at["cut"].x);
  assertNoOverlap(nodes);
});

// The inverse: when EVERY node is positioned (a canvas Save writes them all), the
// saved layout is honoured verbatim — including [x,y] tuples normalised to {x,y}
// (acceptance r4 — positions survive a reload).
test("specToGraph honours a complete position set and normalises [x,y] tuples", () => {
  const spec: Spec = {
    id: "p", name: "P",
    inputs: { pic: "image" },
    steps: [{ id: "edit1", op: "edit", image: "inputs.pic", params: { prompt: "x" } }],
    ui: { positions: {
      [inputNodeId("pic")]: [11, 22],
      edit1: { x: 300, y: 40 },
    } as unknown as Record<string, { x: number; y: number }> },
  };
  const at = Object.fromEntries(specToGraph(spec, catalog).nodes.map((n) => [n.id, n.position]));
  expect(at[inputNodeId("pic")]).toEqual({ x: 11, y: 22 });
  expect(at["edit1"]).toEqual({ x: 300, y: 40 });
});

// The round trip must carry the fields the backend uses but the canvas doesn't
// render as graph: the spec `description`/`expose_as_tool` (so a pipeline keeps
// its agent-tool exposure — pipeline_tool_factory requires expose_as_tool) and
// every step `alias` (so a step keeps its gateway model — _resolve_alias prefers
// step.alias). Regression for the review's confirmed Save-drops-fields finding.
test("round trip preserves step.alias and the description/expose_as_tool metadata", () => {
  const gen = makeOpNode(entry("generate"), { x: 40, y: 40 }, "gen");
  (gen.data as OpNodeData).alias = "protolabs/qwen-image";
  const spec = graphToSpec([gen], [], {
    id: "tool", name: "Tool", description: "An exposed pipeline", expose_as_tool: true,
  });
  expect(spec.description).toBe("An exposed pipeline");
  expect(spec.expose_as_tool).toBe(true);
  expect(spec.steps.find((s) => s.id === "gen")!.alias).toBe("protolabs/qwen-image");
  expect(validateSpec(spec)).toEqual({ ok: true, error: "" });

  // specToGraph restores the alias onto the op node, so a re-save keeps it.
  const g = specToGraph(spec, catalog);
  expect((g.nodes.find((n) => n.id === "gen")!.data as OpNodeData).alias).toBe("protolabs/qwen-image");
});

// The import picker offers both .json and .yaml/.yml (the formats the backend
// `_load_text_spec` reads); parseSpecText must handle both. Regression for the
// confirmed "picker offers YAML, import only runs JSON.parse" finding.
test("parseSpecText reads both JSON and YAML specs and rejects non-objects", () => {
  const fromJson = parseSpecText('{"id":"j","steps":[{"id":"gen","op":"generate"}]}');
  expect(fromJson.id).toBe("j");
  const fromYaml = parseSpecText("id: y\nname: Y\nsteps:\n  - id: gen\n    op: generate\n");
  expect(fromYaml.id).toBe("y");
  expect(fromYaml.steps[0].op).toBe("generate");
  expect(() => parseSpecText("just a scalar")).toThrow();
  expect(() => parseSpecText("")).toThrow();
});

test("a canvas-saved spec passes the real pipelines.validate; an image→text spec is refused", () => {
  const g = buildChain();
  const spec = graphToSpec(g.nodes, g.edges, { id: "chain", name: "Chain" });
  const good = validateSpec(spec);
  expect(good, `canvas spec should validate, got: ${good.error}`).toEqual({ ok: true, error: "" });

  // The same rule the UI enforces (connectionAllowed), proven against the backend:
  // an image input wired into a text param is a port-type mismatch.
  const bad = validateSpec({
    id: "bad",
    inputs: { pic: "image" },
    steps: [{ id: "gen", op: "generate", params: { prompt: "{{inputs.pic}}" } }],
  });
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/mismatch|text parameter/i);
});

// R6: the pl- class scan (the same guard as playground.spec's pbx test), now
// covering the new pipelines sources. Only `--pl-*` design TOKENS are allowed.
test("pipelines sources use the pbx-* namespace, never the kit's pl-*", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const classTokens = (src: string) => stripComments(src).match(/(?<!-)\bpl-[a-zA-Z0-9-]+/g) ?? [];
  const sources = {
    "pipelines/pipelines.ts": read("../src/pipelines/pipelines.ts"),
    "pipelines/Canvas.tsx": read("../src/pipelines/Canvas.tsx"),
  };
  for (const [name, src] of Object.entries(sources)) {
    expect([...new Set(classTokens(src))], `${name} must not use the pl-* class namespace`).toEqual([]);
  }
});

// ==================================================================== browser

const bundled = readdirSync("../pipelines").filter((n) => /\.(yaml|yml|json)$/.test(n))
  .map((n) => parseSpecText(readFileSync(`../pipelines/${n}`, "utf8")));

const kitCss = readFileSync(fileURLToPath(new URL("./fixtures/plugin-kit.generated.css", import.meta.url)), "utf8");

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#e8bb65"/><circle cx="320" cy="240" r="120" fill="#504550"/></svg>';

interface SetupResult { save: Record<string, unknown>[]; run: { id: string; inputs: unknown }[]; resume: string[]; polls: number; historyReads: number }

async function setup(page: Page, opts: { theme?: string; seed?: Spec; history?: unknown[]; pollStatus?: "done" | "failed" } = {}): Promise<SetupResult> {
  const theme = opts.theme || "light";
  const result: SetupResult = { save: [], run: [], resume: [], polls: 0, historyReads: 0 };
  await page.addInitScript((seed) => {
    (window as any).__kb = [];
    window.addEventListener("message", (e) => {
      if ((e as MessageEvent).data?.type === "protoagent:keybindings") (window as any).__kb.push((e as MessageEvent).data);
    });
    (window as any).pluginKit = {
      initPluginView: () => ({}),
      apiFetch: (path: string, init?: RequestInit) => fetch(`/fixture/${path}`, init),
    };
    try {
      window.localStorage.clear();
      if (seed) {
        window.localStorage.setItem("protobanana.pipelines.specs", JSON.stringify({ [(seed as any).id]: seed }));
        window.localStorage.setItem("protobanana.pipelines.last", (seed as any).id);
      }
    } catch { /* ignore */ }
  }, opts.seed ?? null);

  // Serve the VENDORED kit CSS (card rule 2) so geometry runs against the real
  // tokens + .pl-* rules; the kit JS is stubbed (the window.pluginKit above wins).
  await page.route("**/_ds/plugin-kit.css", (route) => route.fulfill({ body: kitCss, contentType: "text/css" }));
  await page.route("**/_ds/plugin-kit.js", (route) => route.fulfill({ body: "", contentType: "text/javascript" }));

  await page.route("**/fixture/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path.endsWith("/catalog")) return route.fulfill({ json: { ops: [...catalog, { op: "protolabs/qwen-image", label: "protolabs/qwen-image" }, { op: "unknown", label: "" }], source: "gateway" } });
    if (path.endsWith("/image")) return route.fulfill({ body: svg, contentType: "image/svg+xml" });
    if (path.endsWith("/history")) {
      result.historyReads++;
      return route.fulfill({ json: { records: opts.history ?? [], next_cursor: null } });
    }
    if (path.endsWith("/pipelines") && method === "POST") {
      const body = route.request().postDataJSON();
      result.save.push(body);
      return route.fulfill({ json: { id: body.id, source: "saved" } });
    }
    if (path.endsWith("/pipelines")) return route.fulfill({ json: { pipelines: bundled.map((spec) => ({ id: spec.id, name: spec.name, source: "bundled", read_only: false, spec })) } });
    if (path.endsWith("/run") && method === "POST") {
      const m = path.match(/pipelines\/([^/]+)\/run/);
      result.run.push({ id: m?.[1] || "", inputs: route.request().postDataJSON()?.inputs });
      return route.fulfill({ status: 202, json: { run_id: "run-1" } });
    }
    if (path.includes("/resume")) {
      result.resume.push(url.search);
      return route.fulfill({ json: { resumed: true } });
    }
    if (path.includes("/runs/")) {
      result.polls++;
      // Poll backstop: a live run with no node rows, so only the bus drives state.
      return route.fulfill({ json: { run_id: "run-1", pipeline: "demo", status: opts.pollStatus ?? "running", order: [], output: null, output_media_id: null, cache_hits: 0, error: null, nodes: {} } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto(`/?theme=${theme}`);
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  return result;
}

const bus = (page: Page, topic: string, data: Record<string, unknown>) =>
  page.evaluate(({ topic, data }) => window.postMessage({ type: "protoagent:event", topic, data }, "*"), { topic, data });

const openPipelines = async (page: Page) => {
  await page.getByRole("tab", { name: "Pipelines", exact: true }).click();
};

const chain2: Spec = {
  id: "demo", name: "Demo",
  steps: [
    { id: "gen", op: "generate", params: { prompt: "a cat" } },
    { id: "edit1", op: "edit", image: "gen", params: { prompt: "make it blue" } },
  ],
  output: "edit1",
  ui: { positions: { gen: { x: 60, y: 90 }, edit1: { x: 340, y: 90 } } },
};

test("the Pipelines tab is enabled and swaps only the body; the header is unchanged", async ({ page }) => {
  await setup(page);
  // Header pieces present on Playground.
  await expect(page.getByRole("heading", { name: "Images" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New", exact: true })).toBeVisible();
  const pipelinesTab = page.getByRole("tab", { name: "Pipelines", exact: true });
  await expect(pipelinesTab).not.toBeDisabled();

  await openPipelines(page);
  // Body swapped: the graph toolbar is present, the composer is gone.
  await expect(page.getByRole("button", { name: "Add node", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toHaveCount(0);
  // Header unchanged across the swap.
  await expect(page.getByRole("heading", { name: "Images" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New", exact: true })).toBeVisible();
});

test("delete/copy/paste/fit keybindings are declared through the protoagent bridge", async ({ page }) => {
  await setup(page);
  await openPipelines(page);
  await expect.poll(() => page.evaluate(() => (window as any).__kb.length)).toBeGreaterThan(0);
  const ids = await page.evaluate(() => (window as any).__kb[0].bindings.map((b: any) => b.id).sort());
  expect(ids).toEqual(["copy", "delete", "fit", "paste"]);
  const scope = await page.evaluate(() => (window as any).__kb[0].scope);
  expect(scope).toBe("protobanana.pipelines");
});

test("run → each node shows its thumbnail from the bus events", async ({ page }) => {
  const captured = await setup(page, { seed: chain2 });
  await openPipelines(page);
  // The seeded graph restored from localStorage.
  await expect(page.locator(".pbx-node--op")).toHaveCount(2);

  // Select a node and run the whole pipeline.
  await page.locator(".react-flow__node").filter({ hasText: "Generate" }).click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => captured.run.length).toBe(1);
  expect(captured.save.length).toBeGreaterThan(0); // Run saves first

  // Per-node completion over the bus paints each node's thumbnail.
  await bus(page, "protobanana.pipeline.node.started", { run_id: "run-1", step: "gen", op: "generate", alias: "a" });
  await bus(page, "protobanana.pipeline.node.done", { run_id: "run-1", step: "gen", op: "generate", alias: "a", media_id: "m-gen", cached: false, elapsed_s: 3 });
  await bus(page, "protobanana.pipeline.node.done", { run_id: "run-1", step: "edit1", op: "edit", alias: "b", media_id: "m-edit", cached: false, elapsed_s: 4 });

  await expect(page.getByAltText("Generate output")).toBeVisible();
  await expect(page.getByAltText("Edit output")).toBeVisible();
});

test("a recoverable node failure shows Re-run from here, which resumes from that step", async ({ page }) => {
  await page.clock.install();
  const captured = await setup(page, { seed: chain2 });
  await openPipelines(page);
  await page.locator(".react-flow__node").filter({ hasText: "Generate" }).click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => captured.run.length).toBe(1);

  await bus(page, "protobanana.pipeline.node.done", { run_id: "run-1", step: "gen", op: "generate", media_id: "m-gen", cached: false });
  await bus(page, "protobanana.pipeline.node.failed", { run_id: "run-1", step: "edit1", op: "edit", recoverable: true, error: "GPU busy", error_kind: "gateway_timeout", hint: "may still finish" });
  await bus(page, "protobanana.pipeline.run.done", { run_id: "run-1", pipeline: "demo", status: "failed", output_media_ids: [] });

  const rerun = page.getByText("Re-run from here", { exact: true });
  await expect(rerun).toBeVisible();
  await rerun.click();
  await expect.poll(() => captured.resume.length).toBe(1);
  expect(captured.resume[0]).toContain("from_step=edit1");
  await expect(page.locator(".pbx-graph-toolbar .rendering-badge")).toBeVisible();
  const polls = captured.polls;
  await page.clock.fastForward(2600);
  await expect.poll(() => captured.polls).toBeGreaterThan(polls);
});

// R7: with the vendored kit CSS, geometry holds at 1440 and 760, light + dark.
for (const theme of ["light", "dark"]) {
  for (const width of [1440, 760]) {
    test(`${theme} @ ${width}px: nothing overflows, no stage scrollbars, nodes inside the stage`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setup(page, { theme, seed: buildChainSpec() });
      await openPipelines(page);
      await page.locator(".react-flow__node").first().click(); // populate the inspector
      await expect(page.locator(".pbx-node--op").first()).toBeVisible();

      const view = page.locator(".images");
      const viewBox = (await view.boundingBox())!;
      const viewRight = viewBox.x + viewBox.width;

      // No column overflows its own width.
      const fits = async (sel: string) => {
        const el = page.locator(sel).first();
        if (await el.count() === 0) return;
        const m = await el.evaluate((n) => ({ sw: n.scrollWidth, cw: n.clientWidth }));
        expect(m.sw, `${sel} scrollWidth ≤ clientWidth`).toBeLessThanOrEqual(m.cw + 1);
      };
      await fits(".pbx-pipelines");
      await fits(".pbx-inspector");
      if (width >= 780) await fits(".history-col");

      // The stage shows no scrollbars.
      const stage = await page.locator(".pbx-graph-stage").evaluate((el) => ({
        sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
      }));
      expect(stage.sw).toBe(stage.cw);
      expect(stage.sh).toBe(stage.ch);

      // Graph nodes stay inside the stage.
      const stageBox = (await page.locator(".pbx-graph-stage").boundingBox())!;
      const nodes = page.locator(".react-flow__node");
      for (let i = 0; i < (await nodes.count()); i++) {
        const b = (await nodes.nth(i).boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(stageBox.x - 1);
        expect(b.y).toBeGreaterThanOrEqual(stageBox.y - 1);
        expect(b.x + b.width).toBeLessThanOrEqual(stageBox.x + stageBox.width + 1);
        expect(b.y + b.height).toBeLessThanOrEqual(stageBox.y + stageBox.height + 1);
      }

      // Tooltips stay inside the view.
      await page.getByRole("button", { name: "Fit to view", exact: true }).hover();
      const tip = page.locator(".view-toolbar .pbx-tooltip").first();
      const tb = await tip.boundingBox();
      if (tb) {
        expect(tb.x).toBeGreaterThanOrEqual(viewBox.x - 1);
        expect(tb.x + tb.width).toBeLessThanOrEqual(viewRight + 1);
      }

      // No horizontal page scroll.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

function buildChainSpec(): Spec {
  const g = buildChain();
  return graphToSpec(g.nodes, g.edges, { id: "chain", name: "Chain" });
}

// Review item 6: after a load the view must be FITTED (auto-layout runs when the
// spec doesn't position every node — the bundled YAMLs place op steps but not the
// declared input nodes) and after an add the new node must be fully on-canvas, not
// half-off at x=-44. Read the node boxes against the stage box and assert every box
// is inside the stage and no two intersect.
async function layout(page: Page): Promise<{ count: number; inside: boolean; disjoint: boolean }> {
  const stage = (await page.locator(".pbx-graph-stage").boundingBox())!;
  const boxes = await page.locator(".react-flow__node").evaluateAll((ns) =>
    ns.map((n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
  const inside = boxes.every((b) =>
    b.x >= stage.x - 1 && b.y >= stage.y - 1 &&
    b.x + b.w <= stage.x + stage.width + 1 && b.y + b.h <= stage.y + stage.height + 1);
  const disjoint = boxes.every((a, i) => boxes.slice(i + 1).every((b) =>
    a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y));
  return { count: boxes.length, inside, disjoint };
}

for (const width of [1440, 760]) {
  test(`item 6 @ ${width}px: added nodes stay on-canvas and each bundled pipeline loads fitted + non-overlapping`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    await openPipelines(page);

    // Build gen → region edit → remove background from an empty canvas; each new
    // node must be fully inside the canvas (the x=-44 half-off finding).
    for (const [i, label] of ["Generate", "Region edit", "Remove background"].entries()) {
      await page.getByRole("button", { name: "Add node", exact: true }).click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      await expect(page.locator(".react-flow__node")).toHaveCount(i + 1);
      await expect.poll(async () => (await layout(page)).inside).toBe(true);
    }

    // Load each bundled pipeline: auto-layout + fitView put every node inside the
    // stage with no two boxes overlapping (the "Product sticker off the left edge,
    // style input overlapping" finding).
    for (const spec of bundled) {
      await page.getByRole("button", { name: "Pipeline menu", exact: true }).click();
      await page.getByRole("option", { name: spec.name, exact: true }).click();
      const expected = spec.steps.length + Object.keys(spec.inputs || {}).length;
      await expect(page.locator(".react-flow__node")).toHaveCount(expected);
      await expect.poll(async () => layout(page)).toEqual({ count: expected, inside: true, disjoint: true });
    }
  });
}

// Capture the PR screenshots (light / dark / narrow). Committed under
// docs/screenshots/images-s8/ as the branch's visual evidence. Shot with the
// "Product sticker" bundled pipeline LOADED (review item 6): it auto-lays out and
// fitView frames it, so the shots prove the previously off-canvas graph now fits.
const sticker = bundled.find((s) => s.id === "product-sticker")!;
for (const [name, theme, width] of [["light", "light", 1440], ["dark", "dark", 1440], ["narrow", "light", 760]] as const) {
  test(`screenshot: pipelines ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { theme });
    await openPipelines(page);
    await page.getByRole("button", { name: "Pipeline menu", exact: true }).click();
    await page.getByRole("option", { name: sticker.name, exact: true }).click();
    const count = sticker.steps.length + Object.keys(sticker.inputs || {}).length;
    await expect(page.locator(".react-flow__node")).toHaveCount(count);
    await expect.poll(async () => layout(page)).toEqual({ count, inside: true, disjoint: true });
    await page.locator(".pbx-node--op").first().click(); // populate the inspector
    await page.waitForTimeout(200); // let fitView settle
    mkdirSync("../docs/screenshots/images-s8", { recursive: true });
    await page.screenshot({ path: `../docs/screenshots/images-s8/${name}.png`, fullPage: true });
  });
}

// R8: Playground → Pipelines → Playground preserves the current image and the
// zoom/pan/Fit + Inpaint/Outpaint gestures (the Playground subtree stays mounted).
const records = ["root"].map((id) => ({
  media_id: id, parent_id: null, op: "generate", alias: "protolabs/qwen-image",
  params: { prompt: "A ceramic vase", seed: 42 }, source: "studio", job_id: null, created: 1, starred: false, pruned: false,
}));

const viewBar = (page: Page) => page.getByRole("toolbar", { name: "View controls", exact: true });

for (const width of [1440, 760]) {
  for (const source of ["history", "focus"] as const) {
    test(`${source} selection from Pipelines shows Playground at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setup(page, { history: records });
      await openPipelines(page);
      if (width < 780) await page.getByRole("button", { name: "History", exact: true }).click();
      if (source === "history") {
        await page.locator(".g-thumb").first().click();
      } else {
        await page.evaluate(() => window.postMessage({ type: "protobanana:focus", focus: "root" }, location.origin));
      }
      await expect(page.getByRole("tab", { name: "Playground", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByAltText("Current image", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator(".pbx-graph-stage")).toBeHidden();
    });
  }
}

test("an unknown focus from Pipelines shows the Playground error", async ({ page }) => {
  await setup(page);
  await openPipelines(page);
  await page.evaluate(() => window.postMessage({ type: "protobanana:focus", focus: "missing" }, location.origin));
  await expect(page.getByRole("tab", { name: "Playground", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".focus-error")).toContainText("Image missing is not in Studio history");
});

async function roundTrip(page: Page) {
  // Select a History image on Playground, round-trip to Pipelines and back.
  await page.locator(".g-thumb").first().click();
  await expect(page.getByAltText("Current image", { exact: true })).toBeVisible();
  await openPipelines(page);
  await expect(page.getByRole("button", { name: "Add node", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Playground", exact: true }).click();
  // The current image survived the round trip (state was never unmounted).
  await expect(page.getByAltText("Current image", { exact: true })).toBeVisible();
}

test("after Playground → Pipelines → Playground, wheel zoom, drag pan and Fit still work", async ({ page }) => {
  await setup(page, { history: records });
  await roundTrip(page);

  const img = page.getByAltText("Current image", { exact: true });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);
  const box = () => img.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, w: r.width }; });
  const fitted = await box();

  const vb = (await page.getByLabel("Image viewport", { exact: true }).boundingBox())!;
  const c = { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, -400);
  expect((await box()).w).toBeGreaterThan(fitted.w + 20); // wheel zoom grows the image

  const zoomedX = (await box()).x;
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 40, { steps: 4 });
  await page.mouse.up();
  expect((await box()).x - zoomedX).toBeGreaterThan(40); // drag pans

  await viewBar(page).getByRole("button", { name: "Fit to stage", exact: true }).click();
  expect(Math.abs((await box()).w - fitted.w)).toBeLessThan(1); // Fit restores
});

test("after the round trip, Inpaint still paints a mask and Outpaint margins still drag", async ({ page }) => {
  const requests: { op: string; params: Record<string, unknown> }[] = [];
  await setup(page, { history: records });
  // Registered AFTER setup so it takes precedence over the broad /fixture/** route.
  await page.route("**/fixture/jobs", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { job_id: `job-${requests.length}` } });
  });
  await roundTrip(page);
  const bar = page.getByRole("toolbar", { name: "Image actions", exact: true });

  // Inpaint: the mask canvas paints, and Apply edit submits an inpaint with a mask.
  await bar.getByRole("button", { name: "Inpaint", exact: true }).click();
  const canvas = page.getByLabel("Mask canvas", { exact: true }).locator("canvas").first();
  await expect(canvas).toBeVisible();
  const cb = (await canvas.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + 10, cb.y + cb.height / 2 + 8, { steps: 3 });
  await page.mouse.up();
  await page.getByLabel("Prompt", { exact: true }).fill("a patch of blue sky");
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].op).toBe("inpaint");
  expect(requests[0].params.mask).toBeTruthy();

  // Outpaint: a handle drag updates a margin number.
  await bar.getByRole("button", { name: "Outpaint", exact: true }).click();
  const left = page.getByLabel("Left", { exact: true });
  await expect(left).toBeVisible();
  await left.fill("64");
  await expect(left).toHaveValue("64");
});


// Renaming must keep both reference wires and template wires, including across
// successive keystrokes, and refuse collisions with another input.
test("input rename preserves selection, wires and saved positions", async ({ page }) => {
  const seed: Spec = {
    id: "rename", inputs: { pic: "image", subject: "text" },
    steps: [{ id: "edit1", op: "edit", image: "inputs.pic", params: { prompt: "{{inputs.subject}}" } }],
    ui: { positions: { [inputNodeId("pic")]: { x: 20, y: 30 }, [inputNodeId("subject")]: { x: 20, y: 180 }, edit1: { x: 350, y: 60 } } },
  };
  const captured = await setup(page, { seed });
  await openPipelines(page);
  await page.locator(".react-flow__node").filter({ hasText: "pic" }).click();
  const name = page.getByRole("textbox", { name: "Input name", exact: true });
  await name.fill("photo");
  await name.press("End");
  await name.pressSequentially("_new");
  await expect(name).toHaveValue("photo_new");
  await name.fill("subject");
  await expect(name).toHaveValue("photo_new");
  await page.locator(".react-flow__node").filter({ hasText: "subject" }).click();
  await expect(name).toHaveValue("subject");
  await name.fill("caption");
  await page.getByRole("button", { name: "Pipeline menu", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => captured.save.length).toBe(1);
  const saved = captured.save[0] as unknown as Spec;
  expect(saved.steps[0].image).toBe("photo_new");
  expect(saved.steps[0].params?.prompt).toBe("{{inputs.caption}}");
  expect(saved.ui?.positions?.[inputNodeId("photo_new")]).toEqual({ x: 20, y: 30 });
  expect(validateSpec(saved)).toEqual({ ok: true, error: "" });
});

// Loading a spec, then Save, must not drop the fields the canvas doesn't render
// as graph. End-to-end proof (openSpec → currentSpec → POST /pipelines) of the
// review's confirmed Save-drops-fields finding.
test("Save keeps a loaded spec's description, expose_as_tool and step alias", async ({ page }) => {
  const seed: Spec = {
    id: "exposed", name: "Exposed",
    description: "A pipeline exposed as an agent tool",
    expose_as_tool: true,
    steps: [{ id: "gen", op: "generate", alias: "protolabs/qwen-image", params: { prompt: "a cat" } }],
    output: "gen",
    ui: { positions: { gen: { x: 60, y: 90 } } },
  };
  const captured = await setup(page, { seed });
  await openPipelines(page);
  await expect(page.locator(".pbx-node--op")).toHaveCount(1);
  await page.getByRole("button", { name: "Pipeline menu", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => captured.save.length).toBe(1);
  const saved = captured.save[0] as unknown as Spec;
  expect(saved.description).toBe("A pipeline exposed as an agent tool");
  expect(saved.expose_as_tool).toBe(true);
  expect(saved.steps.find((s) => s.id === "gen")?.alias).toBe("protolabs/qwen-image");
  expect(validateSpec(saved)).toEqual({ ok: true, error: "" });
});

for (const terminal of ["done", "failed"] as const) {
  for (const source of ["bus", "poll"] as const) {
    test(`terminal ${terminal} via ${source} stops polling and refreshes history once`, async ({ page }) => {
      await page.clock.install();
      const captured = await setup(page, { seed: chain2, pollStatus: source === "poll" ? terminal : undefined });
      await openPipelines(page);
      await page.locator(".react-flow__node").filter({ hasText: "Generate" }).click();
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect.poll(() => captured.run.length).toBe(1);
      const before = captured.historyReads;
      if (source === "bus") {
        await bus(page, "protobanana.pipeline.run.done", { run_id: "run-1", status: terminal });
      } else {
        await page.clock.fastForward(2600);
      }
      await expect.poll(() => captured.historyReads).toBe(before + 2);
      const reads = captured.historyReads;
      const polls = captured.polls;
      await page.clock.fastForward(10000);
      expect(captured.polls).toBe(polls);
      expect(captured.historyReads).toBe(reads);
    });
  }

  test(`inspector edits after ${terminal} save and run the updated spec`, async ({ page }) => {
    const captured = await setup(page, { seed: chain2 });
    await openPipelines(page);
    await page.locator(".react-flow__node").filter({ hasText: "Edit" }).click();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect.poll(() => captured.run.length).toBe(1);
    await bus(page, "protobanana.pipeline.run.done", { run_id: "run-1", status: terminal });
    await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("make it green");
    await page.getByRole("button", { name: "Run from here", exact: true }).click();
    await expect.poll(() => captured.run.length).toBe(2);
    expect(captured.resume).toEqual([]);
    expect(captured.save).toHaveLength(2);
    const saved = captured.save[1] as unknown as Spec;
    expect(saved.steps.find((s) => s.id === "edit1")?.params?.prompt).toBe("make it green");
  });
}

for (const mode of ["Inpaint", "Outpaint"]) {
  test(`Escape in Pipelines preserves Playground ${mode} edits`, async ({ page }) => {
    await setup(page, { history: records });
    await page.locator(".g-thumb").first().click();
    await page.getByRole("toolbar", { name: "Image actions", exact: true })
      .getByRole("button", { name: mode, exact: true }).click();
    let mask = "";
    const canvas = page.getByLabel("Mask canvas", { exact: true }).locator("canvas").first();
    if (mode === "Inpaint") {
      await expect(canvas).toBeVisible();
      const cb = (await canvas.boundingBox())!;
      await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
      await page.mouse.down();
      await page.mouse.move(cb.x + cb.width / 2 + 30, cb.y + cb.height / 2 + 30, { steps: 3 });
      await page.mouse.up();
      mask = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL());
    } else {
      await page.getByLabel("Left", { exact: true }).fill("96");
    }
    await openPipelines(page);
    await page.getByRole("button", { name: "Add node", exact: true }).focus();
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Playground", exact: true }).click();
    await expect(page.getByRole("button", { name: "Apply edit", exact: true })).toBeVisible();
    if (mode === "Inpaint") {
      await expect(canvas).toBeVisible();
      expect(await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL())).toBe(mask);
    } else {
      await expect(page.getByLabel("Left", { exact: true })).toHaveValue("96");
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: `Leave ${mode} mode`, exact: true })).toHaveCount(0);
  });
}

for (const theme of ["light", "dark"]) {
  for (const width of [1440, 760]) {
    test(`review regressions ${theme} ${width}: readable non-overlapping nodes and usable menus`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await setup(page, { theme });
      await openPipelines(page);
      await page.getByRole("button", { name: "Pipeline menu", exact: true }).click();
      const slot = (await page.locator(".pbx-inspector-slot").boundingBox())!;
      const empty = (await page.locator(".pbx-inspector-empty").boundingBox())!;
      expect(empty.y).toBeGreaterThanOrEqual(slot.y);
      expect(empty.y + empty.height).toBeLessThanOrEqual(slot.y + slot.height);
      expect(slot.y + slot.height).toBeLessThanOrEqual(1000);
      await page.getByRole("button", { name: "Pipeline menu", exact: true }).click();
      for (const label of ["Generate", "Remove background", "Edit"]) {
        await page.getByRole("button", { name: "Add node", exact: true }).click();
        const labels = await page.getByRole("menuitem").allTextContents();
        expect(labels).toEqual(["Text", "Image", "Mask", "Generate", "Edit", "Region edit", "Inpaint", "Outpaint", "Remove background", "Compose"]);
        await page.getByRole("menuitem", { name: label, exact: true }).click();
        await expect(page.getByRole("menu")).toHaveCount(0);
      }
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      await expect(page.locator(".react-flow__edge")).toHaveCount(2);
      const boxes = await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((n) => {
        const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
      }));
      for (const [i, a] of boxes.entries()) {
        expect(a.w).toBeGreaterThanOrEqual(180);
        expect(a.w).toBeLessThanOrEqual(320);
        for (const b of boxes.slice(i + 1)) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
      for (const spec of bundled) {
        await page.getByRole("button", { name: "Pipeline menu", exact: true }).click();
        await page.getByRole("option", { name: spec.name, exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Pipeline", exact: true })).toHaveCount(0);
        await expect(page.locator(".react-flow__node")).toHaveCount(spec.steps.length + Object.keys(spec.inputs || {}).length);
        expect(await page.locator(".react-flow__node").count()).toBeGreaterThanOrEqual(2);
        await expect.poll(() => page.locator(".react-flow__edge").count()).toBeGreaterThanOrEqual(1);
      }
    });
  }
}


test("read-only pipelines open for inspection and become editable through Duplicate", async ({ page }) => {
  await setup(page);
  const spec = bundled[0];
  await page.route("**/fixture/pipelines", (route) => route.fulfill({ json: { pipelines: [
    { id: spec.id, name: spec.name, source: "another-plugin", read_only: true, spec },
  ] } }));
  await openPipelines(page);
  // Refresh the listing via Save, since the canvas may have mounted before this route.
  await page.getByRole("button", { name: "Pipeline menu", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("option").filter({ hasText: spec.name }).click();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add node", exact: true })).toBeDisabled();
  await expect.poll(() => page.locator(".react-flow__edge").count()).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add node", exact: true })).toBeEnabled();
  await expect(page.getByText("Read-only", { exact: true })).toHaveCount(0);
});
