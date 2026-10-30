// Local, token-only stand-ins for @protolabsai/ui (DS-first rule; design §5
// "build note"). The real package (npm:@protolabsai/ui) can't be installed into
// this view today: it declares `react@^19` as a peer (this app is React 18) and
// its export map points most subpaths at raw `.tsx` that drag in framer-motion,
// radix, dnd-kit, streamdown and katex. So until a `waits_for: npm:@protolabsai/ui`
// swap card lands, these components mirror the DS API but emit a PLUGIN-LOCAL
// `.pbx-*` class namespace — never `.pl-*`, which belongs to /_ds/plugin-kit.css
// (kit `.pl-popover`/`.pl-empty`/`.pl-menu`/… are real, differently-shaped rules
// that would clobber these stand-ins when the kit CSS is loaded in the console).
// They still consume the host's `--pl-*` design TOKENS (served by
// /_ds/plugin-kit.css); every colour is a token with a literal fallback — no
// hard-coded palette — so the view also renders standalone (tests, screenshots).
// The ds-pending-no-pl-collision test guards the namespace split.

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// -------------------------------------------------------------------- Spinner

export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <span
      className="pbx-spinner"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    />
  );
}

// --------------------------------------------------------------------- Button

type ButtonVariant = "default" | "primary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "xs" | "sm";
  icon?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size, icon, loading, className, children, type = "button", disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "pbx-btn",
        variant === "primary" && "pbx-btn--primary",
        variant === "ghost" && "pbx-btn--ghost",
        variant === "danger" && "pbx-btn--danger",
        icon && "pbx-btn--icon",
        size === "xs" && "pbx-btn--xs",
        size === "sm" && "pbx-btn--sm",
        loading && "pbx-btn--loading",
        className,
      )}
      {...rest}
    >
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------- Badge

export function Badge({
  tone,
  className,
  children,
}: {
  tone?: "info" | "success" | "warning" | "error";
  className?: string;
  children: ReactNode;
}) {
  return <span className={cx("pbx-badge", tone && `pbx-badge--${tone}`, className)}>{children}</span>;
}

// ---------------------------------------------------------------- PanelHeader

export function PanelHeader({
  kicker,
  title,
  actions,
  compact,
  className,
  children,
}: {
  kicker?: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <header className={cx("pbx-panel-header", compact && "pbx-panel-header--compact", className)}>
      <div className="pbx-panel-header-titles">
        {kicker && <span className="pbx-panel-header-kicker">{kicker}</span>}
        {compact ? (
          <h2 className="pbx-panel-header-title">{title}</h2>
        ) : (
          <h1 className="pbx-panel-header-title">{title}</h1>
        )}
      </div>
      {children && <div className="pbx-panel-header-mid">{children}</div>}
      {actions && <div className="pbx-panel-header-actions">{actions}</div>}
    </header>
  );
}

// ----------------------------------------------------------------------- Tabs

export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

