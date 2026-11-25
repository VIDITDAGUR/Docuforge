import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { loadPdfDocument } from '../services/pdfjsSetup';
import { triggerBlobDownload } from '../utils/fileValidation';

const PdfViewerTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.25);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
  });

  useEffect(() => {
    let cancelled = false;
    if (files.length === 0) {
      setPdfDoc(null);
      setTotalPages(0);
      setCurrentPage(1);
      return;
    }

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const doc = await loadPdfDocument(files[0]);
        if (cancelled) return;
        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setCurrentPage(1);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF document.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [files]);

  useEffect(() => {
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    if (!pdfDoc || !canvasRef.current) return;

    (async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'name' in err && err.name === 'RenderingCancelledException') {
          return;
        }
      }
    })();

    return () => {
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
      }
    };
  }, [pdfDoc, currentPage, scale]);

  const handleFitToPage = async () => {
    if (!pdfDoc || !containerRef.current) return;
    const page = await pdfDoc.getPage(currentPage);
    const unscaled = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(300, containerRef.current.clientWidth - 48);
    const availableHeight = Math.max(400, window.innerHeight - 280);
    const fitScale = Math.min(availableWidth / unscaled.width, availableHeight / unscaled.height);
    setScale(Number(Math.max(0.4, Math.min(2.5, fitScale)).toFixed(2)));
  };

  const handleReset = () => {
    setFiles([]);
    setPdfDoc(null);
    setError(null);
    setCurrentPage(1);
    setTotalPages(0);
    setScale(1.25);
  };

  return (
    <div className="space-y-4">
      <FileDropzone
        acceptedExtensions={tool.acceptedExtensions}
        formatsLabel={tool.formatsLabel}
        maxSizeMB={tool.maxSizeMB}
        multiple={false}
        files={files}
        onFilesSelected={setFiles}
        onError={setError}
        onReset={handleReset}
        compact={Boolean(pdfDoc)}
      />

      {error && <StatusBanner type="error" message={error} />}
      {loading && <StatusBanner type="loading" message="Rendering PDF document..." />}

      {pdfDoc && (
        <div className="border border-[#E5E5E5] bg-white">
          {/* Toolbar */}
          <div className="bg-[#F5F5F5] border-b border-[#E5E5E5] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                aria-label="Previous page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Prev
              </button>
              <div className="flex items-center gap-1.5 px-2 text-xs font-mono">
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={currentPage}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v >= 1 && v <= totalPages) setCurrentPage(v);
                  }}
                  aria-label="Current page number"
                  className="w-12 border border-[#E5E5E5] bg-white px-1.5 py-1 text-center text-xs"
                />
                <span className="text-[#777777]">/ {totalPages}</span>
              </div>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                aria-label="Next page"
              >
                Next
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setScale((s) => Number(Math.max(0.4, s - 0.2).toFixed(2)))}
                className="df-btn-light px-2 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                title="Zoom Out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="px-2 text-xs font-mono text-[#222222] min-w-[52px] text-center">
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setScale((s) => Number(Math.min(3.0, s + 0.2).toFixed(2)))}
                className="df-btn-light px-2 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                title="Zoom In"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleFitToPage}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                Fit to Page
              </button>
              <button
                type="button"
                onClick={() => triggerBlobDownload(files[0], files[0].name)}
                className="df-btn-dark px-3 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download Original
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                title="Close document"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Canvas Viewport */}
          <div
            ref={containerRef}
            className="bg-[#F5F5F5] p-4 sm:p-6 overflow-auto flex justify-center min-h-[480px] max-h-[75vh]"
          >
            <canvas ref={canvasRef} className="border border-[#E5E5E5] bg-white block" />
          </div>
        </div>
      )}
    </div>
  );
};

export default PdfViewerTool;
