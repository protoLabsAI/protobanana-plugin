// Thin adapter over the protoAgent DS plugin-kit (served by the host at
// /_ds/plugin-kit.js), per building-react-plugin-views.md rules 1–4:
//
//   2. initPluginView() performs the bearer + theme handshake (postMessage,
//      never a token in the URL — ADR 0026 D5).
//   3. apiFetch / apiUrl are slug-aware: they prefix the per-member fleet-proxy
//      slug and the plugin's gated API root, so the view passes only short,
//      plugin-relative paths ("jobs", "catalog", `jobs/${id}`) — no hardcoded
//      /api path, no token, ever leaves this module.
//   4. subscribe() bridges the core event bus (protoagent:subscribe, ADR 0039)
//      so job.done / job.failed reach the view without holding an HTTP request
//      open across a render (the fleet proxy's 20 s read lane — design R1).
//
// The kit's exact global name isn't contractual, so we resolve it defensively
// from a short list of candidates (and bare window globals), and every seam has
// a standalone fallback so the view still renders when opened outside the
// console (e.g. for a screenshot). GET /jobs/{id} polling (see App.tsx) is the
// reliability backstop whenever the bus bridge is unavailable.

export interface ViewContext {
  token?: string;
  theme?: "light" | "dark" | string;
  slug?: string;
  pluginId?: string;
}

type Unsubscribe = () => void;

interface PluginKit {
  initPluginView?: (opts?: unknown) => Promise<ViewContext> | ViewContext;
  apiFetch?: (path: string, init?: RequestInit) => Promise<Response>;
  apiUrl?: (path: string) => string;
  subscribe?: (topic: string, handler: (data: unknown) => void) => Unsubscribe | void;
  publish?: (topic: string, data?: unknown) => void;
}

// Used ONLY by the standalone fallback (no console host present). Component code
// never references this — it goes through apiFetch/apiUrl with short paths.
const API_ROOT = "api/plugins/protobanana";

