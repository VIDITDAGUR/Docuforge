"""Notebook-ready PDF and DOCX exporters with per-page student header metadata."""

from html import escape
from pathlib import Path
import re
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

from .models import ExportRequest


def format_page_header(name: str, roll_no: str) -> str:
    """Format standard header stamped on every exported PDF and DOCX page."""
    clean_name = (name or "").strip() or "Student"
    clean_roll = (roll_no or "").strip() or "N/A"
    return f"Submitted by: {clean_name} | Roll No.: {clean_roll}"


def _format_marks_label(marks: float) -> str:
    num = int(marks) if float(marks).is_integer() else marks
    unit = "Mark" if marks == 1 else "Marks"
    return f"[{num} {unit}]"


def _format_question_heading(number: str, part: str, marks: float, text: str) -> str:
    q_label = f"Q{number}{part}".strip() if part else f"Q{number}"
    return f"{q_label}. {_format_marks_label(marks)} {text}"


def _looks_like_code_or_formula(line: str, q_type: str) -> bool:
    if q_type not in {"code", "numerical", "derivation"}:
        return False
    stripped = line.strip()
    if line.startswith(("    ", "\t")) or any(
        stripped.startswith(prefix)
        for prefix in ("def ", "class ", "for ", "while ", "if ", "return ", "#include", "import ")
    ):
        return True
    if "=" in stripped and len(re.findall(r"[A-Za-z]{4,}", stripped)) <= 2:
        return True
    return False


