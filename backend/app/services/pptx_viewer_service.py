from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import logging
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
import xml.etree.ElementTree as ET
import zipfile
from PIL import Image
from fastapi import HTTPException, UploadFile

from ..config import PPTX_CACHE_DIR, PPTX_MAX_UPLOAD_BYTES, PPTX_MAX_UPLOAD_MB
from ..security import cleanup_dir, safe_stem, validate_file_signature

logger = logging.getLogger("docuforge.pptx_viewer")

ALLOWED_PPTX_MIME_TYPES = {
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/octet-stream",
    "",
}

HEX_HASH_RE = re.compile(r"^[a-f0-9]{64}$")
SLIDE_FILE_NUM_RE = re.compile(r"(\d+)\.png$")

_EXECUTOR = ThreadPoolExecutor(max_workers=2)
_JOBS_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_HASH_LOCKS_GUARD = threading.Lock()
_HASH_LOCKS: dict[str, threading.Lock] = {}
_INSTALLED_FONTS_CACHE: set[str] | None = None


def _get_hash_lock(file_hash: str) -> threading.Lock:
    with _HASH_LOCKS_GUARD:
        if file_hash not in _HASH_LOCKS:
            _HASH_LOCKS[file_hash] = threading.Lock()
        return _HASH_LOCKS[file_hash]


def _get_installed_fonts() -> set[str]:
    global _INSTALLED_FONTS_CACHE
    if _INSTALLED_FONTS_CACHE is not None:
        return _INSTALLED_FONTS_CACHE

    fonts: set[str] = set()
    fc_list = shutil.which("fc-list")
    if fc_list:
        try:
            res = subprocess.run(
                [fc_list, "--format=%{family}\n"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if res.returncode == 0:
                for line in res.stdout.splitlines():
                    for fam in line.split(","):
                        clean = fam.strip().lower()
                        if clean:
                            fonts.add(clean)
        except Exception:
            pass

    _INSTALLED_FONTS_CACHE = fonts
    return fonts


def inspect_pptx_fonts(pptx_path: Path) -> tuple[list[str], list[str]]:
    """
    Inspects PPTX XML files for declared typeface names and warns if any
    declared fonts are missing from the server's installed font families.
    Returns (declared_fonts, missing_fonts).
    """
    declared: set[str] = set()
    try:
        with zipfile.ZipFile(pptx_path, "r") as zf:
            for name in zf.namelist():
                if not (
                    name.startswith("ppt/slides/slide")
                    or name.startswith("ppt/slideLayouts/")
                    or name.startswith("ppt/slideMasters/")
                    or name.startswith("ppt/theme/")
                ) or not name.endswith(".xml"):
                    continue
                try:
                    root = ET.fromstring(zf.read(name))
                    for elem in root.iter():
                        tf = elem.attrib.get("typeface")
                        if tf:
                            tf = tf.strip()
                            # Ignore OOXML theme alias tokens like +mj-lt, +mn-lt
                            if tf and not tf.startswith("+"):
                                declared.add(tf)
                except Exception:
                    continue
    except Exception:
        return [], []

    installed = _get_installed_fonts()
    missing: list[str] = []
    if installed:
        for font_name in sorted(declared):
            if font_name.lower() not in installed:
                missing.append(font_name)
                logger.warning(
                    "PPTX deck uses font '%s' which is not installed on the server; metric fallback may apply.",
                    font_name,
                )
    else:
        missing = sorted(declared)
        for font_name in missing:
            logger.warning(
                "Could not verify server fonts via fc-list; deck declares font '%s'.",
                font_name,
            )

    return sorted(declared), missing


def _slide_urls(file_hash: str, slide_count: int) -> list[str]:
    return [f"/api/slides/{file_hash}/{i}.png" for i in range(1, slide_count + 1)]


def get_cached_result(file_hash: str, cache_dir: Path | None = None) -> dict | None:
    if not HEX_HASH_RE.match(file_hash):
        return None
    cache_dir = cache_dir or PPTX_CACHE_DIR
    target_dir = cache_dir / file_hash
    meta_file = target_dir / "metadata.json"
    if not meta_file.exists():
        return None

    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        count = int(meta.get("slide_count", 0))
        if count <= 0:
            return None
        for idx in range(1, count + 1):
            if not (target_dir / f"slide-{idx:03d}.png").exists():
                return None
        return {
            "file_hash": file_hash,
            "slide_count": count,
            "slides": _slide_urls(file_hash, count),
            "aspect_ratio": float(meta.get("aspect_ratio", 16.0 / 9.0)),
            "missing_fonts": list(meta.get("missing_fonts", [])),
        }
    except Exception:
        return None


def get_slide_image_path(
    file_hash: str, slide_number: int, cache_dir: Path | None = None
) -> Path | None:
    if not HEX_HASH_RE.match(file_hash) or slide_number < 1:
        return None
    cache_dir = cache_dir or PPTX_CACHE_DIR
    candidate = cache_dir / file_hash / f"slide-{slide_number:03d}.png"
    return candidate if candidate.exists() and candidate.is_file() else None


async def save_and_hash_pptx_upload(upload: UploadFile) -> tuple[Path, Path, str, str]:
    """
    Validates .pptx extension, MIME type, 50 MB size limit, and OOXML ZIP signature
    while computing SHA-256. Returns (temp_dir, saved_pptx_path, file_hash, safe_name).
    """
    orig_name = upload.filename or ""
    ext = Path(orig_name).suffix.lower()
    if ext != ".pptx":
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file extension '{ext or 'none'}'. Expected '.pptx'.",
        )

    content_type = (upload.content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_PPTX_MIME_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid MIME type '{content_type}'. Expected a .pptx presentation.",
        )

    temp_dir = Path(tempfile.mkdtemp(prefix="docuforge_pptx_in_"))
    safe_base = safe_stem(orig_name, "presentation")
    target_path = temp_dir / f"{safe_base}.pptx"

    sha = hashlib.sha256()
    total_bytes = 0
    try:
        with open(target_path, "wb") as out_f:
            while True:
                chunk = await upload.read(1024 * 256)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > PPTX_MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds maximum allowed size of {PPTX_MAX_UPLOAD_MB} MB.",
                    )
                sha.update(chunk)
                out_f.write(chunk)

        if total_bytes == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        validate_file_signature(target_path, ".pptx")
        return temp_dir, target_path, sha.hexdigest(), f"{safe_base}.pptx"
    except Exception:
        cleanup_dir(temp_dir)
        raise