export function Tabs({
  items,
  value,
  onChange,
  variant = "segmented",
  ariaLabel,
}: {
  items: TabItem[];
  value: string;
  onChange?: (id: string) => void;
  variant?: "segmented";
  ariaLabel?: string;
}) {
  return (
    <div className={cx("pbx-tabs", `pbx-tabs--${variant}`)} role="tablist" aria-label={ariaLabel}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={value === it.id}
          aria-disabled={it.disabled || undefined}
          disabled={it.disabled}
          title={it.title}
          className={cx("pbx-tab", value === it.id && "pbx-tab--active")}
          onClick={() => !it.disabled && onChange?.(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Segmented

export interface SegmentedOption {
  value: string;
  label: ReactNode;
}

export function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
  size,
}: {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  size?: "sm";
}) {
  return (
    <div className={cx("pbx-segmented", size === "sm" && "pbx-segmented--sm")} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={cx("pbx-segmented-opt", value === o.value && "is-active")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------- Empty

export function Empty({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("pbx-empty", className)}>
      {icon && (
        <div className="pbx-empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      {title && <p className="pbx-empty-title">{title}</p>}
      {description && <p className="pbx-empty-desc">{description}</p>}
      {action && <div className="pbx-empty-action">{action}</div>}
    </div>
  );
}

// -------------------------------------------------------------------- Callout

export function Callout({
  tone = "info",
  title,
  actions,
  className,
  children,
}: {
  tone?: "info" | "success" | "warning" | "error";
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  // No role="alert" here (design §7 "Live regions"): overlay callouts are polite.
  return (
    <div className={cx("pbx-callout", `pbx-callout--${tone}`, className)}>
      <div className="pbx-callout-body">
        {title && <strong className="pbx-callout-title">{title}</strong>}
        {children && <div className="pbx-callout-text">{children}</div>}
      </div>
      {actions && <div className="pbx-callout-actions">{actions}</div>}
    </div>
  );
}

// --------------------------------------------------------------------- Banner

export function Banner({
  tone = "error",
  role,
  action,
  className,
  children,
}: {
  tone?: "info" | "success" | "warning" | "error";
  role?: string;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cx("pbx-banner", `pbx-banner--${tone}`, className)} role={role}>
      <div className="pbx-banner-body">{children}</div>
      {action && <div className="pbx-banner-actions">{action}</div>}
    </div>
  );
}

// ------------------------------------------------------------------- Textarea

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx("pbx-textarea", className)} {...rest} />;
  },
);

// ----------------------------------------------------------------- Form field

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx("pbx-input", className)} {...rest} />;
  },
);

export function FormField({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  // A <div>, not a <label>: these FormFields wrap custom controls (Segmented /
  // Switch are <button>s, which ARE labelable), so a <label> would hijack the
  // first button's accessible name. Each control carries its own aria-label.
  return (
    <div className={cx("pbx-field", className)}>
      <span className="pbx-field-label">{label}</span>
      {children}
      {hint && <span className="pbx-field-hint">{hint}</span>}
    </div>
  );
}

// ------------------------------------------------------------- DropdownSelect

export function DropdownSelect({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SegmentedOption[];
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <select
      className={cx("pbx-select", className)}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// --------------------------------------------------------------------- Switch

export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={cx("pbx-switch", checked && "is-on")}
      onClick={() => onChange(!checked)}
    >
      <span className="pbx-switch-track">
        <span className="pbx-switch-thumb" />
      </span>
      {label && <span className="pbx-switch-label">{label}</span>}
    </button>
  );
}

// --------------------------------------------------------------------- Slider

// Token-only range control (DS gap #643): a native <input type="range"> whose
// thumb/track read as the DS accent (`accent-color: --pl-color-accent`) instead
// of the browser-blue default. Used by the Inpaint mask tools (brush / feather).
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  ariaLabel,
  className,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel?: string;
  className?: string;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="range"
      className={cx("pbx-slider", className)}
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

// ------------------------------------------------------------------- Progress

export function Progress({
  value,
  indeterminate,
  ariaLabel,
}: {
  value?: number;
  indeterminate?: boolean;
  ariaLabel?: string;
}) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div
      className={cx("pbx-progress", indeterminate && "pbx-progress--indet")}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
    >
      <span className="pbx-progress-bar" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

// ------------------------------------------------------------------ Skeletons

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span className={cx("pbx-skeleton", className)} style={style} aria-hidden="true" />;
}

export function SkeletonGroup({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cx("pbx-skeleton-group", className)} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} />
      ))}
    </div>
  );
}

// -------------------------------------------------------------------- Popover

