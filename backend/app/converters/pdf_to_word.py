from io import BytesIO
from pathlib import Path
import re
from PIL import Image
import pymupdf as fitz
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor


BULLET_RE = re.compile(r"^(?:[\u2022\u25cf\u25cb\u25aa\u2023\-\*]\s+|\d+[\.\)]\s+|[a-zA-Z][\.\)]\s+)")


def _int_to_rgb(color_int: int) -> RGBColor:
    r = (color_int >> 16) & 0xFF
    g = (color_int >> 8) & 0xFF
    b = color_int & 0xFF
    return RGBColor(r, g, b)


def _normalize_image_bytes(raw_bytes: bytes) -> BytesIO | None:
    try:
        with Image.open(BytesIO(raw_bytes)) as img:
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA" if "A" in img.mode else "RGB")
            out = BytesIO()
            img.save(out, format="PNG")
            out.seek(0)
            return out
    except Exception:
        return None


def _bbox_inside_any(bbox: tuple[float, float, float, float], regions: list[tuple[float, float, float, float]]) -> bool:
    cx = (bbox[0] + bbox[2]) / 2.0
    cy = (bbox[1] + bbox[3]) / 2.0
    for rx0, ry0, rx1, ry1 in regions:
        if (rx0 - 2) <= cx <= (rx1 + 2) and (ry0 - 2) <= cy <= (ry1 + 2):
            return True
    return False


def _infer_alignment(bbox: tuple[float, float, float, float], page_width: float):
    x0, _, x1, _ = bbox
    width = x1 - x0
    if width < page_width * 0.72:
        center = (x0 + x1) / 2.0
        if abs(center - page_width / 2.0) < page_width * 0.08 and x0 > page_width * 0.15:
            return WD_ALIGN_PARAGRAPH.CENTER
        if x0 > page_width * 0.52 and x1 > page_width * 0.78:
            return WD_ALIGN_PARAGRAPH.RIGHT
    return WD_ALIGN_PARAGRAPH.LEFT


def _add_spans_to_paragraph(para, lines: list[dict], heading_level: int) -> None:
    for line_idx, line in enumerate(lines):
        spans = line.get("spans", [])
        if line_idx > 0 and spans:
            para.add_run(" ")
        for span in spans:
            text = span.get("text", "")
            if not text:
                continue
            run = para.add_run(text)
            flags = span.get("flags", 0)
            font_name = (span.get("font") or "").lower()
            is_bold = bool(flags & 16) or ("bold" in font_name) or ("black" in font_name)
            is_italic = bool(flags & 2) or ("italic" in font_name) or ("oblique" in font_name)
            run.bold = is_bold
            run.italic = is_italic
            size = span.get("size")
            if size and 6 <= size <= 48 and heading_level == 0:
                run.font.size = Pt(round(size, 1))
            clr = span.get("color")
            if isinstance(clr, int) and clr not in (0, 0x000000):
                run.font.color.rgb = _int_to_rgb(clr)


def _split_block_into_line_groups(lines: list[dict], block_x0: float) -> list[list[dict]]:
    groups: list[list[dict]] = []
    current: list[dict] = []
    prev_y1: float | None = None
    prev_x1: float | None = None

    for line in lines:
        spans = [s for s in line.get("spans", []) if s.get("text", "")]
        if not spans:
            continue
        line_text = "".join(s.get("text", "") for s in spans).strip()
        if not line_text:
            continue

        lb = line.get("bbox", (block_x0, 0.0, block_x0 + 100.0, 12.0))
        lx0, ly0, lx1, ly1 = lb
        line_h = max(8.0, ly1 - ly0)

        start_new = False
        if current:
            if BULLET_RE.match(line_text):
                start_new = True
            elif prev_y1 is not None and (ly0 - prev_y1) > line_h * 0.55:
                start_new = True
            elif abs(lx0 - block_x0) > 18 and prev_x1 is not None and (lx1 - lx0) < 260:
                start_new = True

        if start_new:
            groups.append(current)
            current = [line]
        else:
            current.append(line)

        prev_y1 = ly1
        prev_x1 = lx1

    if current:
        groups.append(current)
    return groups


