// Local, token-only stand-ins for @protolabsai/ui (DS-first rule; design §5
// "build note"). The real package (npm:@protolabsai/ui) can't be installed into
// this view today: it declares `react@^19` as a peer (this app is React 18) and
// its export map points most subpaths at raw `.tsx` that drag in framer-motion,
// radix, dnd-kit, streamdown and katex. So until a `waits_for: npm:@protolabsai/ui`
// swap card lands, these components mirror the DS API with the SAME `.pl-*`
// class names and consume the host's `--pl-*` tokens (served by
// /_ds/plugin-kit.css). Every colour is a token with a literal fallback — no
// hard-coded palette — so the view also renders standalone (tests, screenshots).

import {
  forwardRef,
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
      className="pl-spinner"
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
        "pl-btn",
        variant === "primary" && "pl-btn--primary",
        variant === "ghost" && "pl-btn--ghost",
        variant === "danger" && "pl-btn--danger",
        icon && "pl-btn--icon",
        size === "xs" && "pl-btn--xs",
        size === "sm" && "pl-btn--sm",
        loading && "pl-btn--loading",
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
  return <span className={cx("pl-badge", tone && `pl-badge--${tone}`, className)}>{children}</span>;
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
    <header className={cx("pl-panel-header", compact && "pl-panel-header--compact", className)}>
      <div className="pl-panel-header-titles">
        {kicker && <span className="pl-panel-header-kicker">{kicker}</span>}
        {compact ? (
          <h2 className="pl-panel-header-title">{title}</h2>
        ) : (
          <h1 className="pl-panel-header-title">{title}</h1>
        )}
      </div>
      {children && <div className="pl-panel-header-mid">{children}</div>}
      {actions && <div className="pl-panel-header-actions">{actions}</div>}
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
    <div className={cx("pl-tabs", `pl-tabs--${variant}`)} role="tablist" aria-label={ariaLabel}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={value === it.id}
          aria-disabled={it.disabled || undefined}
          disabled={it.disabled}
          title={it.title}
          className={cx("pl-tab", value === it.id && "pl-tab--active")}
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
    <div className={cx("pl-segmented", size === "sm" && "pl-segmented--sm")} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={cx("pl-segmented-opt", value === o.value && "is-active")}
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
    <div className={cx("pl-empty", className)}>
      {icon && (
        <div className="pl-empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      {title && <p className="pl-empty-title">{title}</p>}
      {description && <p className="pl-empty-desc">{description}</p>}
      {action && <div className="pl-empty-action">{action}</div>}
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
    <div className={cx("pl-callout", `pl-callout--${tone}`, className)}>
      <div className="pl-callout-body">
        {title && <strong className="pl-callout-title">{title}</strong>}
        {children && <div className="pl-callout-text">{children}</div>}
      </div>
      {actions && <div className="pl-callout-actions">{actions}</div>}
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
    <div className={cx("pl-banner", `pl-banner--${tone}`, className)} role={role}>
      <div className="pl-banner-body">{children}</div>
      {action && <div className="pl-banner-actions">{action}</div>}
    </div>
  );
}

// ------------------------------------------------------------------- Textarea

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx("pl-textarea", className)} {...rest} />;
  },
);

// ----------------------------------------------------------------- Form field

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx("pl-input", className)} {...rest} />;
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
    <div className={cx("pl-field", className)}>
      <span className="pl-field-label">{label}</span>
      {children}
      {hint && <span className="pl-field-hint">{hint}</span>}
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
      className={cx("pl-select", className)}
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
      className={cx("pl-switch", checked && "is-on")}
      onClick={() => onChange(!checked)}
    >
      <span className="pl-switch-track">
        <span className="pl-switch-thumb" />
      </span>
      {label && <span className="pl-switch-label">{label}</span>}
    </button>
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
      className={cx("pl-progress", indeterminate && "pl-progress--indet")}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
    >
      <span className="pl-progress-bar" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

// ------------------------------------------------------------------ Skeletons

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span className={cx("pl-skeleton", className)} style={style} aria-hidden="true" />;
}

export function SkeletonGroup({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cx("pl-skeleton-group", className)} aria-hidden="true">
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
    <div className={cx("pl-popover", className)} ref={rootRef}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={cx("pl-popover-panel", `pl-popover-panel--${align}`, `pl-popover-panel--${side}`)}
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
    <div className="pl-drawer-overlay" onMouseDown={onClose}>
      <div
        className={cx("pl-drawer", `pl-drawer--${side}`)}
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

// ---------------------------------------------------------------------- Icons

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
