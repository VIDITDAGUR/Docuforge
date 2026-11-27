# DOCUFORGE

DOCUFORGE is a free, open-source document utility workspace designed for college students and academic workflows. It provides **14 functional tools** for converting, viewing, editing, compressing, resizing, and generating notebook-ready answers for PDF, Word (`.docx`), PowerPoint (`.pptx`), and image files with a minimal sharp-edge interface.

## Implemented Tools (14)

### Document Conversion
1. **PDF to Word** — Extracts text blocks, headings, styling, tables, lists, and images into `.docx` (FastAPI + PyMuPDF).
2. **Word to PDF** — Converts `.docx` files into PDF via LibreOffice headless (when installed) or ReportLab fallback.
3. **PDF to PowerPoint** — Converts PDF pages into `.pptx` slides preserving page dimensions and appearance, with extracted text in speaker notes.
4. **Image to PDF** — Combines ordered JPG, JPEG, PNG, and WebP images locally in the browser.
5. **PDF to Image** — Renders PDF pages into PNG or JPG images locally with per-page or ZIP downloads.

### Document Viewers
6. **PDF Viewer** — Page navigation, zoom, fit-to-page, and original download (local in browser via PDF.js).
7. **PPTX Viewer (High Fidelity)** — Uploads `.pptx` (up to 50 MB) to FastAPI, converts via **LibreOffice headless** (`soffice`) + **Poppler** (`pdftoppm -png -r 150`), caches per-slide PNGs by SHA-256 hash, and presents slides in a responsive 16:9 / aspect-preserving slideshow viewer with lazy-loaded thumbnails, keyboard arrows, mobile touch swipe, and fullscreen mode.

### Document Editors
8. **Word Editor** — Rich-text editor supporting headings, bold/italic/underline, color, alignment, lists, tables, `.docx` OpenXML import, and `.docx`/`.pdf` export.
9. **PDF Editor** — Add text, highlights, notes, freehand drawings, and shapes directly onto PDF pages and export.

### PDF, Document & Image Utilities
10. **PDF Resizer** — Resize PDF pages to A4, A3, A5, US Letter, or custom dimensions (`mm`, `in`, `pt`).
11. **PDF Compressor** — Shrink PDF size with percentage (`10%–85%`) compression control.
12. **Word Compressor** — Optimize embedded `.docx` media and ZIP deflate level with percentage (`10%–85%`) control.
13. **Image Compressor** — Compress JPG, PNG, and WebP images locally in the browser with `%` control and ZIP export.
14. **Assignment Answer Generator** — Upload an assignment sheet (PDF, `.docx`, `.png`, `.jpg`), review and confirm extracted questions & marks, generate course-tailored answers via Google Gemini sized by marks (`30–40 words/mark` default), and export notebook-ready PDF or `.docx` with page headers.

## Marks-Based Assignment Answer Generator Setup & Customization

