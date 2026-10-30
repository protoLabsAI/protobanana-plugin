"""Studio S7 — pipeline spec, a plugin-side DAG runner, and a step cache.

A *pipeline* chains the Studio's own operations (generate, edit, region edit,
bgremove, compose, outpaint, inpaint) into a saved, re-runnable graph (design
§3.2). This is the deterministic "tool step" graph core Workflows can't express
(core workflows delegate to LLM subagents and "execute no code", ADR 0002), so
protoBanana ships its own small runner here.

Three concerns live in this module:

- **The spec + validator.** A declarative mapping (``id``, ``inputs``, ``steps``,
  ``output``, ``ui.positions``; see design §3.2) with :func:`validate`. It
  rejects, with a readable error: a step on an unknown op, a ref pointing at
  nothing (a dangling ref), a cycle, and a type-mismatched port — notably an
  image wired into a text port. :data:`SPEC_SCHEMA` is the JSON Schema for the
  spec's *shape*; the semantic checks (cycles, refs, port types) can't be
  expressed in JSON Schema, so they run in code after the shape validates.
  (``jsonschema`` the library is not a dependency, so the shape is checked by a
  small built-in validator over the subset of keywords the schema uses.)

- **The DAG runner.** :func:`start_run` returns a ``run_id`` immediately and
  drives the graph in a background task (R1: no HTTP request is ever held). Each
  step makes ONE gateway call through the SAME ``jobs._dispatch`` → ``client.py``
  path the agent tools and single-image jobs use, saves the result to the core
  media store plus a history record carrying ``pipeline_run_id``, and publishes
  per-node bus events (ADR 0039):
  ``protobanana.pipeline.node.started|done|failed`` and, at the terminal state,
  ``protobanana.pipeline.run.done``. Run state is server-side (the ``_runs``
  ring), so it survives a view reload (design §6 S7 acceptance).

- **The step cache.** Keyed by ``hash(op, alias, scalar params, the content
  identity of each input medium, the catalog's workflows_hash)``. A re-run only
  redoes the steps whose key changed and everything downstream of them (a changed
  upstream output is new bytes → a new input identity → the downstream key
  changes), which is ComfyUI's "only re-execute what changed" behaviour and the
  core of its feel. Keying on the catalog ``workflows_hash`` means a changed
  gateway workflow behind the same alias invalidates the cache (design R10).

A gateway 524 on a step (Cloudflare's ~100 s cap — the ComfyUI job keeps
running, protoBanana#52) marks only that node ``failed`` + ``recoverable`` and
stops the run; :func:`resume_run` re-runs from the failed node, and the
already-finished upstream steps are served from the cache, so "re-run from here"
resumes without redoing them.

Host-free on import: the only host touch (``save_media``/``emit`` via the
registry, image resolution via ``tools``) is reached lazily inside functions, so
pytest collects this module with no protoAgent present.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
import uuid
from collections import OrderedDict
from pathlib import Path

from . import catalog, history, jobs

log = logging.getLogger(__name__)

_MAX_RUNS = 200

_registry = None
_cfg: dict = {}
# The dir saved pipelines are written to (plugin data dir / "pipelines"), and the
# dir starters ship in (plugin_dir / "pipelines"). Both set by configure().
_saved_dir: Path | None = None
_bundled_dir: Path | None = None

# run_id -> run state dict (internal; _public_run strips the bytes + task).
_runs: "OrderedDict[str, dict]" = OrderedDict()

# The step cache: cache key -> {"media_id", "bytes"}. Module-global so a re-run
# of the same (or an edited) pipeline reuses unchanged steps across runs.
_cache: dict[str, dict] = {}


# ---------------------------------------------------------------- port types

# Each op's output is an ``image``. These are the ref (image/mask) input ports —
# the fields that carry a media hand-off between nodes. Everything else is a
# scalar param (text/int) resolved from the step's ``params``.
_REF_PORTS: dict[str, dict[str, str]] = {
    "generate": {},
    "edit": {"image": "image"},
    "inpaint": {"image": "image", "mask": "mask"},
    "region_edit": {"image": "image"},
    "outpaint": {"image": "image"},
    "remove_background": {"image": "image"},
    "compose": {"images": "image_list"},
}

# A declared input's type, normalized. ``seed`` is an int; ``image``/``mask`` are
# media; ``text``/``int`` are scalars. Anything else is rejected by the schema.
_INPUT_TYPES = {"text", "image", "mask", "int", "seed"}


def _known_ops() -> set[str]:
    """The op names a step may use — the static catalog's built-in ops. Imported
    lazily (catalog_static is host-free, but keep the import local to the check
    so a reload picks up any change)."""
    from . import catalog_static

    return set(catalog_static.OPS)


# ------------------------------------------------------------ the spec schema

# The JSON Schema for the spec's SHAPE (design §3.2). Semantic rules — cycles,
# refs resolving, port types — are not expressible here and run in code.
SPEC_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": True,
    "required": ["id", "steps"],
    "properties": {
        "id": {"type": "string", "pattern": r"^[a-z0-9][a-z0-9_-]*$"},
        "name": {"type": "string"},
        "description": {"type": "string"},
        "inputs": {
            "type": "object",
            "additionalProperties": {
                "anyOf": [
                    {"type": "string", "enum": sorted(_INPUT_TYPES)},
                    {
                        "type": "object",
                        "required": ["type"],
                        "properties": {"type": {"type": "string", "enum": sorted(_INPUT_TYPES)}},
                    },
                ]
            },
        },
        "steps": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "op"],
                "properties": {
                    "id": {"type": "string", "pattern": r"^[a-z0-9][a-z0-9_-]*$"},
                    "op": {"type": "string"},
                    "image": {"type": "string"},
                    "mask": {"type": "string"},
                    "images": {"type": "array", "items": {"type": "string"}},
                    "alias": {"type": "string"},
                    "tier": {"type": "string"},
                    "params": {"type": "object"},
                },
            },
        },
        "output": {"type": "string"},
        "ui": {"type": "object"},
    },
}


class SpecError(ValueError):
    """An invalid pipeline spec. ``errors`` lists every problem found so the whole
    set is reported at once; ``str()`` is a readable one-line (or bulleted)
    summary the tools and routes return verbatim."""

    def __init__(self, errors):
        self.errors = list(errors) if isinstance(errors, (list, tuple)) else [str(errors)]
        if len(self.errors) == 1:
            msg = self.errors[0]
        else:
            msg = "invalid pipeline spec:\n  - " + "\n  - ".join(self.errors)
        super().__init__(msg)


# ------------------------------------------------------ small schema validator

def _schema_errors(instance, schema, path: str = "") -> list[str]:
    """Validate ``instance`` against the subset of JSON Schema :data:`SPEC_SCHEMA`
    uses (type/required/properties/additionalProperties/enum/pattern/items/
    minItems/maxItems/anyOf). Returns a list of readable errors (empty = valid).
    Deliberately small — ``jsonschema`` is not a dependency."""
    import re

    where = path or "spec"
    errs: list[str] = []

    if "anyOf" in schema:
        if any(not _schema_errors(instance, sub, path) for sub in schema["anyOf"]):
            return []
        return [f"{where} does not match any allowed form"]

    types = schema.get("type")
    if types:
        types = [types] if isinstance(types, str) else types
        if not any(_is_type(instance, t) for t in types):
            return [f"{where} must be {' or '.join(types)}"]

    if "enum" in schema and instance not in schema["enum"]:
        errs.append(f"{where} must be one of {schema['enum']}")

    if isinstance(instance, str) and "pattern" in schema:
        if not re.search(schema["pattern"], instance):
            errs.append(f"{where} {instance!r} is not a valid name")

    if _is_type(instance, "object"):
        for key in schema.get("required", []):
            if key not in instance:
                errs.append(f"{where} is missing required key {key!r}")
        props = schema.get("properties", {})
        addl = schema.get("additionalProperties", True)
        for key, val in instance.items():
            if key in props:
                errs += _schema_errors(val, props[key], f"{where}.{key}")
            elif addl is False:
                errs.append(f"{where} has unknown key {key!r}")
            elif isinstance(addl, dict):
                errs += _schema_errors(val, addl, f"{where}.{key}")

    if _is_type(instance, "array"):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errs.append(f"{where} needs at least {schema['minItems']} item(s)")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errs.append(f"{where} allows at most {schema['maxItems']} item(s)")
        if "items" in schema:
            for i, item in enumerate(instance):
                errs += _schema_errors(item, schema["items"], f"{where}[{i}]")

    return errs


def _is_type(value, t: str) -> bool:
    if t == "object":
        return isinstance(value, dict)
    if t == "array":
        return isinstance(value, (list, tuple))
    if t == "string":
        return isinstance(value, str)
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "boolean":
        return isinstance(value, bool)
    return True


# --------------------------------------------------------------- spec helpers

def _input_type(decl) -> str:
    """A declared input's normalized type (``decl`` is a type string or a
    ``{type, default}`` mapping)."""
    if isinstance(decl, str):
        return decl
    if isinstance(decl, dict):
        return decl.get("type", "text")
    return "text"


def _input_default(decl):
    if isinstance(decl, dict):
        return decl.get("default")
    return None


_TEMPLATE_RE = None


def _placeholders(text: str) -> list[str]:
    """The input names referenced by ``{{inputs.NAME}}`` / ``{{NAME}}`` in a
    string param. Returns bare names (``NAME``)."""
    global _TEMPLATE_RE
    if _TEMPLATE_RE is None:
        import re

        _TEMPLATE_RE = re.compile(r"\{\{\s*(?:inputs\.)?([a-zA-Z0-9_]+)\s*\}\}")
    return _TEMPLATE_RE.findall(text or "")


def _param_port_type(op: str, name: str) -> str | None:
    """The port type of a scalar param ``name`` on ``op`` (``text`` / ``int``),
    from the static catalog schema, or ``None`` if the op has no such param."""
    from . import catalog_static

    props = catalog_static._PARAMS.get(op, {}).get("properties", {})
    schema = props.get(name)
    if schema is None:
        return None
    return "int" if schema.get("type") == "integer" else "text"


# ------------------------------------------------------------------ validate

def validate(spec) -> dict:
    """Validate a pipeline spec and return it unchanged, or raise
    :class:`SpecError` with every problem found.

    Beyond the shape (:data:`SPEC_SCHEMA`): every step op is known; step ids are
    unique; each ref port resolves to a step or a declared input (else a dangling
    ref); a ref port's source type matches the port, and a templated scalar param
    never pulls an image/mask input into a text port (the image→text mismatch);
    required image/mask ports are present; the graph is acyclic; and ``output``
    names a real step.
    """
    if not isinstance(spec, dict):
        raise SpecError("spec must be a mapping")

    errs = _schema_errors(spec, SPEC_SCHEMA)
    if errs:
        raise SpecError(errs)

    errors: list[str] = []
    steps = spec.get("steps") or []
    inputs = spec.get("inputs") or {}
    known_ops = _known_ops()

    # Input types.
    input_types: dict[str, str] = {}
    for name, decl in inputs.items():
        t = _input_type(decl)
        if t not in _INPUT_TYPES:
            errors.append(f"input {name!r} has unknown type {t!r} "
                          f"(expected one of {sorted(_INPUT_TYPES)})")
        input_types[name] = t

    # Step ids unique + ops known.
    step_ids: list[str] = []
    seen: set[str] = set()
    for step in steps:
        sid = step.get("id")
        if sid in seen:
            errors.append(f"duplicate step id {sid!r}")
        seen.add(sid)
        step_ids.append(sid)
        op = step.get("op")
        if op not in known_ops:
            errors.append(f"step {sid!r} uses unknown op {op!r} "
                          f"(known ops: {', '.join(sorted(known_ops))})")

    step_id_set = set(step_ids)

    def resolve_source_type(ref: str) -> str | None:
        """The output type of what ``ref`` points at: a step produces ``image``;
        an input (``NAME`` or ``inputs.NAME``) has its declared type. ``None`` =
        the ref resolves to nothing (dangling)."""
        if ref in step_id_set:
            return "image"
        name = ref.split(".", 1)[1] if ref.startswith("inputs.") else ref
        if name in input_types:
            return input_types[name]
        return None

    # Ref ports: present + resolvable + type-compatible; required ports present.
    edges: dict[str, set[str]] = {sid: set() for sid in step_ids}
    for step in steps:
        sid = step.get("id")
        op = step.get("op")
        ports = _REF_PORTS.get(op, {})
        for port, ptype in ports.items():
            if port not in step:
                continue
            values = step[port] if ptype == "image_list" else [step[port]]
            want = "image" if ptype in ("image", "image_list") else ptype
            for ref in values:
                if not isinstance(ref, str):
                    errors.append(f"step {sid!r} port {port!r} must be a reference string")
                    continue
                src = resolve_source_type(ref)
                if src is None:
                    errors.append(f"step {sid!r} port {port!r} references {ref!r}, "
                                  f"which is not a step id or a declared input (dangling ref)")
                    continue
                if src != want:
                    errors.append(f"step {sid!r} port {port!r} expects {want}, but "
                                  f"{ref!r} provides {src} (port type mismatch)")
                if ref in step_id_set:
                    edges[sid].add(ref)

        # Required image/mask ports present (e.g. edit needs an image).
        from . import catalog_static

        required = catalog_static._PARAMS.get(op, {}).get("required", [])
        for req in required:
            if req in ports and req not in step:
                errors.append(f"step {sid!r} ({op}) is missing required input {req!r}")

        # Templated scalar params: the referenced input must exist (else dangling)
        # and must not feed an image/mask into a text/int port (image→text).
        params = step.get("params") or {}
        for pname, pval in params.items():
            if not isinstance(pval, str):
                continue
            port_type = _param_port_type(op, pname)
            for name in _placeholders(pval):
                if name not in input_types:
                    errors.append(f"step {sid!r} param {pname!r} references input "
                                  f"{name!r}, which is not declared (dangling ref)")
                    continue
                itype = input_types[name]
                if itype in ("image", "mask") and port_type in ("text", "int"):
                    errors.append(f"step {sid!r} feeds {itype} input {name!r} into "
                                  f"the text parameter {pname!r} (port type mismatch)")

    # Cycles (Kahn's): if not every step is orderable, there is a cycle.
    order = _topo_order(step_ids, edges)
    if order is None:
        errors.append("the pipeline has a cycle (a step depends, directly or "
                      "indirectly, on its own output)")

    # output names a real step.
    output = spec.get("output")
    if output is None and step_ids:
        output = step_ids[-1]
    if output is not None and output not in step_id_set:
        errors.append(f"output {output!r} is not a step id")

    if errors:
        raise SpecError(errors)
    return spec


def _topo_order(step_ids: list[str], edges: dict[str, set[str]]) -> list[str] | None:
    """A topological order (dependencies first), or ``None`` if there is a cycle.
    ``edges[sid]`` is the set of step ids ``sid`` depends on (its upstream)."""
    indeg = {sid: 0 for sid in step_ids}
    downstream: dict[str, list[str]] = {sid: [] for sid in step_ids}
    for sid, deps in edges.items():
        for dep in deps:
            indeg[sid] += 1
            downstream[dep].append(sid)
    ready = [sid for sid in step_ids if indeg[sid] == 0]
    out: list[str] = []
    while ready:
        sid = ready.pop(0)
        out.append(sid)
        for nxt in downstream[sid]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                ready.append(nxt)
    return out if len(out) == len(step_ids) else None


# --------------------------------------------------------------- configure

def configure(registry, data_dir=None) -> None:
    """Remember the registry (save_media + event bus) and resolve the pipeline
    dirs: ``<data_dir>/pipelines`` for saved specs and ``<plugin_dir>/pipelines``
    for the shipped starters. ``data_dir`` overrides the resolved data dir (tests;
    mirrors :func:`history.configure`)."""
    global _registry, _saved_dir, _bundled_dir
    _registry = registry
    _cfg.clear()
    _cfg.update({k: v for k, v in dict(getattr(registry, "config", {}) or {}).items()
                 if v is not None})
    base = Path(data_dir) if data_dir is not None else _resolve_data_dir(registry)
    _saved_dir = base / "pipelines"
    _bundled_dir = Path(getattr(registry, "plugin_dir", ".") or ".") / "pipelines"


def _resolve_data_dir(registry) -> Path:
    """The plugin data dir — the same resolution history.py uses (a host-scoped
    data dir if the registry exposes one, else a dot-dir beside the code)."""
    for name in ("plugin_data_dir", "data_dir", "state_dir"):
        val = getattr(registry, name, None)
        if callable(val):
            try:
                val = val()
            except Exception:  # noqa: BLE001
                val = None
        if val:
            return Path(val)
    return Path(getattr(registry, "plugin_dir", ".") or ".") / ".studio"


# --------------------------------------------------------- saved / bundled I/O

def _load_text_spec(text: str) -> dict:
    """Parse a spec document — YAML (the design §3.2 shape) or JSON. PyYAML comes
    with the core runtime (and langchain pulls it into the test env); JSON is
    valid YAML, so a saved ``.json`` spec also parses. Raises SpecError on a
    parse failure or a non-mapping document."""
    text = text or ""
    try:
        import yaml

        data = yaml.safe_load(text)
    except ImportError:  # pragma: no cover - PyYAML ships with the runtime
        try:
            data = json.loads(text)
        except Exception as exc:
            raise SpecError(f"could not parse spec (no YAML support, invalid JSON): {exc}")
    except Exception as exc:  # noqa: BLE001 - yaml.YAMLError and friends
        raise SpecError(f"could not parse spec: {exc}")
    if not isinstance(data, dict):
        raise SpecError("a pipeline spec must be a mapping")
    return data


def _candidate_files(name: str) -> list[Path]:
    """The files a pipeline ``name`` could live in — saved first (it shadows a
    starter of the same id), then bundled; ``.yaml`` / ``.yml`` / ``.json``."""
    out: list[Path] = []
    for base in (_saved_dir, _bundled_dir):
        if base is None:
            continue
        for ext in (".yaml", ".yml", ".json"):
            out.append(base / f"{name}{ext}")
    return out


def load_pipeline(name: str) -> dict:
    """Load a saved or bundled pipeline by id/name, validated. Raises SpecError if
    there is no such pipeline or the stored spec is invalid."""
    name = (name or "").strip()
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise SpecError(f"invalid pipeline name {name!r}")
    for path in _candidate_files(name):
        try:
            if path.is_file():
                return validate(_load_text_spec(path.read_text(encoding="utf-8")))
        except SpecError:
            raise
        except Exception as exc:  # noqa: BLE001 - a bad read falls through to "not found"
            log.warning("[protobanana] could not read pipeline %s: %s", path, exc)
    raise SpecError(f"no pipeline named {name!r}")


def list_pipelines() -> list[dict]:
    """Every pipeline known to the plugin — the shipped starters plus any saved in
    the data dir — as ``{id, name, description, source, inputs, steps}`` summaries.
    A saved pipeline shadows a bundled starter with the same id. Never raises."""
    found: "OrderedDict[str, dict]" = OrderedDict()
    for source, base in (("bundled", _bundled_dir), ("saved", _saved_dir)):
        if base is None or not base.is_dir():
            continue
        try:
            files = sorted(base.iterdir())
        except Exception:  # noqa: BLE001
            continue
        for path in files:
            if path.suffix.lower() not in (".yaml", ".yml", ".json") or not path.is_file():
                continue
            try:
                spec = _load_text_spec(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001 - skip an unreadable/garbage file
                continue
            pid = spec.get("id") or path.stem
            found[pid] = {
                "id": pid,
                "name": spec.get("name") or pid,
                "description": spec.get("description", ""),
                "source": source,  # "saved" overwrites "bundled" (listed last)
                "inputs": spec.get("inputs") or {},
                "steps": [s.get("id") for s in (spec.get("steps") or [])],
            }
    return list(found.values())


def save_pipeline(spec) -> dict:
    """Validate ``spec`` and write it to the data dir as ``<id>.json`` (JSON is
    valid YAML, and avoids a yaml.dump dependency). Returns the saved summary.
    Raises SpecError on an invalid spec or if the data dir isn't writable."""
    if isinstance(spec, str):
        spec = _load_text_spec(spec)
    validate(spec)
    pid = spec["id"]
    if _saved_dir is None:
        raise SpecError("the plugin data dir is not configured, so a pipeline cannot be saved")
    try:
        _saved_dir.mkdir(parents=True, exist_ok=True)
        (_saved_dir / f"{pid}.json").write_text(
            json.dumps(spec, indent=2, default=str), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        raise SpecError(f"could not save pipeline {pid!r}: {exc}")
    # Announce the save so a live Studio view can refresh (design §4).
    _publish("protobanana.pipeline.saved", {"id": pid})
    return {"id": pid, "source": "saved"}


# ------------------------------------------------------------- run accounting

_PUBLIC_RUN = ("run_id", "pipeline", "status", "inputs", "order", "output",
               "output_media_id", "created", "elapsed_s", "cache_hits",
               "error", "nodes")


def _public_run(run: dict) -> dict:
    """The readable run state — no internal keys (``_bytes``/``_task``/``_spec``)."""
    out = {k: run.get(k) for k in _PUBLIC_RUN if k != "nodes"}
    out["nodes"] = {sid: {k: v for k, v in node.items() if not k.startswith("_")}
                    for sid, node in run.get("nodes", {}).items()}
    return out


def get_run(run_id: str) -> dict | None:
    """The readable state of one run, or ``None`` if unknown. Server-side state:
    a view that reloaded re-reads it here (design §6 S7 acceptance)."""
    run = _runs.get(run_id)
    return _public_run(run) if run is not None else None


def recent_runs(limit: int = 50) -> list[dict]:
    items = [_public_run(r) for r in _runs.values()]
    items.reverse()
    return items[: max(0, int(limit))]


async def wait(run_id: str) -> dict | None:
    """Await a run's background task and return its final public state (for a tool
    that runs a pipeline to completion). Never raises — a task that errored still
    leaves the run in a terminal ``failed`` state readable here."""
    run = _runs.get(run_id)
    task = run.get("_task") if run else None
    if task is not None:
        try:
            await task
        except Exception:  # noqa: BLE001 - the run state already captured the failure
            log.exception("[protobanana] pipeline run %s task raised", run_id)
    return get_run(run_id)


def _remember(run: dict) -> None:
    _runs[run["run_id"]] = run
    while len(_runs) > _MAX_RUNS:
        _runs.popitem(last=False)


def reset_cache() -> None:
    """Drop the step cache (tests)."""
    _cache.clear()


# ----------------------------------------------------------------- the runner

def start_run(name_or_spec, inputs: dict | None = None, *, operator: str = "default",
              run_id: str | None = None) -> str:
    """Queue a pipeline run and return its ``run_id`` immediately (R1).

    ``name_or_spec`` is a saved/bundled pipeline name or an inline spec dict. The
    graph runs in a background task; completion arrives on the bus. Requires a
    running event loop (routes run under one; tests wrap in ``asyncio.run``).
    Raises SpecError synchronously for an unknown name or an invalid inline spec,
    so the caller (route/tool) can answer 4xx without a run ever starting.
    """
    spec = load_pipeline(name_or_spec) if isinstance(name_or_spec, str) else validate(name_or_spec)
    rid = run_id or uuid.uuid4().hex
    steps = spec["steps"]
    order = _run_order(spec)  # dependency order (same computation validate() uses)
    run = {
        "run_id": rid,
        "pipeline": spec.get("id"),
        "status": "queued",
        "inputs": dict(inputs or {}),
        "order": order,
        "output": spec.get("output") or (order[-1] if order else None),
        "output_media_id": None,
        "created": time.time(),
        "elapsed_s": None,
        "cache_hits": 0,
        "error": None,
        "nodes": {s["id"]: _new_node(s) for s in steps},
        "_spec": spec,
        "_bytes": {},
        "_task": None,
    }
    _remember(run)
    run["_task"] = asyncio.ensure_future(_execute(rid))
    return rid


def resume_run(run_id: str, *, from_step: str | None = None) -> bool:
    """Re-run a finished/failed run from its first unfinished node (or from
    ``from_step``), reusing the cache for the steps already done (design §6 S7:
    "re-run from here" after a recoverable 524). Returns False if the run is
    unknown or still running."""
    run = _runs.get(run_id)
    if run is None or run.get("status") in ("queued", "running"):
        return False
    # Clear the forced node (and everything downstream, so stale outputs can't be
    # reused) back to pending; the cache still serves the untouched upstream. Evict
    # the forced nodes' cache entries FIRST so they truly recompute even if their
    # key is unchanged (a "run from here" that isn't param-driven).
    if from_step:
        for sid in _downstream_of(run["_spec"], from_step):
            _cache.pop(run["nodes"].get(sid, {}).get("_key", ""), None)
            run["nodes"][sid] = _new_node(_step_by_id(run["_spec"], sid))
    for sid, node in run["nodes"].items():
        if node.get("status") in ("failed", "pending"):
            run["nodes"][sid] = _new_node(_step_by_id(run["_spec"], sid))
    run["status"] = "queued"
    run["error"] = None
    run["_task"] = asyncio.ensure_future(_execute(run_id))
    return True


def _new_node(step: dict) -> dict:
    return {"id": step.get("id"), "op": step.get("op"), "alias": None,
            "status": "pending", "media_id": None, "url": None, "cached": False,
            "elapsed_s": None, "error": None, "error_kind": None,
            "recoverable": None, "hint": None}


def output_bytes(run_id: str) -> bytes | None:
    """The output node's rendered bytes for a finished run (for a tool that wants
    to attach the image to its result), or ``None``."""
    run = _runs.get(run_id)
    if run is None:
        return None
    return run.get("_bytes", {}).get(run.get("output"))


def _step_by_id(spec: dict, sid: str) -> dict:
    return next((s for s in spec["steps"] if s.get("id") == sid), {"id": sid})


def _run_order(spec: dict) -> list[str]:
    """Execution order for a (validated) spec — dependencies first."""
    steps = spec["steps"]
    step_ids = [s["id"] for s in steps]
    step_id_set = set(step_ids)
    edges: dict[str, set[str]] = {sid: set() for sid in step_ids}
    for step in steps:
        for port, ptype in _REF_PORTS.get(step.get("op"), {}).items():
            if port not in step:
                continue
            values = step[port] if ptype == "image_list" else [step[port]]
            for ref in values:
                if isinstance(ref, str) and ref in step_id_set:
                    edges[step["id"]].add(ref)
    return _topo_order(step_ids, edges) or step_ids


def _downstream_of(spec: dict, start: str) -> list[str]:
    """``start`` plus every step that (transitively) consumes its output."""
    order = _run_order(spec)
    step_id_set = {s["id"] for s in spec["steps"]}
    affected = {start}
    for sid in order:
        step = _step_by_id(spec, sid)
        for port, ptype in _REF_PORTS.get(step.get("op"), {}).items():
            if port not in step:
                continue
            values = step[port] if ptype == "image_list" else [step[port]]
            if any(isinstance(r, str) and r in affected and r in step_id_set for r in values):
                affected.add(sid)
    return [sid for sid in order if sid in affected]


async def _execute(run_id: str) -> None:
    """Drive the graph in dependency order. Each step resolves its inputs, checks
    the cache, and on a miss makes one gateway call via ``jobs._dispatch`` — the
    same path a single-image job takes. A recoverable failure (524) stops the run
    with that node flagged; :func:`resume_run` picks up from there."""
    run = _runs.get(run_id)
    if run is None:  # pragma: no cover - evicted before it ran
        return
    run["status"] = "running"
    started = time.monotonic()
    spec = run["_spec"]
    try:
        snapshot = await catalog.build(_cfg)
    except Exception as exc:  # noqa: BLE001 - treat a catalog failure as a run failure
        run.update(status="failed", error=f"catalog unavailable: {exc}",
                   elapsed_s=round(time.monotonic() - started, 2))
        _publish("protobanana.pipeline.run.done",
                 {"run_id": run_id, "pipeline": run["pipeline"], "status": "failed"})
        return
    workflows_hash = snapshot.get("workflows_hash")
    input_values = _resolve_input_values(spec, run["inputs"])

    for sid in run["order"]:
        node = run["nodes"][sid]
        if node["status"] in ("done", "cached"):
            continue  # already satisfied (a resume keeps finished nodes)
        step = _step_by_id(spec, sid)
        op = step["op"]
        try:
            entry, alias = _resolve_alias(snapshot, step, op)
            node["alias"] = alias
            scalar, ref_bytes = _prepare_step(step, op, input_values, run["_bytes"])
            key = _cache_key(op, alias, scalar, ref_bytes, workflows_hash)
            node["_key"] = key
            hit = _cache.get(key)
            if hit is not None:
                run["_bytes"][sid] = hit["bytes"]
                node.update(status="cached", cached=True, media_id=hit["media_id"],
                            url=hit.get("url"), elapsed_s=0.0)
                run["cache_hits"] += 1
                _publish("protobanana.pipeline.node.done",
                         {"run_id": run_id, "step": sid, "op": op, "alias": alias,
                          "media_id": hit["media_id"], "cached": True, "elapsed_s": 0.0})
                continue
            node["status"] = "running"
            _publish("protobanana.pipeline.node.started",
                     {"run_id": run_id, "step": sid, "op": op, "alias": alias})
            node_started = time.monotonic()
            raw = await _dispatch_step(op, alias, entry, scalar, ref_bytes)
            # Saving is part of the step: a storage failure must leave a failed,
            # resumable node, never a running node or a successful cache entry.
            parent_id = _parent_media_id(step, run["nodes"])
            params = _history_params(step, scalar, input_values, run["nodes"])
            meta = {"source": "pipeline", "op": op, "alias": alias, "params": params,
                    "parent_id": parent_id, "pipeline": run["pipeline"],
                    "pipeline_run_id": run_id, "step": sid}
            ref = _registry.save_media(raw, "image/png", meta)
        except Exception as exc:  # noqa: BLE001 - classified into a node result
            fail = jobs.classify(exc, alias=node.get("alias"))
            elapsed = round(time.monotonic() - started, 2)
            node.update(status="failed", error=fail.error, error_kind=fail.error_kind,
                        recoverable=fail.recoverable, hint=fail.hint)
            run.update(status="failed", error=fail.error, elapsed_s=elapsed)
            _publish("protobanana.pipeline.node.failed",
                     {"run_id": run_id, "step": sid, "op": op, "alias": node.get("alias"),
                      "error": fail.error, "error_kind": fail.error_kind,
                      "recoverable": fail.recoverable, "hint": fail.hint})
            _publish("protobanana.pipeline.run.done",
                     {"run_id": run_id, "pipeline": run["pipeline"], "status": "failed"})
            return
        # Cache + history + node.done only after the output is safely saved.
        run["_bytes"][sid] = raw
        _cache[key] = {"media_id": ref.id, "url": getattr(ref, "url", None), "bytes": raw}
        node.update(status="done", media_id=ref.id, url=getattr(ref, "url", None),
                    cached=False, elapsed_s=round(time.monotonic() - node_started, 2))
        history.record_pipeline(ref.id, run_id=run_id, pipeline=run["pipeline"], step=sid,
                                op=op, alias=alias, params=params, parent_id=parent_id)
        _publish("protobanana.pipeline.node.done",
                 {"run_id": run_id, "step": sid, "op": op, "alias": alias,
                  "media_id": ref.id, "cached": False, "elapsed_s": node["elapsed_s"]})

    out_sid = run["output"]
    out_node = run["nodes"].get(out_sid) if out_sid else None
    run.update(status="done",
               output_media_id=out_node.get("media_id") if out_node else None,
               elapsed_s=round(time.monotonic() - started, 2))
    _publish("protobanana.pipeline.run.done",
             {"run_id": run_id, "pipeline": run["pipeline"], "status": "done",
              "output_media_id": run["output_media_id"]})


# ---------------------------------------------------------- step preparation

def _resolve_alias(snapshot: dict, step: dict, op: str):
    """Resolve the gateway alias for a step from the catalog snapshot (the same
    source of truth jobs._run uses). A per-step ``alias`` wins; otherwise the
    tier's alias (``params.tier`` or ``tier``, default final)."""
    entry = next((e for e in snapshot.get("ops", []) if e.get("op") == op), None)
    if entry is None:
        raise ValueError(f"unknown op {op!r} — not in the catalog")
    params = step.get("params") or {}
    override = step.get("alias") or params.get("alias")
    if override:
        return entry, override
    tier = step.get("tier") or params.get("tier") or "final"
    aliases = entry.get("aliases") or {}
    alias = aliases.get(tier) or aliases.get("final")
    if alias is None:
        raise ValueError(f"no alias for op {op!r} at tier {tier!r}")
    return entry, alias


def _resolve_input_values(spec: dict, provided: dict) -> dict:
    """Merge declared input defaults with the caller's values."""
    values: dict = {}
    for name, decl in (spec.get("inputs") or {}).items():
        default = _input_default(decl)
        values[name] = provided.get(name, default)
    for name, val in (provided or {}).items():
        values.setdefault(name, val)
    return values


def _substitute(value, input_values: dict):
    """Replace ``{{inputs.NAME}}`` / ``{{NAME}}`` in a string with the input value
    (as text). Non-strings pass through unchanged."""
    if not isinstance(value, str):
        return value
    import re

    def repl(m):
        name = m.group(1)
        return "" if input_values.get(name) is None else str(input_values.get(name))

    return re.sub(r"\{\{\s*(?:inputs\.)?([a-zA-Z0-9_]+)\s*\}\}", repl, value)


def _ref_bytes(ref: str, input_values: dict, produced: dict) -> bytes:
    """The bytes a ref port points at: an upstream step's produced output, or a
    runtime input's image (resolved the same way the tools resolve any image
    reference). Raises ValueError if an upstream output isn't ready or an input is
    missing — both surface as a readable node failure."""
    from . import tools

    if ref in produced:
        return produced[ref]
    name = ref.split(".", 1)[1] if ref.startswith("inputs.") else ref
    val = input_values.get(name)
    if val is None:
        raise ValueError(f"input {name!r} was not provided (needed as an image/mask)")
    return tools._resolve_image(val)


def _prepare_step(step: dict, op: str, input_values: dict, produced: dict):
    """Build the (scalar params, resolved ref bytes) for a step: substitute input
    placeholders into scalar params, and resolve each image/mask port to bytes."""
    raw_params = step.get("params") or {}
    scalar: dict = {}
    for name, val in raw_params.items():
        if name in ("alias", "tier"):
            continue
        scalar[name] = _substitute(val, input_values)
    ref_bytes: "OrderedDict[str, list]" = OrderedDict()
    for port, ptype in _REF_PORTS.get(op, {}).items():
        if port not in step:
            continue
        refs = step[port] if ptype == "image_list" else [step[port]]
        ref_bytes[port] = [_ref_bytes(r, input_values, produced) for r in refs]
    return scalar, ref_bytes


async def _dispatch_step(op: str, alias: str, entry: dict, scalar: dict,
                         ref_bytes) -> bytes:
    """One gateway call for a step, through the SAME ``jobs._dispatch`` the Studio
    jobs use. Ref ports are handed in as data URLs so dispatch resolves them with
    no media-store round-trip (intermediate hand-offs never need to be persisted
    to be readable)."""
    params = dict(scalar)
    for port, blobs in ref_bytes.items():
        if port == "images":
            params["images"] = [_data_url(b) for b in blobs]
        else:
            params[port] = _data_url(blobs[0])
    st = {"op": op, "params": params, "alias": alias, "tier": "final",
          "_catalog_entry": entry}
    return await jobs._dispatch(st)


def _history_params(step: dict, scalar: dict, input_values: dict, nodes: dict) -> dict:
    """Job-shaped params for Gallery re-run/branch: replace graph references
    with saved upstream media ids or the caller's resolved input references."""
    def resolve(ref):
        if ref in nodes:
            return nodes[ref]["media_id"]
        name = ref.split(".", 1)[1] if ref.startswith("inputs.") else ref
        return input_values[name]

    params = dict(scalar)
    for port, ptype in _REF_PORTS.get(step["op"], {}).items():
        if port in step:
            params[port] = ([resolve(ref) for ref in step[port]] if ptype == "image_list"
                            else resolve(step[port]))
    return params


def _parent_media_id(step: dict, nodes: dict) -> str | None:
    """The media id of the step's primary upstream (its ``image`` port if that is
    a step, else the first of ``images``) — for history lineage."""
    op = step.get("op")
    ports = _REF_PORTS.get(op, {})
    if "image" in ports and isinstance(step.get("image"), str):
        node = nodes.get(step["image"])
        if node:
            return node.get("media_id")
    if "images" in ports and isinstance(step.get("images"), list):
        for ref in step["images"]:
            node = nodes.get(ref)
            if node:
                return node.get("media_id")
    return None


# --------------------------------------------------------------- cache key

def _cache_key(op: str, alias: str, scalar: dict, ref_bytes, workflows_hash) -> str:
    """The step cache key (design R10).

    Keyed on the op, the resolved alias, the scalar params, the *content identity*
    of each input medium, and the catalog's ``workflows_hash``. Hashing the input
    content (rather than a media id) is store-independent and strictly stronger:
    a recomputed upstream step yields new bytes → a new identity → every
    downstream key changes, which is exactly "re-run only what changed plus its
    descendants". The ``workflows_hash`` folds in a changed gateway workflow
    behind the same alias, so that invalidates the cache too."""
    inputs = {port: [hashlib.sha256(b).hexdigest() for b in blobs]
              for port, blobs in ref_bytes.items()}
    payload = {"op": op, "alias": alias,
               "params": scalar, "inputs": inputs, "wf": workflows_hash}
    blob = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode()


def _publish(topic: str, data: dict) -> None:
    """Announce on the core event bus via the registry (ADR 0039). A background
    task must not die on a bad bus call, so failures are logged."""
    try:
        if _registry is not None:
            _registry.emit(topic, data)
    except Exception:  # noqa: BLE001 - best-effort notification
        log.exception("[protobanana] failed to publish %s", topic)
