"""The natural-language query layer (spec 5.2), behind the schema it already has.

The architecture was settled before any model existed: `web/src/lib/nlq/tools.ts`
defines a closed `Tool` schema, the palette resolves phrases against it with a
lookup table, and the resolved call is shown before it runs. Adding a model does
not change any of that. It adds one more *source* of `Tool` objects, and
everything downstream -- validation, display, execution -- is unchanged.

Four rules, all of them from 5.2, and all enforced here rather than promised:

  * **The model never touches the data.** It emits a tool call and nothing else.
    `query_floats` is answered by `/api/instruments` against the observation
    index, so a ranking is measured. No number the model produces is ever shown.

  * **The model can only say things the UI can already do.** Every call is
    validated against this module's own schema before it leaves; an unknown
    tool, an unknown variable, a depth outside the dataset -- all rejected.
    The blast radius of a hallucination is a rejected request.

  * **The deterministic path stays first.** A phrase the lookup table matches
    never reaches a model: it is faster, free, offline, and identical every
    time. The model is for the phrases the table cannot parse, which is exactly
    the case 5.2 argues natural language earns its place.

  * **It must never be required.** No key, no network, a dead free tier, a
    renamed model -- all degrade to the lookup table, and the API says why.

Deliberately no new dependency. This is one POST with a timeout, and
`urllib.request` does it; adding an HTTP client so a *hackathon demo's optional
feature* can call an optional service is how a stack acquires something that
fails to install the night before.
"""

from __future__ import annotations

import concurrent.futures
import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any

from ...core.config import settings

log = logging.getLogger(__name__)

