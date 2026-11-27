"""FastAPI routes for the marks-based assignment answer generator."""

from pathlib import Path
import tempfile
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask

from ..config import ASSIGNMENT_MAX_UPLOAD_MB, GEMINI_MODEL, get_gemini_api_key
from ..security import cleanup_dir, safe_stem
from .exporter import export_answers_to_docx, export_answers_to_pdf
from .file_ingest import extract_assignment_input, save_validated_assignment_upload
from .generator import (
    enqueue_generation_job,
    generate_single_answer,
    get_generation_job,
    stream_answer_sse,
)
from .models import (
    AssignmentQuestion,
    ChatSingleRequest,
    ExportRequest,
    GenerationRequest,
    ParseResponse,
    QuestionType,
    RegenerateRequest,
    StreamAnswerRequest,
)
from .presets import get_preset, load_preset_catalog
from .prompt_builder import infer_question_type
from .question_parser import parse_assignment_questions

router = APIRouter(prefix="/api/assignments", tags=["assignments"])

AVAILABLE_MODELS = [
    {"id": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash-Lite (Fast / Recommended)"},
    {"id": "gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash-Lite (High-Quota)"},
    {"id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash"},
    {"id": "gemini-3.6-flash", "label": "Gemini 3.6 Flash"},
    {"id": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"},
]


@router.get("/presets")
def get_assignment_presets():
    """Return section-grouped course presets, word-per-mark defaults, and Gemini configuration status."""
    catalog = load_preset_catalog()
    return {
        "default_words_per_mark_min": catalog.default_words_per_mark_min,
        "default_words_per_mark_max": catalog.default_words_per_mark_max,
        "explicit_overrides": catalog.explicit_overrides,
        "sections": catalog.sections,
        "presets": [p.model_dump() for p in catalog.presets],
        "default_model": GEMINI_MODEL,
        "available_models": AVAILABLE_MODELS,
        "max_upload_mb": ASSIGNMENT_MAX_UPLOAD_MB,
        "gemini_configured": bool(get_gemini_api_key()),
    }


@router.post("/parse", response_model=ParseResponse)
async def parse_assignment_endpoint(file: UploadFile = File(...), model: str | None = None):
    """Validate an uploaded PDF/DOCX/image file, extract its content, and parse structured questions."""
    temp_dir, saved_path, ext, orig_name = await save_validated_assignment_upload(file)
    try:
        extracted = extract_assignment_input(saved_path, ext, orig_name)
        questions, usage = parse_assignment_questions(extracted, model=model)
        return ParseResponse(
            filename=orig_name,
            extraction_method=extracted.extraction_method,
            page_count=extracted.page_count,
            questions=questions,
            token_usage=usage,
        )
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=422, detail=f"Failed to parse assignment questions: {exc}"
        ) from exc
    finally:
        cleanup_dir(temp_dir)


@router.post("/generate")
def start_generation_endpoint(payload: GenerationRequest):
    """Start background answer generation for confirmed questions."""
    if not get_gemini_api_key():
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY is not configured on the server. Set GEMINI_API_KEY in .env.",
        )
    try:
        return enqueue_generation_job(payload)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/jobs/{job_id}")
def get_generation_job_endpoint(job_id: str):
    """Poll progress and results of an assignment answer generation job."""
    job = get_generation_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Generation job not found.")
    return job


@router.post("/regenerate")
def regenerate_single_answer_endpoint(payload: RegenerateRequest):
    """Regenerate a single question answer without re-running the whole batch."""
    if not get_gemini_api_key():
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY is not configured on the server. Set GEMINI_API_KEY in .env.",
        )
    try:
        preset = get_preset(payload.preset_id)
        item, usage = generate_single_answer(
            question=payload.question,
            preset=preset,
            subject_hint=payload.subject_hint,
            words_per_mark_min=payload.words_per_mark_min,
            words_per_mark_max=payload.words_per_mark_max,
            model=payload.model,
            bypass_cache=payload.bypass_cache,
        )
        return {"item": item.model_dump(), "token_usage": usage.model_dump()}
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/export/pdf")
def export_assignment_pdf_endpoint(payload: ExportRequest):
    """Export generated assignment Q&As as a notebook-ready PDF with student page headers."""
    if not payload.items:
        raise HTTPException(status_code=400, detail="No answers provided to export.")
    temp_dir = Path(tempfile.mkdtemp(prefix="docuforge_assign_pdf_"))
    out_name = f"{safe_stem(payload.title, 'assignment_answers')}.pdf"
    out_path = temp_dir / out_name
    try:
        export_answers_to_pdf(payload, out_path)
    except Exception as exc:
        cleanup_dir(temp_dir)
        raise HTTPException(status_code=422, detail=f"PDF export failed: {exc}") from exc

    return FileResponse(
        path=out_path,
        filename=out_name,
        media_type="application/pdf",
        background=BackgroundTask(cleanup_dir, temp_dir),
    )


