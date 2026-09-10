"""POST /api/chat -- the assistant, with the datastore behind it.

Conversation state lives in the CLIENT and is posted with each turn. That is
deliberate: a server-side session would need eviction, identity and a store,
and would make two browser tabs share a conversation neither asked for. The
history is small, and the model is stateless anyway.

The reply carries three things the UI keeps visually separate, because 5.2
requires it: the assistant's prose, the tool readings it is based on, and the
view actions for the browser to apply.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..datastore import DataStore, get_store
from ..services import chat
from .query import _context

router = APIRouter(prefix="/api", tags=["query"])


class Turn(BaseModel):
    role: str
    content: str = Field("", max_length=4000)


class ViewState(BaseModel):
    """What the user is looking at, so "here" and "now" resolve to something.

    Sent by the client rather than tracked server-side: the display is the
    client's state, and a server that kept its own copy would be wrong the
    moment two tabs were open.
    """

    variable: str | None = None
    time: str | None = None
    depth: float | None = None
    bbox: list[float] | None = None
    mode: str | None = None
    profile: str | None = None


class ChatRequest(BaseModel):
    #: Whole conversation, oldest first. Capped so a long session cannot grow
    #: the prompt without bound -- the service also keeps only the last turns.
    messages: list[Turn] = Field(..., max_length=40)
    view: ViewState | None = None


def _payload(req: ChatRequest):
    history = [{"role": t.role, "content": t.content} for t in req.messages]
    view = req.view.model_dump(exclude_none=True) if req.view else None
    return history, view


@router.post("/chat")
def post_chat(req: ChatRequest, store: DataStore = Depends(get_store)):
    """The whole answer in one object, once the loop has finished."""
    history, view = _payload(req)
    return chat.converse(store, history, _context(store), view)


@router.post("/chat/stream")
def post_chat_stream(req: ChatRequest, store: DataStore = Depends(get_store)):
    """The same loop, reported as it happens, as newline-delimited JSON.

    NDJSON rather than server-sent events: the client is a `fetch` reading a
    stream, not an `EventSource`, so the `data:`/`event:` framing would be
    ceremony around a format that is already one object per line. It also means
    a curl of this endpoint is readable without a decoder.

    Why it exists at all: a question costs 18-35 s, because every tool round is
    a round trip to a free-tier model and the first of a session queues. Twenty
    seconds of an unchanging spinner is indistinguishable from a hang, and
    "reading the timeseries" is both reassuring and the truest available
    account of where the time is going.
    """
    history, view = _payload(req)
    ctx = _context(store)

    def lines():
        for event in chat.stream(store, history, ctx, view):
            yield json.dumps(event) + "\n"

    return StreamingResponse(
        lines(),
        media_type="application/x-ndjson",
        # Buffering a progress stream defeats its only purpose, and a proxy
        # will do it by default.
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
