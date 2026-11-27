"""Structured question and marks parsing backed by Gemini JSON schema + regex post-processing."""

from dataclasses import dataclass, field
import logging
import re
from typing import Any, Optional
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, Field

from ..config import GEMINI_MODEL, get_gemini_api_key
from .file_ingest import ExtractedAssignmentInput
from .generator import call_with_exponential_backoff
from .models import AssignmentQuestion, QuestionType, TokenUsage

logger = logging.getLogger("docuforge.assignment.parser")


class RawParsedQuestion(BaseModel):
    """Schema item expected from Gemini structured JSON parsing."""

    id: str = ""
    number: str = "1"
    part: str = ""
    text: str
    marks: Optional[float] = None
    split_marks: Optional[list[float]] = None
    type: QuestionType = "explain"
    confidence: float = Field(default=0.9, ge=0.0, le=1.0)


class RawParsedAssignment(BaseModel):
    """Top-level schema expected from Gemini structured JSON parsing."""

    questions: list[RawParsedQuestion]


@dataclass
class MarksDetectionResult:
    """Result returned by regex-based marks detection on a question string."""

    total: Optional[float] = None
    parts: list[float] = field(default_factory=list)
    is_compound: bool = False
    matched_text: Optional[str] = None


# Compound patterns like "(2+3)", "[2 + 3 marks]", "2+3M", "Marks: 2+3"
_COMPOUND_MARKS_RE = re.compile(
    r"(?:\bmarks?\s*[:=\-]?\s*|[\(\[])\s*"
    r"(\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)+)"
    r"\s*(?:marks?|pts?|m)?\s*[\)\]]?"
    r"|\b(\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)+)\s*(?:marks?|m)\b",
    re.IGNORECASE,
)

# Labeled explicit marks: "Marks: 10", "Marks - 5", "[5 marks]", "(5 Marks)", "5M"
_EXPLICIT_MARKS_RE = re.compile(
    r"(?:"
    r"\bmarks?\s*[:=\-]\s*(\d+(?:\.\d+)?)\b"
    r"|[\(\[]\s*(\d+(?:\.\d+)?)\s*(?:marks?|mark|pts?|points?|m)\s*[\)\]]"
    r"|\b(\d+(?:\.\d+)?)\s*(?:marks?|mark)\b"
    r"|(?<!\w)(\d+(?:\.\d+)?)\s*M\b"
    r")",
    re.IGNORECASE,
)

# Trailing bracketed/parenthesized numeric marks at end of question/line: "...? (5)" or "... [10]"
_TRAILING_BRACKET_MARKS_RE = re.compile(
    r"(?:\s|^)[\(\[]\s*(\d+(?:\.\d+)?)\s*[\)\]]\s*$"
)

# Leading sub-part split markers inside a single compound prompt: "(a) ... (b) ..." or "i) ... ii) ..."
_SUBPART_SPLIT_RE = re.compile(
    r"(?:^|\s)(?:\(([a-z]|[ivx]{1,4})\)|([a-z]|[ivx]{1,4})\))\s+",
    re.IGNORECASE,
)


def _clean_number(val: float) -> float | int:
    return int(val) if float(val).is_integer() else round(val, 2)


def detect_marks_in_text(text: str) -> MarksDetectionResult:
    """
    Detect marks annotations such as '(5)', '[5 marks]', '5M', '(2+3)', or 'Marks: 10'.

    Compound expressions like '(2+3)' preserve individual split values in ``parts``
    as well as their sum in ``total``.
    """
    if not text or not text.strip():
        return MarksDetectionResult()

    stripped = text.strip()

    comp_match = _COMPOUND_MARKS_RE.search(stripped)
    if comp_match:
        expr = comp_match.group(1) or comp_match.group(2) or ""
        nums = [float(x.strip()) for x in expr.split("+") if x.strip()]
        if len(nums) >= 2 and all(n > 0 for n in nums):
            return MarksDetectionResult(
                total=float(_clean_number(sum(nums))),
                parts=[float(_clean_number(n)) for n in nums],
                is_compound=True,
                matched_text=comp_match.group(0).strip(),
            )

    exp_match = _EXPLICIT_MARKS_RE.search(stripped)
    if exp_match:
        raw_val = next((g for g in exp_match.groups() if g is not None), None)
        if raw_val is not None:
            val = float(raw_val)
            if 0 < val <= 100:
                return MarksDetectionResult(
                    total=float(_clean_number(val)),
                    parts=[float(_clean_number(val))],
                    is_compound=False,
                    matched_text=exp_match.group(0).strip(),
                )

    trail_match = _TRAILING_BRACKET_MARKS_RE.search(stripped)
    if trail_match:
        val = float(trail_match.group(1))
        if 0 < val <= 100:
            return MarksDetectionResult(
                total=float(_clean_number(val)),
                parts=[float(_clean_number(val))],
                is_compound=False,
                matched_text=trail_match.group(0).strip(),
            )

    return MarksDetectionResult()


