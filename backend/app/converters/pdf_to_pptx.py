from io import BytesIO
from pathlib import Path
import pymupdf as fitz
from pptx import Presentation
from pptx.util import Inches


def convert_pdf_to_pptx(pdf_path: Path, output_path: Path) -> None:
    with fitz.open(pdf_path) as pdf:
        if len(pdf) == 0:
            raise ValueError("PDF contains zero pages.")

        first_rect = pdf[0].rect
        prs = Presentation()
        prs.slide_width = Inches(first_rect.width / 72.0)
        prs.slide_height = Inches(first_rect.height / 72.0)
        blank_layout = prs.slide_layouts[6]

        for page in pdf:
            slide = prs.slides.add_slide(blank_layout)
            pix = page.get_pixmap(dpi=180, alpha=False)
            img_stream = BytesIO(pix.tobytes("png"))

            slide_w = prs.slide_width
            slide_h = prs.slide_height
            page_ratio = page.rect.width / max(1.0, page.rect.height)
            slide_ratio = float(slide_w) / max(1.0, float(slide_h))

            if page_ratio >= slide_ratio:
                pic_w = slide_w
                pic_h = int(slide_w / page_ratio)
                left = 0
                top = int((slide_h - pic_h) / 2)
            else:
                pic_h = slide_h
                pic_w = int(slide_h * page_ratio)
                top = 0
                left = int((slide_w - pic_w) / 2)

            slide.shapes.add_picture(img_stream, left, top, width=pic_w, height=pic_h)

            # Attach extracted text as speaker notes for accessibility and copy-paste
            text = page.get_text("text").strip()
            if text:
                notes_frame = slide.notes_slide.notes_text_frame
                notes_frame.text = text

        prs.save(output_path)
