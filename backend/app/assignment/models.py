"""Pydantic data models for the marks-based assignment answer generator."""

from typing import Literal, Optional
from pydantic import BaseModel, Field

QuestionType = Literal[
    "define",
    "explain",
    "compare",
    "numerical",
    "code",
    "derivation",
    "diagram",
    "short_note",
    "case_study",
    "other",
]


class AssignmentQuestion(BaseModel):
    """Structured representation of a single parsed or reviewed assignment question."""

    id: str = Field(..., description="Identifier such as Q1 or Q1a.")
    number: str = Field(..., description="Main question number such as '1' or '2'.")
    part: str = Field(default="", description="Optional sub-part label such as 'a' or 'ii'.")
    text: str = Field(..., description="Question text.")
    marks: Optional[float] = Field(default=None, description="Assigned marks, if detected.")
    type: QuestionType = Field(default="explain", description="Question category.")
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    needs_review: bool = Field(default=False)
    review_reason: Optional[str] = Field(default=None)


class CoursePreset(BaseModel):
    """Tone, formatting, and word-per-mark rules for a specific course."""

    id: str
    course_name: str
    section: str
    tone_style_notes: str
    answer_format_rules: str
    words_per_mark_min: int = Field(default=30, ge=5, le=200)
    words_per_mark_max: int = Field(default=40, ge=5, le=250)
    explicit_overrides: dict[str, list[int]] = Field(default_factory=dict)
    is_custom: bool = Field(default=False)


class PresetCatalog(BaseModel):
    """Top-level configuration loaded from presets_config.json."""

    default_words_per_mark_min: int = Field(default=30, ge=5, le=200)
    default_words_per_mark_max: int = Field(default=40, ge=5, le=250)
    explicit_overrides: dict[str, list[int]] = Field(default_factory=dict)
    sections: list[str]
    presets: list[CoursePreset]


class TokenUsage(BaseModel):
    """Cumulative Gemini token telemetry for a parsing or generation run."""

    prompt_tokens: int = 0
    candidates_tokens: int = 0
    thoughts_tokens: int = 0
    total_tokens: int = 0
    api_calls: int = 0
    cache_hits: int = 0


class ParseResponse(BaseModel):
    """Response payload returned after extracting and parsing an uploaded assignment."""

    filename: str
    extraction_method: str
    page_count: int
    questions: list[AssignmentQuestion]
    token_usage: TokenUsage = Field(default_factory=TokenUsage)


class StudentProfile(BaseModel):
    """Student metadata stamped in exported PDF/DOCX page headers."""

    name: str = ""
    roll_no: str = ""


class GenerationRequest(BaseModel):
    """Request payload to start background answer generation for confirmed questions."""

    questions: list[AssignmentQuestion]
    preset_id: str
    subject_hint: str = ""
    words_per_mark_min: Optional[int] = Field(default=None, ge=5, le=200)
    words_per_mark_max: Optional[int] = Field(default=None, ge=5, le=250)
    model: Optional[str] = None
    concurrency: int = Field(default=2, ge=1, le=3)
    use_cache: bool = True


class RegenerateRequest(BaseModel):
    """Request payload to regenerate a single answer without re-running the batch."""

    question: AssignmentQuestion
    preset_id: str
    subject_hint: str = ""
    words_per_mark_min: Optional[int] = Field(default=None, ge=5, le=200)
    words_per_mark_max: Optional[int] = Field(default=None, ge=5, le=250)
    model: Optional[str] = None
    bypass_cache: bool = True


class GeneratedAnswerItem(BaseModel):
    """Generated answer paired with word-count metrics and notebook line estimates."""

    question_id: str
    number: str
    part: str = ""
    question_text: str
    marks: float
    type: QuestionType
    answer: str
    explanation_word_count: int
    total_word_count: int
    min_words: int
    max_words: int
    target_words: int
    estimated_lines: int
    length_warning: bool = False
    attempts: int = 1
    cached: bool = False
    error: Optional[str] = None


class ExportRequest(BaseModel):
    """Request payload for rendering notebook-ready PDF or DOCX downloads."""

    title: str = "Assignment Answers"
    course_name: str = ""
    subject_hint: str = ""
    profile: StudentProfile = Field(default_factory=StudentProfile)
    items: list[GeneratedAnswerItem]


class StreamAnswerRequest(BaseModel):
    """Request payload to stream a single answer or contextual follow-up over SSE."""

    question: AssignmentQuestion
    preset_id: str
    subject_hint: str = ""
    words_per_mark_min: Optional[int] = Field(default=None, ge=5, le=200)
    words_per_mark_max: Optional[int] = Field(default=None, ge=5, le=250)
    target_min_words: Optional[int] = Field(default=None, ge=10, le=5000)
    target_max_words: Optional[int] = Field(default=None, ge=10, le=5000)
    model: Optional[str] = None
    bypass_cache: bool = False
    previous_answer: Optional[str] = None
    followup_instruction: Optional[str] = None
    conversation_context: list[str] = Field(default_factory=list)


class ChatSingleRequest(BaseModel):
    """Request to generate an answer for a free-form typed question."""

    question_text: str
    marks: float = Field(default=5.0, ge=0.5, le=100.0)
    question_type: str = "auto"
    preset_id: str
    subject_hint: str = ""
    words_per_mark_min: Optional[int] = Field(default=None, ge=5, le=200)
    words_per_mark_max: Optional[int] = Field(default=None, ge=5, le=250)
    model: Optional[str] = None
    bypass_cache: bool = False
