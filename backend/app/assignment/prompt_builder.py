"""Prompt templates for per-question answer generation and word-count rewrite retries."""

from .length_validator import WordRange
from .models import AssignmentQuestion, CoursePreset


def build_system_prompt(course_name: str) -> str:
    """Build the system instruction tailored to a course preset."""
    return (
        f"You are helping a {course_name} student write answers for a notebook assignment. "
        "Write in simple, clear student-style English. Be accurate. "
        "Output plain text only: no markdown symbols, no emojis, no greetings, no \"Here is your answer\"."
    )


def build_user_prompt(
    question: AssignmentQuestion,
    preset: CoursePreset,
    subject_hint: str,
    word_range: WordRange,
) -> str:
    """Build the structured prompt encoding marks-based length and course style rules."""
    marks_val = int(question.marks) if question.marks and float(question.marks).is_integer() else question.marks
    subject_line = subject_hint.strip() or "General"

    extra_rules: list[str] = []
    if question.marks is not None and question.marks <= 1:
        extra_rules.append(
            "Special length note: Because this question is 1 mark or less, keep the answer to 1-2 crisp sentences."
        )
    if question.type in ("numerical", "derivation", "code"):
        extra_rules.append(
            f"Special {question.type} rule: The {word_range.min_words}-{word_range.max_words} word target applies "
            "to the explanation text only. Calculations, formulas, and code lines must be kept complete and accurate on separate lines."
        )

    extra_block = ("\n" + "\n".join(extra_rules)) if extra_rules else ""

    return (
        f"Course: {preset.course_name}\n"
        f"Subject hint: {subject_line}\n"
        f"Question ({marks_val} marks, type: {question.type}): {question.text}\n"
        f"Required length: between {word_range.min_words} and {word_range.max_words} words "
        f"(aim for about {word_range.target_words}).\n"
        "Structure by marks:\n"
        "  - 1-2 marks: a direct definition or answer in 1-3 sentences.\n"
        "  - 3-5 marks: short introduction plus 3-5 key points with one line of explanation each.\n"
        "  - 6-8 marks: introduction, 4-6 explained points, an example, and a one-line conclusion.\n"
        "  - 9-15 marks: introduction, sub-headed sections, explanation, an example or a diagram description "
        "(describe what to draw and its labels), and a conclusion.\n"
        f"Style rules for this course: {preset.tone_style_notes} {preset.answer_format_rules}\n"
        "Keep it easy to write by hand: short paragraphs or numbered points, no tables unless the question asks for a comparison.\n"
        f"Return only the answer text.{extra_block}"
    )


def build_retry_prompt(
    word_count: int,
    target_words: int,
    min_words: int,
    max_words: int,
) -> str:
    """Build the exact word-count correction prompt used for the single allowed retry."""
    return (
        f"Your previous answer had {word_count} words. Rewrite it to about {target_words} words "
        f"(allowed {min_words}-{max_words}), keeping the same content quality. "
        "Remember: output plain text only with no markdown or preamble."
    )