def _convert_pptx_to_slide_pngs(
    input_pptx: Path,
    file_hash: str,
    cache_dir: Path | None = None,
) -> dict:
    cache_dir = cache_dir or PPTX_CACHE_DIR
    soffice_bin = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice_bin:
        raise RuntimeError(
            "LibreOffice (soffice) is not installed on the server. Install LibreOffice, poppler-utils, and fonts."
        )

    pdftoppm_bin = shutil.which("pdftoppm")
    if not pdftoppm_bin:
        raise RuntimeError(
            "Poppler (pdftoppm) is not installed on the server. Install poppler-utils."
        )

    _, missing_fonts = inspect_pptx_fonts(input_pptx)

    lo_profile = Path(tempfile.gettempdir()) / f"lo_{uuid.uuid4().hex}"
    work_dir = Path(tempfile.mkdtemp(prefix="docuforge_pptx_work_"))
    stage_dir = work_dir / "slides"
    stage_dir.mkdir(parents=True, exist_ok=True)

    try:
        lo_cmd = [
            soffice_bin,
            "--headless",
            "--norestore",
            "--nolockcheck",
            f"-env:UserInstallation=file://{lo_profile}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(work_dir),
            str(input_pptx),
        ]
        try:
            lo_res = subprocess.run(
                lo_cmd,
                timeout=120,
                check=False,
                capture_output=True,
                text=True,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("LibreOffice conversion timed out after 120 seconds.") from exc

        pdf_path = work_dir / f"{input_pptx.stem}.pdf"
        if lo_res.returncode != 0 or not pdf_path.exists() or pdf_path.stat().st_size == 0:
            raise RuntimeError(
                f"LibreOffice failed to convert PPTX to PDF (exit {lo_res.returncode})."
            )

        ppm_prefix = stage_dir / "slide"
        ppm_cmd = [pdftoppm_bin, "-png", "-r", "150", str(pdf_path), str(ppm_prefix)]
        try:
            ppm_res = subprocess.run(
                ppm_cmd,
                timeout=120,
                check=False,
                capture_output=True,
                text=True,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("pdftoppm slide rendering timed out after 120 seconds.") from exc

        if ppm_res.returncode != 0:
            raise RuntimeError(f"pdftoppm failed with exit code {ppm_res.returncode}.")

        raw_pngs = list(stage_dir.glob("slide-*.png"))
        if not raw_pngs:
            raise RuntimeError("pdftoppm produced zero slide images.")

        def _sort_key(p: Path) -> int:
            m = SLIDE_FILE_NUM_RE.search(p.name)
            return int(m.group(1)) if m else 0

        raw_pngs.sort(key=_sort_key)

        cache_dir.mkdir(parents=True, exist_ok=True)
        final_dir = cache_dir / file_hash
        tmp_cache = cache_dir / f".tmp_{file_hash}_{uuid.uuid4().hex[:8]}"
        tmp_cache.mkdir(parents=True, exist_ok=True)

        try:
            aspect_ratio = 16.0 / 9.0
            for idx, src_png in enumerate(raw_pngs, start=1):
                dst_png = tmp_cache / f"slide-{idx:03d}.png"
                shutil.move(str(src_png), str(dst_png))
                if idx == 1:
                    try:
                        with Image.open(dst_png) as im:
                            w, h = im.size
                            if h > 0:
                                aspect_ratio = round(w / float(h), 4)
                    except Exception:
                        pass

            slide_count = len(raw_pngs)
            meta = {
                "file_hash": file_hash,
                "slide_count": slide_count,
                "aspect_ratio": aspect_ratio,
                "missing_fonts": missing_fonts,
            }
            (tmp_cache / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")

            if final_dir.exists():
                shutil.rmtree(final_dir, ignore_errors=True)
            shutil.move(str(tmp_cache), str(final_dir))
        finally:
            if tmp_cache.exists():
                shutil.rmtree(tmp_cache, ignore_errors=True)

        return {
            "file_hash": file_hash,
            "slide_count": len(raw_pngs),
            "slides": _slide_urls(file_hash, len(raw_pngs)),
            "aspect_ratio": aspect_ratio,
            "missing_fonts": missing_fonts,
        }
    finally:
        cleanup_dir(work_dir)
        cleanup_dir(lo_profile)


def _run_job(
    job_id: str,
    temp_dir: Path,
    input_pptx: Path,
    file_hash: str,
    cache_dir: Path,
) -> None:
    try:
        with _JOBS_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["status"] = "processing"

        hash_lock = _get_hash_lock(file_hash)
        with hash_lock:
            cached = get_cached_result(file_hash, cache_dir=cache_dir)
            result = cached if cached is not None else _convert_pptx_to_slide_pngs(
                input_pptx, file_hash, cache_dir=cache_dir
            )

        with _JOBS_LOCK:
            _JOBS[job_id].update(
                {
                    "status": "done",
                    "slide_count": result["slide_count"],
                    "slides": result["slides"],
                    "aspect_ratio": result["aspect_ratio"],
                    "missing_fonts": result["missing_fonts"],
                    "error": None,
                }
            )
    except Exception as exc:
        logger.exception("PPTX viewer job %s failed", job_id)
        with _JOBS_LOCK:
            _JOBS[job_id].update(
                {
                    "status": "failed",
                    "error": str(exc),
                }
            )
    finally:
        cleanup_dir(temp_dir)


def enqueue_pptx_job(
    temp_dir: Path,
    input_pptx: Path,
    file_hash: str,
    cache_dir: Path | None = None,
) -> dict:
    cache_dir = cache_dir or PPTX_CACHE_DIR
    cached = get_cached_result(file_hash, cache_dir=cache_dir)
    job_id = uuid.uuid4().hex

    if cached is not None:
        cleanup_dir(temp_dir)
        job_data = {
            "job_id": job_id,
            "file_hash": file_hash,
            "status": "done",
            "cached": True,
            "slide_count": cached["slide_count"],
            "slides": cached["slides"],
            "aspect_ratio": cached["aspect_ratio"],
            "missing_fonts": cached["missing_fonts"],
            "error": None,
        }
        with _JOBS_LOCK:
            _JOBS[job_id] = job_data
        return dict(job_data)

    job_data = {
        "job_id": job_id,
        "file_hash": file_hash,
        "status": "pending",
        "cached": False,
        "slide_count": 0,
        "slides": [],
        "aspect_ratio": 16.0 / 9.0,
        "missing_fonts": [],
        "error": None,
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job_data

    _EXECUTOR.submit(_run_job, job_id, temp_dir, input_pptx, file_hash, cache_dir)
    return dict(job_data)


def get_pptx_job(job_id: str) -> dict | None:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        return dict(job) if job else None
