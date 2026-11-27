import hashlib
from io import BytesIO
import json
import logging
from pathlib import Path
from unittest.mock import patch
import zipfile
from fastapi.testclient import TestClient
from PIL import Image
from pptx import Presentation
from pptx.util import Inches, Pt

from app.main import app
from app.services import pptx_viewer_service as pvs

client = TestClient(app)


def _make_pptx_bytes(title: str = "Fidelity Slide", font_name: str | None = None) -> bytes:
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(1.5))
    run = tb.text_frame.paragraphs[0].add_run()
    run.text = title
    run.font.size = Pt(28)
    if font_name:
        run.font.name = font_name
    buf = BytesIO()
    prs.save(buf)
    return buf.getvalue()


def _make_png_bytes(width: int = 160, height: int = 90) -> bytes:
    img = Image.new("RGB", (width, height), (240, 240, 240))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_upload_rejects_wrong_extension():
    res = client.post(
        "/api/upload",
        files={"file": ("deck.pdf", b"%PDF-1.4\n", "application/pdf")},
    )
    assert res.status_code == 400
    assert "extension" in res.json()["detail"].lower()


def test_upload_rejects_wrong_mime_type():
    pptx_bytes = _make_pptx_bytes()
    res = client.post(
        "/api/upload",
        files={"file": ("deck.pptx", pptx_bytes, "text/plain")},
    )
    assert res.status_code == 400
    assert "mime" in res.json()["detail"].lower()


def test_upload_rejects_empty_and_corrupt_pptx():
    res_empty = client.post(
        "/api/upload",
        files={
            "file": (
                "empty.pptx",
                b"",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
        },
    )
    assert res_empty.status_code == 400

    # Valid ZIP but missing ppt/presentation.xml
    bad_zip = BytesIO()
    with zipfile.ZipFile(bad_zip, "w") as zf:
        zf.writestr("hello.txt", "not a presentation")
    res_bad = client.post(
        "/api/upload",
        files={
            "file": (
                "fake.pptx",
                bad_zip.getvalue(),
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
        },
    )
    assert res_bad.status_code == 400


def test_upload_rejects_oversized_pptx(monkeypatch):
    monkeypatch.setattr(pvs, "PPTX_MAX_UPLOAD_BYTES", 1024)
    monkeypatch.setattr(pvs, "PPTX_MAX_UPLOAD_MB", 1)
    big_bytes = _make_pptx_bytes("Too Big")
    assert len(big_bytes) > 1024

    res = client.post(
        "/api/upload",
        files={
            "file": (
                "large.pptx",
                big_bytes,
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
        },
    )
    assert res.status_code == 413


def test_sha256_cache_hit_and_slide_headers(tmp_path, monkeypatch):
    monkeypatch.setattr(pvs, "PPTX_CACHE_DIR", tmp_path)

    pptx_bytes = _make_pptx_bytes("Cached Presentation")
    file_hash = hashlib.sha256(pptx_bytes).hexdigest()

    cached_dir = tmp_path / file_hash
    cached_dir.mkdir(parents=True)
    png_bytes = _make_png_bytes()
    (cached_dir / "slide-001.png").write_bytes(png_bytes)
    (cached_dir / "slide-002.png").write_bytes(png_bytes)
    (cached_dir / "metadata.json").write_text(
        json.dumps(
            {
                "file_hash": file_hash,
                "slide_count": 2,
                "aspect_ratio": 1.7778,
                "missing_fonts": [],
            }
        ),
        encoding="utf-8",
    )

    with patch.object(pvs._EXECUTOR, "submit") as mock_submit:
        res = client.post(
            "/api/upload",
            files={
                "file": (
                    "cached_deck.pptx",
                    pptx_bytes,
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                )
            },
        )
    mock_submit.assert_not_called()
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "done"
    assert body["cached"] is True
    assert body["file_hash"] == file_hash
    assert body["slide_count"] == 2
    assert body["slides"] == [
        f"/api/slides/{file_hash}/1.png",
        f"/api/slides/{file_hash}/2.png",
    ]

    slide_res = client.get(f"/api/slides/{file_hash}/1.png")
    assert slide_res.status_code == 200
    assert slide_res.headers["content-type"] == "image/png"
    assert "max-age=31536000" in slide_res.headers["cache-control"]
    assert "immutable" in slide_res.headers["cache-control"]


def test_slide_endpoint_blocks_invalid_hash_and_filename():
    bad_hash = client.get("/api/slides/not-a-sha256/1.png")
    assert bad_hash.status_code == 404

    bad_name = client.get(f"/api/slides/{'a' * 64}/slide.txt")
    assert bad_name.status_code == 400


def test_conversion_pipeline_and_font_warning(tmp_path, monkeypatch, caplog):
    pptx_bytes = _make_pptx_bytes("Custom Font Slide", font_name="RareAcademicFontXYZ")
    file_hash = hashlib.sha256(pptx_bytes).hexdigest()
    in_file = tmp_path / "deck.pptx"
    in_file.write_bytes(pptx_bytes)

    cache_dir = tmp_path / "cache"
    monkeypatch.setattr(pvs, "_INSTALLED_FONTS_CACHE", {"carlito", "liberation sans"})

    seen_commands: list[list[str]] = []

    def fake_which(name: str):
        if name in ("soffice", "pdftoppm"):
            return f"/usr/bin/{name}"
        return None

    class FakeResult:
        def __init__(self, returncode=0):
            self.returncode = returncode
            self.stdout = ""
            self.stderr = ""

    def fake_run(cmd, timeout=None, check=False, capture_output=False, text=False):
        seen_commands.append(cmd)
        if cmd[0].endswith("soffice"):
            assert "--headless" in cmd
            assert "--convert-to" in cmd
            assert timeout == 120
            assert any(arg.startswith("-env:UserInstallation=file://") for arg in cmd)
            out_dir = Path(cmd[cmd.index("--outdir") + 1])
            (out_dir / "deck.pdf").write_bytes(b"%PDF-1.4\n%fake\n")
        elif cmd[0].endswith("pdftoppm"):
            assert "-png" in cmd
            assert "-r" in cmd and "150" in cmd
            assert timeout == 120
            prefix = Path(cmd[-1])
            png_bytes = _make_png_bytes(1920, 1080)
            Path(f"{prefix}-1.png").write_bytes(png_bytes)
            Path(f"{prefix}-2.png").write_bytes(png_bytes)
        return FakeResult(0)

    with caplog.at_level(logging.WARNING, logger="docuforge.pptx_viewer"), patch.object(
        pvs.shutil, "which", side_effect=fake_which
    ), patch.object(pvs.subprocess, "run", side_effect=fake_run):
        res = pvs._convert_pptx_to_slide_pngs(in_file, file_hash, cache_dir=cache_dir)

    assert len(seen_commands) == 2
    assert res["slide_count"] == 2
    assert res["aspect_ratio"] == round(1920 / 1080, 4)
    assert "RareAcademicFontXYZ" in res["missing_fonts"]
    assert any("RareAcademicFontXYZ" in rec.message for rec in caplog.records)
    assert (cache_dir / file_hash / "slide-001.png").exists()
    assert (cache_dir / file_hash / "slide-002.png").exists()
