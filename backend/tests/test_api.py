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


def test_pdf_to_word_preserves_tables_and_lists():
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 70), "Lab Report Title", fontsize=20)
    page.insert_text((72, 110), "- First bullet item", fontsize=11)
    page.insert_text((72, 130), "- Second bullet item", fontsize=11)
    # Draw a 2x2 table grid
    for x in (72, 200, 350):
        page.draw_line((x, 160), (x, 220))
    for y in (160, 190, 220):
        page.draw_line((72, y), (350, y))
    page.insert_text((80, 180), "Header A", fontsize=11)
    page.insert_text((210, 180), "Header B", fontsize=11)
    page.insert_text((80, 210), "Row 1 A", fontsize=11)
    page.insert_text((210, 210), "Row 1 B", fontsize=11)
    buf = BytesIO()
    doc.save(buf)
    doc.close()

    res = client.post(
        "/api/convert/pdf-to-word",
        files={"file": ("table_report.pdf", buf.getvalue(), "application/pdf")},
    )
    assert res.status_code == 200
    out_doc = Document(BytesIO(res.content))
    assert len(out_doc.tables) >= 1
    table_text = " ".join(c.text for r in out_doc.tables[0].rows for c in r.cells)
    assert "Header A" in table_text
    assert "Row 1 B" in table_text
    para_text = "\n".join(p.text for p in out_doc.paragraphs)
    assert "First bullet item" in para_text
    assert "Second bullet item" in para_text


def test_editor_pdf_export_with_table():
    res = client.post(
        "/api/export/editor-pdf",
        json={
            "title": "table-notes",
            "blocks": [
                {"kind": "h1", "align": "center", "runs": [{"text": "Table Report", "bold": True}], "text": "Table Report", "index": 1},
                {"kind": "table", "align": "left", "runs": [], "text": "", "index": 1, "rows": [["Col 1", "Col 2"], ["A", "B"]]},
            ],
        },
    )
    assert res.status_code == 200
    assert res.content.startswith(b"%PDF-")
    with fitz.open(stream=res.content, filetype="pdf") as pdf:
        txt = pdf[0].get_text()
        assert "Table Report" in txt
        assert "Col 1" in txt


def test_pdf_compressor_shrinks_image_pdf():
    from PIL import Image

    img = Image.new("RGB", (1600, 1200))
    # Add noisy gradients so uncompressed/high-res PNG inside PDF is bulky
    pixels = img.load()
    for x in range(0, 1600, 2):
        for y in range(0, 1200, 2):
            pixels[x, y] = ((x * 7) % 255, (y * 11) % 255, ((x + y) * 3) % 255)
    img_buf = BytesIO()
    img.save(img_buf, format="PNG")

    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_image(fitz.Rect(20, 20, 560, 440), stream=img_buf.getvalue())
    pdf_buf = BytesIO()
    pdf.save(pdf_buf)
    pdf.close()
    raw_pdf = pdf_buf.getvalue()

    res = client.post(
        "/api/compress/pdf",
        files={"file": ("heavy.pdf", raw_pdf, "application/pdf")},
        data={"compression": "75"},
    )
    assert res.status_code == 200
    assert res.content.startswith(b"%PDF-")
    assert len(res.content) < len(raw_pdf)


def test_word_compressor_shrinks_image_docx():
    from PIL import Image
    from docx.shared import Inches

    img = Image.new("RGB", (1400, 1000), (180, 90, 60))
    pixels = img.load()
    for x in range(0, 1400, 2):
        for y in range(0, 1000, 2):
            pixels[x, y] = ((x * 5) % 255, (y * 9) % 255, 120)
    img_buf = BytesIO()
    img.save(img_buf, format="PNG")
    img_buf.seek(0)

    doc = Document()
    doc.add_heading("Heavy Report", level=1)
    doc.add_picture(img_buf, width=Inches(5.0))
    docx_buf = BytesIO()
    doc.save(docx_buf)
    raw_docx = docx_buf.getvalue()

    res = client.post(
        "/api/compress/word",
        files={
            "file": (
                "heavy.docx",
                raw_docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
        data={"compression": "75"},
    )
    assert res.status_code == 200
    assert res.content.startswith(b"PK\x03\x04")
    assert len(res.content) < len(raw_docx)
