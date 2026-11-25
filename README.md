# DOCUFORGE

DOCUFORGE is a free, open-source document utility workspace designed for college students and academic workflows. It provides 12 functional tools for converting, viewing, editing, and resizing PDF, Word (`.docx`), PowerPoint (`.pptx`), and image files with a minimal monochrome interface.

## Features (12 Tools)

### Document Conversion
1. **PDF to Word** — Extracts text, headings, styling, and embedded images from PDFs into editable `.docx` files.
2. **Word to PDF** — Converts `.docx` paragraphs, headings, lists, and tables into vector `.pdf` files.
3. **PDF to PowerPoint** — Converts PDF pages into `.pptx` slides preserving page dimensions and visual appearance, with extracted text attached as slide notes.
4. **PowerPoint to PDF** — Converts `.pptx` slides into multi-page `.pdf` documents preserving slide dimensions, shapes, images, and text.
5. **Image to PDF** — Combines multiple JPG, JPEG, PNG, and WebP images with custom ordering and page sizing locally in the browser.
6. **PDF to Image** — Renders PDF pages into PNG or JPG images locally with individual downloads or bulk ZIP export.

### Document Viewers
7. **PDF Viewer** — Page navigation, zoom controls, fit-to-page, and original download (local in browser).
8. **PPTX Viewer** — Parses and renders `.pptx` slides with slide navigation and fullscreen presentation mode (local in browser).

### Document Editors
9. **Word Editor** — Rich-text document editor supporting headings, bold/italic/underline, alignment, bullet/numbered lists, `.docx` import, and `.docx` / `.pdf` export.
10. **PDF Editor** — Add text, highlights, annotation notes, freehand drawings, and rectangles/circles directly onto PDF pages and download the edited PDF.
11. **PPTX Editor** — Create or open `.pptx` decks, add/delete slides, insert text boxes and shapes, change slide backgrounds, and export to `.pptx`.

### PDF Utilities
12. **PDF Resizer** — Resize PDF pages to A4, A3, A5, US Letter, or custom dimensions (`mm`, `in`, `pt`) while preserving content proportions.

## Privacy & Security

- **Local Processing:** PDF Viewer, PPTX Viewer, Image to PDF, PDF to Image, PDF Resizer, PDF Editor, PPTX Editor, and Word Editor (DOCX export) execute completely in your browser. Files never leave your device.
- **Stateless Backend Processing:** Server-side conversions validate file extensions, magic-byte signatures, archive structure, and upload size limits (`DOCUFORGE_MAX_UPLOAD_MB`). Files are processed in isolated temporary directories and deleted immediately once the response completes.
- **No Accounts or Tracking:** DOCUFORGE does not store documents or collect personal information.

## Tech Stack & Dependencies

### Frontend (`/frontend`)
- **React 18 + TypeScript + Vite + Tailwind CSS v4**
- `pdfjs-dist` — Client-side PDF rendering
- `pdf-lib` — Client-side PDF generation, page resizing, and annotation baking
- `jszip` — ZIP archive generation and `.pptx` OpenXML extraction
- `mammoth` — `.docx` import into HTML for the Word Editor
- `docx` — Client-side `.docx` generation
- `pptxgenjs` — Client-side `.pptx` generation
- `lucide-react` — Minimal monochrome icons

### Backend (`/backend`)
- **Python FastAPI + Uvicorn**
- `pymupdf` (`fitz`) — PDF text/image extraction and page rendering
- `python-docx` — Reading and writing `.docx` files
- `python-pptx` — Reading and writing `.pptx` files
- `reportlab` — Vector PDF generation
- `pillow` — Image handling

## Local Development

### Prerequisites
- Node.js 20+ and npm
- Python 3.11+

### 1. Backend Setup
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### 2. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` requests to `http://127.0.0.1:8000`.

### 3. Running Tests & Production Build
```bash
# Backend tests
cd backend
.venv/bin/pytest

# Frontend typecheck & production build
cd frontend
npm run build
```

## Production Deployment

1. Copy `.env.example` and configure `DOCUFORGE_MAX_UPLOAD_MB` and `DOCUFORGE_CORS_ORIGINS`.
2. Build the frontend (`cd frontend && npm run build`) and serve `frontend/dist/` via Nginx, Caddy, or Cloudflare Pages.
3. Run the backend with Uvicorn/Gunicorn (`uvicorn app.main:app --host 0.0.0.0 --port 8000`) and reverse-proxy `/api/` to it (or set `VITE_API_BASE_URL` at build time if hosted on a separate origin).

## License

MIT License — see [LICENSE](LICENSE).
