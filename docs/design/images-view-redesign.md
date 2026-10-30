# protoBanana "Images" view: redesign spec

Status: **APPROVED by Josh 2026-10-30**. Owner: designSystem. Date: 2026-10-30.
Interactive preview: artifact `a-1793353286738-7f7636`. It has six states and a narrow / Work-panel toggle.
Replaces the three-column Playground in `protobanana-plugin/view/src` (App.tsx, OpForm.tsx, Compare.tsx, Lineage.tsx, Gallery.tsx, MaskEditor.tsx, QueueStrip.tsx).

## 1. Principles
1. **The image is the product.** The canvas takes every pixel the other regions don't need.
2. **Prompt first, everything else on demand.** One textarea and one primary button are always visible. Everything else waits until it is useful.
3. **Ops are verbs on an image, not a mode chosen up front.** With no image you can only Generate (or upload). Once there is an image, edits appear as actions on it.
4. **One status place.** Render progress lives on the canvas where the result will land, not in a permanent section.
5. **House style.** Use @protolabsai/ui components and `--pl-*` tokens only, with the console's type scale and no orange accent. This matches the core views (Workflows, Board).

## 2. Rail name and icon
- **Label: "Images"**, lucide icon **`Images`** (manifest `views[0]`: `label: Images`, `icon: Images`).
- In-view header: eyebrow `protoBanana` over the title `Images`. "Studio" stays with core Workflows, so two identical "Studio" rail items no longer show at once.
- Rejected: "Studio" (collides), "Playground" (that names a mode inside the view, not the view), "Banana" (an internal codename).

## 3. Information architecture
```
┌ Header: protoBanana / Images · [Playground | Pipelines] ·········· (● 1 rendering) [+ New] [History]* ┐
├──────────────────────────────────────────────────────────────┬────────────────────────┤
│ CANVAS (dominant, bg-inset)                                  │ HISTORY (248px)        │
│   image, fit-to-stage; floating view toolbar top-right       │  header + filter btn   │
│   status / error overlay bottom-centre                       │  3-col thumb grid      │
├──────────────────────────────────────────────────────────────┤  (studio + agent,      │
│ ACTION BAR: Vary Edit Region Inpaint Outpaint RemoveBG Compose│   agent badge)        │
│             ··· ☆ Star  ⬇ Download  [Send to agent]          │                        │
├──────────────────────────────────────────────────────────────┤                        │
│ LINEAGE STRIP: gen → edit → [region]   ⑂ 2 variants           │                        │
├──────────────────────────────────────────────────────────────┤                        │
│ COMPOSER: [ prompt textarea ................ ] [1:1 · Final ▾] [Generate/Apply edit]   │
└──────────────────────────────────────────────────────────────┴────────────────────────┘
```
`*` The History button shows only when narrow (see §8).

| Region | Contents | Shows when |
|---|---|---|
| Header | Title, Playground/Pipelines tabs, a rendering badge, New, History (narrow only) | always |
| Canvas | Empty state, or the current image plus its view toolbar and overlays | always |
| Action bar | Edit verbs, Star, Download, Send to agent | an image is selected |
| Lineage strip | Ancestors of the current image, left to right; branch count | an image is selected |
| Composer | Prompt plus an options popover plus the primary action | always |
| History | Every render (studio + agent), filter popover | wide; a Drawer when narrow |

## 4. Primary flow
1. **Empty.** The canvas shows `Empty`: "Describe an image to start", with an Upload action. Drop or paste anywhere on the canvas also works. The composer is focused, and the button reads **Generate**.
2. **First image.** You press Generate (or ⌘/Ctrl+Enter). A render overlay sits on the canvas (§7). The result fades in, becomes the current image, and appears first in History.
3. **Iterate.** The composer now reads "Describe a change to this image…" and the button reads **Apply edit**, so the default verb is a whole-image edit. The action bar holds the other verbs:
   - **Vary**: same params, new seed. One click, no form. This replaces "Branch / new seed".
   - **Edit**: whole-image edit, same as the composer default. It focuses the composer.
   - **Region**: a "What to change?" field (`grounding`) appears in the composer above the prompt.
   - **Inpaint**: puts the canvas in mask mode (§5). The composer asks "What should go in the painted area?"
   - **Outpaint**: puts the canvas in margin mode. You drag edge handles (16px steps, arrow keys too), and the composer shows the margins as text.
   - **Remove BG**: one click, no prompt. It shows a "Non-commercial (RMBG CC BY-NC)" `Badge` when the catalog flags it.
   - **Compose**: the composer gains 1–2 extra reference slots (`ImageDropzone compact`) next to the current image, each filled from upload or a History pick.
   - A mode (Region, Inpaint, Outpaint, Compose) shows as a `Chip` above the prompt with an × to leave it. Esc also leaves.
