import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  Minimize2,
  RotateCcw,
} from 'lucide-react';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { triggerBlobDownload } from '../utils/fileValidation';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

interface JobResponse {
  job_id: string;
  file_hash: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  cached?: boolean;
  slide_count: number;
  slides: string[];
  aspect_ratio: number;
  missing_fonts?: string[];
  error?: string | null;
}

const PptxViewerTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusPhase, setStatusPhase] = useState<string | null>(null);

  const [slides, setSlides] = useState<string[]>([]);
  const [aspectRatio, setAspectRatio] = useState<number>(16 / 9);
  const [missingFonts, setMissingFonts] = useState<string[]>([]);
  const [wasCached, setWasCached] = useState<boolean>(false);
  const [activeSlide, setActiveSlide] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const touchStartX = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
  });

  const clearTimersAndRequests = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => clearTimersAndRequests();
  }, []);

  useEffect(() => {
    clearTimersAndRequests();
    if (files.length === 0) {
      setSlides([]);
      setMissingFonts([]);
      setWasCached(false);
      setActiveSlide(0);
      setStatusPhase(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;

    const pollJob = async (jobId: string) => {
      if (cancelled) return;
      try {
        const res = await fetch(`${API_BASE}/api/jobs/${jobId}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Unable to read conversion status (HTTP ${res.status}).`);
        }
        const job: JobResponse = await res.json();
        if (cancelled) return;

        if (job.status === 'done') {
          setSlides(job.slides.map((u) => `${API_BASE}${u}`));
          setAspectRatio(job.aspect_ratio || 16 / 9);
          setMissingFonts(job.missing_fonts || []);
          setActiveSlide(0);
          setStatusPhase(null);
          return;
        }

        if (job.status === 'failed') {
          setError(
            job.error ||
              'Presentation conversion failed. Ensure LibreOffice and Poppler are installed on the server.'
          );
          setStatusPhase(null);
          return;
        }

        setStatusPhase(
          job.status === 'processing'
            ? 'Rendering slides via LibreOffice headless and pdftoppm (150 DPI)...'
            : 'Queued for LibreOffice conversion...'
        );
        pollTimerRef.current = window.setTimeout(() => void pollJob(jobId), 800);
      } catch (err: unknown) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : 'Failed while checking conversion progress.');
        setStatusPhase(null);
      }
    };

    const uploadDeck = async () => {
      setError(null);
      setSlides([]);
      setMissingFonts([]);
      setWasCached(false);
      setStatusPhase('Uploading PPTX presentation to server...');

      try {
        const formData = new FormData();
        formData.append('file', files[0]);

        const res = await fetch(`${API_BASE}/api/upload`, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });

        if (!res.ok) {
          let detail = `Upload failed with status ${res.status}.`;
          try {
            const payload = await res.json();
            if (payload?.detail) detail = payload.detail;
          } catch {
            // ignore non-json error
          }
          throw new Error(detail);
        }

        const job: JobResponse = await res.json();
        if (cancelled) return;

        setWasCached(Boolean(job.cached));
        if (job.status === 'done') {
          setSlides(job.slides.map((u) => `${API_BASE}${u}`));
          setAspectRatio(job.aspect_ratio || 16 / 9);
          setMissingFonts(job.missing_fonts || []);
          setActiveSlide(0);
          setStatusPhase(null);
        } else {
          setStatusPhase('Queued for LibreOffice conversion...');
          pollTimerRef.current = window.setTimeout(() => void pollJob(job.job_id), 600);
        }
      } catch (err: unknown) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(
          err instanceof Error
            ? err.message
            : 'Unable to upload presentation. Verify the DOCUFORGE backend server is running.'
        );
        setStatusPhase(null);
      }
    };

    void uploadDeck();

    return () => {
      cancelled = true;
      clearTimersAndRequests();
    };
  }, [files]);

  const goToSlide = (idx: number) => {
    if (slides.length === 0) return;
    setActiveSlide(Math.max(0, Math.min(slides.length - 1, idx)));
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (slides.length === 0) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        goToSlide(activeSlide + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goToSlide(activeSlide - 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSlide, slides.length]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
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

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (touchStartX.current === null || slides.length === 0) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
    const delta = endX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(delta) >= 40) {
      if (delta < 0) goToSlide(activeSlide + 1);
      else goToSlide(activeSlide - 1);
    }
  };

  const handleReset = () => {
    clearTimersAndRequests();
    setFiles([]);
    setSlides([]);
    setMissingFonts([]);
    setWasCached(false);
    setActiveSlide(0);
    setStatusPhase(null);
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
        compact={slides.length > 0}
      />

      {error && <StatusBanner type="error" message={error} />}
      {statusPhase && <StatusBanner type="loading" message={statusPhase} />}

      {slides.length > 0 && missingFonts.length > 0 && (
        <StatusBanner
          type="info"
          message={`Font notice: server substituted missing fonts (${missingFonts.slice(0, 5).join(', ')}${
            missingFonts.length > 5 ? '…' : ''
          }) with metric-compatible fonts.`}
        />
      )}

      {slides.length > 0 && (
        <div className="border border-[#E5E5E5] bg-white">
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
                Slide {activeSlide + 1} / {slides.length}
              </span>
              <button
                type="button"
                disabled={activeSlide >= slides.length - 1}
                onClick={() => goToSlide(activeSlide + 1)}
                className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                Next
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              {wasCached && (
                <span className="ml-2 text-[11px] font-mono text-[#777777] border border-[#E5E5E5] bg-white px-2 py-0.5">
                  Cached
                </span>
              )}
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
                title="Close presentation"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div
            ref={stageRef}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            className="bg-[#E5E5E5] p-3 sm:p-6 flex flex-col items-center justify-center"
          >
            {/* Large current-slide display */}
            <div
              className="w-full border border-[#CCCCCC] bg-white overflow-hidden flex items-center justify-center"
              style={{
                maxWidth: isFullscreen ? '1280px' : '960px',
                aspectRatio: `${aspectRatio}`,
              }}
            >
              <img
                src={slides[activeSlide]}
                alt={`Slide ${activeSlide + 1} of ${slides.length}`}
                className="w-full h-full object-contain select-none"
                draggable={false}
              />
            </div>

            {isFullscreen && (
              <div className="mt-3 flex items-center gap-2 bg-white border border-[#222222] px-3 py-1.5">
                <button
                  type="button"
                  disabled={activeSlide <= 0}
                  onClick={() => goToSlide(activeSlide - 1)}
                  className="df-btn-light px-2.5 py-1 text-xs cursor-pointer"
                >
                  Prev
                </button>
                <span className="text-xs font-mono">
                  {activeSlide + 1} / {slides.length}
                </span>
                <button
                  type="button"
                  disabled={activeSlide >= slides.length - 1}
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

            {/* Thumbnail strip with lazy loading */}
            {!isFullscreen && (
              <div className="w-full max-w-[960px] mt-4 border border-[#E5E5E5] bg-white p-2 flex gap-2 overflow-x-auto">
                {slides.map((src, idx) => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => goToSlide(idx)}
                    aria-label={`Go to slide ${idx + 1}`}
                    className={`shrink-0 border p-1 cursor-pointer transition-colors ${
                      idx === activeSlide
                        ? 'border-[#222222] bg-[#222222]'
                        : 'border-[#E5E5E5] bg-[#F5F5F5] hover:border-[#222222]'
                    }`}
                  >
                    <img
                      src={src}
                      alt={`Slide ${idx + 1} thumbnail`}
                      loading="lazy"
                      className="h-16 w-auto block bg-white"
                    />
                    <div
                      className={`text-[10px] font-mono text-center mt-1 ${
                        idx === activeSlide ? 'text-white' : 'text-[#222222]'
                      }`}
                    >
                      {idx + 1}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default PptxViewerTool;
