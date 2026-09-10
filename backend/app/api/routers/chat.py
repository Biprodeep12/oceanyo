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

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..datastore import DataStore, get_store
from ..services import chat
from .query import _context

router = APIRouter(prefix="/api", tags=["query"])


class Turn(BaseModel):
    role: str
    content: str = Field("", max_length=4000)


class ChatRequest(BaseModel):
    #: Whole conversation, oldest first. Capped so a long session cannot grow
    #: the prompt without bound -- the service also keeps only the last turns.
    messages: list[Turn] = Field(..., max_length=40)


@router.post("/chat")
def post_chat(req: ChatRequest, store: DataStore = Depends(get_store)):
    history = [{"role": t.role, "content": t.content} for t in req.messages]
    return chat.converse(store, history, _context(store))