4. **Compare.** Compare in the view toolbar splits the image against its parent, with a draggable, keyboard-operable handle. It is available only when the image has a parent.
5. **Keep.** Star pins the image (it survives retention). Download saves it. Selecting any thumb in History or the strip makes it the current image.
6. **Send to agent.** This button calls `protoagent:chat:compose` with `Image <media_id> (<op>, seed …, prompt "…"): `. A `useToast` confirms "Added to chat composer". The view has no chat box of its own.

Branching is implicit: editing any non-leaf image creates a sibling branch. The strip shows "⑂ N variants" at the fork. Clicking it opens a `Popover` of the sibling thumbs, so the tree appears only when it actually branches.

## 5. Component map

| Part | @protolabsai/ui | Gap issue |
|---|---|---|
| Header | `PanelHeader` (title + kicker + actions), `Tabs variant="segmented"` (Playground / Pipelines), `Badge` + `Spinner`, `Button variant="ghost"` | — |
| Canvas stage, zoom/fit, fullscreen | hand-built for now, with `Button size="xs" icon` toolbar + `Tooltip` and `Lightbox` for fullscreen | **#642 ImageViewport** |
| Compare split | inside ImageViewport | #642 |
| Mask paint and tools | `Button xs` toolbar (brush, eraser, invert, undo, clear) | **#639 MaskCanvas**, **#643 Slider** (brush size) |
| Empty canvas | `Empty` (icon/title/description/action) | drop target → **#641 ImageDropzone** |
| Render status | `Spinner`, `Progress` (determinate against typical latency, indeterminate past it), ghost `Button` "Stop" | — |
| Errors | `Callout tone="warning"/"error"` in the canvas overlay; `Banner` for catalog/plugin-unreachable | — |
| Action bar | `Button ghost sm` with icons, `Menu`/`MenuItem` for overflow ("More"), `Button` Send to agent | — |
| Lineage strip | `ScrollArea` | **#640 ImageThumb + ThumbnailStrip** |
| Composer | `Textarea`, `Button variant="primary"`, `Chip` for mode, `Popover` for options | — |
| Options popover | `Tabs variant="segmented"` (aspect, quality), `FormField` + `Input` (avoid, seed), `Button icon` seed lock | — |
| History | `PanelHeader compact`, `Grid auto`, `ScrollArea`, `Popover` filter with `DropdownSelect` (op), `Tabs segmented` (All/Mine/Agent), `Switch` (Starred) | thumbs → #640 |
| History when narrow | `Drawer side="right"` | — |
| Toasts | `ToastProvider` / `useToast` | — |

**Build note:** v1 must not wait on the gap issues. The builder composes local, token-only versions in `view/src/ds-pending/` with the props proposed in each issue. When protoContent publishes the real component, it swaps in through a `waits_for: npm:@protolabsai/ui@contains:…` follow-up card.

## 6. Progressive disclosure: hidden vs removed

