#!/usr/bin/env bash
set -euo pipefail

echo "Installing LibreOffice headless, Poppler (pdftoppm), and metric-compatible fonts..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libreoffice-impress \
  libreoffice-writer \
  poppler-utils \
  fontconfig \
  fonts-crosextra-carlito \
  fonts-crosextra-caladea \
  fonts-liberation \
  fonts-noto-core

sudo fc-cache -fv

echo "Done. Verify installed tools:"
soffice --version
pdftoppm -v 2>&1 | head -n 1
echo "Note: Ensure Nginx sets 'client_max_body_size 55M;' to match the 50 MB PPTX upload limit."
