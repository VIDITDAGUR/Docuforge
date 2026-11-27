FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DOCUFORGE_PPTX_CACHE_DIR=/tmp/docuforge_pptx_cache \
    DOCUFORGE_PPTX_MAX_UPLOAD_MB=50

# Install LibreOffice headless, Poppler (pdftoppm), fontconfig, and metric-compatible fonts:
# - Carlito / Caladea: metric-compatible replacements for Calibri / Cambria
# - Liberation: metric-compatible replacements for Arial, Times New Roman, Courier New
# - Noto: broad Unicode / international script coverage
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-impress \
    libreoffice-writer \
    poppler-utils \
    fontconfig \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
    fonts-liberation \
    fonts-noto-core \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN mkdir -p /tmp/docuforge_pptx_cache

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
