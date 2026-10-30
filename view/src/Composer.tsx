import { useEffect, useMemo, useRef, useState } from "react";

import { type CatalogEntry, type HistoryRecord, type JobRequest } from "./api";
import type { EditMode } from "./ActionBar";
import { Badge, Button, Chip, FormField, Input, Popover, Segmented, Textarea } from "./ds-pending";

// The always-visible composer (design §3/§4). Prompt first: one Textarea and one
// primary Button are the only permanent controls. With no current image the verb
// is "Generate" (a new root); once there is a current image it becomes
// "Apply edit". The active edit MODE (from the action bar) decides which op runs
// and which extra fields appear: Region → a grounding field above the prompt;
// Inpaint → the painted mask (painted on the canvas); Outpaint → editable numeric
// margins (the WCAG 2.5.7 dragging alternative); Compose → reference slots beside
// the current image. A contextual mode shows as a Chip with ×. ⌘/Ctrl+Enter submits.

// Each aspect preset maps to a fixed WxH from the catalog's size bounds (16px
// grid, 256–2048 — see catalog_static._SIZE). Replaces the raw size field (§6).
const ASPECTS: { value: string; size: string }[] = [
  { value: "1:1", size: "1024x1024" },
  { value: "3:4", size: "768x1024" },
  { value: "4:3", size: "1024x768" },
  { value: "16:9", size: "1280x720" },
  { value: "9:16", size: "720x1280" },
];

const QUALITY = [
  { value: "draft", label: "Draft" },
  { value: "final", label: "Final" },
];

export interface Margins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const EDGES: (keyof Margins)[] = ["left", "top", "right", "bottom"];
const EDGE_LABEL: Record<keyof Margins, string> = { left: "Left", top: "Top", right: "Right", bottom: "Bottom" };

// mode → op. `null` is the default (generate without an image, else whole-image
// edit); the contextual modes map to their catalog op.
function opFor(hasImage: boolean, mode: EditMode): string {
  if (!hasImage) return "generate";
  switch (mode) {
    case "region": return "region_edit";
    case "inpaint": return "inpaint";
    case "outpaint": return "outpaint";
    case "compose": return "compose";
    case "identity": return "identity";
    default: return "edit";
  }
}

const MODE_LABEL: Record<Exclude<EditMode, null>, string> = {
  region: "Region", inpaint: "Inpaint", outpaint: "Outpaint", compose: "Compose", identity: "Identity",
};

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

