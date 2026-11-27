import tempfile
from pathlib import Path
import re
from typing import List
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .config import ALLOWED_ORIGINS, MAX_UPLOAD_MB, PPTX_MAX_UPLOAD_MB
from .security import cleanup_dir, safe_stem, save_validated_upload
from .converters.pdf_to_word import convert_pdf_to_docx
from .converters.word_to_pdf import convert_docx_to_pdf
from .converters.pdf_to_pptx import convert_pdf_to_pptx
from .converters.editor_pdf import EditorBlock, render_editor_blocks_to_pdf
from .converters.compressors import compress_docx, compress_pdf
from .converters.libreoffice import find_libreoffice
from .services.pptx_viewer_service import (
    enqueue_pptx_job,
    get_pptx_job,
    get_slide_image_path,
    save_and_hash_pptx_upload,
)

SLIDE_FILENAME_RE = re.compile(r"^(\d+)\.png$")

app = FastAPI(
    title="DOCUFORGE API",
    description="Stateless document conversion, compression, and high-fidelity PPTX viewer API for DOCUFORGE.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["X-Original-Bytes", "X-Compressed-Bytes", "Content-Disposition"],
)


@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "service": "docuforge-api",
        "max_upload_mb": MAX_UPLOAD_MB,
        "pptx_max_upload_mb": PPTX_MAX_UPLOAD_MB,
        "libreoffice_available": bool(find_libreoffice()),
    }


@app.post("/api/upload")
async def upload_pptx_for_viewer(file: UploadFile = File(...)):
    temp_dir, input_path, file_hash, _ = await save_and_hash_pptx_upload(file)
    return enqueue_pptx_job(temp_dir, input_path, file_hash)


@app.get("/api/jobs/{job_id}")
def get_pptx_job_status(job_id: str):
    job = get_pptx_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.get("/api/slides/{file_hash}/{slide_filename}")
def get_slide_png(file_hash: str, slide_filename: str):
    match = SLIDE_FILENAME_RE.match(slide_filename)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid slide filename.")
    slide_num = int(match.group(1))
    slide_path = get_slide_image_path(file_hash, slide_num)
    if not slide_path:
        raise HTTPException(status_code=404, detail="Slide image not found.")
    return FileResponse(
        path=slide_path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.post("/api/convert/pdf-to-word")
async def pdf_to_word_endpoint(file: UploadFile = File(...)):
    temp_dir, input_path = await save_validated_upload(file, ".pdf")
    out_name = f"{safe_stem(file.filename)}.docx"
    output_path = temp_dir / out_name
    try:
        convert_pdf_to_docx(input_path, output_path)
    except Exception as exc:
        cleanup_dir(temp_dir)
        raise HTTPException(status_code=422, detail=f"PDF to Word conversion failed: {exc}") from exc

    return FileResponse(
        path=output_path,
        filename=out_name,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        background=BackgroundTask(cleanup_dir, temp_dir),
    )


@app.post("/api/convert/word-to-pdf")
async def word_to_pdf_endpoint(file: UploadFile = File(...)):
    temp_dir, input_path = await save_validated_upload(file, ".docx")
    out_name = f"{safe_stem(file.filename)}.pdf"
    output_path = temp_dir / out_name
    try:
        convert_docx_to_pdf(input_path, output_path)
    except Exception as exc:
        cleanup_dir(temp_dir)
        raise HTTPException(status_code=422, detail=f"Word to PDF conversion failed: {exc}") from exc

    return FileResponse(
        path=output_path,
        filename=out_name,
        media_type="application/pdf",
        background=BackgroundTask(cleanup_dir, temp_dir),
    )


@app.post("/api/convert/pdf-to-pptx")
async def pdf_to_pptx_endpoint(file: UploadFile = File(...)):
    temp_dir, input_path = await save_validated_upload(file, ".pdf")
    out_name = f"{safe_stem(file.filename)}.pptx"
    output_path = temp_dir / out_name
    try:
        convert_pdf_to_pptx(input_path, output_path)
    except Exception as exc:
        cleanup_dir(temp_dir)
        raise HTTPException(status_code=422, detail=f"PDF to PowerPoint conversion failed: {exc}") from exc

    return FileResponse(
        path=output_path,
        filename=out_name,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        background=BackgroundTask(cleanup_dir, temp_dir),
    )


class EditorExportRequest(BaseModel):
    title: str = "document"
    blocks: List[EditorBlock]


@app.post("/api/export/editor-pdf")
async def export_editor_pdf_endpoint(payload: EditorExportRequest):
    temp_dir = Path(tempfile.mkdtemp(prefix="docuforge_ed_"))
    out_name = f"{safe_stem(payload.title, 'document')}.pdf"
    output_path = temp_dir / out_name
    try:
        render_editor_blocks_to_pdf(payload.blocks, output_path)
    except Exception as exc:
        cleanup_dir(temp_dir)
        raise HTTPException(status_code=422, detail=f"PDF export failed: {exc}") from exc

    return FileResponse(
        path=output_path,
        filename=out_name,
        media_type="application/pdf",
        background=BackgroundTask(cleanup_dir, temp_dir),
    )


@app.post("/api/compress/pdf")
async def compress_pdf_endpoint(
    file: UploadFile = File(...),
    compression: int = Form(50),
):
    temp_dir, input_path = await save_validated_upload(file, ".pdf")
    out_name = f"{safe_stem(file.filename)}-compressed.pdf"
    output_path = temp_dir / out_name
    try:
        orig_bytes, new_bytes = compress_pdf(input_path, output_path, compression)
    except Exception as exc:
        cleanup_dir(temp_dir)
        raise HTTPException(status_code=422, detail=f"PDF compression failed: {exc}") from exc

    return FileResponse(
        path=output_path,
        filename=out_name,
        media_type="application/pdf",
        headers={
            "X-Original-Bytes": str(orig_bytes),
            "X-Compressed-Bytes": str(new_bytes),
        },
        background=BackgroundTask(cleanup_dir, temp_dir),
    )


@app.post("/api/compress/word")
async def compress_word_endpoint(
    file: UploadFile = File(...),
    compression: int = Form(50),
):
    temp_dir, input_path = await save_validated_upload(file, ".docx")
    out_name = f"{safe_stem(file.filename)}-compressed.docx"
    output_path = temp_dir / out_name
    try:
        orig_bytes, new_bytes = compress_docx(input_path, output_path, compression)
    except Exception as exc:
        cleanup_dir(temp_dir)
        raise HTTPException(status_code=422, detail=f"Word compression failed: {exc}") from exc

    return FileResponse(
        path=output_path,
        filename=out_name,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "X-Original-Bytes": str(orig_bytes),
            "X-Compressed-Bytes": str(new_bytes),
        },
        background=BackgroundTask(cleanup_dir, temp_dir),
    )
