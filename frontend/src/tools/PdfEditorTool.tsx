import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  Highlighter,
  MessageSquare,
  MousePointer,
  Pencil,
  RotateCcw,
  Square,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { loadPdfDocument } from '../services/pdfjsSetup';
import { replaceExtension, triggerBlobDownload } from '../utils/fileValidation';

type EditorMode = 'select' | 'text' | 'highlight' | 'note' | 'draw' | 'rect' | 'circle';

type PageAnnotation =
  | {
      id: string;
      kind: 'text';
      x: number; // normalized 0..1
      y: number;
      text: string;
      fontSize: number;
      color: string;
    }
  | {
      id: string;
      kind: 'note';
      x: number;
      y: number;
      text: string;
    }
  | {
      id: string;
      kind: 'highlight' | 'rect' | 'circle';
      x: number;
      y: number;
      w: number;
      h: number;
      color: string;
    }
  | {
      id: string;
      kind: 'draw';
      points: Array<{ x: number; y: number }>;
      color: string;
      strokeWidth: number;
    };

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [
    Number.isFinite(r) ? r : 0.13,
    Number.isFinite(g) ? g : 0.13,
    Number.isFinite(b) ? b : 0.13,
  ];
}

const PdfEditorTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [canvasSize, setCanvasSize] = useState({ width: 700, height: 900 });

  const [mode, setMode] = useState<EditorMode>('text');
  const [color, setColor] = useState('#222222');
  const [fontSize, setFontSize] = useState(14);
  const [pendingText, setPendingText] = useState('Sample text');
  const [annotationsByPage, setAnnotationsByPage] = useState<Record<number, PageAnnotation[]>>({});

  // Interactive drag state
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [activeStroke, setActiveStroke] = useState<Array<{ x: number; y: number }>>([]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
  });

  useEffect(() => {
    let cancelled = false;
    if (files.length === 0) {
      setPdfDoc(null);
      setTotalPages(0);
      setCurrentPage(1);
      setAnnotationsByPage({});
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
        setAnnotationsByPage({});
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load PDF.');
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
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        setCanvasSize({ width: viewport.width, height: viewport.height });
        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
      } catch {
        // ignore cancel
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
  }, [pdfDoc, currentPage]);

  const currentAnnotations = annotationsByPage[currentPage] || [];

  const addAnnotation = (item: PageAnnotation) => {
    setAnnotationsByPage((prev) => ({
      ...prev,
      [currentPage]: [...(prev[currentPage] || []), item],
    }));
    setSuccessMsg(null);
  };

  const removeAnnotation = (id: string) => {
    setAnnotationsByPage((prev) => ({
      ...prev,
      [currentPage]: (prev[currentPage] || []).filter((a) => a.id !== id),
    }));
  };

  const getNormCoords = (e: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (mode === 'select') return;
    const pt = getNormCoords(e);

    if (mode === 'text') {
      const content = pendingText.trim() || 'Text';
      addAnnotation({
        id: `ann-${Date.now()}`,
        kind: 'text',
        x: pt.x,
        y: pt.y,
        text: content,
        fontSize,
        color,
      });
      return;
    }

    if (mode === 'note') {
      const content = pendingText.trim() || 'Annotation note';
      addAnnotation({
        id: `ann-${Date.now()}`,
        kind: 'note',
        x: pt.x,
        y: pt.y,
        text: content,
      });
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    if (mode === 'draw') {
      setActiveStroke([pt]);
    } else {
      setDragStart(pt);
      setDragCurrent(pt);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (mode === 'draw' && activeStroke.length > 0) {
      const pt = getNormCoords(e);
      setActiveStroke((prev) => [...prev, pt]);
    } else if (dragStart) {
      setDragCurrent(getNormCoords(e));
    }
  };

  const handlePointerUp = () => {
    if (mode === 'draw' && activeStroke.length > 1) {
      addAnnotation({
        id: `ann-${Date.now()}`,
        kind: 'draw',
        points: activeStroke,
        color,
        strokeWidth: 2.5,
      });
      setActiveStroke([]);
      return;
    }
    setActiveStroke([]);

    if (dragStart && dragCurrent && (mode === 'highlight' || mode === 'rect' || mode === 'circle')) {
      const x = Math.min(dragStart.x, dragCurrent.x);
      const y = Math.min(dragStart.y, dragCurrent.y);
      const w = Math.abs(dragCurrent.x - dragStart.x);
      const h = Math.abs(dragCurrent.y - dragStart.y);
      if (w > 0.01 && h > 0.008) {
        addAnnotation({
          id: `ann-${Date.now()}`,
          kind: mode,
          x,
          y,
          w,
          h,
          color: mode === 'highlight' ? '#FEF08A' : color,
        });
      }
    }
    setDragStart(null);
    setDragCurrent(null);
  };

  const handleUndo = () => {
    setAnnotationsByPage((prev) => {
      const list = prev[currentPage] || [];
      if (list.length === 0) return prev;
      return { ...prev, [currentPage]: list.slice(0, -1) };
    });
  };

  const handleClearPage = () => {
    setAnnotationsByPage((prev) => ({ ...prev, [currentPage]: [] }));
  };

  const handleExportPdf = async () => {
    if (files.length === 0) return;
    setSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const origBytes = await files[0].arrayBuffer();
      const outDoc = await PDFDocument.load(origBytes);
      const font = await outDoc.embedFont(StandardFonts.Helvetica);
      const boldFont = await outDoc.embedFont(StandardFonts.HelveticaBold);

      const pages = outDoc.getPages();
      for (let pIdx = 0; pIdx < pages.length; pIdx++) {
        const pageNum = pIdx + 1;
        const page = pages[pIdx];
        const { width, height } = page.getSize();
        const items = annotationsByPage[pageNum] || [];

        for (const item of items) {
          if (item.kind === 'text') {
            const [r, g, b] = hexToRgbTuple(item.color);
            page.drawText(item.text, {
              x: item.x * width,
              y: height - item.y * height - item.fontSize * 0.8,
              size: item.fontSize,
              font,
              color: rgb(r, g, b),
            });
          } else if (item.kind === 'note') {
            const boxX = item.x * width;
            const boxW = Math.min(180, Math.max(90, width - boxX - 12));
            const boxH = 26;
            const boxY = Math.max(12, height - item.y * height - boxH);
            page.drawRectangle({
              x: boxX,
              y: boxY,
              width: boxW,
              height: boxH,
              color: rgb(0.96, 0.96, 0.96),
              borderColor: rgb(0.133, 0.133, 0.133),
              borderWidth: 1,
            });
            page.drawText(item.text.slice(0, 42), {
              x: boxX + 6,
              y: boxY + 9,
              size: 9,
              font: boldFont,
              color: rgb(0.133, 0.133, 0.133),
            });
          } else if (item.kind === 'highlight') {
            const [r, g, b] = hexToRgbTuple(item.color);
            page.drawRectangle({
              x: item.x * width,
              y: height - (item.y + item.h) * height,
              width: item.w * width,
              height: item.h * height,
              color: rgb(r, g, b),
              opacity: 0.35,
            });
          } else if (item.kind === 'rect') {
            const [r, g, b] = hexToRgbTuple(item.color);
            page.drawRectangle({
              x: item.x * width,
              y: height - (item.y + item.h) * height,
              width: item.w * width,
              height: item.h * height,
              borderColor: rgb(r, g, b),
              borderWidth: 1.5,
            });
          } else if (item.kind === 'circle') {
            const [r, g, b] = hexToRgbTuple(item.color);
            const rx = (item.w * width) / 2;
            const ry = (item.h * height) / 2;
            page.drawEllipse({
              x: item.x * width + rx,
              y: height - item.y * height - ry,
              xScale: rx,
              yScale: ry,
              borderColor: rgb(r, g, b),
              borderWidth: 1.5,
            });
          } else if (item.kind === 'draw') {
            const [r, g, b] = hexToRgbTuple(item.color);
            for (let i = 1; i < item.points.length; i++) {
              const p1 = item.points[i - 1];
              const p2 = item.points[i];
              page.drawLine({
                start: { x: p1.x * width, y: height - p1.y * height },
                end: { x: p2.x * width, y: height - p2.y * height },
                thickness: item.strokeWidth,
                color: rgb(r, g, b),
              });
            }
          }
        }
      }

      const outBytes = await outDoc.save();
      const blob = new Blob([new Uint8Array(outBytes)], { type: 'application/pdf' });
      const outName = replaceExtension(files[0].name, '-edited.pdf');
      triggerBlobDownload(blob, outName);
      setSuccessMsg(`Downloaded edited PDF "${outName}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export edited PDF.');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setFiles([]);
    setPdfDoc(null);
    setAnnotationsByPage({});
    setError(null);
    setSuccessMsg(null);
  };

  const previewRect =
    dragStart && dragCurrent
      ? {
          x: Math.min(dragStart.x, dragCurrent.x) * canvasSize.width,
          y: Math.min(dragStart.y, dragCurrent.y) * canvasSize.height,
          w: Math.abs(dragCurrent.x - dragStart.x) * canvasSize.width,
          h: Math.abs(dragCurrent.y - dragStart.y) * canvasSize.height,
        }
      : null;

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
      {loading && <StatusBanner type="loading" message="Loading PDF into editor..." />}
      {successMsg && <StatusBanner type="success" message={successMsg} />}

      {pdfDoc && (
        <div className="border border-[#E5E5E5] bg-white">
          {/* Editor Controls */}
          <div className="bg-[#F5F5F5] border-b border-[#E5E5E5] p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  { id: 'select', label: 'Delete/Select', icon: MousePointer },
                  { id: 'text', label: 'Add Text', icon: Type },
                  { id: 'highlight', label: 'Highlight', icon: Highlighter },
                  { id: 'note', label: 'Note', icon: MessageSquare },
                  { id: 'draw', label: 'Draw', icon: Pencil },
                  { id: 'rect', label: 'Rectangle', icon: Square },
                  { id: 'circle', label: 'Circle', icon: Circle },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMode(id)}
                  className={`px-2.5 py-1.5 text-xs font-medium border inline-flex items-center gap-1.5 cursor-pointer ${
                    mode === id
                      ? 'bg-[#222222] text-white border-[#222222]'
                      : 'bg-white text-[#222222] border-[#E5E5E5] hover:border-[#222222]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleUndo}
                disabled={currentAnnotations.length === 0}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" />
                Undo
              </button>
              <button
                type="button"
                onClick={handleClearPage}
                disabled={currentAnnotations.length === 0}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear Page
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleExportPdf}
                className="df-btn-dark px-3.5 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                {saving ? 'Saving...' : 'Download Edited PDF'}
              </button>
            </div>
          </div>

          {/* Tool Options Sub-bar */}
          <div className="border-b border-[#E5E5E5] bg-white px-3 py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              {(mode === 'text' || mode === 'note') && (
                <label className="flex items-center gap-1.5">
                  <span className="text-[#777777]">{mode === 'text' ? 'Text to place:' : 'Note text:'}</span>
                  <input
                    type="text"
                    value={pendingText}
                    onChange={(e) => setPendingText(e.target.value)}
                    className="border border-[#E5E5E5] px-2 py-1 text-xs w-48"
                  />
                </label>
              )}

              {mode === 'text' && (
                <label className="flex items-center gap-1.5">
                  <span className="text-[#777777]">Size:</span>
                  <select
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="border border-[#E5E5E5] px-2 py-1 text-xs"
                  >
                    <option value={11}>11 pt</option>
                    <option value={14}>14 pt</option>
                    <option value={18}>18 pt</option>
                    <option value={24}>24 pt</option>
                  </select>
                </label>
              )}

              {mode !== 'highlight' && mode !== 'note' && mode !== 'select' && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[#777777]">Ink:</span>
                  {['#222222', '#555555', '#991B1B', '#1E40AF'].map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      onClick={() => setColor(swatch)}
                      aria-label={`Select color ${swatch}`}
                      className={`w-5 h-5 border cursor-pointer ${
                        color === swatch ? 'border-[#222222] ring-1 ring-[#222222]' : 'border-[#E5E5E5]'
                      }`}
                      style={{ backgroundColor: swatch }}
                    />
                  ))}
                </div>
              )}

              <span className="text-[#777777]">
                {mode === 'select'
                  ? 'Click any added element to remove it.'
                  : mode === 'text' || mode === 'note'
                  ? 'Click anywhere on the page to place.'
                  : 'Click and drag on the page.'}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="df-btn-light px-2 py-1 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Prev
              </button>
              <span className="font-mono px-2">
                Page {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="df-btn-light px-2 py-1 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                Next
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="df-btn-light p-1 cursor-pointer"
                title="Close file"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Interactive Page Canvas */}
          <div className="bg-[#E5E5E5] p-4 sm:p-6 overflow-auto flex justify-center">
            <div
              className="relative border border-[#CCCCCC] bg-white shrink-0"
              style={{ width: canvasSize.width, height: canvasSize.height }}
            >
              <canvas ref={canvasRef} className="block w-full h-full" />

              <svg
                ref={overlayRef}
                width={canvasSize.width}
                height={canvasSize.height}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                className={`absolute inset-0 w-full h-full select-none ${
                  mode === 'select' ? 'cursor-pointer' : 'cursor-crosshair'
                }`}
              >
                {currentAnnotations.map((item) => {
                  const onRemove = () => {
                    if (mode === 'select') removeAnnotation(item.id);
                  };

                  if (item.kind === 'highlight') {
                    return (
                      <rect
                        key={item.id}
                        x={item.x * canvasSize.width}
                        y={item.y * canvasSize.height}
                        width={item.w * canvasSize.width}
                        height={item.h * canvasSize.height}
                        fill={item.color}
                        fillOpacity={0.38}
                        onClick={onRemove}
                      />
                    );
                  }
                  if (item.kind === 'rect') {
                    return (
                      <rect
                        key={item.id}
                        x={item.x * canvasSize.width}
                        y={item.y * canvasSize.height}
                        width={item.w * canvasSize.width}
                        height={item.h * canvasSize.height}
                        fill="none"
                        stroke={item.color}
                        strokeWidth={2}
                        onClick={onRemove}
                      />
                    );
                  }
                  if (item.kind === 'circle') {
                    const rx = (item.w * canvasSize.width) / 2;
                    const ry = (item.h * canvasSize.height) / 2;
                    return (
                      <ellipse
                        key={item.id}
                        cx={item.x * canvasSize.width + rx}
                        cy={item.y * canvasSize.height + ry}
                        rx={rx}
                        ry={ry}
                        fill="none"
                        stroke={item.color}
                        strokeWidth={2}
                        onClick={onRemove}
                      />
                    );
                  }
                  if (item.kind === 'text') {
                    return (
                      <text
                        key={item.id}
                        x={item.x * canvasSize.width}
                        y={item.y * canvasSize.height + item.fontSize * 1.2}
                        fill={item.color}
                        fontSize={item.fontSize * 1.35}
                        fontFamily="sans-serif"
                        onClick={onRemove}
                      >
                        {item.text}
                      </text>
                    );
                  }
                  if (item.kind === 'note') {
                    const bx = item.x * canvasSize.width;
                    const by = item.y * canvasSize.height;
                    return (
                      <g key={item.id} onClick={onRemove}>
                        <rect
                          x={bx}
                          y={by}
                          width={190}
                          height={28}
                          fill="#F5F5F5"
                          stroke="#222222"
                          strokeWidth={1}
                        />
                        <text x={bx + 8} y={by + 18} fill="#222222" fontSize={11} fontWeight="bold">
                          {item.text.slice(0, 28)}
                        </text>
                      </g>
                    );
                  }
                  if (item.kind === 'draw') {
                    const pts = item.points
                      .map((p) => `${p.x * canvasSize.width},${p.y * canvasSize.height}`)
                      .join(' ');
                    return (
                      <polyline
                        key={item.id}
                        points={pts}
                        fill="none"
                        stroke={item.color}
                        strokeWidth={item.strokeWidth}
                        strokeLinecap="square"
                        onClick={onRemove}
                      />
                    );
                  }
                  return null;
                })}

                {/* Active drag preview */}
                {previewRect && mode === 'highlight' && (
                  <rect
                    x={previewRect.x}
                    y={previewRect.y}
                    width={previewRect.w}
                    height={previewRect.h}
                    fill="#FEF08A"
                    fillOpacity={0.45}
                  />
                )}
                {previewRect && mode === 'rect' && (
                  <rect
                    x={previewRect.x}
                    y={previewRect.y}
                    width={previewRect.w}
                    height={previewRect.h}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeDasharray="4 2"
                  />
                )}
                {previewRect && mode === 'circle' && (
                  <ellipse
                    cx={previewRect.x + previewRect.w / 2}
                    cy={previewRect.y + previewRect.h / 2}
                    rx={previewRect.w / 2}
                    ry={previewRect.h / 2}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeDasharray="4 2"
                  />
                )}
                {activeStroke.length > 1 && (
                  <polyline
                    points={activeStroke
                      .map((p) => `${p.x * canvasSize.width},${p.y * canvasSize.height}`)
                      .join(' ')}
                    fill="none"
                    stroke={color}
                    strokeWidth={2.5}
                  />
                )}
              </svg>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PdfEditorTool;