**Always visible:** prompt, primary action, current image, (once there's an image) the action bar and the strip.

**Behind the options popover** (the button label summarises the state, e.g. `16:9 · Draft`):
- **Aspect**: 1:1, 3:4, 4:3, 16:9, 9:16 as segmented choices. Each maps to a fixed WxH from the catalog.
- **Quality**: Draft (turbo alias) / Final.
- **Avoid**: the negative prompt, hidden for ops whose schema has no `negative_prompt`.
- **Seed**: empty means random. A lock button pins the last seed so the next run reproduces it.

**Behind contextual modes:** grounding (Region), mask tools (Inpaint), margins (Outpaint), reference slots (Compose), person reference and `grounding_px` (Identity, under "More" until it earns a top-level slot).

**Behind the image's ⋯ / info:** full params, alias, media id, Copy params, Open in new tab.

**Removed outright:**
- the Operation `<select>` (ops become verbs on the image);
- Count / `n` and the "batch generation is not supported" note;
- the raw size text field (aspect presets replace it);
- "Advanced alias override" (operator config; at most a hidden `?debug` flag);
- the raw model id under the tier toggle (it moves to the info popover);
- the "Random / New seed" buttons (Vary + seed lock replace them);
- the always-visible zoom slider and Reset view (zoom shows only with an image; Fit resets);
- the permanent "Queue · Ready to render" section;
- the per-item "Branch / new seed" buttons in Lineage;
- the free-text "media reference" field in every input slot.

## 7. States

| State | Canvas | Composer / other |
|---|---|---|
| **Empty** (no history) | `Empty` + Upload; whole canvas is a drop/paste target | button "Generate" |
| **Catalog loading** | `Skeleton` stage; History `SkeletonGroup` | composer disabled, "Loading models…" |
| **Submitting** (<1s) | — | primary `Button loading` |
| **Rendering** (10–40s) | Previous image dimmed under a bottom-centre overlay: `Spinner` · "Rendering edit · 14s · usually ~25s" · `Progress` against the catalog's `typical_latency_s`, switching to indeterminate past it · ghost **Stop**. A placeholder thumb with a spinner sits at the end of the strip. The header shows a badge "1 rendering". | Composer stays usable. A second submit queues, and the badge reads "2 rendering · 1 queued". |
| **Cold load** | after 1.5× typical: the overlay line adds "Model is loading — first render after a swap can take longer" | — |
| **Stop** | Tooltip: "Stops tracking; the GPU still finishes. The result will appear in History." | — |
| **Done** | Result becomes current, the strip and History update, focus stays in the composer | announced via `role="status"` |
| **GPU busy / 524 timeout** | `Callout tone="warning"` "GPU busy — the gateway timed out. Your render may still land in History." with **Retry** (primary) and **Edit prompt**. History keeps listening on the bus, so a late result still appears and clears the callout. | — |
| **Recoverable (job lost after reload)** | same callout, "Lost track of this render", Retry | — |
| **Failed (non-recoverable)** | `Callout tone="error"` with the backend hint, Copy details, Edit prompt | — |
| **Plugin / API unreachable** | `Banner tone="error"` across the view with Reload | composer disabled |
| **Pruned image** | thumb shows a pruned placeholder; selecting it shows `Empty` "This image expired — star images to keep them" | — |

Live regions: the overlay status is `role="status"` (polite), and errors use `Callout` with no `role="alert"`, except plugin-unreachable (`Banner role="alert"`).

## 8. Width: console view with the Work panel open
The view uses a container query on its own root, not the viewport.
- **≥ 780px:** the layout above, with History as a 248px right column.
- **< 780px** (Work panel open): History becomes a header button that opens a `Drawer`. The action bar keeps Vary, Edit, Region and Inpaint, and moves the rest into a **More** `Menu`. The composer options button shrinks to an icon.
- **< 480px:** the canvas switches to `aspect-ratio` sizing, the strip scrolls, and the composer button stacks under the textarea.

## 9. Room for Pipelines (slice 2)
- The header's `Playground | Pipelines` segmented tabs exist from v1, with Pipelines disabled and the tooltip "Coming soon". Adding Pipelines changes only the body; the header stays.
- In the Pipelines body, the canvas area holds the xyflow graph. History stays in the right column, where a node's output thumbs land. The composer turns into the selected node's inspector, with the same `Textarea`, options popover and button pattern.
- Every Playground render is already a one-node pipeline (design doc §3.2). The lineage strip doubles as the "run from here" path, and **Open as pipeline** goes in the image ⋯ menu.
- Node visuals reuse core `DagCanvas` styling, so the two canvases look like one product.

## 10. Accessibility requirements (definition of done)
- Keyboard:
  - ⌘/Ctrl+Enter submits. Esc leaves a mode.
  - The action bar is a toolbar with arrow-key roving focus.
  - The strip and History are listboxes.
  - The compare handle and brush size are sliders.
  - `[` / `]` change brush size.
- Every icon button has a name (`aria-label` + `Tooltip`). Thumbs are named by op and time ("Region edit, 2 min ago").
- Dragging alternatives (WCAG 2.5.7): outpaint margins take numeric input in the composer; the mask has invert and select-all.
- Contrast: tokens only. Mask tint is `--pl-color-accent` at 35% over the image, plus an outline so it never relies on colour alone.
- Honors `prefers-reduced-motion` (no fade-in or progress animation).
- Focus is never lost when a render completes.

## 11. Gap issues filed (protoContent, `design-system`)
- #642 ImageViewport: zoom/pan stage, floating toolbar, before/after compare
- #639 MaskCanvas: paint-a-mask overlay plus brush tools
- #640 ImageThumb + ThumbnailStrip: selectable thumbs, lineage filmstrip, grid
- #641 ImageDropzone: drop / paste / browse image input
- #643 Slider: range primitive in `@protolabsai/ui/forms`

## 12. Open questions for Josh
1. Is "Images" the right rail name? The alternative is "Image Studio", which still half-collides.
2. Is "Apply edit" the right default verb after the first image, or should the composer stay on Generate (new image) until you pick an action?
3. Does Identity edit belong in v1's More menu, or should it be deferred?