// A compact reference dropzone for Compose (design §4.3): upload, drop, paste, or
// pick from History. The current image is reference #1 implicitly; these are the
// 1–2 extra slots beside it.
function RefSlot({ index, value, records, onChange }: {
  index: number; value: string; records: HistoryRecord[]; onChange: (value: string) => void;
}) {
  const read = (file?: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(file);
  };
  const filled = value.startsWith("data:") ? "uploaded image" : value;
  return (
    <div
      className={`ref-slot${value ? " is-filled" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); read(e.dataTransfer.files?.[0]); }}
      onPaste={(e) => { const f = e.clipboardData?.files?.[0]; if (f) { e.preventDefault(); e.stopPropagation(); read(f); } }}
    >
      <span className="ref-slot-label">Reference {index}</span>
      {value ? (
        <div className="ref-slot-filled">
          <span className="ref-slot-value" title={filled}>{filled}</span>
          <Button variant="ghost" size="xs" aria-label={`Clear reference ${index}`} onClick={() => onChange("")}>Clear</Button>
        </div>
      ) : (
        <div className="ref-slot-pickers">
          <label className="ref-slot-upload">
            Upload
            <input className="visually-hidden" type="file" accept="image/*" aria-label={`Upload reference ${index}`}
              onChange={(e) => { read(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <select
            className="pl-select"
            aria-label={`Pick reference ${index} from history`}
            value=""
            onChange={(e) => e.target.value && onChange(e.target.value)}
          >
            <option value="">From History…</option>
            {records.filter((r) => !r.pruned).map((r) => (
              <option key={r.media_id} value={r.media_id}>{r.op} · {r.media_id}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

export function Composer({
  catalog,
  hasImage,
  inputRef: imageRef,
  parentId,
  unreachable,
  focusSignal,
  mode,
  onLeaveMode,
  mask,
  margins,
  onMarginsChange,
  records,
  onSubmit,
}: {
  catalog: CatalogEntry[] | null;
  hasImage: boolean;
  inputRef: string | null;
  parentId: string | null;
  unreachable: boolean;
  focusSignal: number;
  mode: EditMode;
  onLeaveMode: () => void;
  mask: string;
  margins: Margins;
  onMarginsChange: (margins: Margins) => void;
  records: HistoryRecord[];
  onSubmit: (req: JobRequest) => void;
}) {
  const op = opFor(hasImage, mode);
  const entry = catalog?.find((e) => e.op === op);
  const loading = catalog === null;

  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState("1:1");
  const [quality, setQuality] = useState("final");
  const [avoid, setAvoid] = useState("");
  const [seedInput, setSeedInput] = useState("");
  const [grounding, setGrounding] = useState("");
  const [references, setReferences] = useState<string[]>(["", ""]);
  const lastSeed = useRef<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep focus in the composer on mount and whenever a render completes (§4.5,
  // §10 "Focus is never lost when a render completes").
  useEffect(() => {
    textareaRef.current?.focus();
  }, [focusSignal]);

  // Leaving (or switching) a mode clears its mode-local fields.
  useEffect(() => {
    setGrounding("");
    setReferences(["", ""]);
  }, [mode]);

  const props = entry?.params.properties ?? {};
  const required = entry?.params.required ?? [];
  const hasSize = "size" in props;
  const hasAvoid = "negative_prompt" in props;
  const hasSeed = "seed" in props;

  const seedLocked = seedInput.trim() !== "";
  const optionSummary = useMemo(() => {
    const parts: string[] = [];
    if (hasSize) parts.push(aspect);
    parts.push(quality === "draft" ? "Draft" : "Final");
    return parts.join(" · ");
  }, [hasSize, aspect, quality]);

  const composeImages = () => [imageRef, ...references].filter((s): s is string => Boolean(s));

  // Submit is blocked by the op's required fields (plus the mode-specific inputs).
  const blocked = (() => {
    if (loading || unreachable || !entry) return true;
    if (required.includes("image") && !imageRef) return true;
    if (required.includes("prompt") && prompt.trim() === "") return true;
    if (required.includes("grounding") && grounding.trim() === "") return true;
    if (required.includes("mask") && !mask) return true;
    if (op === "compose" && composeImages().length < 2) return true;
    if (op === "outpaint" && !EDGES.some((e) => Number(margins[e]) > 0)) return true;
    return false;
  })();

  const selectedAlias = entry?.aliases[quality] ?? entry?.aliases.final ?? "";

  const submit = () => {
    if (!entry || blocked) return;
    const params: Record<string, unknown> = {};
    if ("prompt" in props) params.prompt = prompt.trim();
    if ("image" in props && imageRef) params.image = imageRef;
    if ("grounding" in props) params.grounding = grounding.trim();
    if ("mask" in props) params.mask = mask;
    if ("keep_transparency" in props) params.keep_transparency = true;
    for (const edge of EDGES) if (edge in props) params[edge] = Number(margins[edge]) || 0;
    if ("images" in props) params.images = composeImages();
    if (hasAvoid) params.negative_prompt = avoid;
    if (hasSize) params.size = ASPECTS.find((a) => a.value === aspect)?.size ?? "1024x1024";
    if (hasSeed) {
      const seed = seedLocked ? Number(seedInput) : randomSeed();
      lastSeed.current = seed;
      params.seed = seed;
    }
    // Generation always starts a new root, even with an expired History selection.
    const parent_id = entry.op === "generate" ? undefined : parentId || undefined;
    onSubmit({ op: entry.op, tier: quality, alias: selectedAlias || undefined, params, parent_id });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = loading
    ? "Loading models…"
    : !hasImage
      ? "Describe an image to start"
      : op === "inpaint"
        ? "What should go in the painted area?"
        : op === "outpaint"
          ? "What should the new areas contain? (optional)"
          : op === "compose"
            ? "Describe the combined image…"
            : "Describe a change to this image…";

  const showChip = hasImage && mode !== null;

  return (
    <form
      className="composer"
      aria-label="Composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {showChip && mode && (
        <Chip
          className="composer-mode"
          label={MODE_LABEL[mode]}
          removeLabel={`Leave ${MODE_LABEL[mode]} mode`}
          onRemove={onLeaveMode}
        />
      )}

      {op === "region_edit" && (
        <FormField className="composer-grounding" label="What to change?" hint="A short noun phrase for the region, e.g. “the red car”.">
          <Input aria-label="What to change?" value={grounding} placeholder="the red car"
            onChange={(e) => setGrounding(e.target.value)} />
        </FormField>
      )}

      {op === "compose" && (
        <div className="composer-refs" aria-label="Reference images">
          {references.map((value, i) => (
            <RefSlot key={i} index={i + 1} value={value} records={records}
              onChange={(v) => setReferences((refs) => refs.map((r, j) => (i === j ? v : r)))} />
          ))}
        </div>
      )}

      <Textarea
        ref={textareaRef}
        className="composer-prompt"
        aria-label="Prompt"
        rows={2}
        value={prompt}
        disabled={loading || unreachable}
        placeholder={placeholder}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
      />

      {op === "outpaint" && (
        <div className="composer-margins" role="group" aria-label="Outpaint margins">
          {EDGES.map((edge) => (
            <FormField key={edge} className="composer-margin" label={EDGE_LABEL[edge]}>
              <Input
                aria-label={EDGE_LABEL[edge]}
                type="number"
                inputMode="numeric"
                min={0}
                step={16}
                value={String(margins[edge] ?? 0)}
                onChange={(e) => onMarginsChange({ ...margins, [edge]: Math.max(0, Number(e.target.value) || 0) })}
              />
            </FormField>
          ))}
        </div>
      )}

      {(entry?.licence?.non_commercial || /rmbg/i.test(selectedAlias)) && (
        <Badge tone="warning" className="badge-nc">
          Non-commercial · {entry?.licence?.note || "RMBG CC BY-NC"}
        </Badge>
      )}

      <div className="composer-actions">
        <Popover
          className="composer-options"
          label="Options"
          align="start"
          side="top"
          trigger={({ toggle, open }) => (
            <Button
              variant="ghost"
              className="composer-options-btn"
              aria-expanded={open}
              aria-label={`Options: ${optionSummary}`}
              disabled={loading || unreachable}
              onClick={toggle}
            >
              <span className="composer-options-summary">{optionSummary}</span>
              <span aria-hidden="true">▾</span>
            </Button>
          )}
        >
          <div className="composer-opt-grid">
            {hasSize && (
              <FormField label="Aspect">
                <Segmented
                  ariaLabel="Aspect"
                  size="sm"
                  value={aspect}
                  onChange={setAspect}
                  options={ASPECTS.map((a) => ({ value: a.value, label: a.value }))}
                />
              </FormField>
            )}
            <FormField label="Quality">
              <Segmented ariaLabel="Quality" size="sm" value={quality} onChange={setQuality} options={QUALITY} />
            </FormField>
            {hasAvoid && (
              <FormField label="Avoid" hint="What the render should not contain.">
                <Input
                  aria-label="Avoid"
                  value={avoid}
                  placeholder="e.g. text, watermark"
                  onChange={(e) => setAvoid(e.target.value)}
                />
              </FormField>
            )}
            {hasSeed && (
              <FormField label="Seed" hint="Empty = random. Lock to reproduce the last render.">
                <div className="composer-seed">
                  <Input
                    aria-label="Seed"
                    inputMode="numeric"
                    value={seedInput}
                    placeholder="random"
                    onChange={(e) => setSeedInput(e.target.value.replace(/[^0-9]/g, ""))}
                  />
                  <Button
                    icon
                    aria-label={seedLocked ? "Unlock seed" : "Lock seed"}
                    aria-pressed={seedLocked}
                    title={seedLocked ? "Seed locked — unlock for a random seed" : "Lock the last seed to reproduce it"}
                    onClick={() => {
                      if (seedLocked) setSeedInput("");
                      else if (lastSeed.current != null) setSeedInput(String(lastSeed.current));
                    }}
                  >
                    {seedLocked ? "🔒" : "🔓"}
                  </Button>
                </div>
              </FormField>
            )}
          </div>
        </Popover>

        <Button variant="primary" type="submit" className="composer-submit" disabled={blocked}>
          {hasImage ? "Apply edit" : "Generate"}
        </Button>
      </div>
    </form>
  );
}
