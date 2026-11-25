import React, { useEffect, useState } from 'react';
import { Download, RotateCcw } from 'lucide-react';
import { PDFDocument } from 'pdf-lib';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { formatFileSize, replaceExtension, triggerBlobDownload } from '../utils/fileValidation';

type PresetSize = 'a4' | 'a3' | 'a5' | 'letter' | 'custom';
type Unit = 'mm' | 'in' | 'pt';

const PRESETS_PT: Record<Exclude<PresetSize, 'custom'>, [number, number]> = {
  a4: [595.28, 841.89],
  a3: [841.89, 1190.55],
  a5: [419.53, 595.28],
  letter: [612, 792],
};

function toPoints(value: number, unit: Unit): number {
  if (unit === 'mm') return (value * 72) / 25.4;
  if (unit === 'in') return value * 72;
  return value;
}

const PdfResizerTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [preset, setPreset] = useState<PresetSize>('a4');
  const [orientation, setOrientation] = useState<'auto' | 'portrait' | 'landscape'>('auto');
  const [unit, setUnit] = useState<Unit>('mm');
  const [customWidth, setCustomWidth] = useState<number>(210);
  const [customHeight, setCustomHeight] = useState<number>(297);
  const [sourceInfo, setSourceInfo] = useState<{ pages: number; widthPt: number; heightPt: number } | null>(null);

  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; filename: string } | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
  });

  useEffect(() => {
    let cancelled = false;
    if (files.length === 0) {
      setSourceInfo(null);
      return;
    }

    (async () => {
      try {
        const bytes = await files[0].arrayBuffer();
        const doc = await PDFDocument.load(bytes);
        if (cancelled) return;
        const first = doc.getPage(0);
        const { width, height } = first.getSize();
        setSourceInfo({ pages: doc.getPageCount(), widthPt: Math.round(width), heightPt: Math.round(height) });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to read PDF page dimensions.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [files]);

  const handleResize = async () => {
    if (files.length === 0) return;

    let baseW: number;
    let baseH: number;
    if (preset === 'custom') {
      baseW = toPoints(customWidth, unit);
      baseH = toPoints(customHeight, unit);
      if (!Number.isFinite(baseW) || !Number.isFinite(baseH) || baseW < 36 || baseH < 36) {
        setError('Custom dimensions must be at least 36 points (approx. 13 mm / 0.5 in).');
        return;
      }
    } else {
      [baseW, baseH] = PRESETS_PT[preset];
    }

    setProcessing(true);
    setError(null);
    setResult(null);

    try {
      const srcBytes = await files[0].arrayBuffer();
      const srcDoc = await PDFDocument.load(srcBytes);
      const outDoc = await PDFDocument.create();

      const pages = srcDoc.getPages();
      for (const srcPage of pages) {
        const { width: srcW, height: srcH } = srcPage.getSize();
        const srcLandscape = srcW > srcH;

        let targetW = baseW;
        let targetH = baseH;

        if (orientation === 'auto') {
          if (srcLandscape && baseW < baseH) {
            targetW = baseH;
            targetH = baseW;
          } else if (!srcLandscape && baseW > baseH) {
            targetW = baseH;
            targetH = baseW;
          }
        } else if (orientation === 'landscape' && baseW < baseH) {
          targetW = baseH;
          targetH = baseW;
        } else if (orientation === 'portrait' && baseW > baseH) {
          targetW = baseH;
          targetH = baseW;
        }

        const embeddedPage = await outDoc.embedPage(srcPage);
        const outPage = outDoc.addPage([targetW, targetH]);

        const scale = Math.min(targetW / srcW, targetH / srcH);
        const drawW = srcW * scale;
        const drawH = srcH * scale;
        const offsetX = (targetW - drawW) / 2;
        const offsetY = (targetH - drawH) / 2;

        outPage.drawPage(embeddedPage, {
          x: offsetX,
          y: offsetY,
          width: drawW,
          height: drawH,
        });
      }

      const outBytes = await outDoc.save();
      const outBlob = new Blob([new Uint8Array(outBytes)], { type: 'application/pdf' });
      setResult({
        blob: outBlob,
        filename: replaceExtension(files[0].name, `-${preset}.pdf`),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resize PDF pages.');
    } finally {
      setProcessing(false);
    }
  };

  const handleReset = () => {
    setFiles([]);
    setResult(null);
    setError(null);
    setSourceInfo(null);
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
          setResult(null);
          setError(null);
        }}
        onError={setError}
        onReset={handleReset}
      />

      {error && <StatusBanner type="error" message={error} />}

      {files.length > 0 && (
        <div className="border border-[#E5E5E5] bg-white">
          <div className="bg-[#F5F5F5] border-b border-[#E5E5E5] px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-[#222222]">Resize Settings</span>
            {sourceInfo && (
              <span className="font-mono text-[#777777]">
                Source: {sourceInfo.pages} {sourceInfo.pages === 1 ? 'page' : 'pages'} &middot;{' '}
                {sourceInfo.widthPt} &times; {sourceInfo.heightPt} pt
              </span>
            )}
          </div>

          <div className="p-4 space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-[#222222] mb-1.5">Target Page Size</label>
                <div className="grid grid-cols-5 gap-1">
                  {(['a4', 'a3', 'a5', 'letter', 'custom'] as PresetSize[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setPreset(p);
                        setResult(null);
                      }}
                      className={`py-2 px-2 border font-medium uppercase cursor-pointer ${
                        preset === p
                          ? 'bg-[#222222] text-white border-[#222222]'
                          : 'bg-white text-[#222222] border-[#E5E5E5] hover:bg-[#F5F5F5]'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block font-medium text-[#222222] mb-1.5">Orientation</label>
                <select
                  value={orientation}
                  onChange={(e) => {
                    setOrientation(e.target.value as 'auto' | 'portrait' | 'landscape');
                    setResult(null);
                  }}
                  className="w-full border border-[#E5E5E5] bg-white px-3 py-2 text-xs"
                >
                  <option value="auto">Auto (Match source page orientation)</option>
                  <option value="portrait">Force Portrait</option>
                  <option value="landscape">Force Landscape</option>
                </select>
              </div>
            </div>

            {preset === 'custom' && (
              <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-3.5 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[#777777] mb-1">Width</label>
                  <input
                    type="number"
                    min={1}
                    step="0.1"
                    value={customWidth}
                    onChange={(e) => {
                      setCustomWidth(Number(e.target.value));
                      setResult(null);
                    }}
                    className="w-full border border-[#E5E5E5] bg-white px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[#777777] mb-1">Height</label>
                  <input
                    type="number"
                    min={1}
                    step="0.1"
                    value={customHeight}
                    onChange={(e) => {
                      setCustomHeight(Number(e.target.value));
                      setResult(null);
                    }}
                    className="w-full border border-[#E5E5E5] bg-white px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[#777777] mb-1">Unit</label>
                  <select
                    value={unit}
                    onChange={(e) => {
                      setUnit(e.target.value as Unit);
                      setResult(null);
                    }}
                    className="w-full border border-[#E5E5E5] bg-white px-2.5 py-1.5 text-xs"
                  >
                    <option value="mm">Millimeters (mm)</option>
                    <option value="in">Inches (in)</option>
                    <option value="pt">Points (pt)</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          <div className="bg-[#F5F5F5] border-t border-[#E5E5E5] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={processing}
                onClick={handleResize}
                className="df-btn-dark px-4 py-2 text-xs font-medium cursor-pointer"
              >
                {processing ? 'Resizing PDF...' : 'Resize PDF'}
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="df-btn-light px-3 py-2 text-xs font-medium inline-flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            </div>

            {result && (
              <button
                type="button"
                onClick={() => triggerBlobDownload(result.blob, result.filename)}
                className="df-btn-dark px-4 py-2 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download Resized PDF ({formatFileSize(result.blob.size)})
              </button>
            )}
          </div>
        </div>
      )}

      {processing && <StatusBanner type="loading" message="Scaling pages proportionally..." />}
      {result && (
        <StatusBanner
          type="success"
          message={`PDF resized cleanly to ${preset.toUpperCase()} (${formatFileSize(result.blob.size)}).`}
        />
      )}
    </div>
  );
};

export default PdfResizerTool;
