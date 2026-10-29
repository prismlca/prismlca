"""AI assistant support endpoints: per-model chat history + user-provided skills.

The LLM call itself runs in the Electron main process (it holds the OpenRouter key); these endpoints
only persist chat history and skills alongside the project data so they survive restarts and stay
model-specific.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel, Field

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import chat_transcripts
from prism_lca.engine.chat_store import ChatStore
from prism_lca.engine.skills_store import SkillStore
from prism_lca.errors import PrismError

router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(require_token)])

_chats = ChatStore()
_skills = SkillStore()


# ---- chats (per foreground model) -----------------------------------------
class NewChatRequest(BaseModel):
    title: str | None = None


class ChatMessage(BaseModel):
    role: str  # user | assistant
    #: May be empty: main stores an assistant record for EVERY run, also one that only called tools or
    #: was stopped before it said a word — the trace, cost and stop reason belong to it.
    content: str = ""
    # Tool trace of an assistant turn: {name, args?, status?, detail?, preview?, resultChars?, ms?}.
    # Shape is validated and capped in chat_store._cap_traces, so the UI never has to trust it.
    tools: list[dict] | None = None
    #: USD this turn cost, as OpenRouter billed it. Stored with the message so "what did that answer
    #: cost" survives a reload — the per-model monthly total in Settings cannot answer it.
    cost: float | None = None
    #: What the turn consumed. Kept for the same reason as the cost, and answering a question the cost
    #: cannot: how much of the prompt the provider served from its prefix cache. `prompt_tokens`
    #: INCLUDES `cached_tokens` — the cached share is a discount on the same prompt, not a second one.
    #: `completion_tokens` includes reasoning tokens; providers report those too unevenly to split.
    prompt_tokens: int | None = None
    cached_tokens: int | None = None
    completion_tokens: int | None = None
    #: The prompt size of the turn's last round — a level (how full the context was), not a sum.
    context_tokens: int | None = None
    #: Which OpenRouter endpoint served the turn. Routing picks one per request, so speed, price and
    #: cache behaviour differ between two otherwise identical runs; without this recorded, a slow
    #: endpoint cannot be told from a slow model afterwards.
    provider: str | None = None
    #: Files sent with a user turn: {id, name, kind, bytes, pages?, chars?, sheets?}. The files
    #: themselves live in ``prism_meta/sources/``; this is what lets a reloaded chat still show what
    #: was attached. Capped in chat_store._cap_attachments — declared here AND written there, the
    #: two-places rule the `provider` field above learnt the hard way.
    attachments: list[dict] | None = None
    #: The assistant turn's id — the key its transcript file is found under after a restart. Kept in
    #: chat_store.append_messages as well (two places, one field).
    turn_id: str | None = None
    #: Why the turn stopped (a RunOutcome from shared/plan.ts); only on a stopped turn. Unknown values
    #: are dropped in the store, not refused here.
    outcome: str | None = None


class AppendRequest(BaseModel):
    messages: list[ChatMessage]


class RenameChatRequest(BaseModel):
    title: str


class PlanRequest(BaseModel):
    #: The accepted revision {title, steps: [{step, status, note?}], revision, updated}, or null to
    #: remove it. Capped in chat_store.cap_plan — the diagnostics are the plan tool's job in main.
    plan: dict | None = None


class TranscriptRequest(BaseModel):
    # Opaque to the backend: main builds, closes and budgets these (chat_transcripts says why).
    turn_id: str = Field(max_length=200)
    history_after: list[Any]
    messages: list[Any]


def _chat_not_found() -> PrismError:
    return PrismError("Chat not found.", code="chat_not_found", status_code=404)


# Declared BEFORE `POST /chats/{database}`, which would otherwise take "mark-interrupted" for a model.
@router.post("/chats/mark-interrupted", summary="Mark every chat still 'running' as interrupted")
def mark_interrupted() -> dict:
    """Main calls this once at startup: a run cannot be going before main is, so any `running` is a
    run the app was closed under."""
    chats = _chats.mark_interrupted()
    return {"count": len(chats), "chats": chats}


@router.get("/chats/{database}", summary="List a model's chats")
def list_chats(database: str) -> dict:
    return {"chats": _chats.list_chats(database)}


@router.post("/chats/{database}", summary="Create a new chat for a model")
def create_chat(database: str, body: NewChatRequest) -> dict:
    return _chats.create_chat(database, body.title)


@router.get("/chats/{database}/{chat_id}", summary="Get a chat with its messages")
def get_chat(database: str, chat_id: str) -> dict:
    chat = _chats.get_chat(database, chat_id)
    if chat is None:
        raise PrismError("Chat not found.", code="chat_not_found", status_code=404)
    return chat


@router.post("/chats/{database}/{chat_id}/messages", summary="Append messages to a chat")
def append_messages(database: str, chat_id: str, body: AppendRequest) -> dict:
    try:
        return _chats.append_messages(database, chat_id, [m.model_dump() for m in body.messages])
    except KeyError as e:
        raise PrismError("Chat not found.", code="chat_not_found", status_code=404) from e


@router.put("/chats/{database}/{chat_id}/plan", summary="Store (or remove) a chat's plan")
def put_plan(database: str, chat_id: str, body: PlanRequest) -> dict:
    try:
        stored = _chats.set_plan(database, chat_id, body.plan)
    except KeyError as e:
        raise _chat_not_found() from e
    return {"ok": True, "plan": stored}


@router.put("/chats/{database}/{chat_id}/run", summary="Store a chat's run state")
def put_run(database: str, chat_id: str, body: dict = Body(...)) -> dict:
    try:
        stored = _chats.set_run(database, chat_id, body)
    except KeyError as e:
        raise _chat_not_found() from e
    return {"ok": True, "run": stored}


@router.put("/chats/{database}/{chat_id}/transcript", summary="Store the tool transcript of a chat's last turn")
def put_transcript(database: str, chat_id: str, body: TranscriptRequest) -> dict:
    try:
        size = _chats.save_transcript(database, chat_id, body.turn_id, body.history_after, body.messages)
    except KeyError as e:
        raise _chat_not_found() from e
    except chat_transcripts.TranscriptTooLarge as e:
        # The old file stays. Main falls back to rebuilding from prose on the next turn.
        raise PrismError(str(e), code="transcript_too_large", status_code=413) from e
    return {"ok": True, "bytes": size}


@router.get("/chats/{database}/{chat_id}/transcript", summary="Get the stored tool transcript of a chat")
def get_transcript(database: str, chat_id: str) -> Any:
    if _chats.get_chat(database, chat_id) is None:
        raise _chat_not_found()
    stored = chat_transcripts.load(chat_id)
    if stored is None:
        raise PrismError("No transcript stored for this chat.", code="transcript_not_found", status_code=404)
    return stored


@router.delete("/chats/{database}/{chat_id}/transcript", summary="Delete a chat's stored tool transcript")
def delete_transcript(database: str, chat_id: str) -> dict:
    # Idempotent, and deliberately without a chat check: deleting what is not there is not an error.
    del database
    chat_transcripts.delete(chat_id)
    return {"ok": True}


@router.post("/chats/{database}/{chat_id}/rename", summary="Rename a chat")
def rename_chat(database: str, chat_id: str, body: RenameChatRequest) -> dict:
    try:
        _chats.rename_chat(database, chat_id, body.title)
    except KeyError as e:
        raise PrismError("Chat not found.", code="chat_not_found", status_code=404) from e
    return {"ok": True}


@router.post("/chats/{database}/{chat_id}/delete", summary="Delete a chat")
def delete_chat(database: str, chat_id: str) -> dict:
    _chats.delete_chat(database, chat_id)
    # A file the user attached lives as long as a message names it; this may have been the last one.
    from prism_lca.engine.attachments import prune_unreferenced

    prune_unreferenced()
    return {"ok": True}


# ---- skills ---------------------------------------------------------------
class NewSkillRequest(BaseModel):
    name: str
    description: str = ""
    content: str


class UpdateSkillRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    content: str | None = None
    enabled: bool | None = None


@router.get("/skills", summary="List AI skills")
def list_skills(enabled: bool = False) -> dict:
    return {"skills": _skills.list(enabled_only=enabled)}


@router.post("/skills", summary="Create an AI skill (Markdown guidance)")
def create_skill(body: NewSkillRequest) -> dict:
    return _skills.create(body.name, body.description, body.content)


@router.post("/skills/{skill_id}", summary="Update an AI skill")
def update_skill(skill_id: str, body: UpdateSkillRequest) -> dict:
    try:
        return _skills.update(
            skill_id, name=body.name, description=body.description,
            content=body.content, enabled=body.enabled,
        )
    except KeyError as e:
        raise PrismError("Skill not found.", code="skill_not_found", status_code=404) from e
    except ValueError as e:
        raise PrismError(str(e), code="skill_builtin", status_code=400) from e


@router.post("/skills/{skill_id}/delete", summary="Delete an AI skill")
def delete_skill(skill_id: str) -> dict:
    try:
        _skills.delete(skill_id)
    except ValueError as e:
        raise PrismError(str(e), code="skill_builtin", status_code=400) from e
    return {"ok": True}
