from html import escape
from io import BytesIO
from pathlib import Path
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.enum.text import PP_ALIGN
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


EMU_PER_PT = 12700.0

ALIGN_MAP = {
    PP_ALIGN.LEFT: TA_LEFT,
    PP_ALIGN.CENTER: TA_CENTER,
    PP_ALIGN.RIGHT: TA_RIGHT,
    PP_ALIGN.JUSTIFY: TA_JUSTIFY,
}


def _emu_to_pt(val: int | None) -> float:
    return float(val or 0) / EMU_PER_PT


def _rgb_hex(rgb) -> str | None:
    if rgb is None:
        return None
    try:
        return f"#{str(rgb)}"
    except Exception:
        return None


def _extract_fill_hex(fill) -> str | None:
    try:
        if fill.type is not None and hasattr(fill, "fore_color") and fill.fore_color:
            if fill.fore_color.rgb is not None:
                return _rgb_hex(fill.fore_color.rgb)
    except Exception:
        pass
    return None


def convert_pptx_to_pdf(pptx_path: Path, output_path: Path) -> None:
    prs = Presentation(pptx_path)
    slide_w_pt = _emu_to_pt(prs.slide_width) or 960.0
    slide_h_pt = _emu_to_pt(prs.slide_height) or 540.0

    c = canvas.Canvas(str(output_path), pagesize=(slide_w_pt, slide_h_pt))

    for slide in prs.slides:
        # Slide background
        bg_hex = "#FFFFFF"
        try:
            bg_fill = slide.background.fill
            parsed_bg = _extract_fill_hex(bg_fill)
            if parsed_bg:
                bg_hex = parsed_bg
        except Exception:
            pass

        c.setFillColor(colors.HexColor(bg_hex))
        c.rect(0, 0, slide_w_pt, slide_h_pt, stroke=0, fill=1)

        for shape in slide.shapes:
            x_pt = _emu_to_pt(shape.left)
            w_pt = max(1.0, _emu_to_pt(shape.width))
            h_pt = max(1.0, _emu_to_pt(shape.height))
            y_top_pt = _emu_to_pt(shape.top)
            y_bot_pt = slide_h_pt - y_top_pt - h_pt

            # Picture
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                try:
                    img_reader = ImageReader(BytesIO(shape.image.blob))
                    c.drawImage(img_reader, x_pt, y_bot_pt, width=w_pt, height=h_pt, preserveAspectRatio=True, mask="auto")
                except Exception:
                    pass
                continue

            # Shape fill / outline
            fill_hex = None
            line_hex = None
            if hasattr(shape, "fill"):
                fill_hex = _extract_fill_hex(shape.fill)
            if hasattr(shape, "line"):
                try:
                    if shape.line.color and shape.line.color.rgb:
                        line_hex = _rgb_hex(shape.line.color.rgb)
                except Exception:
                    pass

            if fill_hex or line_hex:
                if fill_hex:
                    c.setFillColor(colors.HexColor(fill_hex))
                if line_hex:
                    c.setStrokeColor(colors.HexColor(line_hex))
                c.rect(
                    x_pt,
                    y_bot_pt,
                    w_pt,
                    h_pt,
                    stroke=1 if line_hex else 0,
                    fill=1 if fill_hex else 0,
                )

            # Text frame
            if getattr(shape, "has_text_frame", False):
                curr_y = slide_h_pt - y_top_pt - 4
                for para in shape.text_frame.paragraphs:
                    text = para.text or ""
                    if not text.strip():
                        curr_y -= 14
                        continue

                    align = ALIGN_MAP.get(para.alignment, TA_LEFT)
                    font_size = 16.0
                    text_color = "#222222"
                    markup_parts = []

                    for run in para.runs:
                        r_txt = escape(run.text or "")
                        if not r_txt:
                            continue
                        if run.font.size:
                            font_size = max(8.0, min(64.0, run.font.size.pt))
                        try:
                            if run.font.color and run.font.color.rgb:
                                text_color = _rgb_hex(run.font.color.rgb) or text_color
                        except Exception:
                            pass
                        if run.font.bold:
                            r_txt = f"<b>{r_txt}</b>"
                        if run.font.italic:
                            r_txt = f"<i>{r_txt}</i>"
                        markup_parts.append(r_txt)

                    markup = "".join(markup_parts) or escape(text)
                    p_style = ParagraphStyle(
                        "SlidePara",
                        fontName="Helvetica",
                        fontSize=font_size,
                        leading=font_size * 1.25,
                        textColor=colors.HexColor(text_color),
                        alignment=align,
                    )
                    rl_p = Paragraph(markup, p_style)
                    _, used_h = rl_p.wrap(max(20.0, w_pt - 8), max(20.0, h_pt))
                    curr_y -= used_h
                    rl_p.drawOn(c, x_pt + 4, curr_y)
                    curr_y -= 4

        c.showPage()

    c.save()
