import React, { useEffect, useState } from 'react';
import { Archive, Download, RotateCcw } from 'lucide-react';
import JSZip from 'jszip';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { formatFileSize, replaceExtension, triggerBlobDownload } from '../utils/fileValidation';

type OutputFormat = 'auto' | 'jpeg' | 'webp' | 'png';

interface CompressedImageResult {
  originalName: string;
  outputName: string;
  origSize: number;
  newSize: number;
  blob: Blob;
  previewUrl: string;
}

async function compressSingleImage(
  file: File,
  compressionPct: number,
  format: OutputFormat
): Promise<CompressedImageResult> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Unable to decode image "${file.name}".`));
      el.src = url;
    });

    // At higher compression %, gently cap very large dimensions too so PNGs & 4K photos shrink cleanly
    const maxDim = Math.round(3200 - compressionPct * 24); // 10% -> 2960px, 50% -> 2000px, 85% -> 1160px
    let targetW = img.naturalWidth;
    let targetH = img.naturalHeight;
    if (Math.max(targetW, targetH) > maxDim) {
      const scale = maxDim / Math.max(targetW, targetH);
      targetW = Math.max(1, Math.round(targetW * scale));
      targetH = Math.max(1, Math.round(targetH * scale));
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');

    const lower = file.name.toLowerCase();
    let targetMime: string;
    let ext: string;

    if (format === 'jpeg') {
      targetMime = 'image/jpeg';
      ext = '.jpg';
    } else if (format === 'webp') {
      targetMime = 'image/webp';
      ext = '.webp';
    } else if (format === 'png') {
      targetMime = 'image/png';
      ext = '.png';
    } else {
      // Auto: preserve format, or switch large PNG to WebP when compression >= 45% for real size drop
      if (lower.endsWith('.webp')) {
        targetMime = 'image/webp';
        ext = '.webp';
      } else if (lower.endsWith('.png')) {
        if (compressionPct >= 45) {
          targetMime = 'image/webp';
          ext = '.webp';
        } else {
          targetMime = 'image/png';
          ext = '.png';
        }
      } else {
        targetMime = 'image/jpeg';
        ext = '.jpg';
      }
    }

    if (targetMime === 'image/jpeg') {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const quality = Math.max(0.15, Math.min(0.95, 1 - compressionPct / 105));
    const encoded = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error(`Failed to encode "${file.name}".`))),
        targetMime,
        quality
      )
    );

    const finalBlob = encoded.size < file.size ? encoded : file;
    const finalName =
      encoded.size < file.size
        ? replaceExtension(file.name, `-compressed${ext}`)
        : file.name;

    return {
      originalName: file.name,
      outputName: finalName,
      origSize: file.size,
      newSize: finalBlob.size,
      blob: finalBlob,
      previewUrl: URL.createObjectURL(finalBlob),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const ImageCompressorTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [compressionPct, setCompressionPct] = useState<number>(50);
  const [format, setFormat] = useState<OutputFormat>('auto');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CompressedImageResult[]>([]);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, true, (incoming) => {
    setFiles(incoming);
  });

  useEffect(() => {
    return () => results.forEach((r) => URL.revokeObjectURL(r.previewUrl));
  }, [results]);

  const clearResults = () => {
    results.forEach((r) => URL.revokeObjectURL(r.previewUrl));
    setResults([]);
  };

  const handleCompress = async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    clearResults();

    try {
      const out: CompressedImageResult[] = [];
      for (const f of files) {
        out.push(await compressSingleImage(f, compressionPct, format));
      }
      setResults(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Image compression failed.');
    } finally {
      setProcessing(false);
    }
  };

  const handleDownloadZip = async () => {
    if (results.length === 0) return;
    const zip = new JSZip();
    for (const item of results) {
      zip.file(item.outputName, item.blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerBlobDownload(zipBlob, 'docuforge-compressed-images.zip');
  };

  const handleReset = () => {
    setFiles([]);
    clearResults();
    setError(null);
  };

  const totalOrig = results.reduce((sum, r) => sum + r.origSize, 0);
  const totalNew = results.reduce((sum, r) => sum + r.newSize, 0);
  const totalSavedPct =
    totalOrig > 0 ? Math.max(0, Math.round(((totalOrig - totalNew) / totalOrig) * 100)) : 0;

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
          clearResults();
          setError(null);
        }}
        onError={setError}
        onReset={handleReset}
        buttonLabel="Add Images"
      />

      {error && <StatusBanner type="error" message={error} />}

      {files.length > 0 && (
        <div className="border border-[#E5E5E5] bg-white">
          <div className="bg-[#F5F5F5] border-b border-[#E5E5E5] px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-[#222222]">Compression Settings</span>
            <span className="font-mono text-[#777777]">
              {files.length} {files.length === 1 ? 'image' : 'images'} &middot; Target reduction: ~{compressionPct}%
            </span>
          </div>

          <div className="p-4 space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
              <div className="md:col-span-8">
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="img-compress-slider" className="font-medium text-[#222222]">
                    Compression Level: <span className="font-mono font-bold">{compressionPct}%</span>
                  </label>
                  <span className="text-[#777777]">
                    {compressionPct <= 30 ? 'Light' : compressionPct <= 60 ? 'Balanced' : 'Strong'}
                  </span>
                </div>
                <input
                  id="img-compress-slider"
                  type="range"
                  min={10}
                  max={85}
                  step={5}
                  value={compressionPct}
                  onChange={(e) => {
                    setCompressionPct(Number(e.target.value));
                    clearResults();
                  }}
                  className="w-full accent-[#222222] cursor-pointer"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[25, 50, 75, 85].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => {
                        setCompressionPct(val);
                        clearResults();
                      }}
                      className={`px-2.5 py-1 border text-xs cursor-pointer ${
                        compressionPct === val
                          ? 'bg-[#222222] text-white border-[#222222]'
                          : 'bg-white text-[#222222] border-[#E5E5E5] hover:bg-[#F5F5F5]'
                      }`}
                    >
                      {val}%
                    </button>
                  ))}
                </div>
              </div>

              <div className="md:col-span-4">
                <label className="block font-medium text-[#222222] mb-1.5">Output Format</label>
                <select
                  value={format}
                  onChange={(e) => {
                    setFormat(e.target.value as OutputFormat);
                    clearResults();
                  }}
                  className="w-full border border-[#E5E5E5] bg-white px-2.5 py-2 text-xs"
                >
                  <option value="auto">Auto (Best size savings)</option>
                  <option value="jpeg">JPG (Smallest photo size)</option>
                  <option value="webp">WebP (Modern compression)</option>
                  <option value="png">PNG (Lossless / resized)</option>
                </select>
              </div>
            </div>
          </div>

          <div className="bg-[#F5F5F5] border-t border-[#E5E5E5] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={processing}
                onClick={handleCompress}
                className="df-btn-dark px-4 py-2 text-xs font-medium cursor-pointer"
              >
                {processing ? 'Compressing...' : 'Compress Images'}
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="df-btn-light px-3 py-2 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            </div>

            {results.length > 1 && (
              <button
                type="button"
                onClick={handleDownloadZip}
                className="df-btn-dark px-4 py-2 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Archive className="w-3.5 h-3.5" />
                Download All as ZIP ({formatFileSize(totalNew)})
              </button>
            )}
          </div>
        </div>
      )}

      {processing && <StatusBanner type="loading" message="Compressing images locally in browser..." />}

      {results.length > 0 && (
        <div className="space-y-3">
          <StatusBanner
            type="success"
            message={`Compressed ${results.length} ${results.length === 1 ? 'image' : 'images'}: ${formatFileSize(
              totalOrig
            )} → ${formatFileSize(totalNew)} (${totalSavedPct}% smaller).`}
          />

          <div className="border border-[#E5E5E5] bg-white divide-y divide-[#E5E5E5]">
            {results.map((item, idx) => {
              const saved =
                item.origSize > 0
                  ? Math.max(0, Math.round(((item.origSize - item.newSize) / item.origSize) * 100))
                  : 0;
              return (
                <div key={idx} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={item.previewUrl}
                      alt={item.outputName}
                      className="w-10 h-10 object-cover border border-[#E5E5E5] bg-[#F5F5F5] shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-[#222222] truncate">{item.outputName}</div>
                      <div className="font-mono text-[11px] text-[#777777]">
                        {formatFileSize(item.origSize)} &rarr; {formatFileSize(item.newSize)} ({saved}% saved)
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => triggerBlobDownload(item.blob, item.outputName)}
                    className="df-btn-dark px-3 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default ImageCompressorTool;
