"""Disk-backed SHA-256 answer cache to avoid redundant Gemini API quota consumption."""

import hashlib
import json
from pathlib import Path
import threading
from typing import Optional

from ..config import ASSIGNMENT_CACHE_DIR


def make_cache_key(
    question_text: str,
    marks: float,
    preset_id: str,
    model: str,
    subject_hint: str = "",
    words_per_mark_min: Optional[int] = None,
    words_per_mark_max: Optional[int] = None,
    question_type: str = "",
) -> str:
    """
    Build a deterministic SHA-256 cache key anchored on question text, marks, preset, and model.
    """
    normalized_text = " ".join((question_text or "").split())
    payload = "|".join(
        [
            normalized_text,
            str(float(marks)),
            preset_id.strip(),
            model.strip(),
            subject_hint.strip(),
            str(words_per_mark_min or ""),
            str(words_per_mark_max or ""),
            question_type.strip(),
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class AssignmentAnswerCache:
    """Thread-safe file cache storing generated answer JSON payloads keyed by SHA-256."""

    def __init__(self, cache_dir: Optional[Path] = None) -> None:
        self._explicit_dir = cache_dir
        self._lock = threading.Lock()

    @property
    def cache_dir(self) -> Path:
        return self._explicit_dir or ASSIGNMENT_CACHE_DIR

    def get(self, cache_key: str) -> Optional[dict]:
        path = self.cache_dir / f"{cache_key}.json"
        with self._lock:
            if not path.exists():
                return None
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                return None

    def set(self, cache_key: str, value: dict) -> None:
        target_dir = self.cache_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / f"{cache_key}.json"
        with self._lock:
            path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
