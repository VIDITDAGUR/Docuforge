import os
from pathlib import Path
import tempfile

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

RAW_ORIGINS = os.getenv(
    "DOCUFORGE_CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173",
)
ALLOWED_ORIGINS = [o.strip() for o in RAW_ORIGINS.split(",") if o.strip()]
