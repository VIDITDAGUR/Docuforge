from html import escape
from pathlib import Path
from typing import List, Literal, Optional
from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


class EditorBlock(BaseModel):
    kind: Literal["h1", "h2", "h3", "p", "ul_item", "ol_item", "table"] = "p"
    align: Literal["left", "center", "right", "justify"] = "left"
    runs: List[dict] = []
    text: str = ""
    index: int = 1
    rows: Optional[List[List[str]]] = None


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
    avail_w = LETTER[0] - 1.7 * inch

    for block in blocks:
        if block.kind == "table" and block.rows:
            data = []
            for r_idx, row in enumerate(block.rows):
                cell_style = ParagraphStyle(
                    f"TblCell_{r_idx == 0}",
                    parent=body_base,
                    fontName="Helvetica-Bold" if r_idx == 0 else "Helvetica",
                    fontSize=10,
                    leading=13,
                    spaceAfter=0,
                )
                data.append([Paragraph(escape(str(c or "")), cell_style) for c in row])
            if data:
                col_count = max(len(r) for r in data)
                col_w = avail_w / max(1, col_count)
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
            continue

        parts = []
        for run in block.runs:
            txt = escape(str(run.get("text", "")))
            if not txt:
                continue
            if run.get("color"):
                txt = f'<font color="{escape(str(run["color"]))}">{txt}</font>'
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