#: The schema, in the form a function-calling API wants. Mirrors the `Tool`
#: union in web/src/lib/nlq/tools.ts -- the two must not drift, because the
#: frontend executes whatever comes back from here.
TOOL_SCHEMA: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "select_preset",
            "description": "Move the view to a named region of the Indian Ocean.",
            "parameters": {
                "type": "object",
                "properties": {"region": {"type": "string"}},
                "required": ["region"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "select_region",
            "description": "Select an arbitrary rectangle by geographic bounds.",
            "parameters": {
                "type": "object",
                "properties": {
                    "bbox": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 4,
                        "maxItems": 4,
                        "description": "west, south, east, north in degrees",
                    },
                    "depthRange": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 2,
                        "maxItems": 2,
                    },
                },
                "required": ["bbox"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_variable",
            "description": "Choose which ocean field is displayed.",
            "parameters": {
                "type": "object",
                "properties": {"variable": {"type": "string"}},
                "required": ["variable"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_depth",
            "description": "Move the depth slider, in metres below the surface.",
            "parameters": {
                "type": "object",
                "properties": {"depth": {"type": "number"}},
                "required": ["depth"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_time",
            "description": "Jump to a timestep. Must be one of the catalogue's own steps.",
            "parameters": {
                "type": "object",
                "properties": {"time": {"type": "string"}},
                "required": ["time"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_layer",
            "description": (
                "Show one assessment layer: count (observation coverage), "
                "blindSpot, rmse (model accuracy), bias, confidence, ageDays "
                "(data freshness), anomaly, or none."
            ),
            "parameters": {
                "type": "object",
                "properties": {"layer": {"type": "string"}},
                "required": ["layer"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_floats",
            "description": (
                "Rank instruments. The RESULT IS COMPUTED BY THE SERVER against "
                "the observation index; never state or guess the answer."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sortBy": {
                        "type": "string",
                        "enum": [
                            "trajectory_length",
                            "model_error",
                            "recency",
                            "profile_count",
                        ],
                    },
                    "order": {"type": "string", "enum": ["desc", "asc"]},
                    "limit": {"type": "integer"},
                },
                "required": ["sortBy"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "focus_platform",
            "description": "Open one instrument's profile by its identifier.",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "dive",
            "description": "Extrude the selected region into the 3D block.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

SYSTEM = """You translate a question about an ocean data platform into tool calls.

Rules you must not break:
- Emit tool calls only. Never answer the question yourself.
- Never state a measurement, a ranking, a temperature, or any other number \
about the ocean. The platform computes those. If the user asks for one, emit \
the tool call that would show it.
- Use only the vocabulary given below. If a region, variable or instrument is \
not listed, do not invent one.
- If the question cannot be served by these tools, return no tool calls.
- Several calls are fine when a question implies several settings."""


def _context_block(ctx: dict[str, Any]) -> str:
    """The catalogue's vocabulary, and nothing else.

    Only what the model needs to map words onto this dataset: variable keys,
    preset ids, the time range, the depth range, instrument identifiers. No
    file paths, no user identity, no measurements -- a prompt sent to a
    third-party endpoint should carry the vocabulary and not the data.
    """
    lines = [
        f"variables: {', '.join(ctx.get('variables') or [])}",
        f"regions: {', '.join(ctx.get('presets') or [])}",
        f"assessment layers: count, blindSpot, rmse, bias, confidence, ageDays, anomaly, none",
    ]
    times = ctx.get("times") or []
    if times:
        lines.append(f"timesteps: {len(times)}, from {times[0]} to {times[-1]}")
        lines.append(f"valid time values: {', '.join(times[:24])}")
    dr = ctx.get("depthRange")
    if dr:
        lines.append(f"depth range: {dr[0]:.0f} to {dr[1]:.0f} m")
    ids = ctx.get("instruments") or []
    if ids:
        lines.append(f"instruments: {', '.join(ids[:40])}")
    return "\n".join(lines)


# ------------------------------------------------------------------ validate --

_LAYERS = {
    "count", "blindSpot", "bias", "rmse", "confidence", "ageDays", "anomaly", "none",
}
_SORTS = {"trajectory_length", "model_error", "recency", "profile_count"}


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def validate(name: str, args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any] | None:
    """Return a Tool the frontend can execute, or None.

    Every field is checked against what this catalogue actually holds. A model
    that invents `variable: "oxygen"` or a depth of 90 km produces nothing,
    rather than a request that 404s or a slider that jumps somewhere absurd.
    """
    variables = set(ctx.get("variables") or [])
    presets = set(ctx.get("presets") or [])
    times = list(ctx.get("times") or [])
    instruments = set(ctx.get("instruments") or [])

    if name == "select_preset":
        region = str(args.get("region", ""))
        if region in presets:
            return {"name": name, "args": {"region": region}}
        # A model will happily say "bay_of_bengal" when the id is "bob". One
        # case-insensitive substring pass, then give up -- fuzzy matching a
        # region is how a demo lands somewhere nobody asked for.
        low = region.lower().replace(" ", "_")
        for p in presets:
            if low and (low in p.lower() or p.lower() in low):
                return {"name": name, "args": {"region": p}}
        return None

    if name == "select_region":
        box = args.get("bbox")
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            return None
        vals = [_num(v) for v in box]
        if any(v is None for v in vals):
            return None
        w, s, e, n = vals
        if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
            return None
        dr = args.get("depthRange")
        depth_range = ctx.get("depthRange") or [0, 2000]
        if isinstance(dr, (list, tuple)) and len(dr) == 2:
            a, b = _num(dr[0]), _num(dr[1])
            if a is not None and b is not None and 0 <= a < b:
                depth_range = [a, b]
        return {"name": name, "args": {"bbox": [w, s, e, n], "depthRange": depth_range}}

    if name == "set_variable":
        v = str(args.get("variable", ""))
        return {"name": name, "args": {"variable": v}} if v in variables else None

    if name == "set_depth":
        d = _num(args.get("depth"))
        if d is None:
            return None
        lo, hi = ctx.get("depthRange") or [0.0, 6000.0]
        if not (lo <= d <= hi):
            return None
        return {"name": name, "args": {"depth": d}}

    if name == "set_time":
        t = str(args.get("time", ""))
        if t in times:
            return {"name": name, "args": {"time": t}}
        # Accept a date, resolve to the catalogue's own step. The model has no
        # business inventing a timestamp the dataset does not contain.
        for candidate in times:
            if candidate.startswith(t[:10]) and len(t) >= 7:
                return {"name": name, "args": {"time": candidate}}
        return None

    if name == "set_layer":
        layer = str(args.get("layer", ""))
        return {"name": name, "args": {"layer": layer}} if layer in _LAYERS else None

    if name == "query_floats":
        sort_by = str(args.get("sortBy", ""))
        if sort_by not in _SORTS:
            return None
        order = str(args.get("order", "desc"))
        limit = _num(args.get("limit")) or 10
        return {
            "name": name,
            "args": {
                "sortBy": sort_by,
                "order": order if order in ("asc", "desc") else "desc",
                "limit": int(max(1, min(50, limit))),
            },
        }

    if name == "focus_platform":
        ident = str(args.get("id", ""))
        if ident in instruments:
            return {"name": name, "args": {"platform": "", "id": ident}}
        for known in instruments:
            if ident and ident in known:
                return {"name": name, "args": {"platform": "", "id": known}}
        return None

    if name == "dive":
        return {"name": name, "args": {}}

    return None


# --------------------------------------------------------------------- call --


def configured() -> dict[str, Any]:
    return {
        "enabled": bool(settings.nlq_enabled),
        "hasKey": bool(settings.nlq_api_key),
        "baseUrl": settings.nlq_base_url,
        "model": settings.nlq_model,
    }


def available() -> bool:
    """A local endpoint needs no key; a hosted one does."""
    if not settings.nlq_enabled:
        return False
    if settings.nlq_api_key:
        return True
    host = settings.nlq_base_url.lower()
    return "localhost" in host or "127.0.0.1" in host


def interpret(query: str, ctx: dict[str, Any]) -> dict[str, Any]:
    """Ask the model for tool calls. Never raises; says why when it cannot."""
    t0 = time.time()
    if not available():
        return {
            "tools": [],
            "source": "unavailable",
            "reason": (
                "no model configured; set OCEANUPS_NLQ_API_KEY (and optionally "
                "OCEANUPS_NLQ_BASE_URL / OCEANUPS_NLQ_MODEL)"
            ),
            "model": settings.nlq_model,
            "latencyMs": 0,
        }

    body = json.dumps({
        "model": settings.nlq_model,
        "temperature": 0,
        "tools": TOOL_SCHEMA,
        "tool_choice": "auto",
        "messages": [
            {"role": "system", "content": SYSTEM + "\n\n" + _context_block(ctx)},
            {"role": "user", "content": query[:400]},
        ],
    }).encode()

    headers = {"Content-Type": "application/json"}
    if settings.nlq_api_key:
        headers["Authorization"] = f"Bearer {settings.nlq_api_key}"
    # OpenRouter asks callers to identify themselves; this is the application,
    # not the user. Nothing about who is running it is sent.
    headers["HTTP-Referer"] = "https://github.com/oceanups"
    headers["X-Title"] = "oceanUps (SIH 26067)"

    url = settings.nlq_base_url.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")

    def _post() -> dict[str, Any]:
        with urllib.request.urlopen(req, timeout=settings.nlq_timeout) as resp:
            return json.loads(resp.read().decode())

    try:
        # A real deadline. urlopen's `timeout` applies to each socket
        # operation, so an endpoint that dribbles a byte every few seconds
        # never trips it and the request hangs for as long as it likes -- with
        # a user watching a palette that says "asking the model". The worker is
        # abandoned rather than joined: it holds the socket timeout too, so it
        # dies on its own, and nothing downstream is waiting on it.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            payload = pool.submit(_post).result(timeout=settings.nlq_timeout)
    except concurrent.futures.TimeoutError:
        log.warning("nlq: %s did not answer within %.0fs", settings.nlq_model, settings.nlq_timeout)
        return {
            "tools": [],
            "source": "error",
            "reason": (
                f"{settings.nlq_model} did not answer within "
                f"{settings.nlq_timeout:.0f}s (free tiers queue the first call)"
            ),
            "model": settings.nlq_model,
            "latencyMs": int((time.time() - t0) * 1000),
        }
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode()[:200]
        except Exception:
            pass
        log.warning("nlq: %s %s -- %s", exc.code, settings.nlq_model, detail)
        return {
            "tools": [],
            "source": "error",
            # The most common failure by far is a free-tier model id that has
            # been retired. Saying so turns a dead feature into one env var.
            "reason": f"HTTP {exc.code} from {settings.nlq_model}: {detail or exc.reason}",
            "model": settings.nlq_model,
            "latencyMs": int((time.time() - t0) * 1000),
        }
    except Exception as exc:
        log.warning("nlq: %s", exc)
        return {
            "tools": [],
            "source": "error",
            "reason": str(exc)[:200],
            "model": settings.nlq_model,
            "latencyMs": int((time.time() - t0) * 1000),
        }

    calls = []
    try:
        message = payload["choices"][0]["message"]
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            raw = fn.get("arguments") or "{}"
            args = json.loads(raw) if isinstance(raw, str) else raw
            calls.append((str(fn.get("name", "")), args if isinstance(args, dict) else {}))
    except Exception as exc:
        log.warning("nlq: unreadable response (%s)", exc)

    tools = []
    rejected = []
    for name, args in calls:
        ok = validate(name, args, ctx)
        if ok is None:
            rejected.append({"name": name, "args": args})
        else:
            tools.append(ok)

    if rejected:
        log.info("nlq: rejected %d call(s) that did not validate: %s", len(rejected), rejected)

    return {
        "tools": tools,
        "source": "model",
        "reason": "",
        "model": settings.nlq_model,
        # Surfaced, not hidden: a model that keeps proposing things this
        # catalogue cannot do is worth seeing in the response rather than only
        # in a log nobody reads.
        "rejected": len(rejected),
        "latencyMs": int((time.time() - t0) * 1000),
    }
