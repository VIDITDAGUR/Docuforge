"""Course preset configuration loader and word-rule resolver."""

from functools import lru_cache
import json
from pathlib import Path
from typing import Optional

from .models import CoursePreset, PresetCatalog

DEFAULT_PRESETS_PATH = Path(__file__).resolve().parent / "presets_config.json"


@lru_cache(maxsize=4)
def _load_cached_catalog(path_str: str) -> PresetCatalog:
    raw = json.loads(Path(path_str).read_text(encoding="utf-8"))
    return PresetCatalog.model_validate(raw)


def load_preset_catalog(config_path: Optional[Path] = None) -> PresetCatalog:
    """Load the course preset catalog from JSON config."""
    target = (config_path or DEFAULT_PRESETS_PATH).resolve()
    return _load_cached_catalog(str(target))


def get_preset(preset_id: str, config_path: Optional[Path] = None) -> CoursePreset:
    """Look up a course preset by id, falling back to 'custom' or first preset only if missing raises KeyError."""
    catalog = load_preset_catalog(config_path)
    for preset in catalog.presets:
        if preset.id == preset_id:
            return preset
    raise KeyError(f"Unknown course preset '{preset_id}'.")


def resolve_length_rules(
    preset: CoursePreset,
    catalog: Optional[PresetCatalog] = None,
    custom_min: Optional[int] = None,
    custom_max: Optional[int] = None,
) -> tuple[int, int, dict[str, list[int]]]:
    """
    Resolve effective (words_per_mark_min, words_per_mark_max, explicit_overrides).

    UI/request overrides take priority for words_per_mark bounds, while
    preset-level explicit_overrides extend/override catalog-level explicit_overrides.
    """
    cat = catalog or load_preset_catalog()
    w_min = custom_min if custom_min is not None else (preset.words_per_mark_min or cat.default_words_per_mark_min)
    w_max = custom_max if custom_max is not None else (preset.words_per_mark_max or cat.default_words_per_mark_max)
    if w_max < w_min:
        w_min, w_max = w_max, w_min

    merged_overrides: dict[str, list[int]] = {}
    merged_overrides.update(cat.explicit_overrides or {})
    merged_overrides.update(preset.explicit_overrides or {})
    return w_min, w_max, merged_overrides
