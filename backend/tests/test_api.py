from io import BytesIO
from pathlib import Path
import tempfile
import pymupdf as fitz
from docx import Document
from pptx import Presentation
from pptx.util import Inches
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _make_sample_pdf(text: str = "Hello DOCUFORGE", pages: int = 1) -> bytes:
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page()
        page.insert_text((72, 100), f"{text} Page {i + 1}", fontsize=16)
    buf = BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


def _make_sample_docx(text: str = "Academic Report Sample") -> bytes:
    doc = Document()
    doc.add_heading(text, level=1)
    doc.add_paragraph("This is a sample paragraph with bold text.").runs[0].bold = True
    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _make_sample_pptx(title: str = "Slide Deck Title") -> bytes:
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(1.5))
    tb.text_frame.text = title
    buf = BytesIO()
    prs.save(buf)
    return buf.getvalue()


def test_health_check():
    res = client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"


def test_pdf_to_word_conversion():
    pdf_bytes = _make_sample_pdf("DOCUFORGE PDF Test")
    res = client.post(
        "/api/convert/pdf-to-word",
        files={"file": ("sample.pdf", pdf_bytes, "application/pdf")},
    )
    assert res.status_code == 200
    assert res.content.startswith(b"PK\x03\x04")
    doc = Document(BytesIO(res.content))
    full_text = "\n".join(p.text for p in doc.paragraphs)
    assert "DOCUFORGE PDF Test" in full_text


def test_word_to_pdf_conversion():
    docx_bytes = _make_sample_docx("DOCUFORGE DOCX Test")
    res = client.post(
        "/api/convert/word-to-pdf",
        files={
            "file": (
                "report.docx",
                docx_bytes,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert res.status_code == 200
    assert res.content.startswith(b"%PDF-")
    with fitz.open(stream=res.content, filetype="pdf") as pdf:
        assert len(pdf) >= 1
        assert "DOCUFORGE DOCX Test" in pdf[0].get_text()


def test_pdf_to_pptx_conversion():
    pdf_bytes = _make_sample_pdf("Slide Conversion", pages=2)
    res = client.post(
        "/api/convert/pdf-to-pptx",
        files={"file": ("slides.pdf", pdf_bytes, "application/pdf")},
    )
    assert res.status_code == 200
    prs = Presentation(BytesIO(res.content))
    assert len(prs.slides) == 2
    assert "Slide Conversion Page 1" in prs.slides[0].notes_slide.notes_text_frame.text


def test_pptx_to_pdf_conversion():
    pptx_bytes = _make_sample_pptx("Presentation PDF Export")
    res = client.post(
        "/api/convert/pptx-to-pdf",
        files={
            "file": (
                "deck.pptx",
                pptx_bytes,
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
        },
    )
    assert res.status_code == 200
    assert res.content.startswith(b"%PDF-")
    with fitz.open(stream=res.content, filetype="pdf") as pdf:
        assert len(pdf) == 1
        assert "Presentation PDF Export" in pdf[0].get_text()


def test_editor_pdf_export():
    res = client.post(
        "/api/export/editor-pdf",
        json={
            "title": "notes",
            "blocks": [
                {"kind": "h1", "align": "left", "runs": [{"text": "Lecture Notes", "bold": True}], "text": "Lecture Notes", "index": 1},
                {"kind": "p", "align": "left", "runs": [{"text": "Summary paragraph."}], "text": "Summary paragraph.", "index": 1},
            ],
        },
    )
    assert res.status_code == 200
    assert res.content.startswith(b"%PDF-")


def test_rejects_invalid_extension_and_magic_bytes():
    res_ext = client.post(
        "/api/convert/pdf-to-word",
        files={"file": ("bad.txt", b"hello", "text/plain")},
    )
    assert res_ext.status_code == 400

    res_magic = client.post(
        "/api/convert/pdf-to-word",
        files={"file": ("fake.pdf", b"not-a-pdf", "application/pdf")},
    )
    assert res_magic.status_code == 400

    res_empty = client.post(
        "/api/convert/word-to-pdf",
        files={"file": ("empty.docx", b"", "application/octet-stream")},
    )
    assert res_empty.status_code == 400


def test_temp_files_cleaned_up():
    tmp_root = Path(tempfile.gettempdir())
    before = set(tmp_root.glob("docuforge_*"))
    pdf_bytes = _make_sample_pdf("Cleanup Test")
    res = client.post(
        "/api/convert/pdf-to-word",
        files={"file": ("cleanup.pdf", pdf_bytes, "application/pdf")},
    )
    assert res.status_code == 200
    after = set(tmp_root.glob("docuforge_*"))
    assert after - before == set()
