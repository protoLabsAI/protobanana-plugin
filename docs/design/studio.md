# protoBanana Studio: a console view for driving the image models by hand

Status: design proposal (research + options + epic). Author: Claude, for Josh. Date: 2026-10-29.

The ask: a full **protoBanana console view** in protoAgent where an operator plays with the
image models directly, without the agent, with a workflow experience that "feels like
ComfyUI". Josh also asked whether we could just render ComfyUI's own UI.

**Short answer.**

- **Can we render ComfyUI's UI?** Technically yes, as a link-out or a cross-origin iframe of
  the ComfyUI server that already runs on the GPU host. As *the product*, no. It bypasses the
  gateway (ADR 0008's "inference pinned to the gateway"), ComfyUI has no auth of its own, it
  only works from a browser that can reach the tailnet host, and results never reach the media
  store or the agent. Proxying it through protoAgent instead breaks the egress model and puts a
  third-party GPL app on the console's origin. Bundling the frontend into our MIT app brings in
  GPL-3.0 obligations. Keep it as an **"Open in ComfyUI" escape hatch** for workflow authors.
- **Recommendation: build "protoBanana Studio" as a plugin view in `protobanana-plugin`,** in
  three layers shipped in order:
  1. **Playground**: pick an operation, fill typed params, generate, compare, branch edits,
     paint masks, see a gallery. This is the first deliverable.
  2. **Pipelines**: a node canvas (xyflow, MIT) that chains *our operations* (gen, region edit,
     bgremove, compose, and so on) into saved, rerunnable, shareable pipelines. The agent can
     also run a saved pipeline as a tool. This layer is where the "feels like ComfyUI" comes from.
  3. **Raw ComfyUI graphs**: deferred. At most, a read-only view of the workflow behind an
     alias plus a deep link into ComfyUI to author it.
- **Everything goes through the gateway.** The only backend change is a small
  **catalog/schema endpoint** in protoBanana, so the view renders its forms from data instead
  of hardcoding them. Core changes stay small: two seams, both generic.

---

## 1. What exists today (the ground truth)

### 1.1 The plugin: `protobanana-plugin` v0.3.0 (MIT)

- **Seven agent tools:** `generate_image`, `edit_image`, `identity_edit`, `region_edit`,
  `remove_background`, `compose_images`, `outpaint_image`
  (`protobanana-plugin/tools.py:52-54`).
- **Three call shapes**, all on `graph.sdk.gateway_client()` (`client.py:1-14`):
  - `POST /images/generations` (JSON; `client.py:45-56`).
  - `POST /images/edits` (multipart; extra knobs ride as form fields: `grounding`,
    `grounding_px`, `person_image`, outpaint margins, `seed`; an optional `mask` file is
    supported by the client but **no tool sends it**; `client.py:59-71`).
  - `POST /chat/completions` on the auto-routing chat alias, used for multi-image compose
    (`client.py:74-88`).
- **Results** go to the core media store through `registry.save_media(raw, "image/png", meta)`
  with provenance meta (`tool`, `prompt`, `model`, `source`, …) (`tools.py:123-142`). Images are
  referenced by media id, signed `/media/` URL, data URL, or path (`tools.py:59-86`).
- **Model aliases are plugin settings** (`protoagent.plugin.yaml` `config:`): `gen_model`,
  `fast_gen_model`, `edit_model`, `fast_edit_model`, `chat_model`, `bgremove_model`,
  `region_model`, `outpaint_model`, `identity_model`, `realism_identity_model`.
- **The manifest states the egress rule outright:** "All traffic rides
  graph.sdk.gateway_client() … image backends are reached only THROUGH the gateway, never
  directly" (`protoagent.plugin.yaml`, comment above `capabilities`). `capabilities.network: []`.
- **No view, no routes, no history of its own.** The installed copy at
  `~/Library/Application Support/studio.protolabs.protoagent/plugins/protobanana` is identical
  to GitHub HEAD (0.3.0).
- **Gaps that matter for a manual UI:**
  - No **inpaint-with-mask** tool, although the gateway exposes `protolabs/qwen-image-inpaint`
    (protoBanana `docs/api.md:194`).
  - No **steps/CFG** knobs.
  - The plugin default `fast_gen_model: protolabs/qwen-image-2-1-turbo` does not match the
    alias table, which lists `protolabs/qwen-image-turbo` (`docs/api.md:186`). This kind of
    alias drift is exactly what a catalog endpoint fixes.
  - `compose_images` caps refs at 2–3 (`tools.py:315`), while the gateway's multiref alias
    now says "up to 10" (`docs/api.md:190`).

### 1.2 The backend: protoBanana (Apache-2.0)

- **A LiteLLM CustomLLM provider runs inside the gateway.** It maps a model name to a
  ComfyUI workflow JSON, patches slots, submits to ComfyUI `/prompt`, polls `/history/<id>`,
  fetches `/view`, and returns an OpenAI-shaped response (`protoBanana/README.md:32-43`).
  The transport is `ComfyUIClient`: `upload_image`, `submit_prompt`, `wait_for_completion`
  (polling, **no WebSocket**), `fetch_image_bytes` (`protobanana/client.py:55-113`).
- **Where ComfyUI runs:**
  - It is a separate process on the GPU host. The provider's default is
    `COMFYUI_BASE_URL=http://protolabs:8188`, and each `model_list` entry's `api_base`
    overrides it (`protobanana/provider.py:86`).
  - Install docs run it as a systemd unit on `ava`:
    `main.py --listen 0.0.0.0 --port 8188` (`docs/installation.md:34-39`).
  - The authoring instance is at `http://ava:8189/` over Tailscale
    (`comfy-workflows/README.md`, "Workflow" step 1).
  - **protoAgent never talks to ComfyUI.** It talks to the gateway (`model.api_base`).
- **Workflows → aliases.**
  - The workflow is chosen by the stem in the model name. Dispatch is by stem prefix
    (`krea2_`, `bgremove_`, `multiref_`, `region_edit_`, `outpaint_`, `inpaint_`) in
    `provider.aimage_edit` (`provider.py:218-250`).
  - **A `mask` reroutes any edit to inpaint** (`provider.py:191-220`).
  - Each route's `substitute()` owns its node-ID convention. For example, gen sets node 6 as
    the positive prompt, 7 as the negative, 5 for dims, 3 for the seed
    (`routes/gen.py:15-42`).
  - ADR 0006 deliberately keeps substitution **server-side**. It names "arbitrary
    user-supplied workflows" as needing "a node-mapping config — defer until that's a real
    ask" (`DECISIONS.md:366-389`).
- **Workflow format:**
  - All 22 shipped workflows under `protoBanana/workflows/` are **API format** (a flat
    `{node_id: {class_type, inputs}}` map). The loader strips non-node keys like `_doc`
    (`workflows/loader.py:50-55`). I checked all 22 by script; every one parses as API format.
  - `comfy-workflows` is the authoring library: it is symlinked into ComfyUI's
    `user/default/workflows`, so it holds **UI-format** saves. Today it is **empty**
    (`.gitkeep` only in every category).
  - The gateway-pinned workflows live in `homelab-iac/stacks/ai/config/open-webui/workflows/`
    (`comfy-workflows/README.md`, "Not in scope").
- **Params each alias exposes** (`docs/api.md:8-200`, `provider.py`):

| Op (alias) | Route | Params beyond `prompt` |
|---|---|---|
| gen (`protolabs/qwen-image`, `-2512`, `-turbo`) | `/images/generations` | `size` (WxH, inferred from prompt if absent), `n`, `seed`, `negative_prompt` |
| edit (`qwen-image-edit[-turbo]`) | `/images/edits` | `image`, `n`, `seed`, `negative_prompt` |
| inpaint (`qwen-image-inpaint`) | `/images/edits` | `image`, **`mask`** (transparent = edit), `seed`, `negative_prompt` |
| region edit (`qwen-image-region-edit`) | `/images/edits` | `image`, `grounding` (noun phrase → SAM 3 mask), `seed` |
| outpaint (`qwen-image-outpaint`) | `/images/edits` | `image`, `left/top/right/bottom` px, `seed` |
| bgremove (`qwen-image-bgremove[-rmbg]`) | `/images/edits` | `image` only (RMBG-2.0 is CC BY-NC) |
| identity (`krea2-identity-edit[-realism]`) | `/images/edits` | `image` (scene), `person_image` (data URL → two-ref), `grounding_px` 512–1536, `seed`; no negative |
| multiref (`qwen-image-multiref`) | `/chat/completions` or edits | 2–N images, prompt |
| chat (`qwen-image-chat`) | `/chat/completions` | auto-routed by protoBanana's own LLM agent |

  Steps, CFG, sampler and LoRA strength are **baked into each workflow JSON**. They are not
  exposed. Variants are separate stems (`_turbo`, `_realism`). This design choice keeps the
  OpenAI surface tiny.
- **Prior art for a playground already exists:** protoBanana's Gradio app (`app/gradio_app.py`)
  has one tab per op, and the Inpaint tab already uses a brush editor
  (`gr.ImageEditor`, `app/gradio_app.py:1002-1010`). The README calls it "a reference
  consumer + quick-test surface, not the product" (`README.md:210-224`). The Studio is that
  idea promoted to a first-class protoAgent surface.

### 1.3 protoAgent core seams a view would use

- **Plugin views are iframes the plugin serves** (ADR 0026 D1; federation retired by
  ADR 0038 D1/D2).
  - The console mounts them with
    `sandbox="allow-scripts allow-forms allow-same-origin allow-popups … allow-downloads"`
    (`apps/web/src/app/PluginView.tsx:645-649`).
  - It hands over the bearer and theme by postMessage, never in the URL (ADR 0026 D5;
    `PluginView.tsx:68-72`).
  - The plugin-kit (`/_ds/plugin-kit.js`) gives `initPluginView`, `apiFetch`, and `apiUrl`,
    all slug-aware (`docs/guides/building-react-plugin-views.md:17-26`).
  - "Want React? … serve the built files" (`building-react-plugin-views.md:490-494`). Rich
    first-party examples: projectBoard (`board_view.py`, no-build vanilla JS inlined into one
    GET) and the campaign plugin (gallery reusing the DS image viewer).
- **Fleet proxy constraint:** a plain request through the hub has a **20 s read timeout**. SSE
  and WebSockets are exempt (`building-react-plugin-views.md:453-467`). Renders take
  10–40 s warm (`docs/api.md:231-245`). So **a render cannot be a blocking HTTP call from
  the view.** It must be job submit → event-bus/SSE completion.
- **Bridges:**
  - `protoagent:chat:compose` prefills the chat composer. It is text only, ≤ 4 KB, never
    auto-sent (`building-react-plugin-views.md:385-398`; `PluginView.tsx:495-499`).
  - Event bus publish/subscribe through `protoagent:publish`/`subscribe` (ADR 0039).
  - Deep-linking into a view via `postToPluginView` plus a registered chat component. That
    needs a **`src/ext` renderer, which is a fork/core seam a git-installed plugin cannot
    ship** (`building-react-plugin-views.md:400-431`).
  - Plugin *frame* components (`register_component(..., frame=)`) can only resize and open
    links (`apps/web/src/chat/FrameComponentHost.tsx:340,401`). **They cannot open a plugin
    view today.**
- **Media store:**
  - `save_media` writes `<uuid>.<ext>` plus a hidden `.<id>.json` provenance sidecar and
    returns a signed URL (`src/infra/media.py:381-449`).
  - **There is no list/browse API.** Routes are only `GET /media/{name}`,
    `/api/media/open-link`, and `/api/media/remint` (`src/server/media.py:24-54`).
  - `media.retention_days` prunes old files (`src/infra/media.py:35,361-378`). That would
    silently empty a gallery.
- **Egress:**
  - ADR 0008's network allowlist is `egress.allowed_hosts` + the model `api_base` + fleet
    endpoints, with "*inference* pinned to the gateway"
    (`docs/adr/0008-sandboxing-and-openshell.md:67-70`).
  - The in-process guard denies private IPs by default (`src/security/egress.py:78-150`).
  - `gateway_client()` says: "Call gateway endpoints through this — never a provider backend
    directly" (`src/graph/sdk.py:139-160`).
- **The console already ships `@xyflow/react` ^12.11.3** (`apps/web/package.json:27`) for the
  core Workflows builder's DAG canvas, which it describes as the "n8n/ComfyUI shape"
  (`apps/web/src/workflows/DagCanvas.tsx:22-30`). **Core workflows run *subagent* steps only;
  they execute no code** (ADR 0002 §Safety). So image pipelines (deterministic tool steps)
  don't fit the core workflow engine as-is.
- **Licences:** protoAgent is **MIT** (`/LICENSE`), protobanana-plugin is **MIT**, protoBanana
  is **Apache-2.0**.

---

## 2. Q1: Can we literally render ComfyUI's UI?

### 2.1 What ComfyUI's UI is

- **The frontend** is `Comfy-Org/ComfyUI_frontend`: Vue 3 + Pinia + Tailwind 4 + Vite, with
  litegraph vendored in-tree at `src/lib/litegraph` (the separate `Comfy-Org/litegraph.js`
  repo was archived on 2025-08-05).
  - Licence: **GPL-3.0-only** (`package.json`). The vendored litegraph directory keeps its
    original **MIT** licence.
  - It ships to ComfyUI as the `comfyui-frontend-package` wheel (1.58.x, Oct 2026). The server
    can override it with `--front-end-version` / `--front-end-root`.
- **The backend** (comfyanonymous/ComfyUI) is also GPL-3.0.
- **The new Comfy Desktop** (Electron + Vue) is AGPL-3.0 or commercial.

### 2.2 Three ways to "render ComfyUI", and what breaks

**Option A1: link-out or cross-origin iframe straight to the tailnet ComfyUI**
(`http://ava:8189/`).

- **Mechanically it works today.** ComfyUI sends no `X-Frame-Options`, and CSP is sent only
  with `--offline`, so any origin can frame it (ComfyUI `server.py`).
- The frontend computes its API base and `/ws` URL from `location`, so it runs unmodified at
  its own origin (frontend `src/scripts/api.ts`).
- **What breaks:**
  - **It bypasses the gateway entirely.** Renders run on the GPU without LiteLLM: no gateway
    key, no Langfuse trace, no budget, no retries. That defeats protoBanana ADR 0002 ("Gateway-routed image gen")
    and ADR 0008's "inference pinned to the gateway". Strictly, ADR 0008 governs the
    *agent process's* egress, not the operator's browser, so A1 is not an ADR violation. It
    is an architectural bypass.
  - **No auth.** ComfyUI has no login flags (`--multi-user` is storage only), and `/ws`
    client ids are unauthenticated. Anyone who can reach the port can queue arbitrary
    graphs, upload files, or use ComfyUI-Manager to install code (CVE-2025-67303, an
    unauthenticated RCE in Manager below 3.38). It is acceptable on a private tailnet; it is
    never acceptable for a fleet/hub URL shared beyond that.
  - **Reachability.** It only works where the *browser* can resolve `ava`, which means Josh's
    tailnet devices. A fleet-member console viewed through the hub, a remote browser, or a
    customer install without ComfyUI all get a dead frame.
  - **Mixed content.** An `https` console cannot frame an `http://ava:8189` page. Desktop
    (custom scheme) and `localhost` work; a TLS-fronted console needs ComfyUI on TLS too
    (`--tls-keyfile/--tls-certfile`).
  - **Zero integration.** Results land in ComfyUI's `output/`, not the media store. The agent
    can't see them, there's no shared history, and no send-to-agent. Keybindings, theme, and
    menus all fight the console. Mobile is poor.
- **Licence:** clean. We distribute nothing of Comfy's. It is a separate program the
  operator's browser visits (GPL FAQ #MereAggregation).

**Option A2: reverse-proxy ComfyUI through protoAgent** (a plugin route
`/plugins/protobanana/comfy/*` with HTTP + WS, the SwarmUI pattern).

- **Precedent:** SwarmUI (MIT) does exactly this.
  - Its "Comfy Workflow" tab iframes `ComfyBackendDirect/`, a same-origin proxy with WS
    support behind Swarm's own permission check (`ComfyUIRedirectHelper.cs`).
  - Swarm then scripts the frame (`contentWindow.app.graphToPrompt()`, CSS-selector menu
    hiding) to pull graphs back into its native Generate tab
    (`comfy_workflow_editor_helper.js`).
  - The frontend tolerates a stripped subpath: Vite `base: ''` and API base from
    `location.pathname` (vite.config.mts, api.ts, PR #7115).
- **What breaks:**
  - **ADR 0008 directly.** The protoAgent process would contact a non-gateway private host.
    The egress guard denies private IPs by default (`src/security/egress.py:78-150`), and
    the OpenShell policy allows only `api_base` + allowlisted hosts (ADR 0008:67-70). The
    plugin's own manifest promises `network: []` and "never directly". This needs an
    explicit ADR exception plus an `egress.allowed_hosts` entry.
  - **Trust.** Plugin rail views are framed with `allow-same-origin`
    (`PluginView.tsx:647`). Proxied ComfyUI JS would run **on the console's origin**, with
    access to the console's storage and the bearer handshake. That puts a large third-party
    app with recent stored-XSS advisories in the trusted zone:
    - core: CVE-2026-56670 (SVG upload on `/view`) and CVE-2026-56672 (`/userdata`);
    - frontend: three DOM-XSS advisories from 2026-08.
    It inverts the ADR 0038 rule: third-party code gets the sandbox, not same-origin.
  - **Fleet proxy.** WS relays are untimed (fine), but every asset and `/api` call rides the
    20 s plain-request lane. Large `/object_info` and `/view` responses on a slow member
    risk 504s.
  - **Fragility.** Every frontend release (daily nightlies, weekly-ish wheels) can move the
    selectors, menus, and globals we would script. SwarmUI's helper is a cautionary example.
- **Licence:** still aggregation as long as we *proxy* an unmodified upstream build and don't
  ship it. Scripting deep into the frame's globals moves toward "intimate communication", a
  grey zone.

**Option A3: route ComfyUI's API through the LiteLLM gateway.**

- LiteLLM's generic `pass_through_endpoints` are HTTP only. The docs only show WS relay for
  the OpenAI realtime passthrough, behind a flag
  ([LiteLLM pass-through](https://docs.litellm.ai/docs/proxy/pass_through),
  [OpenAI passthrough](https://docs.litellm.ai/docs/pass_through/openai_passthrough.md)). I
  could not confirm generic WS support.
- ComfyUI's frontend needs `/ws` for queue, progress, and execution state, so **the full UI
  can't run through the gateway.**
- Passing through `/prompt` and `/upload` would also turn the gateway key into "arbitrary
  code on the GPU box".
- **A3 is only viable for a curated read-only subset** (`/object_info`, a workflow fetch),
  and that is what §5.2 proposes, through protoBanana's own routes rather than a raw
  passthrough.

**Option A4: bundle or fork the ComfyUI frontend into the console build.**

- This is a non-starter on licence. The frontend is GPL-3.0-only, and GPL JavaScript sent to
  browsers counts as distribution (GPL FAQ #UnreleasedMods).
- Combining it into protoAgent's MIT console (and shipping it in the desktop app) would make
  the combined work GPL, or force us to offer source for that part and keep a hard module
  boundary. Only the vendored **litegraph** directory is MIT-reusable, and it is a
  Canvas2D, non-React graph lib.
- This is not legal advice. If Josh ever wants this route, it needs counsel.

### 2.3 Verdict

- **We can render it**: A1 as a link-out or optional iframe for the tailnet operator, or A2 with
  an ADR 0008 exception.
- **We shouldn't make it the product.** What Josh wants (play with *our* models, workflows
  that feel like ComfyUI, shared with the agent) is precisely what ComfyUI's UI *doesn't*
  give: it bypasses the aliases, the gateway, the media store, and the agent.
- **ComfyUI itself is moving the same way.** It shipped **App Mode / App Builder** (2026-03,
  frontend ≥ 1.41.13), a simplified non-graph surface where an author exposes chosen inputs
  and outputs and the graph stays hidden. That is the shape we are building. Our "app" layer
  is protoBanana's aliases plus the catalog.
- **Every comparable product** (SwarmUI, InvokeAI, ViewComfy, ComfyUIMini, NodeTool) ships
  a *native* simple form first and treats the graph as opt-in.
- **Do:** a `comfy_ui_url` setting that renders an **"Open in ComfyUI"** link (new tab,
  never framed or proxied) for workflow authors. It costs about 10 lines and carries no
  licence, egress, or same-origin risk. **Don't:** proxy, frame same-origin, or bundle.

---

## 3. Q2: If we build our own, what's the right layering?

### 3.1 Layer (a): the Playground (ship first)

The Gradio app's tabs plus the agent tools, as a real console surface. Layout: a three-column
studio that collapses to stacked panes on mobile.

- **Left: the operation picker and form.**
  - Pick an op (Generate · Edit · Inpaint · Region · Identity · Outpaint · Remove BG ·
    Compose), plus a **quality tier** toggle (Draft = turbo alias, Final = full) and an
    advanced alias override.
  - The form is **rendered from a param schema** (§5.1): prompt, negative, size presets with
    aspect chips, seed with lock/dice, `n`, `grounding`, `grounding_px` slider, outpaint
    margin handles, person-ref slot.
  - Input slots accept drag-drop, paste, a pick from the gallery, or the current image.
- **Centre: the canvas.**
  - The current image, with **compare** (A/B slider or onion skin against the parent) and
    **zoom/pan**.
  - A **mask brush** with brush/eraser/size/feather/invert/clear. It exports a PNG where
    transparent = edit, which is the gateway's inpaint convention (`docs/api.md:194`).
  - A **region preview**: type "the red car", run grounding, see the SAM mask. This needs a
    mask-only output from the backend, an optional backend slice.
  - Outpaint shows draggable canvas edges that set the margins.
- **Right: history and gallery.**
  - A **lineage tree**, not a flat list. Every result records `parent_id`, op, alias, and full
    params, so you can **branch** ("edit chain") and **re-run with a new seed**.
  - **Copy params**, **send to agent**, **download**, **star** (pin from retention).
  - The gallery filters by op, starred, and source (manual vs agent).
- **Queue strip:** pending jobs with elapsed time (ComfyUI is serial,
  `docs/api.md:231-245`), cancel, and a "cold load" hint on the first job after a model swap.

**Backend for the view:** gated plugin routes under `/api/plugins/protobanana/`:

- `POST /jobs` returns `{job_id}` immediately.
- A background task calls the same `client.py` functions the tools use (one code path), then
  `save_media(...)` with meta `{source: "studio", op, alias, params, parent_id, job_id}`.
- It emits `protobanana.job.done` / `job.failed` on the bus. The view subscribes through the
  kit, which keeps it clear of the 20 s fleet read lane.
- `GET /jobs`, `GET /history?cursor=`, `POST /history/<id>/star`, `GET /catalog`.

**History index:** a plugin-owned append-only `history.jsonl` (or SQLite) under the plugin data
dir, holding records that point at media ids. Agent tool calls write the same record with
`source: "agent"`, so **one history serves both**. This needs **no core list API**. The core
store stays the bytes; the plugin owns the index.

### 3.2 Layer (b): Pipelines, a node graph over *our* operations (ship second)

This is the "feels like ComfyUI" layer, but at the right altitude:

- **Nodes are protoBanana operations, not ComfyUI primitives.** Types: `Prompt`, `Image
  input`, `Generate`, `Edit`, `Inpaint`, `Region edit`, `Identity`, `Outpaint`, `Remove BG`,
  `Compose`, `Output`.
- **Ports are typed:** `image`, `mask`, `text`, `int(seed)`. A widget can be promoted to an
  input, as in ComfyUI.
- **The canvas is `@xyflow/react`** (MIT; the same library and visual idiom as core's
  Workflows DAG). Because the view is an iframe, the plugin bundles its own copy (Vite build
  → static assets served by the plugin).
- **The pipeline spec** is a small declarative JSON/YAML:

```yaml
id: product-sticker
inputs: { subject: text, style: { type: text, default: "studio product shot" } }
steps:
  - { id: gen,   op: generate, params: { prompt: "{{inputs.subject}}, {{inputs.style}}", size: 1024x1024, tier: final } }
  - { id: fix,   op: region_edit, image: gen, params: { grounding: "the label", prompt: "clean white label" } }
  - { id: cut,   op: remove_background, image: fix }
output: cut
ui: { positions: { gen: [0,0], fix: [260,0], cut: [520,0] } }
```

- **Why xyflow, not litegraph or Rete.**
  - xyflow is MIT, React-native, already the console's DAG idiom, and InvokeAI's choice for
    the same job.
  - litegraph (MIT) is Canvas2D with no React bindings, and the jagenjo repo has been
    inactive since 2024.
  - Rete.js (MIT) is viable but would be a second graph idiom in the product.
- **InvokeAI's lesson:** the simple Generate tab and the Workflow editor share one graph
  schema and one queue. Here, the Playground's single op *is* a one-node pipeline, so one
  runner serves both.
- **Execution is a plugin-side DAG runner.** Each step runs one gateway call, and each
  intermediate is saved to media and history (with `pipeline_run_id`). Per-node progress
  arrives on the bus. You can re-run from a node: unchanged upstream steps reuse cached
  outputs, keyed by `hash(op, alias, params, input media ids)`. This is ComfyUI's
  "only re-execute what changed" behaviour, which is the core of its feel.
- **Saving and sharing.** Pipelines live under the plugin data dir (and can ship inside a
  plugin's `pipelines/` dir), with export/import as a file.
- **The agent can run them.** One generic tool, `run_pipeline(name, inputs)`, plus
  `list_pipelines`. Optionally, a pipeline marked `expose_as_tool: true` is registered as its
  own tool via `register_late_tool_factory`, and the plugin ships a `SKILL.md` describing
  when to use pipelines.

**Why not express pipelines as core Workflows?**

- Core workflows delegate to LLM subagents and "execute no code" (ADR 0002). An image
  pipeline is deterministic tool calls with binary hand-offs between steps.
- Bending the core engine to add tool steps is a core ADR in its own right. It is worth
  proposing **later**, if pipelines prove their value, as a "tool step" kind, and the Studio
  spec is designed to be liftable into it.
- Reuse the *idiom* (xyflow, lane auto-layout, `ui.positions` extras) so the two canvases feel
  like one product.

### 3.3 Layer (c): raw ComfyUI graphs (defer)

What "raw graphs" would really take:

1. **Read the workflow.** A backend endpoint returns the API-format JSON behind an alias.
2. **Render it.** Convert API format to a positioned graph (API format has no positions, so
   auto-layout), then show it read-only in the same xyflow canvas.
3. **Edit and run it.**
   - This needs `/object_info` (every node class's inputs, types, and enums) to render
     widgets and validate links.
   - It needs a path to **submit an arbitrary graph**, which protoBanana deliberately does
     not have (ADR 0006: substitution is server-side, arbitrary workflows deferred).
   - Arbitrary-graph submission is **remote execution on the GPU box**: custom nodes run
     Python, and `/upload` writes files.

Recommendation:

- Ship **(c-lite)**: a **read-only "View workflow" panel** per alias, plus an **"Open in
  ComfyUI"** link to the authoring instance when `comfy_ui_url` is configured. It helps
  authors debug aliases without making protoAgent a ComfyUI client.
- Full (c) means rebuilding ComfyUI's frontend on top of a GPL-adjacent, fast-moving node
  schema, and adding an arbitrary-execution endpoint to the gateway. Revisit only if
  authoring inside protoAgent becomes a real requirement.

### 3.4 Order

(a) Playground → (b) Pipelines → (c-lite) read-only workflow view and link-out. Full (c) is not
planned.

---

## 4. Q3: How the agent and the manual view interoperate

| Interaction | Mechanism | Core change? |
|---|---|---|
| **Shared history.** Agent renders appear in the Studio gallery; Studio renders are referenceable by the agent | Both paths write the same plugin history record (`source: agent/studio`) next to `save_media`. Media ids are already the tools' image refs (`tools.py:76-82`), so a Studio id pasted into chat just works | None |
| **Send to agent** ("refine this with the agent") | `protoagent:chat:compose` with text such as `Image <media_id> (<op>, seed 42, prompt "…"): ` ready for the operator to continue. Text only, ≤ 4 KB, the operator sends | None for v1. Later: an **image-attachment variant of chat:compose** so the composer shows a thumbnail (core slice, optional) |
| **Agent opens the Studio** ("open that in the studio", "open pipeline X") | A `protobanana-ref` chip in the chat transcript that opens the view on a media id or pipeline. Today a git-installed plugin **cannot** do this: chips need a `src/ext` renderer, and frame components can't open views | **Yes, a small generic core seam:** a core `plugin-view-ref` component kind (like `code-ref`) **or** a `protoComponent:openView {view, message}` frame message routed to `postToPluginView`. Benefits every plugin (campaign, board) |
| **Pipeline as a reusable tool/skill** | `run_pipeline` / `list_pipelines` tools + a bundled `SKILL.md`. Optionally, per-pipeline tools via `register_late_tool_factory` | None |
| **Agent authors a pipeline** | A `save_pipeline(spec)` tool validated by the same schema. The view live-updates through the bus (`protobanana.pipeline.saved`) | None |
| **Bus events for other plugins** (brandLaunch/campaign consuming renders) | `emits: [protobanana.job.done, protobanana.pipeline.run.done]` in the manifest | None |

The rule from the "don't rebuild core in a plugin" note applies. The Studio **never grows a
chat box or a prompt-helper LLM pane.** "Help me write a prompt" is "send to agent". The view
does only what chat can't: painting masks, scrubbing seeds, side-by-side compare, branching a
lineage, wiring a graph, browsing a gallery.

---

## 5. Q4: Where the code lives, backend additions, risks

### 5.1 Where the code lives

**Plugin view in `protobanana-plugin`, not core.** Weighed against the memory note ("a view is
justified only for BROWSING — a gallery, a ledger, an editor"):

- **The Studio is a gallery plus an editor.** Both are on the note's allowed list. What it
  must not do is duplicate chat, artifacts, or core workflows, and §4 keeps it from doing so.
- **It is not core.** Image generation is optional and backend-specific: it needs a
  protoBanana gateway, and most installs have none. The plugin already owns the aliases,
  client, and settings. A core surface would hardcode a vendor stack into the template repo
  (CLAUDE.md "Forking note").
- **Core gets only generic seams** that every plugin benefits from:
  - the view-ref deep link (§4);
  - optionally, a media **pin/exempt-from-retention** flag (or the plugin copies starred items
    into its own data dir, with no core change);
  - optionally, image attachments in chat:compose.
- **Build tooling:**
  - The plugin becomes a "built view" plugin: a `view/` Vite + React + TS app compiled to
    static files committed under `view/dist/` (served by the plugin router), so git-URL
    installs and the frozen desktop runtime need no Node.
  - It links the DS kit (`/_ds/plugin-kit.css|js`) for tokens and the handshake, and
    `@protolabsai/ui` primitives where they're publishable.
  - Size budget: about 300–400 KB gz with xyflow and a canvas lib.
  - Mask painting uses **react-konva** (MIT). Brush = `source-over`, eraser =
    `destination-out`, export via `toDataURL()`. This is Konva's free-drawing pattern, and
    InvokeAI webv1 also builds on Konva.
  - Follow `building-react-plugin-views.md` rules 1–4, especially slug-aware URLs for the
    fleet proxy.

### 5.2 Backend additions (protoBanana, behind the gateway)

1. **`GET /v1/protobanana/catalog`** (a LiteLLM pass-through or custom route served by the
   provider package). It returns, per alias: `op`, `route`, `stem`, a param **JSON Schema**
   (types, ranges, defaults, enum sizes), `tier` (draft/final), `licence` flags (e.g. RMBG
   non-commercial), `typical_latency_s`, and `inputs` (image count, mask, person ref).
   - The Studio builds every form from it; the plugin's alias settings become defaults rather
     than the source of truth.
   - **This is the "expose workflow params through the gateway" piece.** It exposes
     *protoBanana's curated param surface*, not raw `/object_info`.
   - Until it ships, the plugin carries a static schema mirroring the table in §1.2.
2. **Mask-only grounding**: `grounding_preview` → returns the SAM 3 mask PNG for a region
   phrase, so the region tab can preview and hand-touch-up the mask before inpainting.
   Optional; one new workflow stem (`segment_sam3`) and a route.
3. **Optional advanced knobs** (`steps`, `cfg`) as allow-listed extras with clamped ranges
   per stem, declared in the catalog. Default off, so the "tiny OpenAI surface" ethos holds.
4. **(c-lite) `GET /v1/protobanana/workflows/<alias>`** returns the API-format JSON for the
   read-only viewer.
5. **Not added:** arbitrary-graph `/prompt` passthrough, `/ws` passthrough, `/upload`
   passthrough.

Progress: protoBanana polls `/history` and returns only at the end, so v1 shows
**indeterminate progress with elapsed time vs typical latency** (from the catalog). True
per-step progress would need the provider to watch ComfyUI's `/ws` and the gateway to stream
it. That is out of scope; note it as a future backend slice.

### 5.3 Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **Render latency vs the 20 s fleet read lane.** A blocking POST that waits on a 30–40 s render 504s through the hub | High / High | Job API returns immediately, completion arrives on the event bus or SSE (S1 acceptance tests the proxied path) |
| R2 | **ComfyUI is serial and shared with the agent and other consumers.** A manual session queues behind agent jobs (and vice versa); Turbo↔Full model swaps cost 5–10 s each (`PHASES.md` cross-phase notes) | High / Medium | Queue strip with honest elapsed time; Draft tier default while exploring; per-op typical latency from the catalog; no client-side parallel fan-out by default (`n` capped) |
| R3 | **No real cancel.** The gateway has no `/interrupt`, so an abandoned job still burns GPU | Medium / Low | Client-side abandon, plus one in-flight Studio job per operator by default; a BE follow-on adds cancel via `prompt_id` if it hurts |
| R4 | **Media retention silently empties the gallery** (`media.retention_days`) | Medium / Medium | Star = copy into plugin data (S2); history shows "pruned" tiles; document the interaction |
| R5 | **Alias/schema drift** between plugin settings, the gateway `model_list` and the docs (already visible: `qwen-image-2-1-turbo` vs `qwen-image-turbo`) | High / Medium | Catalog endpoint (S6) as source of truth; Settings warns on unknown aliases |
| R6 | **Scope creep into "rebuild ComfyUI" or "rebuild chat"** | Medium / High | Layer (c) explicitly capped at c-lite; no chat box or prompt-LLM pane in the view (§4); nodes are our ops, not Comfy primitives |
| R7 | **Built-view plugin tooling.** Vite/React build inside a drop-in plugin: committed `dist/`, bundle size, frozen-desktop compatibility, DS drift | Medium / Medium | Commit `view/dist/` with a CI check that it's fresh; link DS kit tokens; size budget; follow plugin-view rules 1–4. First rich *built* first-party view, so expect to write the guide section |
| R8 | **Core seam for deep links (S5) needs core review and a release.** The plugin's chip is inert on older cores | Medium / Low | Generic seam benefits all plugins; raise the plugin's core floor when it lands (core-floor policy: no fallbacks) |
| R9 | **Licence flags per model.** RMBG-2.0 is CC BY-NC; Krea 2 weights have a community licence (`docs/api.md:191`; `routes/krea2_edit.py` header) | Low / Medium | Catalog carries licence flags; the view badges NC aliases |
| R10 | **Pipeline runner correctness:** binary hand-offs, partial failure, cache invalidation when a gateway workflow changes behind the same alias | Medium / Medium | Cache key includes the catalog's workflow hash/version; failures recorded per node; "re-run from here" |
| R11 | **If anyone later revives A2 (proxy ComfyUI):** egress exception, same-origin third-party JS, recent XSS CVEs | n/a | This doc's recommendation is to not do it. Any revival needs its own ADR plus a cross-origin, no-`allow-same-origin` frame |

---

## 6. Epic: protoBanana Studio

The slices are ordered so a useful Playground ships at S3 and is polished by S5. Repos:
**PB** = `protoLabsAI/protobanana-plugin`, **BE** = `protoLabsAI/protoBanana`, **CORE** =
`protoLabsAI/protoAgent`. Per the slice-closing rule, only the last slice says
`Fixes #<epic>`.

### S1: Studio shell and job API (PB)

- **Scope:**
  - Add a `views:` entry (`studio`, icon `Wand2` or `Image`, rail) and a `view/` Vite + React +
    TS app built to committed `view/dist/`, served at `/plugins/protobanana/studio` (page
    public, data gated).
  - Gated routes `POST /api/plugins/protobanana/jobs` and `GET /jobs/<id>`.
  - A background runner that reuses `client.py`, `save_media`, and a `protobanana.job.done|failed`
    bus event (manifest `emits:`).
  - A static param schema module, the stand-in for the S6 catalog.
- **Acceptance:**
  - The rail icon opens the view in light and dark themes.
  - A "Generate" form submits a job, gets a `job_id` in under 1 s, and shows the image when the
    bus event lands. This works on the host **and** through the fleet proxy, with no request
    held over 20 s.
  - The result is in the media store with `source: studio` meta.
  - Host-free tests cover the job runner using the stubbed gateway.
  - A 404 on an alias shows the readable "alias missing from the gateway" hint.
- **Dependencies:** none.

### S2: Shared history index and gallery (PB)

- **Scope:**
  - Plugin-owned `history` store (JSONL or SQLite in the plugin data dir) with records
    `{media_id, parent_id, op, alias, params, source, job_id, created, starred}`.
  - The agent tools' `_finish` writes the same record with `source: agent`.
  - `GET /history?cursor=&op=&source=&starred=`.
  - The gallery pane uses DS image viewer conventions (lightbox, download, open in new tab),
    plus "copy params" and "re-run" (same params, new seed).
  - Starring copies the file into plugin data so it **survives `media.retention_days`**.
- **Acceptance:**
  - Images the agent generated in chat appear in the gallery within one refresh or bus tick.
  - Re-run reproduces with a fixed seed.
  - A starred item survives a forced media GC in a test.
  - Records whose media was pruned show a "pruned" tile, not a broken image.
- **Dependencies:** S1.

### S3: Playground, all single-image ops (PB). First useful release.

- **Scope:**
  - Schema-driven forms for Generate, Edit, Region edit (grounding text), Identity (scene +
    person slots, `grounding_px`, realism), Outpaint (draggable margins), Remove BG, and
    Compose (2–N slots).
  - A Draft/Final tier toggle and an advanced alias override.
  - Input slots: drag-drop, paste, pick from gallery, use current.
  - A lineage tree in history (branching edit chains via `parent_id`).
  - An A/B compare slider against the parent.
  - A queue strip with elapsed time and cancel. Cancel is client-side abandonment: we cannot
    interrupt ComfyUI through the gateway.
- **Acceptance:**
  - Every op in the §1.2 table except inpaint completes from the view against the live
    gateway.
  - An edit chain of three or more steps renders as a branchable tree.
  - Mobile width stacks the panes with no horizontal scroll.
  - A smoke test drives one gen → edit chain on the dev instance (`scripts/dev.sh`, :7871).
- **Dependencies:** S1, S2.

### S4: Mask painting and inpaint (PB)

- **Scope:**
  - A canvas mask editor: brush, eraser, size, feather, invert, clear, undo.
  - Export as a PNG at the source resolution with transparent = edit.
  - An `Inpaint` op on `protolabs/qwen-image-inpaint` via `client.edit(mask=…)`.
  - A new agent tool, `inpaint_image(image_ref, mask_ref, prompt)`, so masks painted in the
    Studio are usable by the agent too.
- **Acceptance:**
  - A painted mask round-trips: the edited region changes and the rest is pixel-identical
    outside the grown mask.
  - The mask is saved as its own media item linked in history.
  - Tests check the mask's polarity and size against the source.
- **Dependencies:** S3.

### S5: Agent interop, send-to-agent and the Studio deep link (PB + CORE)

- **Scope:**
  - **PB:** a "Send to agent" action posting `protoagent:chat:compose` with the media id plus
    its op, seed, and prompt.
  - **CORE:** a generic seam to open a plugin view from chat, either a core `plugin-view-ref`
    component kind (rendered like `code-ref`, routed to `postToPluginView` + `openView`) or a
    `protoComponent:openView` frame message. Accept only declared views of the emitting
    plugin, and don't auto-open on mobile (ADR 0086).
  - **PB:** tools append a `protobanana-ref` chip so "open in Studio" lands on that image.
- **Acceptance:**
  - From chat, clicking the chip on an agent render opens the Studio focused on that item,
    including when the view was collapsed.
  - From the Studio, Send to agent prefills the composer, and sending resolves the id in the
    agent's next tool call.
  - The core seam has unit tests and an ADR 0026/0051 amendment.
- **Dependencies:** S2 (PB part). The CORE part is independent and can land in parallel.

### S6: Catalog endpoint behind the gateway (BE, then PB)

- **Scope:**
  - **BE:** `GET /v1/protobanana/catalog` from the provider package, giving per alias: op,
    route, stem, param JSON Schema, tier, input arity, licence flags, typical latency.
    Exposed through the gateway as a LiteLLM pass-through or custom route, with the
    gateway's bearer.
  - **PB:** fetch the catalog through `gateway_client()` and cache it. The static schema
    becomes the fallback. Plugin alias settings become defaults validated against the
    catalog, with a Settings warning on unknown aliases (fixes the
    `qwen-image-2-1-turbo` / `qwen-image-turbo` drift).
- **Acceptance:**
  - Adding a new alias and workflow on the gateway makes it appear in the Studio picker with
    a correct form, and no plugin release is needed.
  - The catalog is unreachable → the Studio still works on the static schema, with a banner.
  - A validator test in `scripts/validate_workflows.py` checks that every stem has a catalog
    entry.
- **Dependencies:** S3 (consumer). The BE half can start any time.

### S7: Pipelines, spec, runner, and agent tools (PB)

- **Scope:**
  - The pipeline spec (§3.2) with a JSON Schema validator.
  - A DAG runner with per-step media and history records, a `pipeline_run_id`, and per-node
    bus events.
  - A step cache keyed by `hash(op, alias, params, input ids)`.
  - Tools: `list_pipelines`, `run_pipeline(name, inputs)`, `save_pipeline(spec)`.
  - A bundled `SKILL.md`, plus two or three starter pipelines (product sticker, portrait
    restage, outpaint banner).
- **Acceptance:**
  - The agent runs a starter pipeline from chat.
  - Re-running with one changed param re-executes only downstream steps, which the cache
    hits prove.
  - An invalid spec (cycle, type mismatch, image→text port) is rejected with a readable error.
  - Runs survive a view reload, because state lives server-side.
- **Dependencies:** S3. Starters using inpaint need S4.

### S8: Pipeline canvas, the "feels like ComfyUI" editor (PB)

- **Scope:**
  - An xyflow canvas in the Studio's Pipelines tab.
  - A node palette from the catalog and static schema, with typed, coloured ports
    (image/mask/text/seed) and connection validation.
  - Inline widgets, with widget↔input promotion.
  - Per-node thumbnails and progress from bus events.
  - "Run from here", save/load/duplicate, export/import a file, and auto-layout plus saved
    `ui.positions`.
  - "Open in Playground" on any node output.
- **Acceptance:**
  - An operator builds gen → region edit → bgremove → compose without touching YAML, runs it,
    sees each node's output, edits one node and re-runs incrementally.
  - A pipeline saved in the canvas is runnable by the agent via `run_pipeline`.
  - Keyboard: delete, copy/paste, and fit view don't clash with console keybindings (uses the
    `protoagent:keybindings` bridge).
- **Dependencies:** S7.

### S9: Pipelines as first-class tools and sharing (PB)

- **Scope:**
  - `expose_as_tool: true` registers a pipeline as its own typed tool via
    `register_late_tool_factory` (name `pipeline_<id>`, args from the pipeline's `inputs`).
  - Plugins can ship `pipelines/` directories.
  - Bus events `protobanana.pipeline.saved` / `run.done` for brandLaunch and campaign
    consumers.
- **Acceptance:**
  - A marked pipeline appears in the agent's tool list after a reload, with a correct
    schema.
  - Unmarking it removes the tool.
  - A pipeline shipped in another plugin's dir shows up read-only in the Studio.
- **Dependencies:** S7, S8.

### S10: (c-lite) workflow inspector and ComfyUI link-out (BE + PB)

- **Scope:**
  - **BE:** `GET /v1/protobanana/workflows/<alias>` returns the API-format JSON with `_doc`.
  - **PB:** an "Inspect workflow" drawer per alias, a read-only xyflow render with
    auto-layout, nodes labelled by `class_type`, and the substituted slots highlighted.
  - An optional `comfy_ui_url` setting adds an "Open in ComfyUI" link (new tab, never framed
    or proxied).
- **Acceptance:**
  - Every shipped stem renders.
  - The link only appears when the setting is set.
  - No protoAgent process ever contacts the ComfyUI host (asserted by test: only
    `gateway_client` is used).
- **Dependencies:** S6.

### Optional follow-ons (not in the epic count)

- **BE:** `segment_sam3` mask-preview stem (region edit preview → editable mask).
- **BE:** streaming progress (provider watches ComfyUI `/ws`).
- **CORE:** image attachments in `chat:compose`.
- **CORE:** an ADR for a "tool step" kind in core workflows, if pipelines prove out.

**Critical path to a useful playground:** S1 → S2 → S3 (ship) → S4. S5 (core seam) and the BE
half of S6 run in parallel from day one.

---

## 7. Sources

### Local (file:line)

- **protobanana-plugin** (GitHub HEAD = installed 0.3.0):
  - `protoagent.plugin.yaml`
  - `client.py:1-88`
  - `tools.py:52-54, 59-86, 123-142, 266-284, 315`
- **protoBanana** (GitHub HEAD e65ae12; the local `~/dev/protoBanana` checkout is older,
  at 2471345, and lacks the krea2/2.1 stems):
  - `README.md:32-62, 168-224`
  - `docs/api.md:8-245`
  - `DECISIONS.md:366-389` (ADR 0006), `DECISIONS.md:463-484` (ADR 0002)
  - `PROPOSAL.md:117-228`
  - `PHASES.md:233-263`
  - `protobanana/client.py:55-113`
  - `protobanana/provider.py:86, 191-250`
  - `protobanana/routes/gen.py:15-42`
  - `protobanana/routes/krea2_edit.py:1-40`
  - `protobanana/workflows/loader.py:50-55`
  - `docs/installation.md:34-39`
  - `app/gradio_app.py:799-1044`
- **comfy-workflows:** `README.md`. All category dirs hold only `.gitkeep`.
- **protoAgent** (MIT):
  - `CLAUDE.md`
  - `docs/adr/0008-sandboxing-and-openshell.md:64-70`
  - `docs/adr/0026-plugin-contributed-console-surfaces.md` (D1, D5, D6)
  - `docs/adr/0034-plugin-ui-first-class-react.md`
  - `docs/adr/0038-generative-ui-artifacts-two-mode.md` (D1-D4)
  - `docs/adr/0002-reusable-subagent-workflows.md` (§Safety)
  - `docs/guides/building-react-plugin-views.md:17-26, 385-398, 400-431, 453-494`
  - `apps/web/src/app/PluginView.tsx:68-72, 495-499, 645-649`
  - `apps/web/src/chat/FrameComponentHost.tsx:340, 401`
  - `apps/web/src/workflows/DagCanvas.tsx:1-30`
  - `apps/web/package.json:27`
  - `src/infra/media.py:16-35, 361-449`
  - `src/server/media.py:24-54`
  - `src/graph/sdk.py:139-160`
  - `src/security/egress.py:78-150`
  - `src/graph/plugins/registry.py:346-360` (`register_component`)
- **Pattern plugins:**
  - `~/dev/projectBoard-plugin/board_view.py`
  - `~/dev/projectBoard-plugin/protoagent.plugin.yaml:356-364`
  - `~/dev/campaign-plugin/protoagent.plugin.yaml:128-137`

### External

**ComfyUI frontend**

- [Comfy-Org/ComfyUI_frontend](https://github.com/Comfy-Org/ComfyUI_frontend)
- [package.json (GPL-3.0-only)](https://raw.githubusercontent.com/Comfy-Org/ComfyUI_frontend/main/package.json)
- [vite.config.mts](https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/vite.config.mts)
- [api.ts](https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/scripts/api.ts)
- [PR #7115](https://github.com/Comfy-Org/ComfyUI_frontend/pull/7115)
- [vendored litegraph LICENSE (MIT)](https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/lib/litegraph/LICENSE)
- [archived Comfy-Org/litegraph.js](https://github.com/Comfy-Org/litegraph.js)
- [comfyui-frontend-package on PyPI](https://pypi.org/project/comfyui-frontend-package/)

**ComfyUI server**

- [server.py](https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/server.py)
- [cli_args.py](https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy/cli_args.py)
- [routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [WS messages](https://docs.comfy.org/development/comfyui-server/comms_messages)
- [API workflow format](https://docs.comfy.org/development/api-development/workflow-api-format)

**Security**

- [ComfyUI advisories](https://github.com/comfyanonymous/ComfyUI/security/advisories)
- [frontend advisories](https://github.com/Comfy-Org/ComfyUI_frontend/security/advisories)
- [CVE-2025-67303 (Manager RCE)](https://docs.byteplus.com/de/docs/byteplus-security-bulletins/CVE-2025-67303)
- [CVE-2024-21576](https://cvefeed.io/vuln/detail/CVE-2024-21576)
- [ComfyUI-Login](https://deepwiki.com/liusida/ComfyUI-Login)

**Simplified UIs and desktop**

- [App Mode launch](https://blog.comfy.org/p/from-workflow-to-app-introducing)
- [App Mode docs](https://docs.comfy.org/interface/app-mode)
- [Subgraphs](https://blog.comfy.org/p/subgraph-official-release)
- [Comfy-Desktop (AGPL-3.0/commercial)](https://github.com/Comfy-Org/Comfy-Desktop)

**GPL FAQ**

- [Mere aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)
- [Plugins](https://www.gnu.org/licenses/gpl-faq.html#GPLPlugins)
- [Unreleased mods](https://www.gnu.org/licenses/gpl-faq.html#UnreleasedMods)
- [Linking with GPL](https://www.gnu.org/licenses/gpl-faq.html#LinkingWithGPL)

**LiteLLM**

- [pass-through endpoints](https://docs.litellm.ai/docs/proxy/pass_through)
- [OpenAI WS passthrough](https://docs.litellm.ai/docs/pass_through/openai_passthrough.md)

**Prior art and libraries**

- SwarmUI:
  - [ComfyUIRedirectHelper.cs](https://github.com/mcmonkeyprojects/SwarmUI/blob/master/src/BuiltinExtensions/ComfyUIBackend/ComfyUIRedirectHelper.cs)
  - [comfy_workflow_editor_helper.js](https://github.com/mcmonkeyprojects/SwarmUI/blob/master/src/BuiltinExtensions/ComfyUIBackend/Assets/comfy_workflow_editor_helper.js)
- InvokeAI:
  - [workflows doc](https://invoke-ai.github.io/InvokeAI/contributing/frontend/WORKFLOWS/)
  - [webv2 ARCHITECTURE.md](https://github.com/invoke-ai/InvokeAI/blob/main/invokeai/frontend/webv2/ARCHITECTURE.md)
- Other frontends:
  - [ViewComfy](https://github.com/ViewComfy/ViewComfy)
  - [ComfyBox](https://github.com/space-nuko/ComfyBox)
  - [ComfyUIMini](https://github.com/ImDarkTom/ComfyUIMini)
  - [NodeTool](https://github.com/nodetool-ai/nodetool)
- Graph libraries:
  - [xyflow](https://github.com/xyflow/xyflow)
  - [Rete.js](https://retejs.org/)
  - [litegraph.js](https://github.com/jagenjo/litegraph.js)
- Canvas libraries:
  - [react-konva](https://github.com/konvajs/react-konva)
  - [Konva free drawing](https://konvajs.org/docs/sandbox/Free_Drawing.html)

**Not verified:**

- generic WS support in LiteLLM pass-through;
- whether frontend PR #7115 is merged (the base-path logic is on `main` either way);
- the 2026 CVE ids above, which were reported by the research pass from the GHSA listings
  and not independently re-read.