### 1. Configure `GEMINI_API_KEY`
1. Get an API key from [Google AI Studio](https://aistudio.google.com/).
2. Copy `.env.example` to `.env` (already in `.gitignore`):
   ```bash
   cp .env.example .env
   ```
3. Add your key and optional model override in `.env`:
   ```dotenv
   GEMINI_API_KEY=your_actual_key_here
   DOCUFORGE_GEMINI_MODEL=gemini-3.8-flash
   ```
   Supported models configurable via `DOCUFORGE_GEMINI_MODEL` or the UI include `gemini-3.8-flash` (default) and `gemini-3.5-flash-lite`.

### 2. Adding a New Course Preset
All course sections (`B.Tech`, `Commerce`, `Management`, `Computer Applications`, `Design`, `Science`, `Arts and Humanities`, `Law`, `Other`) live in `backend/app/assignment/presets_config.json`. Add a new object under `"presets"`:
```json
{
  "id": "science-biochem",
  "course_name": "B.Sc Biochemistry",
  "section": "Science",
  "tone_style_notes": "Precise biochemical pathways, enzyme kinetics, and balanced reactions.",
  "answer_format_rules": "Include pathway diagrams described in words, key enzymes, and clinical relevance.",
  "words_per_mark_min": 30,
  "words_per_mark_max": 40
}
```
Restart the backend (or run tests) to load the new preset into the UI dropdown automatically.

### 3. Changing the Word-per-Mark Rule
- **Global / per-preset defaults:** Change `default_words_per_mark_min` / `default_words_per_mark_max` (or `words_per_mark_min` / `words_per_mark_max` on any preset) in `backend/app/assignment/presets_config.json`, or override them directly in the UI's Length & Model Settings.
- **Exact mark overrides:** Populate `"explicit_overrides"` (at the root of `presets_config.json` or inside a specific preset) so specific mark values bypass the `marks * min..max` formula:
  ```json
  "explicit_overrides": {
    "7": [210, 250],
    "11": [350, 420]
  }
  ```
- **Numerical / derivation / code questions:** Word-count limits apply strictly to the explanation prose; calculation lines and code blocks are excluded from word validation while remaining intact in the exported notebook sheet.

## High-Fidelity PPTX Viewer Architecture

DOCUFORGE deliberately **does not parse PPTX in the browser** for slide viewing:

1. **Upload & Validation (`POST /api/upload`):** Accepts `.pptx` only (extension check, MIME check, 50 MB size limit, `PK` ZIP + `ppt/presentation.xml` validation), sanitizes filenames, and computes the **SHA-256** digest while streaming.
2. **SHA-256 Cache Hit:** If `DOCUFORGE_PPTX_CACHE_DIR/<sha256>/` already holds rendered PNGs, returns `status: "done"` and slide URLs immediately.
3. **Background Job (`GET /api/jobs/{job_id}`):** On cache miss, spawns a background conversion job (`pending` → `processing` → `done` / `failed`):
   - Inspects `.pptx` XML for declared `typeface` names and logs warnings for fonts missing on the host.
   - Runs `soffice --headless --convert-to pdf` with a unique `-env:UserInstallation=file:///tmp/lo_<uuid>` profile and 120 s timeout.
   - Runs `pdftoppm -png -r 150` to produce `slide-001.png`, `slide-002.png`, etc., and cleans up temp workspaces and LibreOffice profiles.
4. **Immutable Slide Serving (`GET /api/slides/{hash}/{n}.png`):** Serves cached slide PNGs with `Cache-Control: public, max-age=31536000, immutable`.

### PPTX Viewer Fidelity & Limitations
- **Not preserved in static PNG rendering:** Slide animations, slide transitions, and embedded audio/video playback are not preserved.
- **Font fidelity:** Install metric-compatible fonts (`Carlito` for Calibri, `Caladea` for Cambria, `Liberation` for Arial/Times New Roman, and `Noto`) so text lines do not wrap differently or overflow boxes. Any missing fonts are logged on the backend and surfaced in the viewer notice.
- **Complex Office constructs:** Certain proprietary Microsoft SmartArt layouts, 3D effects/shadows, or custom chart themes may render slightly differently under LibreOffice Impress compared to desktop PowerPoint.

## Setup & Installation

### 1. System Dependencies (Ubuntu / Debian)
Run the included setup script to install LibreOffice headless, Poppler (`pdftoppm`), and metric-compatible fonts:
```bash
chmod +x scripts/setup_pptx_server.sh
./scripts/setup_pptx_server.sh
```

### 2. Backend Setup
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### 3. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```
Open `http://localhost:5173`. Vite proxies `/api/*` to `http://127.0.0.1:8000`.

### 4. Docker (Backend with LibreOffice, Poppler & Fonts)
```bash
cd backend
docker build -t docuforge-backend .
docker run -d -p 8000:8000 -e DOCUFORGE_CORS_ORIGINS="*" docuforge-backend
```

### 5. Running Tests & Production Build
```bash
# Backend tests (API + PPTX viewer validation, cache, and mocked conversion)
cd backend
.venv/bin/pytest -v

# Frontend typecheck & production build
cd frontend
npm run build
```

> [!NOTE]
> If deploying behind Nginx, set `client_max_body_size 55M;` in your `/etc/nginx/sites-available/docuforge` block so 50 MB `.pptx` uploads are accepted.

## License

MIT License — see [LICENSE](LICENSE).
