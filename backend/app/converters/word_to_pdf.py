from html import escape
from pathlib import Path
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from .libreoffice import convert_with_libreoffice


ALIGN_MAP = {
    WD_ALIGN_PARAGRAPH.LEFT: TA_LEFT,
    WD_ALIGN_PARAGRAPH.CENTER: TA_CENTER,
    WD_ALIGN_PARAGRAPH.RIGHT: TA_RIGHT,
    WD_ALIGN_PARAGRAPH.JUSTIFY: TA_JUSTIFY,
}


def _runs_to_reportlab_markup(paragraph) -> str:
    parts: list[str] = []
    for run in paragraph.runs:
        text = escape(run.text or "").replace("\n", "<br/>")
        if not text:
            continue
        if run.bold:
            text = f"<b>{text}</b>"
        if run.italic:
            text = f"<i>{text}</i>"
        if run.underline:
            text = f"<u>{text}</u>"
        parts.append(text)
    if not parts and paragraph.text:
        return escape(paragraph.text)
    return "".join(parts)


def convert_docx_to_pdf(docx_path: Path, output_path: Path) -> None:
    if convert_with_libreoffice(docx_path, output_path, "pdf"):
        return

    docx_doc = Document(docx_path)
    base_styles = getSampleStyleSheet()

    story = []
    pdf_doc = SimpleDocTemplate(
        str(output_path),
        pagesize=LETTER,
        leftMargin=0.85 * inch,
        rightMargin=0.85 * inch,
        topMargin=0.85 * inch,
        bottomMargin=0.85 * inch,
    )

    body_base = ParagraphStyle(
        "DocuBody",
        parent=base_styles["Normal"],
        fontName="Helvetica",
        fontSize=11,
        leading=15.5,
        textColor=colors.HexColor("#222222"),
        spaceAfter=6,
    )

    h1_style = ParagraphStyle(
        "DocuH1",
        parent=body_base,
        fontName="Helvetica-Bold",
        fontSize=18,
        leading=23,
        spaceBefore=10,
        spaceAfter=8,
    )

    h2_style = ParagraphStyle(
        "DocuH2",
        parent=body_base,
        fontName="Helvetica-Bold",
        fontSize=14,
        leading=19,
        spaceBefore=8,
        spaceAfter=6,
    )

    h3_style = ParagraphStyle(
        "DocuH3",
        parent=body_base,
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=16,
        spaceBefore=6,
        spaceAfter=4,
    )

    # Iterate body elements in document order (paragraphs + tables)
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table as DocxTable
    from docx.text.paragraph import Paragraph as DocxParagraph

    for child in docx_doc.element.body.iterchildren():
        if isinstance(child, CT_P):
            p = DocxParagraph(child, docx_doc)
            markup = _runs_to_reportlab_markup(p)
            if not markup.strip():
                story.append(Spacer(1, 8))
                continue

            style_name = (p.style.name or "").lower() if p.style else ""
            align = ALIGN_MAP.get(p.alignment, TA_LEFT)

            if "heading 1" in style_name or style_name == "title":
                base = h1_style
            elif "heading 2" in style_name or style_name == "subtitle":
                base = h2_style
            elif "heading 3" in style_name:
                base = h3_style
            else:
                base = body_base

            if "bullet" in style_name or "list" in style_name:
                markup = f"&bull;&nbsp;&nbsp;{markup}"

            custom_style = ParagraphStyle(
                f"{base.name}_{align}",
                parent=base,
                alignment=align,
                leftIndent=18 if ("bullet" in style_name or "list" in style_name) else 0,
            )
            story.append(Paragraph(markup, custom_style))

        elif isinstance(child, CT_Tbl):
            tbl = DocxTable(child, docx_doc)
            data = []
            for row in tbl.rows:
                data.append([Paragraph(escape(cell.text.strip()), body_base) for cell in row.cells])
            if data:
                col_count = max(len(r) for r in data)
                avail_width = LETTER[0] - 1.7 * inch
                col_w = avail_width / max(1, col_count)
                rl_table = Table(data, colWidths=[col_w] * col_count)
                rl_table.setStyle(
                    TableStyle(
                        [
                            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#CCCCCC")),
                            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F5F5F5")),
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("PADDING", (0, 0), (-1, -1), 6),
                        ]
                    )
                )
                story.append(Spacer(1, 6))
                story.append(rl_table)
                story.append(Spacer(1, 10))

    if not story:
        story.append(Paragraph(" ", body_base))

    pdf_doc.build(story)
