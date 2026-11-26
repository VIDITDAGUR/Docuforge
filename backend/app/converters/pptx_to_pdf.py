from html import escape
from io import BytesIO
from pathlib import Path
from PIL import Image
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE, MSO_SHAPE_TYPE
from pptx.enum.text import PP_ALIGN
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle
from .libreoffice import convert_with_libreoffice


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
        s = str(rgb)
        return f"#{s}" if not s.startswith("#") else s
    except Exception:
        return None


def _extract_fill_hex(fill) -> str | None:
    try:
        if fill.type is None:
            return None
        if hasattr(fill, "fore_color") and fill.fore_color and fill.fore_color.rgb is not None:
            return _rgb_hex(fill.fore_color.rgb)
        if hasattr(fill, "gradient_stops") and len(fill.gradient_stops) > 0:
            stop = fill.gradient_stops[0]
            if stop.color and stop.color.rgb is not None:
                return _rgb_hex(stop.color.rgb)
    except Exception:
        pass
    return None


def _normalize_image_stream(blob: bytes) -> BytesIO | None:
    try:
        with Image.open(BytesIO(blob)) as img:
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA" if "A" in img.mode else "RGB")
            out = BytesIO()
            img.save(out, format="PNG")
            out.seek(0)
            return out
    except Exception:
        return None


def _render_shape(
    c: canvas.Canvas,
    shape,
    slide_h_pt: float,
    offset_x_pt: float = 0.0,
    offset_y_pt: float = 0.0,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
) -> None:
    x_pt = offset_x_pt + _emu_to_pt(shape.left) * scale_x
    y_top_pt = offset_y_pt + _emu_to_pt(shape.top) * scale_y
    w_pt = max(1.0, _emu_to_pt(shape.width) * scale_x)
    h_pt = max(1.0, _emu_to_pt(shape.height) * scale_y)
    y_bot_pt = slide_h_pt - y_top_pt - h_pt

    # 1. Grouped shapes: recursively render children mapped into group bounds
    if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        try:
            sp = shape._element.grpSpPr.xfrm
            ch_off_x = _emu_to_pt(int(sp.chOff.x))
            ch_off_y = _emu_to_pt(int(sp.chOff.y))
            ch_ext_cx = max(1.0, _emu_to_pt(int(sp.chExt.cx)))
            ch_ext_cy = max(1.0, _emu_to_pt(int(sp.chExt.cy)))
            grp_sx = w_pt / ch_ext_cx
            grp_sy = h_pt / ch_ext_cy
        except Exception:
            ch_off_x, ch_off_y, grp_sx, grp_sy = 0.0, 0.0, 1.0, 1.0

        for child in shape.shapes:
            _render_shape(
                c,
                child,
                slide_h_pt,
                offset_x_pt=x_pt - ch_off_x * grp_sx,
                offset_y_pt=y_top_pt - ch_off_y * grp_sy,
                scale_x=grp_sx,
                scale_y=grp_sy,
            )
        return

    # 2. Picture
    if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
        try:
            stream = _normalize_image_stream(shape.image.blob)
            if stream:
                img_reader = ImageReader(stream)
                c.drawImage(
                    img_reader,
                    x_pt,
                    y_bot_pt,
                    width=w_pt,
                    height=h_pt,
                    preserveAspectRatio=True,
                    mask="auto",
                )
        except Exception:
            pass
        return

    # 3. Table
    if getattr(shape, "has_table", False):
        try:
            tbl = shape.table
            col_widths = [max(16.0, _emu_to_pt(col.width) * scale_x) for col in tbl.columns]
            total_cw = sum(col_widths) or w_pt
            col_widths = [cw * (w_pt / total_cw) for cw in col_widths]
            data = []
            for r_idx, row in enumerate(tbl.rows):
                row_cells = []
                for cell in row.cells:
                    p_style = ParagraphStyle(
                        f"PptxTbl_{r_idx == 0}",
                        fontName="Helvetica-Bold" if r_idx == 0 else "Helvetica",
                        fontSize=9,
                        leading=11.5,
                        textColor=colors.HexColor("#222222"),
                    )
                    row_cells.append(Paragraph(escape(cell.text.strip()), p_style))
                data.append(row_cells)
            if data:
                rl_tbl = Table(data, colWidths=col_widths)
                rl_tbl.setStyle(
                    TableStyle(
                        [
                            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#999999")),
                            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAEAEA")),
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("PADDING", (0, 0), (-1, -1), 4),
                        ]
                    )
                )
                _, tbl_h = rl_tbl.wrapOn(c, w_pt, h_pt)
                rl_tbl.drawOn(c, x_pt, slide_h_pt - y_top_pt - tbl_h)
        except Exception:
            pass
        return

    # 4. Line / Connector
    if shape.shape_type == MSO_SHAPE_TYPE.LINE:
        line_hex = "#222222"
        try:
            if shape.line.color and shape.line.color.rgb:
                line_hex = _rgb_hex(shape.line.color.rgb) or line_hex
        except Exception:
            pass
        c.setStrokeColor(colors.HexColor(line_hex))
        c.setLineWidth(1.2)
        c.line(x_pt, slide_h_pt - y_top_pt, x_pt + w_pt, slide_h_pt - (y_top_pt + h_pt))
        return

    # 5. Shape fill / outline
    fill_hex = _extract_fill_hex(shape.fill) if hasattr(shape, "fill") else None
    line_hex = None
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
        is_ellipse = False
        try:
            if hasattr(shape, "auto_shape_type") and shape.auto_shape_type == MSO_SHAPE.OVAL:
                is_ellipse = True
        except Exception:
            pass

        if is_ellipse:
            c.ellipse(
                x_pt,
                y_bot_pt,
                x_pt + w_pt,
                y_bot_pt + h_pt,
                stroke=1 if line_hex else 0,
                fill=1 if fill_hex else 0,
            )
        else:
            c.rect(
                x_pt,
                y_bot_pt,
                w_pt,
                h_pt,
                stroke=1 if line_hex else 0,
                fill=1 if fill_hex else 0,
            )

    # 6. Text frame
    if getattr(shape, "has_text_frame", False):
        curr_y = slide_h_pt - y_top_pt - 4
        for para in shape.text_frame.paragraphs:
            text = para.text or ""
            if not text.strip():
                curr_y -= 12
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
            _, used_h = rl_p.wrap(max(20.0, w_pt - 8), max(20.0, h_pt + 20))
            curr_y -= used_h
            rl_p.drawOn(c, x_pt + 4, curr_y)
            curr_y -= 4


def convert_pptx_to_pdf(pptx_path: Path, output_path: Path) -> None:
    if convert_with_libreoffice(pptx_path, output_path, "pdf"):
        return

    prs = Presentation(pptx_path)
    slide_w_pt = _emu_to_pt(prs.slide_width) or 960.0
    slide_h_pt = _emu_to_pt(prs.slide_height) or 540.0

    c = canvas.Canvas(str(output_path), pagesize=(slide_w_pt, slide_h_pt))

    for slide in prs.slides:
        bg_hex = "#FFFFFF"
        try:
            parsed_bg = _extract_fill_hex(slide.background.fill)
            if parsed_bg:
                bg_hex = parsed_bg
        except Exception:
            pass

        c.setFillColor(colors.HexColor(bg_hex))
        c.rect(0, 0, slide_w_pt, slide_h_pt, stroke=0, fill=1)

        for shape in slide.shapes:
            _render_shape(c, shape, slide_h_pt)

        c.showPage()

    c.save()
