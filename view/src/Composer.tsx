import { useEffect, useMemo, useRef, useState } from "react";

import { type CatalogEntry, type JobRequest } from "./api";
import { Badge, Button, FormField, Input, Popover, Segmented, Textarea } from "./ds-pending";

// The always-visible composer (design §3/§4). Prompt first: one Textarea and one
// primary Button are the only permanent controls. With no current image the verb
// is "Generate" (a new root); once there is a current image it becomes
// "Apply edit" — a whole-image edit op with that image as input. Everything else
// (aspect, quality, avoid, seed) waits behind the options Popover whose button
// summarises the state ("16:9 · Draft"). ⌘/Ctrl+Enter submits.

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

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

export function Composer({
  catalog,
  hasImage,
  inputRef: imageRef,
  parentId,
  unreachable,
  focusSignal,
  onSubmit,
}: {
  catalog: CatalogEntry[] | null;
  hasImage: boolean;
  inputRef: string | null;
  parentId: string | null;
  unreachable: boolean;
  focusSignal: number;
  onSubmit: (req: JobRequest) => void;
}) {
  const op = hasImage ? "edit" : "generate";
  const entry = catalog?.find((e) => e.op === op);
  const loading = catalog === null;

  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState("1:1");
  const [quality, setQuality] = useState("final");
  const [avoid, setAvoid] = useState("");
  const [seedInput, setSeedInput] = useState("");
  const lastSeed = useRef<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep focus in the composer on mount and whenever a render completes (§4.5,
  // §10 "Focus is never lost when a render completes").
  useEffect(() => {
    textareaRef.current?.focus();
  }, [focusSignal]);

  const props = entry?.params.properties ?? {};
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

  const disabled = loading || unreachable || prompt.trim() === "";
  const selectedAlias = entry?.aliases[quality] ?? entry?.aliases.final ?? "";

  const submit = () => {
    if (!entry || disabled) return;
    const params: Record<string, unknown> = {};
    if ("prompt" in props) params.prompt = prompt.trim();
    if ("image" in props && imageRef) params.image = imageRef;
    if (hasAvoid) params.negative_prompt = avoid;
    if (hasSize) params.size = ASPECTS.find((a) => a.value === aspect)?.size ?? "1024x1024";
    if ("keep_transparency" in props) params.keep_transparency = true;
    if (hasSeed) {
      const seed = seedLocked ? Number(seedInput) : randomSeed();
      lastSeed.current = seed;
      params.seed = seed;
    }
    const tier = quality;
    // Generation always starts a new root, even with an expired History selection.
    const parent_id = entry.op === "edit" ? parentId || undefined : undefined;
    onSubmit({ op: entry.op, tier, alias: selectedAlias || undefined, params, parent_id });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="composer"
      aria-label="Composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        ref={textareaRef}
        className="composer-prompt"
        aria-label="Prompt"
        rows={2}
        value={prompt}
        disabled={loading || unreachable}
        placeholder={
          loading
            ? "Loading models…"
            : hasImage
              ? "Describe a change to this image…"
              : "Describe an image to start"
        }
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
      />

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

        <Button variant="primary" type="submit" className="composer-submit" disabled={disabled}>
          {hasImage ? "Apply edit" : "Generate"}
        </Button>
      </div>
    </form>
  );
}
