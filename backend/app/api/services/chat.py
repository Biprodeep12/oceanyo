"""A conversational assistant that can look at the data before it answers.

The palette's query layer maps one phrase to one tool call. This is the other
half of spec 5.2: a conversation, where the assistant can walk the record --
any timestep, any depth, any region -- read what is actually there, and answer
from it.

**The line that must not blur.** 5.2 is explicit: "measured values and generated
interpretation must be visually separated. The scientific credibility built by
the matchup metrics is easy to lose here." So the tools split in two, and the
split is structural rather than a convention someone has to remember:

  * **read_*** tools run HERE, against the datastore, and their results are
    returned to the client verbatim alongside the answer. Every number the
    assistant states can be checked against the tool result printed beneath it.
  * **view_*** tools do not run here at all. They are collected and handed back
    as `actions` for the browser to apply, which is what lets the assistant
    *show* you the timestep it is talking about.

The model therefore cannot state a measurement without having called something
that measured it -- and if it does anyway, the reading beside it contradicts it
in front of the user. That is a stronger guarantee than a prompt instruction,
which is why the split is here and not in the system message.

**Bounded by construction.** The loop runs at most MAX_ROUNDS times and each
read is capped, so a question cannot turn into an unbounded crawl of the
dataset. A conversation that cannot terminate is worse than one that cannot
answer.
"""

from __future__ import annotations

import concurrent.futures
import json
import logging
import re
import time
import urllib.error
import urllib.request
from typing import Any

import numpy as np

from ...core.config import settings
from ...core.conventions import CANONICAL
from ...core.geometry import BBox
from .assessment import assess
from .events import find_events
from .nlq import TOOL_SCHEMA as VIEW_TOOLS
from .nlq import validate as validate_view

log = logging.getLogger(__name__)

#: How many times the model may call tools before it must answer. Four is
#: enough for "find the warmest month, then look at that month"; more is a
#: model that has lost the thread, and every round is a free-tier call.
MAX_ROUNDS = 4

SYSTEM = """You are the assistant inside an ocean data visualisation platform \
for the Indian Ocean. You help a scientist explore a model and the floats that \
measure it.

How you work:
- To answer anything quantitative, CALL A read_ TOOL FIRST. Never state a \
temperature, a salinity, a bias, a date or a ranking that did not come back \
from a tool in this conversation.
- If you do not have a reading, say what you would need to look at instead of \
estimating. "I don't know without checking" is a correct answer here.
- Use view_ tools to move the display so the user can see what you are \
describing. Moving the view is not an answer on its own -- pair it with a \
reading.
- Be brief. Two or three sentences. This sits beside the data, not instead of it.
- Units matter. Always give them, and use the ones the tool returned.
- Copy numbers EXACTLY from the tool result. Do not round them, do not \
recompute them, and do not average anything yourself. If a tool named the \
value you want -- warmestMean, regionalRmse, peakAnomaly -- quote that field \
rather than reading it out of an array.
- You are not a forecast or a warning system. If asked to predict or to advise \
on safety, say plainly that this is a research and visualisation tool.
- The user is looking at something right now, described under "On screen" \
below. Resolve "here", "this region", "now" and "this depth" against it \
instead of asking what they mean."""