def export_answers_to_pdf(payload: ExportRequest, output_path: Path) -> None:
    """Render confirmed assignment questions and answers to a notebook-friendly PDF."""
    header_text = format_page_header(payload.profile.name, payload.profile.roll_no)
    base_styles = getSampleStyleSheet()

    def _draw_page_chrome(canvas, doc):
        canvas.saveState()
        width, height = LETTER
        canvas.setFont("Helvetica-Bold", 9)
        canvas.setFillColor(colors.HexColor("#222222"))
        canvas.drawString(doc.leftMargin, height - 0.52 * inch, header_text)
        canvas.setStrokeColor(colors.HexColor("#CCCCCC"))
        canvas.setLineWidth(0.6)
        canvas.line(doc.leftMargin, height - 0.62 * inch, width - doc.rightMargin, height - 0.62 * inch)

        canvas.setFont("Helvetica", 8.5)
        canvas.setFillColor(colors.HexColor("#777777"))
        canvas.drawRightString(width - doc.rightMargin, 0.45 * inch, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    pdf_doc = SimpleDocTemplate(
        str(output_path),
        pagesize=LETTER,
        leftMargin=0.8 * inch,
        rightMargin=0.8 * inch,
        topMargin=0.85 * inch,
        bottomMargin=0.75 * inch,
    )

    title_style = ParagraphStyle(
        "AssignTitle",
        parent=base_styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=15,
        leading=19,
        textColor=colors.HexColor("#222222"),
        spaceAfter=4,
    )
    meta_style = ParagraphStyle(
        "AssignMeta",
        parent=base_styles["Normal"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=13,
        textColor=colors.HexColor("#555555"),
        spaceAfter=12,
    )
    question_style = ParagraphStyle(
        "AssignQuestion",
        parent=base_styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=15.5,
        textColor=colors.HexColor("#111111"),
        spaceBefore=8,
        spaceAfter=5,
    )
    answer_style = ParagraphStyle(
        "AssignAnswer",
        parent=base_styles["Normal"],
        fontName="Helvetica",
        fontSize=10.5,
        leading=15.5,
        textColor=colors.HexColor("#222222"),
        spaceAfter=5,
    )
    code_style = ParagraphStyle(
        "AssignCode",
        parent=answer_style,
        fontName="Courier",
        fontSize=9.5,
        leading=13.5,
        leftIndent=14,
        spaceAfter=3,
    )
    note_style = ParagraphStyle(
        "AssignNote",
        parent=base_styles["Normal"],
        fontName="Helvetica",
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#666666"),
        spaceAfter=10,
    )

    story = [Paragraph(escape(payload.title or "Assignment Answers"), title_style)]
    meta_parts = [p for p in [payload.course_name, payload.subject_hint] if p and p.strip()]
    if meta_parts:
        story.append(Paragraph(escape(" | ".join(meta_parts)), meta_style))
    else:
        story.append(Spacer(1, 6))

    for item in payload.items:
        q_head = _format_question_heading(item.number, item.part, item.marks, item.question_text)
        story.append(Paragraph(escape(q_head), question_style))

        for para_text in (item.answer or "").splitlines():
            clean = para_text.rstrip()
            if not clean.strip():
                story.append(Spacer(1, 4))
                continue
            if _looks_like_code_or_formula(clean, item.type):
                story.append(Paragraph(escape(clean), code_style))
            else:
                story.append(Paragraph(escape(clean), answer_style))

        story.append(
            Paragraph(
                escape(
                    f"Words: {item.explanation_word_count} "
                    f"(target {item.min_words}-{item.max_words}) | "
                    f"Est. handwritten space: ~{item.estimated_lines} lines"
                ),
                note_style,
            )
        )

    pdf_doc.build(story, onFirstPage=_draw_page_chrome, onLaterPages=_draw_page_chrome)


def export_answers_to_docx(payload: ExportRequest, output_path: Path) -> None:
    """Render confirmed assignment questions and answers to a clean Word (.docx) document."""
    header_text = format_page_header(payload.profile.name, payload.profile.roll_no)
    doc = Document()

    for section in doc.sections:
        section.top_margin = Inches(0.85)
        section.bottom_margin = Inches(0.75)
        section.left_margin = Inches(0.85)
        section.right_margin = Inches(0.85)
        section.different_first_page_header_footer = False

        header_para = section.header.paragraphs[0]
        header_para.alignment = WD_ALIGN_PARAGRAPH.LEFT
        hdr_run = header_para.add_run(header_text)
        hdr_run.bold = True
        hdr_run.font.size = Pt(9.5)
        hdr_run.font.color.rgb = RGBColor(0x22, 0x22, 0x22)

    title_para = doc.add_heading(payload.title or "Assignment Answers", level=1)
    if title_para.runs:
        title_para.runs[0].font.color.rgb = RGBColor(0x22, 0x22, 0x22)

    meta_parts = [p for p in [payload.course_name, payload.subject_hint] if p and p.strip()]
    if meta_parts:
        meta_p = doc.add_paragraph(" | ".join(meta_parts))
        if meta_p.runs:
            meta_p.runs[0].font.size = Pt(10)
            meta_p.runs[0].font.color.rgb = RGBColor(0x55, 0x55, 0x55)

    for item in payload.items:
        q_head = _format_question_heading(item.number, item.part, item.marks, item.question_text)
        q_para = doc.add_paragraph()
        q_para.paragraph_format.space_before = Pt(10)
        q_para.paragraph_format.space_after = Pt(4)
        q_run = q_para.add_run(q_head)
        q_run.bold = True
        q_run.font.size = Pt(11.5)
        q_run.font.color.rgb = RGBColor(0x11, 0x11, 0x11)

        for raw_line in (item.answer or "").splitlines():
            clean = raw_line.rstrip()
            if not clean.strip():
                continue
            a_para = doc.add_paragraph()
            a_para.paragraph_format.space_after = Pt(4)
            run = a_para.add_run(clean)
            if _looks_like_code_or_formula(clean, item.type):
                a_para.paragraph_format.left_indent = Inches(0.25)
                run.font.name = "Courier New"
                run.font.size = Pt(10)
            else:
                run.font.size = Pt(11)
                run.font.color.rgb = RGBColor(0x22, 0x22, 0x22)

        meta_note = doc.add_paragraph()
        meta_note.paragraph_format.space_after = Pt(8)
        n_run = meta_note.add_run(
            f"Words: {item.explanation_word_count} (target {item.min_words}-{item.max_words}) | "
            f"Est. handwritten space: ~{item.estimated_lines} lines"
        )
        n_run.font.size = Pt(8.5)
        n_run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    doc.save(output_path)
