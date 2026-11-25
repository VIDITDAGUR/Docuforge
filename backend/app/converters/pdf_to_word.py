from pathlib import Path
from io import BytesIO
import pymupdf as fitz
from docx import Document
from docx.shared import Inches, Pt, RGBColor


def _int_to_rgb(color_int: int) -> RGBColor:
    r = (color_int >> 16) & 0xFF
    g = (color_int >> 8) & 0xFF
    b = color_int & 0xFF
    return RGBColor(r, g, b)


def convert_pdf_to_docx(pdf_path: Path, output_path: Path) -> None:
    doc = Document()

    with fitz.open(pdf_path) as pdf:
        if len(pdf) == 0:
            raise ValueError("PDF contains zero pages.")

        for page_index, page in enumerate(pdf):
            page_dict = page.get_text("dict")
            blocks = page_dict.get("blocks", [])

            # Sort blocks top-to-bottom, left-to-right
            blocks.sort(key=lambda b: (round(b.get("bbox", [0, 0, 0, 0])[1], 1), b.get("bbox", [0, 0, 0, 0])[0]))

            for block in blocks:
                btype = block.get("type")
                if btype == 0:  # Text block
                    lines = block.get("lines", [])
                    if not lines:
                        continue

                    # Estimate dominant font size of block for heading inference
                    sizes = [
                        span.get("size", 11)
                        for line in lines
                        for span in line.get("spans", [])
                        if span.get("text", "").strip()
                    ]
                    max_size = max(sizes) if sizes else 11

                    if max_size >= 19:
                        para = doc.add_heading(level=1)
                    elif max_size >= 15:
                        para = doc.add_heading(level=2)
                    else:
                        para = doc.add_paragraph()

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
                            is_bold = bool(flags & 16) or ("bold" in font_name)
                            is_italic = bool(flags & 2) or ("italic" in font_name) or ("oblique" in font_name)
                            run.bold = is_bold
                            run.italic = is_italic
                            size = span.get("size")
                            if size and 6 <= size <= 48 and max_size < 15:
                                run.font.size = Pt(round(size, 1))
                            clr = span.get("color")
                            if isinstance(clr, int) and clr != 0:
                                run.font.color.rgb = _int_to_rgb(clr)

                elif btype == 1:  # Image block
                    img_bytes = block.get("image")
                    if img_bytes:
                        try:
                            bbox = block.get("bbox", [0, 0, 200, 150])
                            width_in = max(0.5, min(6.0, (bbox[2] - bbox[0]) / 72.0))
                            doc.add_picture(BytesIO(img_bytes), width=Inches(width_in))
                        except Exception:
                            pass

            if page_index < len(pdf) - 1:
                doc.add_page_break()

    doc.save(output_path)
