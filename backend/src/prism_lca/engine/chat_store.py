"""Per-model AI chat history.

Each foreground model (database) has its own set of chats — mirrors the canvas: the chat lives
on the model's canvas. Stored as one JSON file in the active project's ``prism_meta`` dir, keyed by
database name. A message is ``{role, content, ts}`` plus — on assistant turns that used tools — a
``tools`` list of traces, so a reloaded chat can still show HOW an answer came about.

Traces are capped here as well as in the caller (``TRACE_PREVIEW_CHARS`` in the agent): tool results
reach 30k characters each, and a 40-round run would otherwise add megabytes to a file that lives in
the user's project directory.

Two more fields sit on a chat, siblings, not nested:
``plan`` — the accepted revision of the list the assistant keeps — and ``run`` — whether a run is
going, and how the last one ended. Both are capped and cleaned here; the diagnostics for a bad plan
are the ``plan`` tool's job in main (``shared/plan.ts``), the store only refuses to grow. The tool
transcript of the last turn lives in its own file (``chat_transcripts``), not in this one.
"""
from __future__ import annotations

import uuid

from prism_lca.engine import chat_transcripts
from prism_lca.engine._store import JsonFileStore, now_iso

# Keep in step with TRACE_PREVIEW_CHARS / TRACE_ARGS_CHARS in frontend/src/main/ai/agent.ts.
# Enforced again here on purpose: the client is not the only defence against a chat file growing
# without bound.
#
# These drifted once and it cost a real diagnosis: the live trace was raised to 6,000 characters so
# that a batched call's result stays readable, while this kept storing 2,000 — so a run reviewed
# after the fact showed a third of what its own developer had watched happen, on tools returning
# 5,000+ characters. A stored trace exists precisely for the look back, so it may not be the
# shorter of the two.
_TRACE_PREVIEW_CHARS = 6_000
# Same value as the frontend's TRACE_ARGS_CHARS, for the reason above — the pair had drifted to 2,500
# live against 4,000 stored, and batching reaches both: an 18-parameter `edit_parameter` stored its
# arguments cut at exactly 4,000 while the live trace had shown 2,500 of them.
_TRACE_ARG_CHARS = 6_000
_MAX_TRACES = 200


def _cap_traces(tools: object) -> list[dict]:
    """Keep a tool trace readable but bounded. Unknown keys are dropped, not trusted."""
    if not isinstance(tools, list):
        return []
    out: list[dict] = []
    for t in tools[:_MAX_TRACES]:
        if not isinstance(t, dict) or not t.get("name"):
            continue
        entry: dict = {"name": str(t["name"])}
        for key, limit in (("args", _TRACE_ARG_CHARS), ("preview", _TRACE_PREVIEW_CHARS), ("detail", _TRACE_PREVIEW_CHARS)):
            value = t.get(key)
            if isinstance(value, str) and value:
                entry[key] = value[:limit]
        if t.get("status") in {"ok", "rejected", "error"}:
            entry["status"] = t["status"]
        # itemsFailed: a batch call whose status is "ok" while some of its items were not applied.
        # It has to survive a reload for the same reason the trace does — that is when someone asks
        # what actually happened.
        for key in ("resultChars", "ms", "itemsFailed"):
            value = t.get(key)
            if isinstance(value, int):
                entry[key] = value
        out.append(entry)
    return out


#: Files per user message. The main process refuses more than ten before it gets this far; this is
#: the store refusing to grow without bound if that ever changes.
_MAX_ATTACHMENTS = 20


def _cap_attachments(attachments: object) -> list[dict]:
    """Keep the description of an attached file, never the file. Unknown keys are dropped.

    What survives is what the chat has to show after a reload and what a later turn needs to open the
    file again: the id (its handle in ``prism_meta/sources/``), the name, and the size. The content
    stays on disk, which is the whole point of storing attachments there.
    """
    if not isinstance(attachments, list):
        return []
    out: list[dict] = []
    for a in attachments[:_MAX_ATTACHMENTS]:
        if not isinstance(a, dict) or not a.get("id") or not a.get("name"):
            continue
        entry: dict = {"id": str(a["id"])[:200], "name": str(a["name"])[:400]}
        kind = a.get("kind")
        if kind in {"pdf", "image", "sheet", "text", "document"}:
            entry["kind"] = kind
        for key in ("bytes", "pages", "chars"):
            value = a.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                entry[key] = value
        sheets = a.get("sheets")
        if isinstance(sheets, list):
            named = [
                {"name": str(s.get("name"))[:200], "rows": int(s.get("rows") or 0), "columns": int(s.get("columns") or 0)}
                for s in sheets[:50]
                if isinstance(s, dict) and s.get("name")
            ]
            if named:
                entry["sheets"] = named
        out.append(entry)
    return out


