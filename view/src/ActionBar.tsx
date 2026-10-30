import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  type CatalogEntry,
  type HistoryRecord,
  type JobRequest,
  sendToAgent,
  starMedia,
  unstarMedia,
} from "./api";
import { branchRequest } from "./Lineage";
import {
  Badge,
  Button,
  ComposeIcon,
  DownloadIcon,
  EditIcon,
  InpaintIcon,
  Menu,
  MenuItem,
  MoreIcon,
  OutpaintIcon,
  RegionIcon,
  RemoveBgIcon,
  SendIcon,
  StarIcon,
  Tooltip,
  useToast,
  VaryIcon,
} from "./ds-pending";

// The contextual edit modes (design §4.3). `null` is the default whole-image
// edit (the composer's "Apply edit"); the four below each put extra controls in
// the composer and/or the canvas and show as a Chip.
export type EditMode = null | "region" | "inpaint" | "outpaint" | "compose" | "identity";

interface Verb {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  active?: boolean;
  disabled?: boolean;
}

// Icon button wired as one roving toolbar item (design §10: role="toolbar",
// arrow-key roving focus, every icon button named with aria-label + Tooltip).
function ToolButton({ label, active, disabled, onClick, children }: {
  label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="sm"
        icon
        data-toolbar-item=""
        aria-label={label}
        aria-pressed={active || undefined}
        className={active ? "is-active" : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

/** The action bar (design §3/§4/§5). Shows only when an image is selected
 *  (App gates it on `hasImage`), between the canvas and the composer. Every
 *  single-image op is reachable here as a verb on the current image. */
export function ActionBar({
  catalog,
  record,
  mediaId,
  imageRef,
  imageUrl,
  mode,
  narrow,
  onSetMode,
  onSubmit,
  onFocusComposer,
}: {
  catalog: CatalogEntry[] | null;
  record?: HistoryRecord;
  mediaId: string | null;
  imageRef: string | null;
  imageUrl?: string;
  mode: EditMode;
  narrow: boolean;
  onSetMode: (mode: EditMode) => void;
  onSubmit: (req: JobRequest) => void;
  onFocusComposer: () => void;
}) {
  const toast = useToast();
  const [starred, setStarred] = useState(false);
  useEffect(() => { setStarred(Boolean(record?.starred)); }, [record?.media_id, record?.starred]);

  const rmbgEntry = catalog?.find((e) => e.op === "remove_background");
  const rmbgNC = Boolean(rmbgEntry?.licence?.non_commercial);
  const identityEntry = catalog?.find((e) => e.op === "identity");

  // Vary: same params as the current image, a new seed, recorded as a child of
  // the current image (card). Reuses branchRequest's seed logic (this replaces
  // Lineage's per-item "Branch / new seed").
  const doVary = () => {
    if (!record) return;
    const req = branchRequest(record);
    req.parent_id = record.media_id;
    onSubmit(req);
  };

  const doRemoveBg = () => {
    if (!imageRef) return;
    const alias = rmbgEntry?.aliases.final ?? rmbgEntry?.aliases.draft ?? undefined;
    onSubmit({ op: "remove_background", tier: "final", alias: alias || undefined,
      params: { image: imageRef }, parent_id: mediaId || undefined });
  };

  const toggleStar = async () => {
    if (!mediaId) return;
    try {
      const next = starred ? await unstarMedia(mediaId) : await starMedia(mediaId);
      setStarred(next);
    } catch {
      /* leave the star as it was */
    }
  };

  const download = () => {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `${mediaId || "image"}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const send = () => {
    if (!record) return;
    sendToAgent(record);
    toast("Added to chat composer");
  };

  const edit: Verb = { id: "edit", label: "Edit", icon: <EditIcon />, active: mode === null, run: () => { onSetMode(null); onFocusComposer(); } };
  const vary: Verb = { id: "vary", label: "Vary", icon: <VaryIcon />, disabled: !record, run: doVary };
  const region: Verb = { id: "region", label: "Region", icon: <RegionIcon />, active: mode === "region", run: () => { onSetMode("region"); onFocusComposer(); } };
  const inpaint: Verb = { id: "inpaint", label: "Inpaint", icon: <InpaintIcon />, active: mode === "inpaint", run: () => onSetMode("inpaint") };
  const outpaint: Verb = { id: "outpaint", label: "Outpaint", icon: <OutpaintIcon />, active: mode === "outpaint", run: () => onSetMode("outpaint") };
  const removebg: Verb = { id: "removebg", label: "Remove BG", icon: <RemoveBgIcon />, disabled: !imageRef, run: doRemoveBg };
  const compose: Verb = { id: "compose", label: "Compose", icon: <ComposeIcon />, active: mode === "compose", run: () => onSetMode("compose") };

  // Below 780px of the view's own width (§8), Outpaint, Remove BG and Compose
  // collapse into the More menu; Identity lives in More at every width.
  const primary = [vary, edit, region, inpaint];
  const overflow = [outpaint, removebg, compose];
  const topLevel = narrow ? primary : [...primary, ...overflow];
  const moreVerbs: Verb[] = narrow ? [...overflow] : [];
  if (identityEntry) {
    moreVerbs.push({ id: "identity", label: "Identity", icon: <RegionIcon />, active: mode === "identity", run: () => { onSetMode("identity"); onFocusComposer(); } });
  }

  // Roving tabindex (design §10): the toolbar is one tab stop and the arrow keys
  // move focus across its controls. Managed on the DOM so it works regardless of
  // how the icon buttons are wrapped (Tooltip span, Popover trigger).
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [stop, setStop] = useState(0);
  const items = () => Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("[data-toolbar-item]") ?? [])
    .filter((b) => !b.disabled);
  useEffect(() => {
    const list = items();
    if (!list.length) return;
    const active = Math.min(stop, list.length - 1);
    list.forEach((b, i) => { b.tabIndex = i === active ? 0 : -1; });
  });
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    if (!list.length) return;
    const cur = list.indexOf(document.activeElement as HTMLButtonElement);
    if (cur < 0) return; // focus is inside an open menu panel — leave it alone
    let next = cur;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % list.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (cur - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault();
    list[next]?.focus();
    setStop(next);
  };

  return (
    <div className="action-bar" role="toolbar" aria-label="Image actions" ref={toolbarRef} onKeyDown={onKeyDown}>
      <div className="action-bar-verbs">
        {topLevel.map((v) => (
          <ToolButton key={v.id} label={v.label} active={v.active} disabled={v.disabled} onClick={v.run}>
            {v.icon}
          </ToolButton>
        ))}
        {moreVerbs.length > 0 && (
          <Menu
            label="More"
            trigger={({ toggle, open }) => (
              <Tooltip label="More actions">
                <Button
                  variant="ghost"
                  size="sm"
                  icon
                  data-toolbar-item=""
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  <MoreIcon />
                </Button>
              </Tooltip>
            )}
          >
            {moreVerbs.map((v) => (
              <MenuItem key={v.id} icon={v.icon} disabled={v.disabled} onClick={v.run}>
                {v.label}
              </MenuItem>
            ))}
          </Menu>
        )}
        {rmbgNC && (
          <Badge tone="warning" className="badge-nc action-bar-nc">
            Non-commercial · {rmbgEntry?.licence?.note || "RMBG CC BY-NC"}
          </Badge>
        )}
      </div>

      <div className="action-bar-right">
        <ToolButton label={starred ? "Unstar" : "Star"} active={starred} disabled={!mediaId} onClick={toggleStar}>
          <StarIcon filled={starred} />
        </ToolButton>
        <ToolButton label="Download" disabled={!imageUrl} onClick={download}>
          <DownloadIcon />
        </ToolButton>
        <Button size="sm" data-toolbar-item="" className="action-bar-send" disabled={!record} onClick={send}>
          <SendIcon />
          Send to agent
        </Button>
      </div>
    </div>
  );
}
