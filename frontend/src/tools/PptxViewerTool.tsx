import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Maximize2, Minimize2 } from 'lucide-react';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { ParsedPresentation, parsePptxFile } from '../services/pptxParser';
import { triggerBlobDownload } from '../utils/fileValidation';

const PptxViewerTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [presentation, setPresentation] = useState<ParsedPresentation | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
  });

  useEffect(() => {
    let cancelled = false;
    if (files.length === 0) {
      setPresentation(null);
      setActiveSlide(0);
      return;
    }

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const parsed = await parsePptxFile(files[0]);
        if (cancelled) return;
        if (parsed.slides.length === 0) {
          setError('No slides found in this PPTX file.');
        } else {
          setPresentation(parsed);
          setActiveSlide(0);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to parse PPTX presentation.');
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
    const onKeyDown = (e: KeyboardEvent) => {
      if (!presentation) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        setActiveSlide((s) => Math.min(presentation.slides.length - 1, s + 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        setActiveSlide((s) => Math.max(0, s - 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [presentation]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = async () => {
    if (!stageRef.current) return;
    if (!document.fullscreenElement) {
      await stageRef.current.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  };

  const handleReset = () => {
    setFiles([]);
    setPresentation(null);
    setError(null);
    setActiveSlide(0);
  };

  const slide = presentation?.slides[activeSlide];

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
        compact={Boolean(presentation)}
      />

      {error && <StatusBanner type="error" message={error} />}
      {loading && <StatusBanner type="loading" message="Parsing PowerPoint slides..." />}

      {presentation && slide && (
        <div className="border border-[#E5E5E5] bg-white">
          <div className="bg-[#F5F5F5] border-b border-[#E5E5E5] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={activeSlide <= 0}
                onClick={() => setActiveSlide((s) => Math.max(0, s - 1))}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Prev
              </button>
              <span className="px-3 text-xs font-mono text-[#222222]">
                Slide {activeSlide + 1} / {presentation.slides.length}
              </span>
              <button
                type="button"
                disabled={activeSlide >= presentation.slides.length - 1}
                onClick={() => setActiveSlide((s) => Math.min(presentation.slides.length - 1, s + 1))}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                Next
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={toggleFullscreen}
                className="df-btn-light px-3 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              </button>
              <button
                type="button"
                onClick={() => triggerBlobDownload(files[0], files[0].name)}
                className="df-btn-dark px-3 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download PPTX
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12">
            {/* Slide Thumbnails List */}
            <aside className="lg:col-span-3 border-b lg:border-b-0 lg:border-r border-[#E5E5E5] bg-[#F5F5F5] p-2.5 max-h-60 lg:max-h-[540px] overflow-y-auto flex lg:flex-col gap-2">
              {presentation.slides.map((s, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setActiveSlide(idx)}
                  className={`text-left p-2 border shrink-0 w-36 lg:w-full cursor-pointer ${
                    idx === activeSlide
                      ? 'bg-[#222222] text-white border-[#222222]'
                      : 'bg-white text-[#222222] border-[#E5E5E5] hover:border-[#222222]'
                  }`}
                >
                  <div className="text-[11px] font-mono">Slide {idx + 1}</div>
                  <div
                    className={`text-xs truncate mt-0.5 ${
                      idx === activeSlide ? 'text-[#E5E5E5]' : 'text-[#777777]'
                    }`}
                  >
                    {s.elements.find((el) => el.text)?.text || 'Blank / Visual Slide'}
                  </div>
                </button>
              ))}
            </aside>

            {/* Active Slide Stage */}
            <div
              ref={stageRef}
              className="lg:col-span-9 bg-[#E5E5E5] p-4 sm:p-6 flex flex-col items-center justify-center"
            >
              <div
                className="relative w-full border border-[#CCCCCC] overflow-hidden"
                style={{
                  maxWidth: isFullscreen ? '1200px' : '840px',
                  aspectRatio: `${presentation.widthPx} / ${presentation.heightPx}`,
                  backgroundColor: slide.backgroundColor || '#FFFFFF',
                }}
              >
                {slide.elements.map((el) => (
                  <div
                    key={el.id}
                    className="absolute overflow-hidden"
                    style={{
                      left: `${el.x}%`,
                      top: `${el.y}%`,
                      width: `${el.w}%`,
                      height: `${el.h}%`,
                      backgroundColor: el.type === 'shape' ? el.fillColor : undefined,
                      border: el.strokeColor ? `1px solid ${el.strokeColor}` : undefined,
                    }}
                  >
                    {el.type === 'image' && el.imageUrl && (
                      <img
                        src={el.imageUrl}
                        alt="Slide visual"
                        className="w-full h-full object-contain"
                      />
                    )}
                    {el.paragraphs && el.paragraphs.length > 0 && (
                      <div className="w-full h-full p-1.5 flex flex-col justify-start">
                        {el.paragraphs.map((p, pIdx) => (
                          <p
                            key={pIdx}
                            style={{
                              fontSize: `${Math.max(10, Math.round((p.fontSizePx || 16) * 0.85))}px`,
                              fontWeight: p.bold ? 700 : 400,
                              fontStyle: p.italic ? 'italic' : 'normal',
                              color: p.color || '#222222',
                              textAlign: p.align || 'left',
                              lineHeight: 1.25,
                            }}
                          >
                            {p.text}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {isFullscreen && (
                <div className="mt-4 flex items-center gap-2 bg-white border border-[#222222] px-3 py-1.5">
                  <button
                    type="button"
                    disabled={activeSlide <= 0}
                    onClick={() => setActiveSlide((s) => Math.max(0, s - 1))}
                    className="df-btn-light px-2.5 py-1 text-xs cursor-pointer"
                  >
                    Prev
                  </button>
                  <span className="text-xs font-mono">
                    {activeSlide + 1} / {presentation.slides.length}
                  </span>
                  <button
                    type="button"
                    disabled={activeSlide >= presentation.slides.length - 1}
                    onClick={() => setActiveSlide((s) => Math.min(presentation.slides.length - 1, s + 1))}
                    className="df-btn-light px-2.5 py-1 text-xs cursor-pointer"
                  >
                    Next
                  </button>
                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    className="df-btn-dark px-2.5 py-1 text-xs cursor-pointer"
                  >
                    Exit
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PptxViewerTool;
