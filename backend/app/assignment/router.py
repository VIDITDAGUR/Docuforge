"""FastAPI routes for the marks-based assignment answer generator."""

from pathlib import Path
import tempfile
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from ..config import ASSIGNMENT_MAX_UPLOAD_MB, GEMINI_MODEL, get_gemini_api_key
from ..security import cleanup_dir, safe_stem
from .exporter import export_answers_to_docx, export_answers_to_pdf
from .file_ingest import extract_assignment_input, save_validated_assignment_upload
from .generator import (
    enqueue_generation_job,
    generate_single_answer,
    get_generation_job,
)
from .models import ExportRequest, GenerationRequest, ParseResponse, RegenerateRequest
from .presets import get_preset, load_preset_catalog
from .question_parser import parse_assignment_questions

router = APIRouter(prefix="/api/assignments", tags=["assignments"])

AVAILABLE_MODELS = [
    {"id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash (Recommended)"},
    {"id": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash-Lite (Fast / High-Quota)"},
    {"id": "gemini-3.6-flash", "label": "Gemini 3.6 Flash"},
    {"id": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"},
    {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
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
