from html import escape
from pathlib import Path
from typing import List, Literal
from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


class EditorBlock(BaseModel):
    kind: Literal["h1", "h2", "h3", "p", "ul_item", "ol_item"] = "p"
    align: Literal["left", "center", "right", "justify"] = "left"
    runs: List[dict] = []
    text: str = ""
    index: int = 1


ALIGN_MAP = {
    "left": TA_LEFT,
    "center": TA_CENTER,
    "right": TA_RIGHT,
    "justify": TA_JUSTIFY,
}


def render_editor_blocks_to_pdf(blocks: List[EditorBlock], output_path: Path) -> None:
    base_styles = getSampleStyleSheet()
    pdf_doc = SimpleDocTemplate(
        str(output_path),
        pagesize=LETTER,
        leftMargin=0.85 * inch,
        rightMargin=0.85 * inch,
        topMargin=0.85 * inch,
        bottomMargin=0.85 * inch,
    )

    body_base = ParagraphStyle(
        "EditorBody",
        parent=base_styles["Normal"],
        fontName="Helvetica",
        fontSize=11,
        leading=16,
        textColor=colors.HexColor("#222222"),
        spaceAfter=6,
    )

    story = []
    for block in blocks:
        parts = []
        for run in block.runs:
            txt = escape(str(run.get("text", "")))
            if not txt:
                continue
            if run.get("bold"):
                txt = f"<b>{txt}</b>"
            if run.get("italic"):
                txt = f"<i>{txt}</i>"
            if run.get("underline"):
                txt = f"<u>{txt}</u>"
            parts.append(txt)

        markup = "".join(parts) or escape(block.text)
        if not markup.strip():
            story.append(Spacer(1, 8))
            continue

        align = ALIGN_MAP.get(block.align, TA_LEFT)
        font_name = "Helvetica"
        font_size = 11
        leading = 16
        space_before = 0
        space_after = 6
        left_indent = 0

        if block.kind == "h1":
            font_name, font_size, leading, space_before, space_after = "Helvetica-Bold", 18, 23, 10, 8
        elif block.kind == "h2":
            font_name, font_size, leading, space_before, space_after = "Helvetica-Bold", 14, 19, 8, 6
        elif block.kind == "h3":
            font_name, font_size, leading, space_before, space_after = "Helvetica-Bold", 12, 16, 6, 4
        elif block.kind == "ul_item":
            markup = f"&bull;&nbsp;&nbsp;{markup}"
            left_indent = 18
        elif block.kind == "ol_item":
            markup = f"{block.index}.&nbsp;&nbsp;{markup}"
            left_indent = 18

        style = ParagraphStyle(
            f"Blk_{block.kind}_{align}",
            parent=body_base,
            fontName=font_name,
            fontSize=font_size,
            leading=leading,
            alignment=align,
            spaceBefore=space_before,
            spaceAfter=space_after,
            leftIndent=left_indent,
        )
        story.append(Paragraph(markup, style))

    if not story:
        story.append(Paragraph(" ", body_base))

    pdf_doc.build(story)
