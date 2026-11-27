"""Word-range calculation, code/formula-aware word counting, and handwritten line estimation."""

from dataclasses import dataclass
import math
import re
from typing import Optional

from .models import QuestionType

_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*")
_MULTI_LETTER_WORD_RE = re.compile(r"\b[A-Za-z]{3,}\b")
_FENCED_CODE_RE = re.compile(r"```[\s\S]*?```")

_CODE_LINE_PREFIXES = (
    "def ",
    "class ",
    "for ",
    "while ",
    "if ",
    "elif ",
    "else:",
    "return ",
    "import ",
    "from ",
    "#include",
    "using namespace",
    "public ",
    "private ",
    "protected ",
    "static ",
    "void ",
    "int ",
    "float ",
    "double ",
    "char ",
    "string ",
    "bool ",
    "const ",
    "let ",
    "var ",
    "function ",
    "printf(",
    "scanf(",
    "console.",
    "system.out",
    "print(",
    "select ",
    "insert ",
    "update ",
    "delete ",
    "create table",
)

_MATH_UNIT_TOKENS = {
    "sin",
    "cos",
    "tan",
    "cot",
    "sec",
    "csc",
    "log",
    "ln",
    "exp",
    "sqrt",
    "lim",
    "max",
    "min",
    "avg",
    "sum",
    "det",
    "deg",
    "rad",
    "mol",
    "atm",
    "ohm",
    "amp",
    "volt",
    "watt",
    "joule",
    "sec",
    "hrs",
}

_EXCLUDED_TYPES = {"numerical", "derivation", "code"}


@dataclass(frozen=True)
class WordRange:
    """Allowed min/max explanation word bounds and target midpoint."""

    min_words: int
    max_words: int
    target_words: int


def _marks_key(marks: float) -> str:
    return str(int(marks)) if float(marks).is_integer() else str(marks)


def calculate_word_range(
    marks: float,
    words_per_mark_min: int = 30,
    words_per_mark_max: int = 40,
    explicit_overrides: Optional[dict[str, list[int]]] = None,
) -> WordRange:
    """
    Compute (min_words, max_words, target_words) from marks and preset rules.

    Explicit overrides (e.g. ``{"7": [210, 250]}``) take priority over the
    ``marks * words_per_mark`` formula.
    """
    if marks <= 0:
        raise ValueError("Marks must be greater than 0.")

    if explicit_overrides:
        override = explicit_overrides.get(_marks_key(marks)) or explicit_overrides.get(str(marks))
        if isinstance(override, (list, tuple)) and len(override) == 2:
            lo = max(1, int(override[0]))
            hi = max(lo, int(override[1]))
            return WordRange(min_words=lo, max_words=hi, target_words=(lo + hi) // 2)

    lo_rate = min(words_per_mark_min, words_per_mark_max)
    hi_rate = max(words_per_mark_min, words_per_mark_max)
    min_words = max(1, int(round(marks * lo_rate)))
    max_words = max(min_words, int(round(marks * hi_rate)))
    target_words = (min_words + max_words) // 2
    return WordRange(min_words=min_words, max_words=max_words, target_words=target_words)


def _is_code_line(raw_line: str) -> bool:
    stripped = raw_line.strip()
    if not stripped:
        return False
    lower = stripped.lower()
    if raw_line.startswith(("    ", "\t")) and any(
        ch in stripped for ch in ("=", "(", ")", "{", "}", ";", "[", "]", "->")
    ):
        return True
    if lower.startswith(_CODE_LINE_PREFIXES):
        return True
    if stripped.endswith((";", "{", "}")) and not stripped.endswith(("e.g.;", "i.e.;")):
        return True
    if stripped.startswith(("//", "/*", "*/")) or (
        stripped.startswith("#") and not stripped.startswith("#1")
    ):
        return True
    if re.match(r"^[A-Za-z_][A-Za-z0-9_\[\]\.]*\s*=\s*.+$", stripped) and not stripped.endswith("."):
        return True
    return False


def _is_formula_only_line(raw_line: str) -> bool:
    stripped = raw_line.strip()
    if not stripped:
        return False

    # Ignore optional step label like "Step 1:" when checking the formula body
    body = re.sub(r"^(?:step\s*\d+|eq(?:uation)?\.?\s*\(?\d+\)?)\s*[:\-]\s*", "", stripped, flags=re.IGNORECASE)
    if not body:
        return False

    has_math_ops = any(op in body for op in ("=", "≈", "≠", "≤", "≥", "=>", "->", "∫", "∑", "^"))
    has_arith = any(op in body for op in ("+", "*", "/", "÷", "×")) and any(ch.isdigit() for ch in body)
    if not (has_math_ops or has_arith):
        return False

    prose_words = [
        w.lower()
        for w in _MULTI_LETTER_WORD_RE.findall(body)
        if w.lower() not in _MATH_UNIT_TOKENS
    ]
    # Pure formulas/calculations have few prose words alongside operators/digits
    if len(prose_words) <= 2:
        return True
    return False


def strip_code_and_formulas(text: str, question_type: QuestionType) -> str:
    """
    Remove code blocks and formula-only lines when ``question_type`` is numerical,
    derivation, or code so word-count bounds apply strictly to explanation prose.
    """
    if question_type not in _EXCLUDED_TYPES:
        return text

    cleaned = _FENCED_CODE_RE.sub(" ", text)
    kept_lines: list[str] = []
    for line in cleaned.splitlines():
        if question_type == "code" and _is_code_line(line):
            continue
        if question_type in {"numerical", "derivation"} and (
            _is_formula_only_line(line) or _is_code_line(line)
        ):
            continue
        if question_type == "code" and _is_formula_only_line(line):
            continue
        kept_lines.append(line)

    return "\n".join(kept_lines)


def count_explanation_words(text: str, question_type: QuestionType = "explain") -> tuple[int, int]:
    """
    Return ``(explanation_word_count, total_word_count)``.

    For numerical, derivation, and code questions, code/formula lines are excluded
    from ``explanation_word_count`` while still counted in ``total_word_count``.
    """
    total_words = len(_WORD_RE.findall(text or ""))
    if question_type not in _EXCLUDED_TYPES:
        return total_words, total_words

    prose_only = strip_code_and_formulas(text or "", question_type)
    explanation_words = len(_WORD_RE.findall(prose_only))
    return explanation_words, total_words


def is_within_range(word_count: int, word_range: WordRange) -> bool:
    """Check whether ``word_count`` falls inclusively within [min_words, max_words]."""
    return word_range.min_words <= word_count <= word_range.max_words


def distance_to_range(word_count: int, word_range: WordRange) -> int:
    """Return distance outside [min_words, max_words] (0 when inside range)."""
    if word_count < word_range.min_words:
        return word_range.min_words - word_count
    if word_count > word_range.max_words:
        return word_count - word_range.max_words
    return 0


def estimate_handwritten_lines(total_word_count: int, words_per_line: int = 11) -> int:
    """Estimate handwritten notebook lines required (~10-12 words per line)."""
    if total_word_count <= 0:
        return 0
    return max(1, math.ceil(total_word_count / max(1, words_per_line)))