def convert_pdf_to_docx(pdf_path: Path, output_path: Path) -> None:
    doc = Document()

    with fitz.open(pdf_path) as pdf:
        if len(pdf) == 0:
            raise ValueError("PDF contains zero pages.")

        for page_index, page in enumerate(pdf):
            page_width = float(page.rect.width or 612.0)

            # 1. Detect structured tables first
            table_regions: list[tuple[float, float, float, float]] = []
            items: list[tuple[float, float, str, object]] = []

            try:
                found_tables = page.find_tables()
                for tbl in found_tables.tables:
                    rows_data = tbl.extract()
                    if not rows_data:
                        continue
                    # Ignore single-cell empty artifacts
                    non_empty = sum(1 for r in rows_data for c in r if c and str(c).strip())
                    if non_empty == 0:
                        continue
                    bbox = tuple(tbl.bbox)
                    table_regions.append(bbox)
                    items.append((round(bbox[1], 1), bbox[0], "table", rows_data))
            except Exception:
                pass

            # 2. Extract text & image blocks outside detected tables
            page_dict = page.get_text("dict")
            blocks = page_dict.get("blocks", [])
            has_text = False
            has_images = False

            for block in blocks:
                btype = block.get("type")
                bbox = tuple(block.get("bbox", (0.0, 0.0, 0.0, 0.0)))

                if btype == 0:
                    if _bbox_inside_any(bbox, table_regions):
                        continue
                    lines = block.get("lines", [])
                    if lines:
                        has_text = True
                        items.append((round(bbox[1], 1), bbox[0], "text", (bbox, lines)))
                elif btype == 1:
                    img_bytes = block.get("image")
                    if img_bytes:
                        has_images = True
                        items.append((round(bbox[1], 1), bbox[0], "image", (bbox, img_bytes)))

            # 3. Fallback for scanned / vector-only pages with no extracted text or images
            if not has_text and not has_images and not table_regions:
                pix = page.get_pixmap(dpi=150, alpha=False)
                norm = _normalize_image_bytes(pix.tobytes("png"))
                if norm:
                    doc.add_picture(norm, width=Inches(min(6.3, page_width / 72.0)))
            else:
                items.sort(key=lambda item: (item[0], item[1]))

                for _, _, kind, payload in items:
                    if kind == "table":
                        rows_data = payload  # type: ignore[assignment]
                        col_count = max(len(r) for r in rows_data)
                        if col_count == 0:
                            continue
                        word_table = doc.add_table(rows=len(rows_data), cols=col_count)
                        word_table.style = "Table Grid"
                        for r_idx, row in enumerate(rows_data):
                            for c_idx in range(col_count):
                                val = row[c_idx] if c_idx < len(row) and row[c_idx] is not None else ""
                                clean_val = re.sub(r"\s+", " ", str(val)).strip()
                                cell = word_table.cell(r_idx, c_idx)
                                cell.text = clean_val
                                if r_idx == 0 and cell.paragraphs and cell.paragraphs[0].runs:
                                    cell.paragraphs[0].runs[0].bold = True
                        doc.add_paragraph("")

                    elif kind == "text":
                        bbox, lines = payload  # type: ignore[misc]
                        line_groups = _split_block_into_line_groups(lines, bbox[0])
                        align = _infer_alignment(bbox, page_width)

                        for grp in line_groups:
                            sizes = [
                                s.get("size", 11)
                                for ln in grp
                                for s in ln.get("spans", [])
                                if s.get("text", "").strip()
                            ]
                            max_size = max(sizes) if sizes else 11
                            first_text = "".join(s.get("text", "") for s in grp[0].get("spans", [])).strip()

                            heading_level = 0
                            if max_size >= 18.5 and len(grp) <= 2:
                                heading_level = 1
                                para = doc.add_heading(level=1)
                            elif max_size >= 14.5 and len(grp) <= 2:
                                heading_level = 2
                                para = doc.add_heading(level=2)
                            elif BULLET_RE.match(first_text):
                                is_num = bool(re.match(r"^\d+[\.\)]\s+", first_text))
                                para = doc.add_paragraph(style="List Number" if is_num else "List Bullet")
                            else:
                                para = doc.add_paragraph()

                            para.alignment = align
                            _add_spans_to_paragraph(para, grp, heading_level)

                    elif kind == "image":
                        bbox, img_bytes = payload  # type: ignore[misc]
                        norm = _normalize_image_bytes(img_bytes)
                        if norm:
                            width_in = max(0.5, min(6.2, (bbox[2] - bbox[0]) / 72.0))
                            doc.add_picture(norm, width=Inches(width_in))

            if page_index < len(pdf) - 1:
                doc.add_page_break()

    doc.save(output_path)
