"""Input file validation and content extraction for PDF, DOCX, and image assignments."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
import zipfile
from docx import Document
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph
from fastapi import HTTPException, UploadFile
from PIL import Image
import pymupdf as fitz

from ..config import ASSIGNMENT_MAX_UPLOAD_BYTES, ASSIGNMENT_MAX_UPLOAD_MB
from ..security import cleanup_dir

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".png", ".jpg", ".jpeg"}
MAX_MULTIMODAL_PDF_PAGES = 20


@dataclass
class ExtractedAssignmentInput:
    """Normalized extracted payload passed to the question parser."""

    filename: str
    ext: str
    extraction_method: Literal[
        "pymupdf_text",
        "pymupdf_multimodal",
        "python_docx",
        "image_multimodal",
    ]
    page_count: int
    text: str = ""
    image_parts: list[tuple[bytes, str]] = field(default_factory=list)


def validate_assignment_signature(path: Path, ext: str) -> None:
    """Verify magic bytes and container integrity before parsing an uploaded assignment."""
    with open(path, "rb") as fh:
        header = fh.read(16)

    if ext == ".pdf":
        if not header.startswith(b"%PDF-"):
            raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF.")
        try:
            with fitz.open(path) as doc:
                if len(doc) == 0:
                    raise HTTPException(status_code=400, detail="Uploaded PDF has no pages.")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Corrupted PDF file: {exc}") from exc
        return

    if ext == ".docx":
        if not header.startswith(b"PK\x03\x04"):
            raise HTTPException(status_code=400, detail="Uploaded file is not a valid DOCX archive.")
        try:
            with zipfile.ZipFile(path, "r") as zf:
                if "word/document.xml" not in set(zf.namelist()):
                    raise HTTPException(
                        status_code=400,
                        detail="Invalid DOCX structure: missing word/document.xml.",
                    )
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="Corrupted DOCX file.") from exc
        return

    if ext == ".png":
        if not header.startswith(b"\x89PNG\r\n\x1a\n"):
            raise HTTPException(status_code=400, detail="Uploaded file is not a valid PNG image.")
    elif ext in {".jpg", ".jpeg"}:
        if not header.startswith(b"\xff\xd8\xff"):
            raise HTTPException(status_code=400, detail="Uploaded file is not a valid JPEG image.")

    try:
        with Image.open(path) as img:
            img.verify()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Corrupted image file: {exc}") from exc


async def save_validated_assignment_upload(upload: UploadFile) -> tuple[Path, Path, str, str]:
    """
    Validate extension and 20 MB upload cap while streaming to an isolated temp dir.

    Returns (temp_dir, saved_path, ext, original_filename).
    """
    import tempfile

    orig_name = upload.filename or "assignment"
    ext = Path(orig_name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported file type '{ext or 'none'}'. "
                "Accepted formats: PDF (.pdf), Word (.docx), PNG (.png), JPG (.jpg, .jpeg)."
            ),
        )

    temp_dir = Path(tempfile.mkdtemp(prefix="docuforge_assign_"))
    target_path = temp_dir / f"assignment{ext}"
    total_bytes = 0

    try:
        with open(target_path, "wb") as out_f:
            while True:
                chunk = await upload.read(1024 * 256)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > ASSIGNMENT_MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds maximum allowed size of {ASSIGNMENT_MAX_UPLOAD_MB} MB.",
                    )
                out_f.write(chunk)

        if total_bytes == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        validate_assignment_signature(target_path, ext)
        return temp_dir, target_path, ext, orig_name
    except Exception:
        cleanup_dir(temp_dir)
        raise


def _extract_docx_text(path: Path) -> str:
    """Extract paragraphs and table rows in visual document order from a DOCX file."""
    doc = Document(path)
    lines: list[str] = []

    for child in doc.element.body.iterchildren():
        if isinstance(child, CT_P):
            para = Paragraph(child, doc)
            text = para.text.strip()
            if text:
                lines.append(text)
        elif isinstance(child, CT_Tbl):
            table = Table(child, doc)
            for row in table.rows:
                cells = [" ".join(c.text.split()) for c in row.cells]
                row_text = " | ".join(c for c in cells if c)
                if row_text:
                    lines.append(row_text)

    combined = "\n".join(lines).strip()
    if not combined:
        raise HTTPException(
            status_code=422,
            detail=(
                "No selectable text was found in this Word document. "
                "If it contains embedded images of questions, upload it as an image or scanned PDF."
            ),
        )
    return combined


def _extract_pdf_content(path: Path, filename: str) -> ExtractedAssignmentInput:
    """Extract selectable PDF text via PyMuPDF, or render scanned pages as PNGs for Gemini."""
    with fitz.open(path) as doc:
        page_count = len(doc)
        page_texts: list[str] = []
        non_empty_pages = 0

        for idx, page in enumerate(doc, start=1):
            raw_text = (page.get_text("text") or "").strip()
            non_ws = len("".join(raw_text.split()))
            if non_ws >= 20:
                non_empty_pages += 1
            if raw_text:
                page_texts.append(f"--- Page {idx} ---\n{raw_text}")

        total_non_ws = sum(len("".join(t.split())) for t in page_texts)
        has_selectable_text = (
            total_non_ws >= 40 and non_empty_pages >= max(1, (page_count + 1) // 2)
        )

        if has_selectable_text:
            return ExtractedAssignmentInput(
                filename=filename,
                ext=".pdf",
                extraction_method="pymupdf_text",
                page_count=page_count,
                text="\n\n".join(page_texts),
            )

        # Scanned PDF: rasterize pages cleanly for multimodal Gemini extraction.
        render_pages = min(page_count, MAX_MULTIMODAL_PDF_PAGES)
        matrix = fitz.Matrix(150 / 72.0, 150 / 72.0)
        image_parts: list[tuple[bytes, str]] = []
        for idx in range(render_pages):
            pix = doc[idx].get_pixmap(matrix=matrix, alpha=False)
            image_parts.append((pix.tobytes("png"), "image/png"))

        return ExtractedAssignmentInput(
            filename=filename,
            ext=".pdf",
            extraction_method="pymupdf_multimodal",
            page_count=page_count,
            image_parts=image_parts,
        )


def extract_assignment_input(path: Path, ext: str, filename: str) -> ExtractedAssignmentInput:
    """Extract text or multimodal image parts from a validated PDF, DOCX, or image file."""
    if ext == ".docx":
        text = _extract_docx_text(path)
        return ExtractedAssignmentInput(
            filename=filename,
            ext=ext,
            extraction_method="python_docx",
            page_count=1,
            text=text,
        )

    if ext == ".pdf":
        return _extract_pdf_content(path, filename)

    mime_type = "image/png" if ext == ".png" else "image/jpeg"
    return ExtractedAssignmentInput(
        filename=filename,
        ext=ext,
        extraction_method="image_multimodal",
        page_count=1,
        image_parts=[(path.read_bytes(), mime_type)],
    )