# Keep in step with PLAN_LIMITS and the status/outcome unions in frontend/src/shared/plan.ts.
_PLAN_STEPS = 20
_PLAN_STEP_CHARS = 120
_PLAN_NOTE_CHARS = 300
_PLAN_TITLE_CHARS = 60
PLAN_STATUSES = ("pending", "in_progress", "blocked", "completed", "skipped")
RUN_STATES = ("idle", "running", "stopped", "interrupted")
RUN_OUTCOMES = (
    "answered", "rounds", "cost", "repetition", "stalled", "empty", "output_limit", "cancelled", "error",
    "interrupted",
)
_ID_CHARS = 60


def _is_int(value: object) -> bool:
    # `bool` is an `int` in Python and would store `True` as 1.
    return isinstance(value, int) and not isinstance(value, bool)


def cap_plan(plan: object) -> dict | None:
    """A plan as the store keeps it: capped, unknown keys dropped. Not a plan at all → None.

    Truncates rather than rejects — by the time a plan gets here main has validated it with a
    diagnostic for the model; this is the store refusing to grow if a caller ever does not. A step
    with an unknown status becomes ``pending`` rather than vanishing: an unfinished step must not be
    cut from the list quietly, that is the one rule the plan exists for.
    """
    if not isinstance(plan, dict):
        return None
    steps: list[dict] = []
    raw_steps = plan.get("steps")
    for st in (raw_steps if isinstance(raw_steps, list) else [])[:_PLAN_STEPS]:
        if not isinstance(st, dict) or not isinstance(st.get("step"), str) or not st["step"].strip():
            continue
        entry: dict = {
            "step": st["step"].strip()[:_PLAN_STEP_CHARS],
            "status": st["status"] if st.get("status") in PLAN_STATUSES else "pending",
        }
        note = st.get("note")
        if isinstance(note, str) and note.strip():
            entry["note"] = note.strip()[:_PLAN_NOTE_CHARS]
        steps.append(entry)
    title = plan.get("title")
    revision = plan.get("revision")
    updated = plan.get("updated")
    return {
        "title": title.strip()[:_PLAN_TITLE_CHARS] if isinstance(title, str) else "",
        "steps": steps,
        "revision": revision if _is_int(revision) and revision >= 0 else 0,
        "updated": updated[:40] if isinstance(updated, str) and updated else now_iso(),
    }


def cap_run(run: object) -> dict:
    """A run state as the store keeps it. Unknown keys dropped, an unknown state is ``idle``.

    A missing ``runId`` gets a fresh one rather than a refusal: the field is what lets main discard a
    late write from a superseded run, and an id nobody else holds is the safe reading of "none".
    """
    src = run if isinstance(run, dict) else {}
    run_id = src.get("runId")
    entry: dict = {
        "runId": run_id.strip()[:_ID_CHARS] if isinstance(run_id, str) and run_id.strip() else uuid.uuid4().hex[:12],
        "state": src["state"] if src.get("state") in RUN_STATES else "idle",
    }
    if src.get("outcome") in RUN_OUTCOMES:
        entry["outcome"] = src["outcome"]
    for key in ("startedAt", "endedAt"):
        value = src.get(key)
        if isinstance(value, str) and value:
            entry[key] = value[:40]
    for key in ("costUsd", "costLimitUsd"):
        value = src.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            entry[key] = float(value)
    rounds = src.get("rounds")
    if _is_int(rounds) and rounds >= 0:
        entry["rounds"] = rounds
    turn_id = src.get("turnId")
    if isinstance(turn_id, str) and turn_id.strip():
        entry["turnId"] = turn_id.strip()[:_ID_CHARS]
    return entry


def plan_progress(plan: object) -> dict | None:
    """What a chat list shows of a plan: its title and how far it got. ``skipped`` is not done."""
    if not isinstance(plan, dict):
        return None
    steps = [s for s in plan.get("steps") or [] if isinstance(s, dict)]
    return {
        "title": plan.get("title") or "",
        "completed": sum(1 for s in steps if s.get("status") == "completed"),
        "total": len(steps),
    }


PROVISIONAL_TITLE_CHARS = 60