@router.post("/export/docx")
def export_assignment_docx_endpoint(payload: ExportRequest):
    """Export generated assignment Q&As as a clean Word (.docx) with student page headers."""
    if not payload.items:
        raise HTTPException(status_code=400, detail="No answers provided to export.")
    temp_dir = Path(tempfile.mkdtemp(prefix="docuforge_assign_docx_"))
    out_name = f"{safe_stem(payload.title, 'assignment_answers')}.docx"
    out_path = temp_dir / out_name
    try:
        export_answers_to_docx(payload, out_path)
    except Exception as exc:
        cleanup_dir(temp_dir)
        raise HTTPException(status_code=422, detail=f"DOCX export failed: {exc}") from exc

    return FileResponse(
        path=out_path,
        filename=out_name,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        background=BackgroundTask(cleanup_dir, temp_dir),
    )


# ---------------------------------------------------------------------------
# Chat / Streaming endpoints
# ---------------------------------------------------------------------------


@router.post("/chat/stream")
async def stream_single_answer_endpoint(payload: StreamAnswerRequest):
    """Stream a single question answer or contextual follow-up as Server-Sent Events (SSE)."""
    if not get_gemini_api_key():
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY is not configured on the server. Set GEMINI_API_KEY in .env.",
        )
    try:
        preset = get_preset(payload.preset_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if payload.question.marks is None or payload.question.marks <= 0:
        raise HTTPException(
            status_code=422, detail="Question must have positive marks to generate an answer."
        )

    model_name = (payload.model or GEMINI_MODEL).strip() or GEMINI_MODEL

    return StreamingResponse(
        stream_answer_sse(
            question=payload.question,
            preset=preset,
            subject_hint=payload.subject_hint,
            words_per_mark_min=payload.words_per_mark_min,
            words_per_mark_max=payload.words_per_mark_max,
            target_min_words=payload.target_min_words,
            target_max_words=payload.target_max_words,
            model_name=model_name,
            bypass_cache=payload.bypass_cache,
            previous_answer=payload.previous_answer,
            followup_instruction=payload.followup_instruction,
            conversation_context=payload.conversation_context,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


_VALID_QUESTION_TYPES: set[str] = {
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
}


@router.post("/chat/single")
async def chat_single_question_endpoint(payload: ChatSingleRequest):
    """Stream an answer for a free-form typed question as SSE."""
    if not get_gemini_api_key():
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY is not configured on the server. Set GEMINI_API_KEY in .env.",
        )
    try:
        preset = get_preset(payload.preset_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    resolved_type: QuestionType = (
        payload.question_type  # type: ignore[assignment]
        if payload.question_type in _VALID_QUESTION_TYPES
        else infer_question_type(payload.question_text)
    )
    question = AssignmentQuestion(
        id="Q_chat",
        number="1",
        part="",
        text=payload.question_text,
        marks=payload.marks,
        type=resolved_type,
        confidence=1.0,
        needs_review=False,
    )
    model_name = (payload.model or GEMINI_MODEL).strip() or GEMINI_MODEL

    return StreamingResponse(
        stream_answer_sse(
            question=question,
            preset=preset,
            subject_hint=payload.subject_hint,
            words_per_mark_min=payload.words_per_mark_min,
            words_per_mark_max=payload.words_per_mark_max,
            model_name=model_name,
            bypass_cache=payload.bypass_cache,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
