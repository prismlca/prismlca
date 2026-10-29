"""User-provided AI *skills* — Markdown snippets that are offered to the assistant as extra
guidance (what a skill is + when to use it). Global to the project (not per model). Stored as one
JSON file in ``prism_meta``.

Built-in skills (``builtin_skills.py``) are merged into the same list: they ship with the app,
cannot be edited or deleted, but can be toggled — only the enabled flag is persisted, in a
separate overrides file so ``ai_skills.json`` keeps its plain-list format.
"""
from __future__ import annotations

import uuid
from pathlib import Path

from prism_lca.engine._store import JsonFileStore, read_json, write_json_atomic
from prism_lca.engine.builtin_skills import BUILTIN_IDS, BUILTIN_SKILLS


class SkillStore(JsonFileStore):
    FILENAME = "ai_skills.json"
    ON_ERROR = "empty"  # corrupt file → start fresh: skills are re-creatable guidance, not the model

    def _default(self) -> list[dict]:
        return []

    def _overrides_path(self) -> Path:
        return self._path().with_name("ai_skills_builtin.json")

    def _load_overrides(self) -> dict:
        return read_json(self._overrides_path(), default={}, on_error="empty")

    @staticmethod
    def _write_json(path: Path, data) -> None:
        write_json_atomic(path, data)

    def _builtins(self) -> list[dict]:
        overrides = self._load_overrides()
        out = []
        for s in BUILTIN_SKILLS:
            skill = dict(s)
            skill["enabled"] = bool(overrides.get(s["id"], {}).get("enabled", s.get("enabled", True)))
            out.append(skill)
        return out

    def list(self, enabled_only: bool = False) -> list[dict]:
        skills = self._builtins() + self._load()
        return [s for s in skills if s.get("enabled", True)] if enabled_only else skills

    def create(self, name: str, description: str, content: str) -> dict:
        with self._lock:
            data = self._load()
            skill = {
                "id": uuid.uuid4().hex[:12],
                "name": name.strip() or "Untitled skill",
                "description": (description or "").strip(),
                "content": content or "",
                "enabled": True,
            }
            data.append(skill)
            self._save(data)
            return skill

    def update(self, skill_id: str, *, name=None, description=None, content=None, enabled=None) -> dict:
        with self._lock:
            if skill_id in BUILTIN_IDS:
                if any(v is not None for v in (name, description, content)):
                    raise ValueError("Built-in skills cannot be edited — only enabled/disabled.")
                if enabled is not None:
                    overrides = self._load_overrides()
                    overrides[skill_id] = {"enabled": bool(enabled)}
                    self._write_json(self._overrides_path(), overrides)
                for s in self._builtins():
                    if s["id"] == skill_id:
                        return s
                raise KeyError(skill_id)  # pragma: no cover — BUILTIN_IDS and BUILTIN_SKILLS agree
            data = self._load()
            for s in data:
                if s["id"] == skill_id:
                    if name is not None:
                        s["name"] = name
                    if description is not None:
                        s["description"] = description
                    if content is not None:
                        s["content"] = content
                    if enabled is not None:
                        s["enabled"] = bool(enabled)
                    self._save(data)
                    return s
            raise KeyError(skill_id)

    def delete(self, skill_id: str) -> None:
        with self._lock:
            if skill_id in BUILTIN_IDS:
                raise ValueError("Built-in skills cannot be deleted (disable them instead).")
            data = self._load()
            self._save([s for s in data if s["id"] != skill_id])