def provisional_title(text: object, limit: int = PROVISIONAL_TITLE_CHARS) -> str:
    """The first words of a message as a stand-in chat title: whitespace collapsed, cut at a word
    boundary where one exists in the last third, an ellipsis marking the cut."""
    if not isinstance(text, str):
        return ""
    flat = " ".join(text.split())
    if len(flat) <= limit:
        return flat
    head = flat[:limit]
    space = head.rfind(" ")
    if space > limit * 2 // 3:
        head = head[:space]
    return head.rstrip(" ,;:.-") + "…"


class ChatStore(JsonFileStore):
    FILENAME = "ai_chats.json"
    # Corrupt file → start fresh: chats are a convenience log, not the model. The lock lives in the
    # base now — mutations are read-modify-write on a single JSON file, and the renderer (user
    # message) and the Electron main (assistant message) may append concurrently.
    ON_ERROR = "empty"

    @staticmethod
    def _summary(chat: dict) -> dict:
        return {
            "id": chat["id"],
            "title": chat.get("title") or "New chat",
            "created": chat.get("created"),
            "updated": chat.get("updated"),
            "message_count": len(chat.get("messages", [])),
            "plan": plan_progress(chat.get("plan")),
            "run": ({k: v for k, v in chat["run"].items() if k in ("state", "outcome")}
                    if isinstance(chat.get("run"), dict) else None),
        }

    def list_chats(self, database: str) -> list[dict]:
        chats = self._load().get(database, [])
        return [self._summary(c) for c in chats]

    def get_chat(self, database: str, chat_id: str) -> dict | None:
        for c in self._load().get(database, []):
            if c["id"] == chat_id:
                return c
        return None

    def create_chat(self, database: str, title: str | None = None) -> dict:
        with self._lock:
            data = self._load()
            chat = {"id": uuid.uuid4().hex[:12], "title": title, "created": now_iso(),
                    "updated": now_iso(), "messages": []}
            data.setdefault(database, []).insert(0, chat)  # newest first
            self._save(data)
            return chat

    def append_messages(
        self, database: str, chat_id: str, messages: list[dict], *, keep_ts: bool = False
    ) -> dict:
        """Append turns, stamped now — or, with ``keep_ts`` (a bundle import restoring a conversation),
        with the time each one carries, so an imported chat does not read as if it happened today."""
        with self._lock:
            data = self._load()
            for c in data.get(database, []):
                if c["id"] == chat_id:
                    for m in messages:
                        # Content may be empty: a turn that only called tools, or was stopped before
                        # it said anything, is still a turn — main stores one for every run so that its
                        # trace, cost and stop reason survive, and its turn_id finds the transcript.
                        content = m.get("content")
                        ts = m.get("ts") if keep_ts and isinstance(m.get("ts"), str) and m["ts"] else now_iso()
                        entry = {"role": m["role"], "content": content if isinstance(content, str) else "", "ts": ts}
                        # The turn id is the key the transcript file is found under, and the
                        # outcome why the turn stopped. Two places, one field: declared on ChatMessage
                        # in api/v1/ai.py as well.
                        turn_id = m.get("turn_id")
                        if isinstance(turn_id, str) and turn_id.strip():
                            entry["turn_id"] = turn_id.strip()[:_ID_CHARS]
                        if m.get("outcome") in RUN_OUTCOMES:
                            entry["outcome"] = m["outcome"]
                        traces = _cap_traces(m.get("tools"))
                        if traces:
                            entry["tools"] = traces
                        attached = _cap_attachments(m.get("attachments"))
                        if attached:
                            entry["attachments"] = attached
                        # What the turn cost, as OpenRouter billed it. Kept with the message rather than
                        # only in the monthly total: the cost limit is a PER-RUN limit, so "what did that
                        # answer cost" is the question the user actually has, and after a reload the
                        # monthly figure in Settings cannot answer it.
                        cost = m.get("cost")
                        if isinstance(cost, (int, float)) and cost > 0:
                            entry["cost"] = float(cost)
                        # Which endpoint served the turn. Kept for the same reason as the cost: it is
                        # the answer to "why was this run four times slower than the last one", and
                        # routing picks per request, so nothing else can reconstruct it afterwards.
                        # The API accepted this field before this line existed and it was dropped
                        # here in silence — the UI showed the name until the next reload.
                        provider = m.get("provider")
                        if isinstance(provider, str) and provider.strip():
                            entry["provider"] = provider.strip()[:100]
                        # What the turn consumed, so the chat header can add it up over the whole
                        # conversation. The monthly ledger in Settings is per model and cannot tell
                        # two chats apart, so nothing else can answer it after a reload. Written here
                        # AND declared on the API model: the provider field above was accepted by the
                        # API and dropped in silence right here, and the name showed until the next
                        # reload. Two places, one field — miss either and the bug is invisible.
                        for key in ("prompt_tokens", "cached_tokens", "completion_tokens", "context_tokens"):
                            value = m.get(key)
                            # `bool` is an `int` in Python and would store `True` as 1.
                            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                                entry[key] = value
                        c["messages"].append(entry)
                        # Until the assistant names the chat (set_chat_title), the first words of the
                        # first user message stand in — a list of "New chat" said nothing. A title once set is
                        # never touched here.
                        if not c.get("title") and entry["role"] == "user":
                            provisional = provisional_title(entry["content"])
                            if provisional:
                                c["title"] = provisional
                    c["updated"] = (c["messages"][-1]["ts"] if keep_ts and c.get("messages") else None) or now_iso()
                    self._save(data)
                    return c
        raise KeyError(chat_id)

    def rename_chat(self, database: str, chat_id: str, title: str) -> None:
        with self._lock:
            data = self._load()
            for c in data.get(database, []):
                if c["id"] == chat_id:
                    c["title"] = title
                    self._save(data)
                    return
        raise KeyError(chat_id)

    def set_plan(self, database: str, chat_id: str, plan: object) -> dict | None:
        """Store the accepted plan revision (capped); None removes the field. Returns what was stored."""
        with self._lock:
            data = self._load()
            for c in data.get(database, []):
                if c["id"] == chat_id:
                    capped = cap_plan(plan)
                    if capped is None:
                        c.pop("plan", None)
                    else:
                        c["plan"] = capped
                    self._save(data)
                    return capped
        raise KeyError(chat_id)

    def set_run(self, database: str, chat_id: str, run: object) -> dict:
        """Store the run state as main reports it. Last write wins — which run may write is main's call
        (it holds the runId of the current one and drops a superseded run's writes)."""
        with self._lock:
            data = self._load()
            for c in data.get(database, []):
                if c["id"] == chat_id:
                    c["run"] = cap_run(run)
                    self._save(data)
                    return c["run"]
        raise KeyError(chat_id)

    def mark_interrupted(self) -> list[dict]:
        """At app start: every chat of every model still marked ``running`` was killed with the app.

        Nothing can be running before main has started, so whatever says so is a leftover — and it
        would otherwise lock the chat's input and Continue forever.
        """
        with self._lock:
            data = self._load()
            hit: list[dict] = []
            for database, chats in data.items():
                for c in chats or []:
                    run = c.get("run")
                    if isinstance(run, dict) and run.get("state") == "running":
                        run["state"] = "interrupted"
                        run["outcome"] = "interrupted"
                        run["endedAt"] = now_iso()
                        hit.append({"database": database, "id": c["id"]})
            if hit:
                self._save(data)
            return hit

    def save_transcript(self, database: str, chat_id: str, turn_id: str, history_after: list,
                        messages: list) -> int:
        """Write the chat's transcript file. Under the chat lock, so a delete cannot slip between the
        "does the chat exist" check and the write and leave an orphan file behind."""
        with self._lock:
            if self.get_chat(database, chat_id) is None:
                raise KeyError(chat_id)
            return chat_transcripts.save(chat_id, turn_id, history_after, messages)

    def delete_chat(self, database: str, chat_id: str) -> None:
        with self._lock:
            data = self._load()
            chats = data.get(database, [])
            data[database] = [c for c in chats if c["id"] != chat_id]
            self._save(data)
            # Only if it was this model's chat — ids are unique, but a stale call with the wrong model
            # must not take another chat's transcript.
            if len(data[database]) != len(chats):
                chat_transcripts.delete(chat_id)

    def attachment_ids(self) -> set[str]:
        """Every attachment id any stored message of any model still names — what keeps a file alive."""
        ids: set[str] = set()
        for chats in self._load().values():
            for chat in chats or []:
                for message in chat.get("messages", []):
                    for a in message.get("attachments") or []:
                        if isinstance(a, dict) and a.get("id"):
                            ids.add(str(a["id"]))
        return ids

    def rename_database(self, old: str, new: str) -> None:
        with self._lock:
            data = self._load()
            if old in data:
                data[new] = data.pop(old)
                self._save(data)

    def remove_database(self, database: str) -> None:
        with self._lock:
            data = self._load()
            if database in data:
                gone = data.pop(database)
                self._save(data)
                # A rename needs nothing (transcripts are keyed by chat id); a removal takes them along.
                chat_transcripts.delete_many([c["id"] for c in gone or [] if isinstance(c, dict) and c.get("id")])
