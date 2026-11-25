import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Trash2 } from 'lucide-react';
import { PDFDocument } from 'pdf-lib';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { formatFileSize, triggerBlobDownload } from '../utils/fileValidation';

type PageFormat = 'fit' | 'a4' | 'letter';

const PAGE_DIMS: Record<Exclude<PageFormat, 'fit'>, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

async function imageFileToPngOrJpgBytes(
  file: File
): Promise<{ kind: 'png' | 'jpg'; bytes: Uint8Array }> {
  const buffer = await file.arrayBuffer();
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return { kind: 'jpg', bytes: new Uint8Array(buffer) };
  }
  if (lower.endsWith('.png')) {
    return { kind: 'png', bytes: new Uint8Array(buffer) };
  }

  // Convert WebP or other raster image to PNG via canvas
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Unable to decode image "${file.name}".`));
      el.src = blobUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    ctx.drawImage(img, 0, 0);
    const pngBlob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed.'))), 'image/png')
    );
    return { kind: 'png', bytes: new Uint8Array(await pngBlob.arrayBuffer()) };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

const ImageToPdfTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pageFormat, setPageFormat] = useState<PageFormat>('a4');
  const [marginPt, setMarginPt] = useState<number>(20);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, true, (incoming) => {
    setFiles(incoming);
  });

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  const moveItem = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= files.length) return;
    const next = [...files];
    const [removed] = next.splice(index, 1);
    next.splice(target, 0, removed);
    setFiles(next);
    setResultBlob(null);
  };

  const removeItem = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setResultBlob(null);
  };

  const handleConvert = async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    setResultBlob(null);

    try {
      const pdfDoc = await PDFDocument.create();
      for (const file of files) {
        const encoded = await imageFileToPngOrJpgBytes(file);
        const embedded =
          encoded.kind === 'jpg'
            ? await pdfDoc.embedJpg(encoded.bytes)
            : await pdfDoc.embedPng(encoded.bytes);

        const imgW = embedded.width;
        const imgH = embedded.height;

        if (pageFormat === 'fit') {
          const page = pdfDoc.addPage([imgW + marginPt * 2, imgH + marginPt * 2]);
          page.drawImage(embedded, {
            x: marginPt,
            y: marginPt,
            width: imgW,
            height: imgH,
          });
        } else {
          const [baseW, baseH] = PAGE_DIMS[pageFormat];
          const isLandscape = imgW > imgH;
          const pageW = isLandscape ? baseH : baseW;
          const pageH = isLandscape ? baseW : baseH;
          const page = pdfDoc.addPage([pageW, pageH]);

          const availW = pageW - marginPt * 2;
          const availH = pageH - marginPt * 2;
          const ratio = Math.min(availW / imgW, availH / imgH);
          const drawW = imgW * ratio;
          const drawH = imgH * ratio;

          page.drawImage(embedded, {
            x: (pageW - drawW) / 2,
            y: (pageH - drawH) / 2,
            width: drawW,
            height: drawH,
          });
        }
      }

      const outBytes = await pdfDoc.save();
      setResultBlob(new Blob([new Uint8Array(outBytes)], { type: 'application/pdf' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate PDF from images.');
    } finally {
      setProcessing(false);
    }
  };

  const handleReset = () => {
    setFiles([]);
    setResultBlob(null);
    setError(null);
  };

  return (
    <div className="space-y-4">
      <FileDropzone
        acceptedExtensions={tool.acceptedExtensions}
        formatsLabel={tool.formatsLabel}
        maxSizeMB={tool.maxSizeMB}
        multiple={true}
        files={files}
        onFilesSelected={(next) => {
          setFiles(next);
          setResultBlob(null);
        }}
        onError={setError}
        onReset={handleReset}
        buttonLabel="Add Images"
      />

      {error && <StatusBanner type="error" message={error} />}

      {files.length > 0 && (
        <div className="border border-[#E5E5E5] bg-white">
          <div className="bg-[#F5F5F5] border-b border-[#E5E5E5] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-semibold text-[#222222]">
              Image Order ({files.length} {files.length === 1 ? 'page' : 'pages'})
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <span className="text-[#777777]">Page Size:</span>
                <select
                  value={pageFormat}
                  onChange={(e) => {
                    setPageFormat(e.target.value as PageFormat);
                    setResultBlob(null);
                  }}
                  className="border border-[#E5E5E5] bg-white px-2 py-1 text-xs"
                >
                  <option value="a4">A4</option>
                  <option value="letter">US Letter</option>
                  <option value="fit">Fit to Image</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-[#777777]">Margin:</span>
                <select
                  value={marginPt}
                  onChange={(e) => {
                    setMarginPt(Number(e.target.value));
                    setResultBlob(null);
                  }}
                  className="border border-[#E5E5E5] bg-white px-2 py-1 text-xs"
                >
                  <option value={0}>None (0 pt)</option>
                  <option value={20}>Small (20 pt)</option>
                  <option value={36}>Standard (36 pt)</option>
                </select>
              </label>
            </div>
          </div>

          <div className="divide-y divide-[#E5E5E5]">
            {files.map((file, idx) => (
              <div key={`${file.name}-${idx}`} className="px-4 py-2.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-mono text-[#777777] w-6">{idx + 1}.</span>
                  {previews[idx] && (
                    <img
                      src={previews[idx]}
                      alt={file.name}
                      className="w-10 h-10 object-cover border border-[#E5E5E5] bg-[#F5F5F5] shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#222222] truncate">{file.name}</div>
                    <div className="text-[11px] font-mono text-[#777777]">{formatFileSize(file.size)}</div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => moveItem(idx, -1)}
                    className="df-btn-light p-1.5 cursor-pointer"
                    aria-label="Move image up"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === files.length - 1}
                    onClick={() => moveItem(idx, 1)}
                    className="df-btn-light p-1.5 cursor-pointer"
                    aria-label="Move image down"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    className="df-btn-light p-1.5 cursor-pointer"
                    aria-label="Remove image"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-[#F5F5F5] border-t border-[#E5E5E5] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              disabled={processing}
              onClick={handleConvert}
              className="df-btn-dark px-4 py-2 text-xs font-medium cursor-pointer"
            >
              {processing ? 'Generating PDF...' : 'Generate PDF'}
            </button>

            {resultBlob && (
              <button
                type="button"
                onClick={() => triggerBlobDownload(resultBlob, 'docuforge-images.pdf')}
                className="df-btn-dark px-4 py-2 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download PDF ({formatFileSize(resultBlob.size)})
              </button>
            )}
          </div>
        </div>
      )}

      {processing && <StatusBanner type="loading" message="Combining images into a single PDF document..." />}
      {resultBlob && (
        <StatusBanner
          type="success"
          message={`PDF generated successfully (${files.length} ${files.length === 1 ? 'page' : 'pages'}). Click Download PDF to save.`}
        />
      )}
    </div>
  );
};

export default ImageToPdfTool;
