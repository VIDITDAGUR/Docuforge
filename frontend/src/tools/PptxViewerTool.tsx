import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { init as initPptxPreview } from 'pptx-preview';
import type PPTXPreviewer from 'pptx-preview/dist/previewer/index';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { triggerBlobDownload } from '../utils/fileValidation';

const PptxViewerTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [slideCount, setSlideCount] = useState(0);
  const [activeSlide, setActiveSlide] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);
  const previewerRef = useRef<PPTXPreviewer | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
  });

  useEffect(() => {
    let cancelled = false;
    if (files.length === 0) {
      previewerRef.current?.destroy();
      previewerRef.current = null;
      setSlideCount(0);
      setActiveSlide(0);
      return;
    }

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const buffer = await files[0].arrayBuffer();
        if (cancelled || !previewWrapRef.current) return;

        previewerRef.current?.destroy();
        previewWrapRef.current.innerHTML = '';

        const containerW = Math.min(960, Math.max(320, previewWrapRef.current.clientWidth || 860));
        const containerH = Math.round((containerW * 9) / 16);

        const previewer = initPptxPreview(previewWrapRef.current, {
          width: containerW,
          height: containerH,
          mode: 'slide',
        });

        await previewer.preview(buffer);
        if (cancelled) {
          previewer.destroy();
          return;
        }

        previewerRef.current = previewer;
        const count = previewer.slideCount || 0;
        if (count === 0) {
          setError('No slides found in this PPTX file.');
        } else {
          setSlideCount(count);
          setActiveSlide(0);
          previewer.renderSingleSlide(0);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to render PPTX presentation.');
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
    return () => {
      previewerRef.current?.destroy();
      previewerRef.current = null;
    };
  }, []);

  const goToSlide = (idx: number) => {
    if (!previewerRef.current || slideCount === 0) return;
    const clamped = Math.max(0, Math.min(slideCount - 1, idx));
    setActiveSlide(clamped);
    previewerRef.current.renderSingleSlide(clamped);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (slideCount === 0) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        goToSlide(activeSlide + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        goToSlide(activeSlide - 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSlide, slideCount]);

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
    previewerRef.current?.destroy();
    previewerRef.current = null;
    setFiles([]);
    setSlideCount(0);
    setActiveSlide(0);
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
        onFilesSelected={setFiles}
        onError={setError}
        onReset={handleReset}
        compact={slideCount > 0}
      />

      {error && <StatusBanner type="error" message={error} />}
      {loading && <StatusBanner type="loading" message="Rendering PowerPoint slides with pptx-preview..." />}

      {files.length > 0 && (
        <div className="border border-[#E5E5E5] bg-white">
          {slideCount > 0 && (
            <div className="bg-[#F5F5F5] border-b border-[#E5E5E5] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={activeSlide <= 0}
                  onClick={() => goToSlide(activeSlide - 1)}
                  className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Prev
                </button>
                <span className="px-3 text-xs font-mono text-[#222222]">
                  Slide {activeSlide + 1} / {slideCount}
                </span>
                <button
                  type="button"
                  disabled={activeSlide >= slideCount - 1}
                  onClick={() => goToSlide(activeSlide + 1)}
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
                <button
                  type="button"
                  onClick={handleReset}
                  className="df-btn-light px-2 py-1.5 text-xs cursor-pointer"
                  title="Close file"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12">
            {slideCount > 0 && (
              <aside className="lg:col-span-2 border-b lg:border-b-0 lg:border-r border-[#E5E5E5] bg-[#F5F5F5] p-2.5 max-h-48 lg:max-h-[560px] overflow-y-auto flex lg:flex-col gap-1.5">
                {Array.from({ length: slideCount }, (_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => goToSlide(idx)}
                    className={`text-left px-2.5 py-2 border shrink-0 w-28 lg:w-full text-xs font-mono cursor-pointer ${
                      idx === activeSlide
                        ? 'bg-[#222222] text-white border-[#222222]'
                        : 'bg-white text-[#222222] border-[#E5E5E5] hover:border-[#222222]'
                    }`}
                  >
                    Slide {idx + 1}
                  </button>
                ))}
              </aside>
            )}

            <div
              ref={stageRef}
              className={`${slideCount > 0 ? 'lg:col-span-10' : 'lg:col-span-12'} bg-[#E5E5E5] p-4 sm:p-6 flex flex-col items-center justify-center overflow-auto`}
            >
              <div
                ref={previewWrapRef}
                className="w-full max-w-[960px] bg-white border border-[#CCCCCC] overflow-hidden flex items-center justify-center"
              />

              {isFullscreen && slideCount > 0 && (
                <div className="mt-4 flex items-center gap-2 bg-white border border-[#222222] px-3 py-1.5">
                  <button
                    type="button"
                    disabled={activeSlide <= 0}
                    onClick={() => goToSlide(activeSlide - 1)}
                    className="df-btn-light px-2.5 py-1 text-xs cursor-pointer"
                  >
                    Prev
                  </button>
                  <span className="text-xs font-mono">
                    {activeSlide + 1} / {slideCount}
                  </span>
                  <button
                    type="button"
                    disabled={activeSlide >= slideCount - 1}
                    onClick={() => goToSlide(activeSlide + 1)}
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