def _split_subpart_segments(text: str, expected_count: int) -> list[tuple[str, str]] | None:
    """Try splitting a compound question string into labelled sub-parts matching expected_count."""
    matches = list(_SUBPART_SPLIT_RE.finditer(text))
    if len(matches) != expected_count:
        return None

    segments: list[tuple[str, str]] = []
    prefix = text[: matches[0].start()].strip()
    for idx, match in enumerate(matches):
        label = (match.group(1) or match.group(2) or "").strip()
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        body = text[start:end].strip(" \n\t;-")
        # Strip redundant trailing compound mark annotation if present on last item
        if idx == len(matches) - 1:
            body = _COMPOUND_MARKS_RE.sub("", body).strip(" \n\t;-")
        full_part_text = f"{prefix} {body}".strip() if (prefix and idx == 0) else body
        if not full_part_text:
            return None
        segments.append((label, full_part_text))

    return segments if len(segments) == expected_count else None


def _build_question_id(number: str, part: str, used_ids: set[str]) -> str:
    clean_num = re.sub(r"[^A-Za-z0-9]", "", str(number or "").strip()) or "1"
    clean_part = re.sub(r"[^A-Za-z0-9]", "", str(part or "").strip())
    base = f"Q{clean_num}{clean_part}" if clean_part else f"Q{clean_num}"
    candidate = base
    suffix = 2
    while candidate in used_ids:
        candidate = f"{base}_{suffix}"
        suffix += 1
    used_ids.add(candidate)
    return candidate


def _evaluate_review_status(
    text: str, marks: Optional[float], confidence: float
) -> tuple[bool, Optional[str]]:
    reasons: list[str] = []
    if marks is None or marks <= 0:
        reasons.append("Missing or invalid marks")
    if confidence < 0.75:
        reasons.append(f"Low parser confidence ({confidence:.2f})")
    if len(text.strip()) < 6:
        reasons.append("Incomplete question text")
    if reasons:
        return True, "; ".join(reasons)
    return False, None


def normalize_parsed_questions(raw_questions: list[RawParsedQuestion]) -> list[AssignmentQuestion]:
    """
    Post-process parsed questions: resolve compound '(2+3)' marks (split sub-parts
    when the text clearly splits, otherwise sum), fill regex-detected marks if omitted,
    assign canonical IDs, and flag missing/low-confidence items with ``needs_review``.
    """
    result: list[AssignmentQuestion] = []
    used_ids: set[str] = set()

    for idx, item in enumerate(raw_questions, start=1):
        number = str(item.number or idx).strip()
        part = str(item.part or "").strip()
        text = " ".join((item.text or "").split())
        if not text:
            continue

        detected = detect_marks_in_text(text)

        # Resolve compound marks such as "(2+3)"
        split_vals: list[float] = []
        if item.split_marks and len(item.split_marks) >= 2:
            split_vals = [float(x) for x in item.split_marks if x > 0]
        elif detected.is_compound and len(detected.parts) >= 2:
            split_vals = detected.parts

        if split_vals and not part:
            split_parts = _split_subpart_segments(text, len(split_vals))
            if split_parts:
                for (sub_label, sub_text), sub_marks in zip(split_parts, split_vals):
                    qid = _build_question_id(number, sub_label, used_ids)
                    needs_rev, reason = _evaluate_review_status(
                        sub_text, sub_marks, item.confidence
                    )
                    result.append(
                        AssignmentQuestion(
                            id=qid,
                            number=number,
                            part=sub_label,
                            text=sub_text,
                            marks=float(_clean_number(sub_marks)),
                            type=item.type,
                            confidence=item.confidence,
                            needs_review=needs_rev,
                            review_reason=reason,
                        )
                    )
                continue

        # Not split -> resolve single mark (sum compound if needed)
        marks = item.marks
        if split_vals and (marks is None or marks <= 0):
            marks = sum(split_vals)
        elif split_vals and marks is not None:
            # Ensure summed marks if item marks wasn't already summed and matches a single segment accidentally
            if len(split_vals) >= 2 and abs(marks - sum(split_vals)) > 0.01 and abs(marks - split_vals[0]) < 0.01:
                marks = sum(split_vals)
        elif (marks is None or marks <= 0) and detected.total is not None:
            marks = detected.total

        if marks is not None and marks <= 0:
            marks = None

        normalized_marks = float(_clean_number(marks)) if marks is not None else None
        needs_rev, reason = _evaluate_review_status(text, normalized_marks, item.confidence)
        qid = _build_question_id(number, part, used_ids)

        result.append(
            AssignmentQuestion(
                id=qid,
                number=number,
                part=part,
                text=text,
                marks=normalized_marks,
                type=item.type,
                confidence=item.confidence,
                needs_review=needs_rev,
                review_reason=reason,
            )
        )

    return result


