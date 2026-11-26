import React, { useRef, useState } from 'react';
import {
  Circle,
  Download,
  FilePlus2,
  Minus,
  Plus,
  Square,
  Trash2,
  Type,
  Upload,
} from 'lucide-react';
import { parse as parsePptxToJson } from 'pptxtojson';
import PptxGenJS from 'pptxgenjs';
import { ToolDefinition } from '../types/tools';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { triggerBlobDownload, validateFile } from '../utils/fileValidation';

interface SlideElement {
  id: string;
  kind: 'text' | 'rect' | 'ellipse' | 'line' | 'image';
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  text: string;
  fontSizePt: number;
  bold: boolean;
  align: 'left' | 'center' | 'right';
  textColor: string;
  fillColor: string;
  strokeColor: string;
  imageData?: string;
}

interface SlideItem {
  id: string;
  backgroundColor: string;
  elements: SlideElement[];
}

function stripHtmlToPlainText(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = Array.from(doc.body.querySelectorAll('p, div, li'));
  if (blocks.length > 0) {
    return blocks
      .map((b) => (b.textContent || '').trim())
      .filter(Boolean)
      .join('\n');
  }
  return (doc.body.textContent || '').trim();
}

function normalizeHex(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  const trimmed = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
  if (/^[0-9A-Fa-f]{6}$/.test(trimmed)) return `#${trimmed}`;
  const m = trimmed.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/i);
  if (m) {
    const h = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }
  return fallback;
}

function createInitialSlides(): SlideItem[] {
  return [
    {
      id: 'slide-1',
      backgroundColor: '#FFFFFF',
      elements: [
        {
          id: 'el-title',
          kind: 'text',
          xPct: 8,
          yPct: 24,
          wPct: 84,
          hPct: 18,
          text: 'Presentation Title',
          fontSizePt: 32,
          bold: true,
          align: 'center',
          textColor: '#222222',
          fillColor: 'transparent',
          strokeColor: 'transparent',
        },
        {
          id: 'el-sub',
          kind: 'text',
          xPct: 14,
          yPct: 48,
          wPct: 72,
          hPct: 14,
          text: 'Subtitle or Course Name — DOCUFORGE',
          fontSizePt: 18,
          bold: false,
          align: 'center',
          textColor: '#777777',
          fillColor: 'transparent',
          strokeColor: 'transparent',
        },
      ],
    },
  ];
}

const PptxEditorTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const [deckTitle, setDeckTitle] = useState('presentation-deck');
  const [slides, setSlides] = useState<SlideItem[]>(createInitialSlides);
  const [activeSlideIdx, setActiveSlideIdx] = useState(0);
  const [selectedElId, setSelectedElId] = useState<string | null>('el-title');

  const [dragState, setDragState] = useState<{
    elId: string;
    startX: number;
    startY: number;
    origXPct: number;
    origYPct: number;
  } | null>(null);

  const [status, setStatus] = useState<{ type: 'loading' | 'error' | 'success'; message: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const loadExistingPptx = async (file: File) => {
    const check = validateFile(file, tool.acceptedExtensions, tool.maxSizeMB);
    if (!check.valid) {
      setStatus({ type: 'error', message: check.error || 'Invalid PPTX file.' });
      return;
    }

    setStatus({ type: 'loading', message: `Parsing "${file.name}" with pptxtojson...` });
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parsePptxToJson(buffer, { imageMode: 'base64' });
      if (!parsed.slides || parsed.slides.length === 0) {
        setStatus({ type: 'error', message: 'PPTX contains no slides.' });
        return;
      }

      const slideW = parsed.size?.width || 960;
      const slideH = parsed.size?.height || 540;

      const mapped: SlideItem[] = parsed.slides.map((s, sIdx) => {
        const bgColor =
          s.fill?.type === 'color'
            ? normalizeHex(s.fill.value, '#FFFFFF')
            : s.fill?.type === 'gradient' && s.fill.value.colors[0]
            ? normalizeHex(s.fill.value.colors[0].color, '#FFFFFF')
            : '#FFFFFF';

        const elements: SlideElement[] = [];
        for (let eIdx = 0; eIdx < (s.elements || []).length; eIdx++) {
          const el = s.elements[eIdx];
          const xPct = Math.max(0, Math.min(98, (el.left / slideW) * 100));
          const yPct = Math.max(0, Math.min(98, (el.top / slideH) * 100));
          const wPct = Math.max(2, Math.min(100, (el.width / slideW) * 100));
          const hPct = Math.max(2, Math.min(100, (el.height / slideH) * 100));

          if (el.type === 'image' && el.base64) {
            elements.push({
              id: `el-${sIdx}-${eIdx}-${Date.now()}`,
              kind: 'image',
              xPct,
              yPct,
              wPct,
              hPct,
              text: '',
              fontSizePt: 16,
              bold: false,
              align: 'left',
              textColor: '#222222',
              fillColor: 'transparent',
              strokeColor: 'transparent',
              imageData: el.base64,
            });
          } else if (el.type === 'text') {
            const plain = stripHtmlToPlainText(el.content);
            if (!plain) continue;
            elements.push({
              id: `el-${sIdx}-${eIdx}-${Date.now()}`,
              kind: 'text',
              xPct,
              yPct,
              wPct,
              hPct,
              text: plain,
              fontSizePt: 18,
              bold: el.content.includes('bold') || el.content.includes('<b>') || el.content.includes('<strong>'),
              align: el.content.includes('text-align: center')
                ? 'center'
                : el.content.includes('text-align: right')
                ? 'right'
                : 'left',
              textColor: '#222222',
              fillColor: 'transparent',
              strokeColor: 'transparent',
            });
          } else if (el.type === 'shape') {
            const plain = stripHtmlToPlainText(el.content || '');
            const shapeFill =
              el.fill?.type === 'color' ? normalizeHex(el.fill.value, '#F5F5F5') : 'transparent';
            const shapeStroke = el.borderColor ? normalizeHex(el.borderColor, '#222222') : '#222222';
            const kind: SlideElement['kind'] =
              el.shapType === 'ellipse'
                ? 'ellipse'
                : el.shapType === 'line'
                ? 'line'
                : plain && shapeFill === 'transparent'
                ? 'text'
                : 'rect';

            elements.push({
              id: `el-${sIdx}-${eIdx}-${Date.now()}`,
              kind,
              xPct,
              yPct,
              wPct,
              hPct,
              text: plain,
              fontSizePt: 16,
              bold: false,
              align: 'center',
              textColor: '#222222',
              fillColor: shapeFill,
              strokeColor: shapeStroke,
            });
          }
        }

        return {
          id: `slide-${Date.now()}-${sIdx}`,
          backgroundColor: bgColor,
          elements,
        };
      });

      setSlides(mapped);
      setActiveSlideIdx(0);
      setSelectedElId(mapped[0]?.elements[0]?.id || null);
      setDeckTitle(file.name.replace(/\.pptx$/i, ''));
      setStatus({
        type: 'success',
        message: `Parsed ${mapped.length} slides from "${file.name}" using pptxtojson.`,
      });
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unable to parse PPTX file.',
      });
    }
  };

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    if (incoming[0]) void loadExistingPptx(incoming[0]);
  });

  const activeSlide = slides[activeSlideIdx] || slides[0];
  const selectedEl = activeSlide?.elements.find((el) => el.id === selectedElId) || null;

  const updateSlide = (updater: (slide: SlideItem) => SlideItem) => {
    setSlides((prev) => prev.map((s, idx) => (idx === activeSlideIdx ? updater(s) : s)));
  };

  const updateSelectedElement = (patch: Partial<SlideElement>) => {
    if (!selectedElId) return;
    updateSlide((s) => ({
      ...s,
      elements: s.elements.map((el) => (el.id === selectedElId ? { ...el, ...patch } : el)),
    }));
  };

  const addSlide = () => {
    const next: SlideItem = {
      id: `slide-${Date.now()}`,
      backgroundColor: '#FFFFFF',
      elements: [
        {
          id: `el-${Date.now()}`,
          kind: 'text',
          xPct: 8,
          yPct: 12,
          wPct: 84,
          hPct: 16,
          text: `Slide ${slides.length + 1} Heading`,
          fontSizePt: 26,
          bold: true,
          align: 'left',
          textColor: '#222222',
          fillColor: 'transparent',
          strokeColor: 'transparent',
        },
      ],
    };
    setSlides((prev) => [...prev, next]);
    setActiveSlideIdx(slides.length);
    setSelectedElId(next.elements[0].id);
  };

  const deleteCurrentSlide = () => {
    if (slides.length <= 1) return;
    const nextSlides = slides.filter((_, idx) => idx !== activeSlideIdx);
    const nextIdx = Math.max(0, activeSlideIdx - 1);
    setSlides(nextSlides);
    setActiveSlideIdx(nextIdx);
    setSelectedElId(null);
  };

  const addElement = (kind: Exclude<SlideElement['kind'], 'image'>) => {
    const id = `el-${Date.now()}`;
    const newEl: SlideElement = {
      id,
      kind,
      xPct: 20,
      yPct: 30,
      wPct: kind === 'line' ? 40 : 32,
      hPct: kind === 'line' ? 2 : kind === 'text' ? 16 : 24,
      text: kind === 'text' ? 'New Text Box' : '',
      fontSizePt: 18,
      bold: false,
      align: 'left',
      textColor: '#222222',
      fillColor: kind === 'text' ? 'transparent' : '#F5F5F5',
      strokeColor: kind === 'text' ? 'transparent' : '#222222',
    };
    updateSlide((s) => ({ ...s, elements: [...s.elements, newEl] }));
    setSelectedElId(id);
  };

  const deleteSelectedElement = () => {
    if (!selectedElId) return;
    updateSlide((s) => ({
      ...s,
      elements: s.elements.filter((el) => el.id !== selectedElId),
    }));
    setSelectedElId(null);
  };

  const handleElementPointerDown = (e: React.PointerEvent, el: SlideElement) => {
    e.stopPropagation();
    setSelectedElId(el.id);
    setDragState({
      elId: el.id,
      startX: e.clientX,
      startY: e.clientY,
      origXPct: el.xPct,
      origYPct: el.yPct,
    });
  };

  const handleStagePointerMove = (e: React.PointerEvent) => {
    if (!dragState || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const dxPct = ((e.clientX - dragState.startX) / rect.width) * 100;
    const dyPct = ((e.clientY - dragState.startY) / rect.height) * 100;
    const newX = Math.max(0, Math.min(95, Number((dragState.origXPct + dxPct).toFixed(1))));
    const newY = Math.max(0, Math.min(95, Number((dragState.origYPct + dyPct).toFixed(1))));

    updateSlide((s) => ({
      ...s,
      elements: s.elements.map((el) =>
        el.id === dragState.elId ? { ...el, xPct: newX, yPct: newY } : el
      ),
    }));
  };

  const handleStagePointerUp = () => {
    setDragState(null);
  };

  const handleExportPptx = async () => {
    setExporting(true);
    setStatus({ type: 'loading', message: 'Exporting PPTX presentation via PptxGenJS...' });
    try {
      const pres = new PptxGenJS();
      pres.layout = 'LAYOUT_16x9';
      const slideWIn = 10;
      const slideHIn = 5.625;

      for (const s of slides) {
        const slide = pres.addSlide();
        slide.background = { color: s.backgroundColor.replace('#', '') || 'FFFFFF' };

        for (const el of s.elements) {
          const x = (el.xPct / 100) * slideWIn;
          const y = (el.yPct / 100) * slideHIn;
          const w = Math.max(0.2, (el.wPct / 100) * slideWIn);
          const h = Math.max(0.1, (el.hPct / 100) * slideHIn);

          if (el.kind === 'image' && el.imageData) {
            slide.addImage({ data: el.imageData, x, y, w, h });
          } else if (el.kind === 'text') {
            slide.addText(el.text || ' ', {
              x,
              y,
              w,
              h,
              fontSize: el.fontSizePt,
              bold: el.bold,
              align: el.align,
              color: el.textColor.replace('#', ''),
              valign: 'top',
            });
          } else if (el.kind === 'rect') {
            slide.addShape(pres.ShapeType.rect, {
              x,
              y,
              w,
              h,
              fill: { color: (el.fillColor === 'transparent' ? 'F5F5F5' : el.fillColor).replace('#', '') },
              line: { color: (el.strokeColor === 'transparent' ? '222222' : el.strokeColor).replace('#', ''), width: 1 },
            });
            if (el.text) {
              slide.addText(el.text, {
                x,
                y,
                w,
                h,
                fontSize: el.fontSizePt,
                align: el.align,
                color: el.textColor.replace('#', ''),
                valign: 'middle',
              });
            }
          } else if (el.kind === 'ellipse') {
            slide.addShape(pres.ShapeType.ellipse, {
              x,
              y,
              w,
              h,
              fill: { color: (el.fillColor === 'transparent' ? 'F5F5F5' : el.fillColor).replace('#', '') },
              line: { color: (el.strokeColor === 'transparent' ? '222222' : el.strokeColor).replace('#', ''), width: 1 },
            });
          } else if (el.kind === 'line') {
            slide.addShape(pres.ShapeType.line, {
              x,
              y,
              w,
              h: 0,
              line: { color: (el.strokeColor === 'transparent' ? '222222' : el.strokeColor).replace('#', ''), width: 2 },
            });
          }
        }
      }

      const outData = await pres.write({ outputType: 'blob' });
      const blob = outData instanceof Blob ? outData : new Blob([outData as ArrayBuffer]);
      const filename = `${deckTitle.trim() || 'presentation'}.pptx`;
      triggerBlobDownload(blob, filename);
      setStatus({ type: 'success', message: `Exported "${filename}" (${slides.length} slides) via PptxGenJS.` });
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'PPTX export failed.',
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pptx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void loadExistingPptx(f);
          e.target.value = '';
        }}
      />

      {/* Top Action Bar */}
      <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-[#777777]">Deck:</label>
          <input
            type="text"
            value={deckTitle}
            onChange={(e) => setDeckTitle(e.target.value)}
            aria-label="Presentation filename"
            className="border border-[#E5E5E5] bg-white px-2.5 py-1.5 text-xs font-mono w-44"
          />
          <button
            type="button"
            onClick={() => {
              const init = createInitialSlides();
              setSlides(init);
              setActiveSlideIdx(0);
              setSelectedElId(init[0].elements[0].id);
              setDeckTitle('presentation-deck');
              setStatus(null);
            }}
            className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
            New Deck
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Open PPTX
          </button>
        </div>

        <button
          type="button"
          disabled={exporting}
          onClick={handleExportPptx}
          className="df-btn-dark px-4 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" />
          {exporting ? 'Exporting...' : 'Export PPTX'}
        </button>
      </div>

      {status && <StatusBanner type={status.type} message={status.message} />}

      {/* Main Editor Workspace */}
      <div className="border border-[#E5E5E5] bg-white">
        <div className="border-b border-[#E5E5E5] bg-[#F5F5F5] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => addElement('text')}
              className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
            >
              <Type className="w-3.5 h-3.5" />
              Add Text Box
            </button>
            <button
              type="button"
              onClick={() => addElement('rect')}
              className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
              Rectangle
            </button>
            <button
              type="button"
              onClick={() => addElement('ellipse')}
              className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
            >
              <Circle className="w-3.5 h-3.5" />
              Circle
            </button>
            <button
              type="button"
              onClick={() => addElement('line')}
              className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
            >
              <Minus className="w-3.5 h-3.5" />
              Line
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-[#777777]">Slide Background:</span>
            {['#FFFFFF', '#F5F5F5', '#E5E5E5', '#222222'].map((bg) => (
              <button
                key={bg}
                type="button"
                onClick={() => updateSlide((s) => ({ ...s, backgroundColor: bg }))}
                aria-label={`Set slide background ${bg}`}
                className={`w-5 h-5 border cursor-pointer ${
                  activeSlide.backgroundColor === bg ? 'border-[#222222] ring-1 ring-[#222222]' : 'border-[#CCCCCC]'
                }`}
                style={{ backgroundColor: bg }}
              />
            ))}
            <input
              type="color"
              value={activeSlide.backgroundColor}
              onChange={(e) => updateSlide((s) => ({ ...s, backgroundColor: e.target.value }))}
              aria-label="Custom slide background color"
              className="w-6 h-6 border border-[#E5E5E5] bg-white p-0 cursor-pointer"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12">
          <aside className="lg:col-span-3 border-b lg:border-b-0 lg:border-r border-[#E5E5E5] bg-[#F5F5F5] p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-1">
              <button
                type="button"
                onClick={addSlide}
                className="df-btn-dark px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer flex-1 justify-center"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Slide
              </button>
              <button
                type="button"
                disabled={slides.length <= 1}
                onClick={deleteCurrentSlide}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                title="Delete selected slide"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex lg:flex-col gap-1.5 overflow-x-auto lg:max-h-[460px] lg:overflow-y-auto">
              {slides.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setActiveSlideIdx(idx);
                    setSelectedElId(s.elements[0]?.id || null);
                  }}
                  className={`text-left p-2 border shrink-0 w-36 lg:w-full cursor-pointer ${
                    idx === activeSlideIdx
                      ? 'bg-[#222222] text-white border-[#222222]'
                      : 'bg-white text-[#222222] border-[#E5E5E5] hover:border-[#222222]'
                  }`}
                >
                  <div className="text-[11px] font-mono">Slide {idx + 1}</div>
                  <div
                    className={`text-xs truncate mt-0.5 ${
                      idx === activeSlideIdx ? 'text-[#E5E5E5]' : 'text-[#777777]'
                    }`}
                  >
                    {s.elements.find((e) => e.text)?.text || `${s.elements.length} element(s)`}
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <div className="lg:col-span-9 flex flex-col">
            <div className="bg-[#E5E5E5] p-4 sm:p-6 flex justify-center">
              <div
                ref={stageRef}
                onPointerMove={handleStagePointerMove}
                onPointerUp={handleStagePointerUp}
                onPointerLeave={handleStagePointerUp}
                onClick={() => setSelectedElId(null)}
                className="relative w-full max-w-[780px] border border-[#CCCCCC] overflow-hidden select-none"
                style={{
                  aspectRatio: '16 / 9',
                  backgroundColor: activeSlide.backgroundColor,
                }}
              >
                {activeSlide.elements.map((el) => {
                  const isSelected = el.id === selectedElId;
                  return (
                    <div
                      key={el.id}
                      onPointerDown={(e) => handleElementPointerDown(e, el)}
                      onClick={(e) => e.stopPropagation()}
                      className={`absolute cursor-move ${
                        isSelected ? 'outline outline-2 outline-[#222222]' : 'hover:outline hover:outline-1 hover:outline-[#777777]'
                      }`}
                      style={{
                        left: `${el.xPct}%`,
                        top: `${el.yPct}%`,
                        width: `${el.wPct}%`,
                        height: `${el.hPct}%`,
                        backgroundColor:
                          el.kind === 'rect'
                            ? el.fillColor
                            : el.kind === 'line'
                            ? el.strokeColor
                            : 'transparent',
                        border:
                          el.kind === 'rect' && el.strokeColor !== 'transparent'
                            ? `1px solid ${el.strokeColor}`
                            : undefined,
                      }}
                    >
                      {el.kind === 'image' && el.imageData && (
                        <img src={el.imageData} alt="Slide element" className="w-full h-full object-contain pointer-events-none" />
                      )}
                      {el.kind === 'ellipse' && (
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full">
                          <ellipse
                            cx="50"
                            cy="50"
                            rx="48"
                            ry="48"
                            fill={el.fillColor}
                            stroke={el.strokeColor}
                            strokeWidth="2"
                          />
                        </svg>
                      )}
                      {(el.kind === 'text' || (el.kind === 'rect' && el.text)) && (
                        <div
                          className="w-full h-full p-1 whitespace-pre-wrap break-words"
                          style={{
                            fontSize: `${Math.max(10, Math.round(el.fontSizePt * 0.78))}px`,
                            fontWeight: el.bold ? 700 : 400,
                            textAlign: el.align,
                            color: el.textColor,
                            lineHeight: 1.25,
                          }}
                        >
                          {el.text}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-[#E5E5E5] bg-white p-3.5 text-xs">
              {selectedEl ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[#222222] uppercase font-mono">
                      Selected {selectedEl.kind}
                    </span>
                    <button
                      type="button"
                      onClick={deleteSelectedElement}
                      className="df-btn-light px-2.5 py-1 text-xs inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete Element
                    </button>
                  </div>

                  {selectedEl.kind === 'text' && (
                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-start">
                      <div className="sm:col-span-6">
                        <label className="block text-[#777777] mb-1">Text Content</label>
                        <textarea
                          rows={2}
                          value={selectedEl.text}
                          onChange={(e) => updateSelectedElement({ text: e.target.value })}
                          className="w-full border border-[#E5E5E5] p-2 text-xs"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[#777777] mb-1">Size (pt)</label>
                        <input
                          type="number"
                          min={8}
                          max={72}
                          value={selectedEl.fontSizePt}
                          onChange={(e) => updateSelectedElement({ fontSizePt: Number(e.target.value) })}
                          className="w-full border border-[#E5E5E5] px-2 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[#777777] mb-1">Align</label>
                        <select
                          value={selectedEl.align}
                          onChange={(e) =>
                            updateSelectedElement({ align: e.target.value as 'left' | 'center' | 'right' })
                          }
                          className="w-full border border-[#E5E5E5] px-2 py-1.5 text-xs"
                        >
                          <option value="left">Left</option>
                          <option value="center">Center</option>
                          <option value="right">Right</option>
                        </select>
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[#777777] mb-1">Style &amp; Color</label>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => updateSelectedElement({ bold: !selectedEl.bold })}
                            className={`px-2 py-1.5 border font-bold cursor-pointer ${
                              selectedEl.bold
                                ? 'bg-[#222222] text-white border-[#222222]'
                                : 'bg-white text-[#222222] border-[#E5E5E5]'
                            }`}
                          >
                            B
                          </button>
                          <input
                            type="color"
                            value={selectedEl.textColor}
                            onChange={(e) => updateSelectedElement({ textColor: e.target.value })}
                            aria-label="Text color"
                            className="w-8 h-7 border border-[#E5E5E5] p-0 cursor-pointer"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {selectedEl.kind !== 'text' && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {selectedEl.kind !== 'line' && selectedEl.kind !== 'image' && (
                        <div>
                          <label className="block text-[#777777] mb-1">Fill Color</label>
                          <input
                            type="color"
                            value={selectedEl.fillColor === 'transparent' ? '#F5F5F5' : selectedEl.fillColor}
                            onChange={(e) => updateSelectedElement({ fillColor: e.target.value })}
                            className="w-full h-7 border border-[#E5E5E5] p-0 cursor-pointer"
                          />
                        </div>
                      )}
                      {selectedEl.kind !== 'image' && (
                        <div>
                          <label className="block text-[#777777] mb-1">Border Color</label>
                          <input
                            type="color"
                            value={selectedEl.strokeColor === 'transparent' ? '#222222' : selectedEl.strokeColor}
                            onChange={(e) => updateSelectedElement({ strokeColor: e.target.value })}
                            className="w-full h-7 border border-[#E5E5E5] p-0 cursor-pointer"
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-[#777777] mb-1">Width (%)</label>
                        <input
                          type="number"
                          min={5}
                          max={100}
                          value={Math.round(selectedEl.wPct)}
                          onChange={(e) => updateSelectedElement({ wPct: Number(e.target.value) })}
                          className="w-full border border-[#E5E5E5] px-2 py-1 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[#777777] mb-1">Height (%)</label>
                        <input
                          type="number"
                          min={2}
                          max={100}
                          value={Math.round(selectedEl.hPct)}
                          onChange={(e) => updateSelectedElement({ hPct: Number(e.target.value) })}
                          className="w-full border border-[#E5E5E5] px-2 py-1 text-xs font-mono"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[#777777]">
                  Click any element on the slide to edit or drag to reposition.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PptxEditorTool;
