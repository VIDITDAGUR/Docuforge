import os
from pathlib import Path
import tempfile
from dotenv import load_dotenv

_ROOT_DIR = Path(__file__).resolve().parents[2]
_BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(_ROOT_DIR / ".env", override=False)
load_dotenv(_BACKEND_DIR / ".env", override=False)

MAX_UPLOAD_MB = int(os.getenv("DOCUFORGE_MAX_UPLOAD_MB", "30"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

PPTX_MAX_UPLOAD_MB = int(os.getenv("DOCUFORGE_PPTX_MAX_UPLOAD_MB", "50"))
PPTX_MAX_UPLOAD_BYTES = PPTX_MAX_UPLOAD_MB * 1024 * 1024

PPTX_CACHE_DIR = Path(
    os.getenv(
        "DOCUFORGE_PPTX_CACHE_DIR",
        str(Path(tempfile.gettempdir()) / "docuforge_pptx_cache"),
    )
)

ASSIGNMENT_MAX_UPLOAD_MB = int(os.getenv("DOCUFORGE_ASSIGNMENT_MAX_UPLOAD_MB", "20"))
ASSIGNMENT_MAX_UPLOAD_BYTES = ASSIGNMENT_MAX_UPLOAD_MB * 1024 * 1024

ASSIGNMENT_CACHE_DIR = Path(
    os.getenv(
        "DOCUFORGE_ASSIGNMENT_CACHE_DIR",
        str(Path(tempfile.gettempdir()) / "docuforge_assignment_cache"),
    )
)

GEMINI_MODEL = os.getenv("DOCUFORGE_GEMINI_MODEL", "gemini-3.5-flash-lite")


def get_gemini_api_key() -> str | None:
    """Return the configured Google Gemini API key from environment, if present."""
    key = os.getenv("GEMINI_API_KEY", "").strip()
    return key or None


RAW_ORIGINS = os.getenv(
    "DOCUFORGE_CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173",
)
ALLOWED_ORIGINS = [o.strip() for o in RAW_ORIGINS.split(",") if o.strip()]