_PARSE_INSTRUCTIONS = """Extract all assignment/exam questions from the provided document in exact sequential order.
Rules:
1. Preserve question numbers (e.g. "1", "2") and sub-parts (e.g. "a", "b", "i", "ii") as separate entries in order.
2. Detect marks annotated in any format such as "(5)", "[5 marks]", "5M", "(2+3)", "Marks: 10", or table columns.
3. For compound marks like "(2+3)":
   - If the question clearly splits into sub-parts, create one question entry per sub-part with its corresponding mark and set split_marks to null.
   - If the text is a single combined prompt with compound marks like "(2+3)", set marks to their sum (5) and include split_marks=[2, 3].
4. If marks are missing or unreadable, set marks to null and confidence below 0.70 — do NOT guess marks silently.
5. Choose the closest type from: define, explain, compare, numerical, code, derivation, diagram, short_note, case_study, other.
6. Set confidence between 0.0 and 1.0 based on clarity of the question text and marks."""


def _extract_usage(response: Any) -> TokenUsage:
    usage = getattr(response, "usage_metadata", None)
    if not usage:
        return TokenUsage(api_calls=1)
    return TokenUsage(
        prompt_tokens=int(getattr(usage, "prompt_token_count", 0) or 0),
        candidates_tokens=int(getattr(usage, "candidates_token_count", 0) or 0),
        thoughts_tokens=int(getattr(usage, "thoughts_token_count", 0) or 0),
        total_tokens=int(getattr(usage, "total_token_count", 0) or 0),
        api_calls=1,
    )


def parse_assignment_questions(
    extracted: ExtractedAssignmentInput,
    model: Optional[str] = None,
    client: Optional[genai.Client] = None,
) -> tuple[list[AssignmentQuestion], TokenUsage]:
    """
    Parse questions and marks from extracted text or multimodal page images via Gemini JSON schema.
    """
    if client is None:
        api_key = get_gemini_api_key()
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is missing. Set GEMINI_API_KEY in your .env file before parsing assignments."
            )
        client = genai.Client(api_key=api_key)

    target_model = model or GEMINI_MODEL

    contents: list[Any] = [_PARSE_INSTRUCTIONS]
    if extracted.text:
        contents.append(f"Document content ({extracted.filename}):\n\n{extracted.text}")
    for img_bytes, mime_type in extracted.image_parts:
        contents.append(types.Part.from_bytes(data=img_bytes, mime_type=mime_type))

    try:
        response = call_with_exponential_backoff(
            lambda: client.models.generate_content(
                model=target_model,
                contents=contents,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=RawParsedAssignment,
                    temperature=0.1,
                ),
            ),
            max_tries=4,
        )
    except genai_errors.APIError as exc:
        raise RuntimeError(f"Gemini parsing failed (HTTP {exc.code}): {exc}") from exc

    parsed_payload: Optional[RawParsedAssignment] = getattr(response, "parsed", None)
    if parsed_payload is None and getattr(response, "text", None):
        parsed_payload = RawParsedAssignment.model_validate_json(response.text)

    if parsed_payload is None:
        raise RuntimeError("Gemini returned an empty response while parsing assignment questions.")

    questions = normalize_parsed_questions(parsed_payload.questions)
    usage = _extract_usage(response)
    logger.info(
        "Parsed %d questions from '%s' using %s (tokens=%d)",
        len(questions),
        extracted.filename,
        target_model,
        usage.total_tokens,
    )
    return questions, usage