function resolveKit(): PluginKit {
  const w = window as unknown as Record<string, unknown>;
  const named = [w.pluginKit, w.PluginKit, w.protoagent, w.ProtoAgent, w.__pluginKit, w.__PLUGIN_KIT__];
  for (const c of named) {
    const k = c as PluginKit | undefined;
    if (k && (k.apiFetch || k.initPluginView || k.subscribe)) return k;
  }
  // Fall back to bare window globals (the guide names the functions, not a
  // namespace): initPluginView / apiFetch / apiUrl / subscribe.
  if (w.apiFetch || w.initPluginView || w.subscribe) {
    return {
      initPluginView: w.initPluginView as PluginKit["initPluginView"],
      apiFetch: w.apiFetch as PluginKit["apiFetch"],
      apiUrl: w.apiUrl as PluginKit["apiUrl"],
      subscribe: w.subscribe as PluginKit["subscribe"],
      publish: w.publish as PluginKit["publish"],
    };
  }
  return {};
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The kit script is `defer`; a module entry is also deferred, so it is usually
// present by first render. Poll briefly to be robust to execution ordering.
async function waitForKit(timeoutMs = 3000): Promise<PluginKit> {
  const start = Date.now();
  let kit = resolveKit();
  while (!(kit.initPluginView || kit.apiFetch || kit.subscribe) && Date.now() - start < timeoutMs) {
    await delay(50);
    kit = resolveKit();
  }
  return kit;
}

let _kit: PluginKit = {};
let _ctx: ViewContext | null = null;
let _ready: Promise<ViewContext> | null = null;

/** Run the view handshake once (bearer + theme) and apply the theme. */
export function ready(): Promise<ViewContext> {
  if (_ready) return _ready;
  _ready = (async () => {
    _kit = await waitForKit();
    try {
      _ctx = _kit.initPluginView ? ((await _kit.initPluginView()) as ViewContext) || {} : {};
    } catch {
      _ctx = {};
    }
    applyTheme(_ctx.theme);
    return _ctx;
  })();
  return _ready;
}

/** Reflect the console theme onto <html data-theme> (styles.css keys off it);
 *  falls back to the OS preference when the kit reports no theme. */
export function applyTheme(theme?: string): void {
  const root = document.documentElement;
  const resolved =
    theme === "light" || theme === "dark"
      ? theme
      : new URLSearchParams(location.search).get("theme") ||
        (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  root.dataset.theme = resolved;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const p = path.replace(/^\/+/, "");
  if (_kit.apiFetch) return _kit.apiFetch(p, init);
  // Standalone fallback: relative path so it still rides any slug prefix the
  // page itself was served under (no token — there is no console to hand one).
  return fetch(`${API_ROOT}/${p}`, init);
}

export function apiUrl(path: string): string {
  const p = path.replace(/^\/+/, "");
  if (_kit.apiUrl) return _kit.apiUrl(p);
  return `${API_ROOT}/${p}`;
}

/** Subscribe to a core bus topic through the kit's bridge, with a postMessage
 *  fallback (ADR 0039). Returns an unsubscribe fn. */
export function subscribe(topic: string, handler: (data: unknown) => void): Unsubscribe {
  if (_kit.subscribe) {
    try {
      const off = _kit.subscribe(topic, handler);
      if (typeof off === "function") return off;
    } catch {
      /* fall through to the postMessage bridge */
    }
  }
  const onMessage = (ev: MessageEvent) => {
    const d = ev.data as { type?: string; topic?: string; data?: unknown } | null;
    if (d && typeof d === "object" && d.type === "protoagent:event" && d.topic === topic) {
      handler(d.data);
    }
  };
  window.addEventListener("message", onMessage);
  try {
    window.parent?.postMessage({ type: "protoagent:subscribe", topic }, "*");
  } catch {
    /* no parent frame in standalone mode */
  }
  return () => window.removeEventListener("message", onMessage);
}

// ------------------------------------------------------------------ data types

export interface JsonSchemaProp {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  const?: unknown;
  pattern?: string;
  items?: JsonSchemaProp;
}

export interface CatalogEntry {
  op: string;
  label: string;
  route: string;
  aliases: Record<string, string | null>;
  default_tier: string;
  inputs: { images: number; mask: boolean; person: boolean };
  licence: { non_commercial: boolean; note?: string };
  typical_latency_s: number;
  params: { type: string; properties: Record<string, JsonSchemaProp>; required: string[] };
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobState {
  job_id: string;
  op: string;
  alias: string | null;
  tier: string;
  status: JobStatus;
  media_id: string | null;
  url: string | null;
  error: string | null;
  error_kind: string | null;
  recoverable: boolean | null;
  hint: string | null;
  parent_id: string | null;
  operator: string;
  created: number | null;
  elapsed_s: number | null;
  queue_position: number | null;
}

export interface JobRequest {
  op: string;
  params: Record<string, unknown>;
  tier?: string;
  alias?: string | null;
  parent_id?: string | null;
  operator?: string;
}

export async function fetchCatalog(): Promise<CatalogEntry[]> {
  const r = await apiFetch("catalog");
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  const body = (await r.json()) as { ops?: CatalogEntry[] };
  return body.ops || [];
}

/** POST /jobs — returns the job_id without awaiting the render (design R1). */
export async function submitJob(req: JobRequest): Promise<string> {
  const r = await apiFetch("jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!(r.status === 202 || r.ok)) throw new Error(`jobs ${r.status}`);
  const body = (await r.json()) as { job_id: string };
  return body.job_id;
}

/** GET /jobs/{id} — a short request, never a long-poll (design R1). */
export async function getJob(jobId: string): Promise<JobState | null> {
  const r = await apiFetch(`jobs/${encodeURIComponent(jobId)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`jobs/${jobId} ${r.status}`);
  return (await r.json()) as JobState;
}

/** Resolve a signed /media/ URL returned by the backend for an <img>. Root paths
 *  are served at the member root by the fleet proxy (like /_ds/), so the signed
 *  URL is used as-is; only the token lives out-of-band (the sig is not a bearer). */
export function mediaSrc(url: string | null | undefined): string {
  return url || "";
}
