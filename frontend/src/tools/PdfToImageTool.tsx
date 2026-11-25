import React, { useEffect, useState } from 'react';
import { Archive, Download } from 'lucide-react';
import JSZip from 'jszip';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { loadPdfDocument } from '../services/pdfjsSetup';
import { replaceExtension, triggerBlobDownload } from '../utils/fileValidation';

interface RenderedImagePage {
  pageNumber: number;
  blob: Blob;
  previewUrl: string;
  filename: string;
}

const PdfToImageTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState<'png' | 'jpg'>('png');
  const [scale, setScale] = useState<number>(2);
  const [processing, setProcessing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<RenderedImagePage[]>([]);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
  });

  useEffect(() => {
    return () => {
      pages.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    };
  }, [pages]);

  const clearPages = () => {
    pages.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPages([]);
  };

  const handleConvert = async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    clearPages();

    try {
      const pdfDoc = await loadPdfDocument(files[0]);
      const baseName = files[0].name.replace(/\.pdf$/i, '');
      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
      const rendered: RenderedImagePage[] = [];

      for (let i = 1; i <= pdfDoc.numPages; i++) {
        setProgressText(`Rendering page ${i} of ${pdfDoc.numPages}...`);
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable.');

        if (format === 'jpg') {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error(`Failed to export page ${i}.`))),
            mimeType,
            0.92
          )
        );

        rendered.push({
          pageNumber: i,
          blob,
          previewUrl: URL.createObjectURL(blob),
          filename: `${baseName}-page-${i}.${format}`,
        });
      }

      setPages(rendered);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to convert PDF pages to images.');
    } finally {
      setProcessing(false);
      setProgressText('');
    }
  };

  const handleDownloadZip = async () => {
    if (pages.length === 0 || files.length === 0) return;
    const zip = new JSZip();
    for (const page of pages) {
      zip.file(page.filename, page.blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerBlobDownload(zipBlob, replaceExtension(files[0].name, '-images.zip'));
  };

  const handleReset = () => {
    setFiles([]);
    clearPages();
    setError(null);
  };

  return (
    <div className="space-y-4">
      <FileDropzone
        acceptedExtensions={tool.acceptedExtensions}
        formatsLabel={tool.formatsLabel}
        maxSizeMB={tool.maxSizeMB}
        multiple={false}
        files={files}
        onFilesSelected={(next) => {
          setFiles(next);
          clearPages();
        }}
        onError={setError}
        onReset={handleReset}
      />

      {error && <StatusBanner type="error" message={error} />}

      {files.length > 0 && (
        <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5">
              <span className="text-[#777777]">Format:</span>
              <select
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value as 'png' | 'jpg');
                  clearPages();
                }}
                className="border border-[#E5E5E5] bg-white px-2.5 py-1.5 text-xs"
              >
                <option value="png">PNG (Lossless)</option>
                <option value="jpg">JPG (Smaller size)</option>
              </select>
            </label>

            <label className="flex items-center gap-1.5">
              <span className="text-[#777777]">Resolution:</span>
              <select
                value={scale}
                onChange={(e) => {
                  setScale(Number(e.target.value));
                  clearPages();
                }}
                className="border border-[#E5E5E5] bg-white px-2.5 py-1.5 text-xs"
              >
                <option value={1.5}>Standard (1.5x)</option>
                <option value={2}>High (2x)</option>
                <option value={3}>Print (3x)</option>
              </select>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={processing}
              onClick={handleConvert}
              className="df-btn-dark px-4 py-2 text-xs font-medium cursor-pointer"
            >
              {processing ? 'Converting...' : 'Convert to Images'}
            </button>

            {pages.length > 0 && (
              <button
                type="button"
                onClick={handleDownloadZip}
                className="df-btn-dark px-4 py-2 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Archive className="w-3.5 h-3.5" />
                Download All as ZIP
              </button>
            )}
          </div>
        </div>
      )}

      {processing && <StatusBanner type="loading" message={progressText || 'Converting PDF pages...'} />}

      {pages.length > 0 && (
        <div className="space-y-3">
          <StatusBanner
            type="success"
            message={`Converted ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} to ${format.toUpperCase()}.`}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pages.map((page) => (
              <div key={page.pageNumber} className="border border-[#E5E5E5] bg-white flex flex-col">
                <div className="bg-[#F5F5F5] p-3 border-b border-[#E5E5E5] flex items-center justify-center h-56 overflow-hidden">
                  <img
                    src={page.previewUrl}
                    alt={`Page ${page.pageNumber}`}
                    className="max-h-full max-w-full object-contain border border-[#E5E5E5]"
                  />
                </div>
                <div className="px-3 py-2.5 flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-[#222222]">Page {page.pageNumber}</span>
                  <button
                    type="button"
                    onClick={() => triggerBlobDownload(page.blob, page.filename)}
                    className="df-btn-light px-2.5 py-1 text-xs inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    Download
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PdfToImageTool;