READ_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_timeseries",
            "description": (
                "Spatial mean, min and max of a variable for EVERY timestep in "
                "the record, at one depth. Use this to find when something was "
                "warmest, freshest, or changing."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "variable": {"type": "string"},
                    "depth": {"type": "number", "description": "metres, default 0"},
                    "bbox": {
                        "type": "array",
                        "items": {"type": "number"},
                        "description": "w,s,e,n; omit for the whole domain",
                    },
                },
                "required": ["variable"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_value",
            "description": "The model value at one point, depth and time.",
            "parameters": {
                "type": "object",
                "properties": {
                    "variable": {"type": "string"},
                    "lon": {"type": "number"},
                    "lat": {"type": "number"},
                    "depth": {"type": "number"},
                    "time": {"type": "string", "description": "ISO timestep"},
                },
                "required": ["variable", "lon", "lat"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_assessment",
            "description": (
                "How well observed and how accurate a region is: observation "
                "coverage, blind spots, pooled model RMSE against the floats."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "variable": {"type": "string"},
                    "bbox": {"type": "array", "items": {"type": "number"}},
                },
                "required": ["variable"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_events",
            "description": (
                "Runs of timesteps where the region sat beyond the "
                "climatological 90th percentile. Warm and cool extremes."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "variable": {"type": "string"},
                    "depth": {"type": "number"},
                },
                "required": ["variable"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_instruments",
            "description": (
                "Rank floats and gliders by distance travelled, disagreement "
                "with the model, recency, or number of profiles."
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
                    "limit": {"type": "integer"},
                    "variable": {"type": "string"},
                },
                "required": ["sortBy"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_profile",
            "description": (
                "One instrument's measured profile against the model at the "
                "same depths: bias, RMSE, correlation and how many levels "
                "matched. Use the instrument name, e.g. 1902669."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "instrument": {"type": "string"},
                    "variable": {"type": "string"},
                },
                "required": ["instrument"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_catalog",
            "description": (
                "What this dataset actually is: model source, variables, the "
                "time range, depth range, how many floats and gliders."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def _view_block(view: dict[str, Any]) -> str:
    """What the display currently shows, in the fewest words that resolve a pronoun.

    Without this the assistant has to ask what "here" means, which in a tool
    that is ALREADY showing a region is an absurd question -- the region is on
    the screen between them.
    """
    bits = []
    if view.get("variable"):
        bits.append(f"variable: {view['variable']}")
    if view.get("time"):
        bits.append(f"timestep: {view['time']}")
    if view.get("depth") is not None:
        bits.append(f"depth slider: {float(view['depth']):.0f} m")
    box = view.get("bbox")
    if isinstance(box, (list, tuple)) and len(box) == 4:
        bits.append(
            "selected region (use this bbox when the user says here or this region): "
            f"[{box[0]:.2f}, {box[1]:.2f}, {box[2]:.2f}, {box[3]:.2f}]"
        )
    else:
        bits.append("no region selected; the whole domain is in view")
    if view.get("mode"):
        bits.append(f"mode: {view['mode']}")
    if view.get("profile"):
        bits.append(f"open profile: {view['profile']}")
    return "\n".join(f"- {b}" for b in bits)


def _view_named() -> list[dict[str, Any]]:
    """The palette's tools, renamed so the two families are unmistakable."""
    out = []
    for t in VIEW_TOOLS:
        fn = dict(t["function"])
        fn["name"] = f"view_{fn['name']}"
        out.append({"type": "function", "function": fn})
    return out


def tool_schema() -> list[dict[str, Any]]:
    return READ_TOOLS + _view_named()


# ----------------------------------------------------------------- reading --


def _bbox(store, args: dict[str, Any], variable: str) -> BBox:
    raw = args.get("bbox")
    cfd = store.dataset_for(variable)
    if isinstance(raw, (list, tuple)) and len(raw) == 4:
        try:
            return BBox.parse(",".join(str(float(v)) for v in raw)).clamp_to(cfd.bbox())
        except Exception:
            pass
    return cfd.bbox()


def _variable(store, args: dict[str, Any]) -> str:
    v = str(args.get("variable") or "")
    return v if v in store.all_variables() else (store.all_variables() or ["temperature"])[0]


def run_read(store, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Execute one read tool. Never raises -- an error is a result the model can see."""
    try:
        if name == "read_catalog":
            variables = store.all_variables()
            cfd = store.dataset_for(variables[0]) if variables else None
            times = cfd.time_strings() if cfd else []
            dr = cfd.depth_range() if cfd else None
            counts: dict[str, int] = {}
            for r in store.observation_refs():
                counts[r.platform] = counts.get(r.platform, 0) + 1
            return {
                "source": store.catalog.source,
                "synthetic": store.catalog.synthetic,
                "variables": variables,
                "timeRange": [times[0], times[-1]] if times else None,
                "timesteps": len(times),
                "depthRange": [dr.top, dr.bottom] if dr else None,
                "bbox": cfd.bbox().as_list() if cfd else None,
                "profiles": counts,
            }

        if name == "read_timeseries":
            var = _variable(store, args)
            cfd = store.dataset_for(var)
            box = _bbox(store, args, var)
            depth = float(args.get("depth") or 0.0)
            times = cfd.time_strings()
            means, mins, maxs = [], [], []
            for t in times:
                vals, _ = cfd.select(var, bbox=box, time=t, depth=depth,
                                     max_shape=(1, 48, 48))
                plane = vals[0]
                if np.isfinite(plane).any():
                    means.append(round(float(np.nanmean(plane)), 3))
                    mins.append(round(float(np.nanmin(plane)), 3))
                    maxs.append(round(float(np.nanmax(plane)), 3))
                else:
                    means.append(None); mins.append(None); maxs.append(None)
            valid = [(t, m) for t, m in zip(times, means) if m is not None]
            return {
                "variable": var,
                "units": CANONICAL[var].units,
                "depth": depth,
                "bbox": box.as_list(),
                "times": times,
                "mean": means,
                "min": mins,
                "max": maxs,
                # The answer, stated. "Which step was highest" is the question
                # nine times out of ten, and picking an argmax out of two
                # parallel arrays is exactly what a language model is worst at
                # -- the first test of this endpoint had one quote a spatial
                # mean of 32.565 when the value was 28.751. Naming the number
                # removes the step where it can go wrong.
                "warmestStep": max(valid, key=lambda x: x[1])[0] if valid else None,
                "warmestMean": max(valid, key=lambda x: x[1])[1] if valid else None,
                "coolestStep": min(valid, key=lambda x: x[1])[0] if valid else None,
                "coolestMean": min(valid, key=lambda x: x[1])[1] if valid else None,
            }

        if name == "read_value":
            var = _variable(store, args)
            cfd = store.dataset_for(var)
            lon = float(args.get("lon"))
            lat = float(args.get("lat"))
            depth = float(args.get("depth") or 0.0)
            when = args.get("time") or None
            pad = 0.35
            box = BBox(lon - pad, lat - pad, lon + pad, lat + pad).clamp_to(cfd.bbox())
            vals, coords = cfd.select(var, bbox=box, time=when, depth=depth,
                                      max_shape=(1, 8, 8))
            plane = vals[0]
            value = float(np.nanmean(plane)) if np.isfinite(plane).any() else None
            return {
                "variable": var,
                "units": CANONICAL[var].units,
                "lon": lon, "lat": lat,
                "depth": float(coords["depth"][0]),
                "time": str(cfd.nearest_time(when)),
                "value": None if value is None else round(value, 3),
                "note": "mean of the model cells within ~0.35 degrees of the point",
            }

        if name == "read_assessment":
            var = _variable(store, args)
            box = _bbox(store, args, var)
            return assess(store, box=box, variable=var)["summary"]

        if name == "read_events":
            var = _variable(store, args)
            if store.climatology is None:
                return {"error": "this catalogue carries no climatology, so no events"}
            cfd = store.dataset_for(var)
            out = find_events(
                cfd, store.climatology, variable=var, bbox=cfd.bbox(),
                depth=float(args.get("depth") or 0.0), limit=5,
            )
            return {
                "events": out["events"],
                "method": out["method"],
                "notHobday": out["notHobday"],
                "units": out["units"],
            }

        if name == "read_profile":
            var = _variable(store, args)
            want = str(args.get("instrument") or "").strip()
            refs = [
                r for r in store.observation_refs()
                if r.id.split(":", 1)[0] == want or want in r.id
            ]
            if not refs:
                return {"error": f"no instrument named {want!r} in this catalogue"}
            from .matchup import compute_matchup, default_window_hours

            cfd = store.dataset_for(var)
            # Order by PROXIMITY TO THE MODEL, not by recency.
            #
            # "The newest cycles" is the obvious heuristic and it is wrong here:
            # float 1902669 reports into 2026 while this model ends in June
            # 2024, so its twelve newest cycles all fall outside the colocation
            # window and the tool reported "no model data" for a float whose
            # early cycles match at RMSE 0.25 over 99 levels. What is wanted is
            # the cycle most likely to have a model step beside it.
            steps = [np.datetime64(t[:19]) for t in cfd.time_strings()]

            def gap(ref) -> float:
                if not steps:
                    return 0.0
                try:
                    t = np.datetime64(ref.time[:19])
                except Exception:
                    return 1e18
                return min(abs(float((t - s) / np.timedelta64(1, "h"))) for s in steps)

            refs.sort(key=gap)
            window = default_window_hours(cfd)
            for ref in refs[:12]:
                try:
                    profile = store.load_profile(ref)
                    m = compute_matchup(
                        cfd, profile, variable=var, window_hours=window,
                    )
                except Exception:
                    continue
                if m.n > 0:
                    return {
                        "instrument": want,
                        "profile": ref.id,
                        "platform": ref.platform,
                        "time": ref.time,
                        "lon": ref.lon, "lat": ref.lat,
                        "variable": var,
                        "units": CANONICAL[var].units,
                        "bias": m.bias, "rmse": m.rmse, "mae": m.mae,
                        "corr": m.corr, "levelsMatched": m.n,
                        "radiusKm": m.radiusKm, "windowHours": m.windowHours,
                        "note": "bias is model minus observation, at the observation depths",
                    }
            return {
                "instrument": want,
                "error": (
                    "no cycle of this instrument has model data within the "
                    "colocation window -- it reports outside the model's record"
                ),
            }

        if name == "read_instruments":
            from ..routers.instruments import instruments as rank

            return rank(
                sortBy=str(args.get("sortBy") or "profile_count"),
                order="desc",
                limit=int(args.get("limit") or 5),
                platform=None,
                bbox=None,
                var=_variable(store, args),
                store=store,
            )
    except Exception as exc:  # a broken read must not end the conversation
        log.info("chat: read %s failed (%s)", name, exc)
        return {"error": f"{type(exc).__name__}: {exc}"[:200]}

    return {"error": f"unknown tool {name}"}


# ------------------------------------------------------------------ verify --

# A leading minus only counts when the character before it is not a digit or a
# dot. Without that lookbehind, "2024-04-15" in a tool result yields 2024, -4
# and -15, while the same date in the reply -- where a model writes it with a
# non-breaking hyphen -- yields 15, and the checker reports the correct date as
# an unverifiable number. That was the first false positive it produced.
_NUM = re.compile(r"(?<![\d.])-?\d+(?:[.,]\d+)?")

#: Models render dates with whatever dash they please.
_DASHES = str.maketrans({
    "\u2010": "-", "\u2011": "-", "\u2012": "-",
    "\u2013": "-", "\u2014": "-", "\u2212": "-",
})

_ISO = re.compile(r"\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?\s*Z?)?")


def _numbers_in(obj: Any, out: set[float]) -> None:
    """Every number anywhere in a tool result, including inside strings."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        out.add(float(obj))
    elif isinstance(obj, str):
        for m in _NUM.finditer(obj):
            try:
                out.add(float(m.group().replace(",", "")))
            except ValueError:
                pass
    elif isinstance(obj, dict):
        for v in obj.values():
            _numbers_in(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _numbers_in(v, out)


def unverified_numbers(reply: str, readings: list[dict[str, Any]]) -> list[str]:
    """Numbers the assistant stated that appear in no reading.

    Displaying the readings beside the prose is necessary and not sufficient:
    a confident sentence is read, and a JSON block underneath is not. So every
    numeric literal in the answer is checked against everything the tools
    actually returned, and anything untraceable is named -- the UI marks the
    reply rather than presenting it as measured.

    Deliberately permissive about WHERE a number came from: matching it to the
    specific field it was quoted as would need the model to say which field it
    meant, and the failure this catches is invention, not mislabelling. A
    number that appears nowhere in any reading cannot have been measured.
    """
    if not reply:
        return []
    text = reply.translate(_DASHES)

    known: set[float] = set()
    for r in readings:
        _numbers_in(r.get("result"), known)

    # Dates are checked as dates, then removed. A timestamp is one fact, not
    # six numbers, and splitting it into its digits is both noisier and weaker:
    # 2024-04-15 and 2024-04-51 share every digit.
    blob = json.dumps([r.get("result") for r in readings])
    bad_dates = [
        d for d in _ISO.findall(text) if d.strip().rstrip("Z").strip()[:16] not in blob
    ]
    text = _ISO.sub(" ", text)
    # Small integers are prose ("two or three floats", "the top 5") far more
    # often than they are measurements, and flagging them would bury the real
    # finding in noise.
    known |= {float(i) for i in range(0, 13)}

    bad: list[str] = list(bad_dates)
    for m in _NUM.finditer(text):
        token = m.group()
        try:
            value = float(token.replace(",", ""))
        except ValueError:
            continue
        # Tolerance covers rounding and unit-free restatement, not a different
        # measurement: 0.5% or 0.01, whichever is larger.
        tol = max(0.01, abs(value) * 0.005)
        if not any(abs(value - k) <= tol for k in known):
            bad.append(token)
    return bad


# -------------------------------------------------------------------- loop --


def _post(body: bytes) -> dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if settings.nlq_api_key:
        headers["Authorization"] = f"Bearer {settings.nlq_api_key}"
    headers["HTTP-Referer"] = "https://github.com/oceanups"
    headers["X-Title"] = "oceanUps (SIH 26067)"
    url = settings.nlq_base_url.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=settings.nlq_timeout) as resp:
        return json.loads(resp.read().decode())


def _call_model(messages: list[dict[str, Any]], deadline: float) -> dict[str, Any]:
    body = json.dumps({
        "model": settings.nlq_model,
        "temperature": 0.2,
        "tools": tool_schema(),
        "tool_choice": "auto",
        "messages": messages,
    }).encode()
    remaining = max(1.0, deadline - time.time())
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(_post, body).result(timeout=remaining)


def converse(
    store,
    history: list[dict[str, str]],
    ctx: dict[str, Any],
    view: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Collect the whole conversation into one object.

    A thin wrapper over `stream()`, kept because the non-streaming endpoint and
    the tests want a single result. The loop itself lives in the generator so
    there is one implementation rather than two that drift.
    """
    final: dict[str, Any] = {}
    for event in stream(store, history, ctx, view):
        if event.get("type") == "final":
            final = event
    return final


def stream(
    store,
    history: list[dict[str, str]],
    ctx: dict[str, Any],
    view: dict[str, Any] | None = None,
):
    """Run the tool loop, reporting each step as it happens.

    A question costs 18-35 s here: every tool round is a round trip to a
    free-tier model, and the first of a session queues. Twenty seconds of an
    unchanging spinner is indistinguishable from a hang, and the honest thing
    to show is what it is actually doing -- "reading the timeseries" is both
    reassuring and the best available explanation of where the time went.

    Yields dicts with a `type`: "tool" when a call starts, "reading" when a
    read returns, "action" when a view call is queued, and exactly one "final".
    """
    from .nlq import _context_block, available

    t0 = time.time()
    if not available():
        yield {
            "type": "final",
            "reply": "",
            "error": "no model configured; set OCEANUPS_NLQ_API_KEY",
            "readings": [], "actions": [], "unverified": [],
            "rounds": 0, "latencyMs": 0,
        }
        return

    system = SYSTEM + "\n\nThis catalogue:\n" + _context_block(ctx)
    if view:
        system += "\n\nOn screen:\n" + _view_block(view)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for m in history[-12:]:
        role = m.get("role")
        if role in ("user", "assistant") and m.get("content"):
            messages.append({"role": role, "content": str(m["content"])[:2000]})

    readings: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    deadline = time.time() + settings.nlq_timeout * MAX_ROUNDS
    rounds = 0

    for rounds in range(1, MAX_ROUNDS + 1):
        try:
            payload = _call_model(messages, deadline)
        except concurrent.futures.TimeoutError:
            yield {
                "type": "final",
                "reply": "", "error": f"{settings.nlq_model} timed out",
                "readings": readings, "actions": actions, "unverified": [],
                "rounds": rounds, "latencyMs": int((time.time() - t0) * 1000),
            }
            return
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode()[:200]
            except Exception:
                pass
            yield {
                "type": "final",
                "reply": "", "error": f"HTTP {exc.code}: {detail or exc.reason}",
                "readings": readings, "actions": actions, "unverified": [],
                "rounds": rounds, "latencyMs": int((time.time() - t0) * 1000),
            }
            return
        except Exception as exc:
            yield {
                "type": "final",
                "reply": "", "error": str(exc)[:200],
                "readings": readings, "actions": actions, "unverified": [],
                "rounds": rounds, "latencyMs": int((time.time() - t0) * 1000),
            }
            return

        try:
            message = payload["choices"][0]["message"]
        except Exception:
            break

        calls = message.get("tool_calls") or []
        if not calls:
            reply = str(message.get("content") or "").strip()
            bad = unverified_numbers(reply, readings)
            if bad:
                log.warning(
                    "chat: reply states %d number(s) found in no reading: %s",
                    len(bad), bad,
                )
            yield {
                "type": "final",
                "reply": reply,
                "error": "",
                "readings": readings,
                "actions": actions,
                # Named so the UI can mark the answer. An empty list is the
                # claim "every number here came from a tool".
                "unverified": bad,
                "rounds": rounds,
                "latencyMs": int((time.time() - t0) * 1000),
            }
            return

        messages.append({
            "role": "assistant",
            "content": message.get("content") or "",
            "tool_calls": calls,
        })

        for call in calls:
            fn = call.get("function") or {}
            name = str(fn.get("name", ""))
            raw = fn.get("arguments") or "{}"
            try:
                args = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                args = {}
            if not isinstance(args, dict):
                args = {}

            yield {"type": "tool", "name": name, "args": args}

            if name.startswith("view_"):
                # Not executed here: handed to the browser. The model is told
                # it worked, because from its point of view it did -- the user
                # will see the display move.
                tool = validate_view(name[5:], args, ctx)
                result: dict[str, Any]
                if tool is None:
                    result = {"error": "that view is not available in this catalogue"}
                else:
                    actions.append(tool)
                    result = {"ok": True, "applied": tool}
                    yield {"type": "action", "action": tool}
            else:
                result = run_read(store, name, args)
                entry = {"tool": name, "args": args, "result": result}
                readings.append(entry)
                yield {"type": "reading", **entry}

            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id", ""),
                "name": name,
                "content": json.dumps(result)[:6000],
            })

    # Ran out of rounds with tools still being called.
    yield {
        "type": "final",
        "reply": "",
        "error": (
            f"stopped after {MAX_ROUNDS} rounds of tool calls without an answer"
        ),
        "readings": readings,
        "actions": actions,
        "unverified": [],
        "rounds": rounds,
        "latencyMs": int((time.time() - t0) * 1000),
    }
