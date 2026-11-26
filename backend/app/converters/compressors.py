from io import BytesIO
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile
from PIL import Image
import pymupdf as fitz


def _clamp_percent(percent: int) -> int:
    return max(10, min(90, int(percent)))


def _recompress_image_bytes(
    raw_bytes: bytes,
    max_dim: int,
    quality: int,
    force_jpeg: bool = False,
) -> bytes | None:
    try:
        with Image.open(BytesIO(raw_bytes)) as img:
            w, h = img.size
            if max(w, h) > max_dim:
                scale = max_dim / float(max(w, h))
                new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
                img = img.resize(new_size, Image.Resampling.LANCZOS)

            has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
            out = BytesIO()

            if has_alpha and not force_jpeg:
                if img.mode != "RGBA":
                    img = img.convert("RGBA")
                # Quantize softly at higher compression levels for smaller PNGs
                if quality < 65:
                    colors_count = 128 if quality >= 40 else 64
                    img = img.quantize(colors=colors_count, method=Image.Quantize.FASTOCTREE)
                img.save(out, format="PNG", optimize=True)
            else:
                if img.mode != "RGB":
                    if has_alpha:
                        bg = Image.new("RGB", img.size, (255, 255, 255))
                        rgba = img.convert("RGBA")
                        bg.paste(rgba, mask=rgba.split()[3])
                        img = bg
                    else:
                        img = img.convert("RGB")
                img.save(out, format="JPEG", quality=quality, optimize=True, progressive=True)

            result = out.getvalue()
            return result if len(result) < len(raw_bytes) else None
    except Exception:
        return None


def _run_ghostscript(input_pdf: Path, out_pdf: Path, compression_percent: int) -> bool:
    gs_bin = shutil.which("gs")
    if not gs_bin:
        return False

    preset = "/screen" if compression_percent >= 65 else "/ebook" if compression_percent >= 35 else "/printer"
    cmd = [
        gs_bin,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        f"-dPDFSETTINGS={preset}",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        f"-sOutputFile={str(out_pdf)}",
        str(input_pdf),
    ]
    try:
        res = subprocess.run(cmd, timeout=45, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return res.returncode == 0 and out_pdf.exists() and out_pdf.stat().st_size > 0
    except Exception:
        return False


def compress_pdf(pdf_path: Path, output_path: Path, compression_percent: int = 50) -> tuple[int, int]:
    pct = _clamp_percent(compression_percent)
    orig_size = pdf_path.stat().st_size

    quality = max(22, min(92, int(96 - pct * 0.78)))
    max_dim = max(600, min(2400, int(2600 - pct * 20)))

    with fitz.open(pdf_path) as doc:
        if len(doc) == 0:
            raise ValueError("PDF contains zero pages.")

        seen_xrefs: set[int] = set()
        for page in doc:
            for img_info in page.get_images(full=True):
                xref = img_info[0]
                if xref in seen_xrefs:
                    continue
                seen_xrefs.add(xref)
                try:
                    extracted = doc.extract_image(xref)
                    raw = extracted.get("image")
                    if not raw:
                        continue
                    smaller = _recompress_image_bytes(
                        raw,
                        max_dim=max_dim,
                        quality=quality,
                        force_jpeg=(pct >= 55),
                    )
                    if smaller:
                        page.replace_image(xref, stream=smaller)
                except Exception:
                    continue

        doc.save(output_path, garbage=4, deflate=True, clean=True)

    # Try Ghostscript pass if output is still close to original and GS is available
    curr_size = output_path.stat().st_size
    if curr_size > orig_size * 0.85:
        gs_tmp = output_path.with_name("gs_tmp.pdf")
        try:
            if _run_ghostscript(pdf_path, gs_tmp, pct):
                gs_size = gs_tmp.stat().st_size
                if gs_size < curr_size:
                    shutil.move(str(gs_tmp), str(output_path))
                    curr_size = gs_size
        finally:
            if gs_tmp.exists():
                gs_tmp.unlink(missing_ok=True)

    # Never return a larger file than input
    if curr_size >= orig_size:
        shutil.copy2(pdf_path, output_path)
        curr_size = orig_size

    return orig_size, curr_size


def compress_docx(docx_path: Path, output_path: Path, compression_percent: int = 50) -> tuple[int, int]:
    pct = _clamp_percent(compression_percent)
    orig_size = docx_path.stat().st_size

    quality = max(25, min(92, int(96 - pct * 0.75)))
    max_dim = max(640, min(2200, int(2400 - pct * 18)))

    tmp_out = output_path.with_name("docx_tmp.docx")
    with zipfile.ZipFile(docx_path, "r") as zin, zipfile.ZipFile(
        tmp_out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            lower = item.filename.lower()
            if lower.startswith("word/media/") and lower.endswith(
                (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff")
            ):
                smaller = _recompress_image_bytes(
                    data,
                    max_dim=max_dim,
                    quality=quality,
                    force_jpeg=lower.endswith((".jpg", ".jpeg", ".bmp")),
                )
                if smaller:
                    data = smaller
            zout.writestr(item, data)

    new_size = tmp_out.stat().st_size
    if new_size < orig_size:
        shutil.move(str(tmp_out), str(output_path))
        return orig_size, new_size

    tmp_out.unlink(missing_ok=True)
    shutil.copy2(docx_path, output_path)
    return orig_size, orig_size