export function Popover({
  trigger,
  label,
  align = "start",
  side = "bottom",
  className,
  children,
}: {
  trigger: (api: { open: boolean; toggle: () => void }) => ReactNode;
  label?: string;
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={cx("pbx-popover", className)} ref={rootRef}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={cx("pbx-popover-panel", `pbx-popover-panel--${align}`, `pbx-popover-panel--${side}`)}
          role="dialog"
          aria-label={label}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- Drawer

export function Drawer({
  open,
  onClose,
  side = "right",
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  side?: "right" | "left";
  label?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="pbx-drawer-overlay" onMouseDown={onClose}>
      <div
        className={cx("pbx-drawer", `pbx-drawer--${side}`)}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Lightbox

// Fullscreen image overlay for the view toolbar's Fullscreen control (design §7).
// Local stand-in until #642 ImageViewport; Esc or a backdrop click closes it, and
// the image is shown whole (object-fit:contain) regardless of the stage zoom.
export function Lightbox({
  open,
  src,
  alt,
  onClose,
}: {
  open: boolean;
  src?: string;
  alt?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="pbx-lightbox" role="dialog" aria-modal="true" aria-label="Fullscreen image" onMouseDown={onClose}>
      <Button
        icon
        size="sm"
        className="pbx-lightbox-close"
        aria-label="Close fullscreen"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        <CloseIcon />
      </Button>
      {src && <img className="pbx-lightbox-img" src={src} alt={alt || "Fullscreen image"} onMouseDown={(e) => e.stopPropagation()} />}
    </div>
  );
}

// -------------------------------------------------------------------- Tooltip

// A supplemental hover/focus tooltip (design §10 "every icon button has a name
// (aria-label + Tooltip)"). The accessible NAME lives on the wrapped control's
// own aria-label; this bubble is decorative and kept out of the a11y tree until
// shown (CSS `display:none` → the role="tooltip" node isn't announced at rest).
export function Tooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <span className="pbx-tooltip-wrap">
      {children}
      <span role="tooltip" className="pbx-tooltip">
        {label}
      </span>
    </span>
  );
}

// ----------------------------------------------------------------------- Chip

// A removable mode pill (design §4.3 / §5 Composer): the active contextual mode
// shows as a Chip above the prompt with an × to leave it.
export function Chip({
  label,
  onRemove,
  removeLabel,
  className,
}: {
  label: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
}) {
  return (
    <span className={cx("pbx-chip", className)}>
      <span className="pbx-chip-label">{label}</span>
      {onRemove && (
        <button type="button" className="pbx-chip-x" aria-label={removeLabel || "Remove"} onClick={onRemove}>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </span>
  );
}

// ----------------------------------------------------------------------- Menu

// Overflow menu for the action bar ("More", design §5/§8). Thin wrapper over
// Popover: the caller owns the trigger (so the toolbar can mark it as a roving
// item), and the panel is a role="menu".
export function Menu({
  trigger,
  label,
  align = "end",
  side = "top",
  className,
  children,
}: {
  trigger: (api: { open: boolean; toggle: () => void }) => ReactNode;
  label?: string;
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Popover trigger={trigger} label={label} align={align} side={side} className={cx("pbx-menu", className)}>
      <div role="menu" className="pbx-menu-list">
        {children}
      </div>
    </Popover>
  );
}

export function MenuItem({
  onClick,
  icon,
  disabled,
  children,
}: {
  onClick: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" className="pbx-menu-item" disabled={disabled} onClick={onClick}>
      {icon && (
        <span className="pbx-menu-item-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}

// --------------------------------------------------------------------- Toasts

interface ToastMsg {
  id: number;
  message: string;
}

const ToastContext = createContext<(message: string) => void>(() => {});

/** Confirm transient actions (design §4.6 "Added to chat composer"). The viewport
 *  is a polite live region so the confirmation is announced without stealing focus. */
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const seq = useRef(0);
  const show = useCallback((message: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pbx-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="pbx-toast">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------- Icons

// Inline lucide-style glyphs, token-coloured via `currentColor`. Icon buttons
// carry their own aria-label; these SVGs stay aria-hidden (design §10).
function Glyph({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const VaryIcon = () => (
  <Glyph>
    <path d="M16 3h5v5" />
    <path d="M21 3 10 14" />
    <path d="M8 3H3v5" />
    <path d="M3 3l7 7" />
    <path d="M16 21h5v-5" />
    <path d="M21 21 14 14" />
    <path d="M3 16v5h5" />
    <path d="M3 21l5-5" />
  </Glyph>
);

export const EditIcon = () => (
  <Glyph>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Glyph>
);

export const RegionIcon = () => (
  <Glyph>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <circle cx="12" cy="12" r="3.2" />
  </Glyph>
);

export const InpaintIcon = () => (
  <Glyph>
    <path d="M14.5 3.5a2.1 2.1 0 0 1 3 3l-8 8-3-3Z" />
    <path d="M6.5 11.5 3 21l9.5-3.5" />
  </Glyph>
);

export const OutpaintIcon = () => (
  <Glyph>
    <rect x="8" y="8" width="8" height="8" rx="1" />
    <path d="M3 3l3 3M3 3v4M3 3h4" />
    <path d="M21 3l-3 3M21 3v4M21 3h-4" />
    <path d="M3 21l3-3M3 21v-4M3 21h4" />
    <path d="M21 21l-3-3M21 21v-4M21 21h-4" />
  </Glyph>
);

export const RemoveBgIcon = () => (
  <Glyph>
    <path d="M12 3a9 9 0 1 0 9 9" />
    <path d="M3 3l18 18" />
    <circle cx="9" cy="9" r="1.4" />
  </Glyph>
);

export const ComposeIcon = () => (
  <Glyph>
    <rect x="3" y="7" width="12" height="12" rx="2" />
    <path d="M9 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2" />
  </Glyph>
);

export const StarIcon = ({ filled }: { filled?: boolean }) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.2l5.9-.9Z" />
  </svg>
);

export const DownloadIcon = () => (
  <Glyph>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 20h16" />
  </Glyph>
);

// Distinct from EditIcon's pencil (design §4 action bar): a paper-plane "send"
// glyph so "Send to agent" never reads as another Edit.
export const SendIcon = () => (
  <Glyph>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4Z" />
  </Glyph>
);

// Settings/sliders glyph for the composer options trigger when it collapses to an
// icon below 780px (design §8 breakpoints).
export const SlidersIcon = () => (
  <Glyph>
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h16" />
    <circle cx="9" cy="7" r="2" />
    <circle cx="15" cy="12" r="2" />
    <circle cx="8" cy="17" r="2" />
  </Glyph>
);

export const MoreIcon = () => (
  <Glyph>
    <circle cx="5" cy="12" r="1.3" />
    <circle cx="12" cy="12" r="1.3" />
    <circle cx="19" cy="12" r="1.3" />
  </Glyph>
);

// Floating view-toolbar glyphs (design §7 zoom/fit/fullscreen). Token-coloured.
export const ZoomInIcon = () => (
  <Glyph>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
    <path d="M11 8v6M8 11h6" />
  </Glyph>
);

export const ZoomOutIcon = () => (
  <Glyph>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
    <path d="M8 11h6" />
  </Glyph>
);

// "Fit to stage" — four inward corners.
export const FitIcon = () => (
  <Glyph>
    <path d="M4 9V5a1 1 0 0 1 1-1h4" />
    <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
    <path d="M4 15v4a1 1 0 0 0 1 1h4" />
    <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
  </Glyph>
);

// Fullscreen / expand — four outward corners.
export const FullscreenIcon = () => (
  <Glyph>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </Glyph>
);

export const CloseIcon = () => (
  <Glyph>
    <path d="M18 6 6 18" />
    <path d="M6 6l12 12" />
  </Glyph>
);

// A single inline glyph for the Empty state (lucide `Images`), token-coloured.
export function ImagesIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <circle cx="8" cy="8" r="1.6" />
      <path d="M3 13l3.5-3.5a1.5 1.5 0 0 1 2 0L17 17" />
      <path d="M21 7v12a2 2 0 0 1-2 2H7" />
    </svg>
  );
}
