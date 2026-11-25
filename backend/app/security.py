import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from fastapi import HTTPException, UploadFile
from .config import MAX_UPLOAD_BYTES, MAX_UPLOAD_MB


def safe_stem(filename: str | None, fallback: str = "document") -> str:
    if not filename:
        return fallback
    stem = Path(filename).stem
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")
    return cleaned[:80] or fallback


async def save_validated_upload(
    upload: UploadFile,
    expected_ext: str,
) -> tuple[Path, Path]:
    """
    Validates extension, file size, and file magic signature, saving to an
    isolated temporary directory. Returns (temp_dir, saved_file_path).
    """
    orig_name = upload.filename or ""
    ext = Path(orig_name).suffix.lower()
    if ext != expected_ext:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file extension '{ext or 'none'}'. Expected '{expected_ext}'.",
        )

    temp_dir = Path(tempfile.mkdtemp(prefix="docuforge_"))
    target_path = temp_dir / f"input{expected_ext}"

    total_bytes = 0
    try:
        with open(target_path, "wb") as out_file:
            while True:
                chunk = await upload.read(1024 * 256)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds maximum allowed size of {MAX_UPLOAD_MB} MB.",
                    )
                out_file.write(chunk)

        if total_bytes == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        validate_file_signature(target_path, expected_ext)
        return temp_dir, target_path
    except Exception:
        cleanup_dir(temp_dir)
        raise


def validate_file_signature(path: Path, expected_ext: str) -> None:
    with open(path, "rb") as f:
        header = f.read(16)

    if expected_ext == ".pdf":
        if not header.startswith(b"%PDF-"):
            raise HTTPException(status_code=400, detail="File is not a valid PDF document.")
        return

    if expected_ext in (".docx", ".pptx"):
        if not header.startswith(b"PK\x03\x04"):
            raise HTTPException(
                status_code=400,
                detail=f"File is not a valid {expected_ext.upper()} archive.",
            )
        try:
            with zipfile.ZipFile(path, "r") as zf:
                names = set(zf.namelist())
                if expected_ext == ".docx" and "word/document.xml" not in names:
                    raise HTTPException(
                        status_code=400,
                        detail="Invalid DOCX structure: missing word/document.xml.",
                    )
                if expected_ext == ".pptx" and "ppt/presentation.xml" not in names:
                    raise HTTPException(
                        status_code=400,
                        detail="Invalid PPTX structure: missing ppt/presentation.xml.",
                    )
        except zipfile.BadZipFile:
            raise HTTPException(
                status_code=400,
                detail=f"Corrupted {expected_ext.upper()} file.",
            )


def cleanup_dir(path: Path) -> None:
    if path and path.exists():
        shutil.rmtree(path, ignore_errors=True)
