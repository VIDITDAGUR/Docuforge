import React, { useRef, useState } from 'react';
import { Download, RotateCcw, X } from 'lucide-react';
import { ToolDefinition } from '../../types/tools';
import { FileDropzone } from '../common/FileDropzone';
import { StatusBanner } from '../common/StatusBanner';
import { useStagedToolFiles } from '../../hooks/useStagedToolFiles';
import { formatFileSize, replaceExtension, triggerBlobDownload } from '../../utils/fileValidation';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

interface ServerCompressionWorkspaceProps {
  tool: ToolDefinition;
  endpoint: string;
  outputSuffix: string;
  actionLabel: string;
}

export const ServerCompressionWorkspace: React.FC<ServerCompressionWorkspaceProps> = ({
  tool,
  endpoint,
  outputSuffix,
  actionLabel,
}) => {
  const [files, setFiles] = useState<File[]>([]);
  const [compressionPct, setCompressionPct] = useState<number>(50);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    blob: Blob;
    filename: string;
    origSize: number;
    newSize: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
  });

  const handleCompress = async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    setResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const formData = new FormData();
      formData.append('file', files[0]);
      formData.append('compression', String(compressionPct));

      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `Server returned status ${response.status}.`;
        try {
          const data = await response.json();
          if (data?.detail) message = data.detail;
        } catch {
          // ignore non-json error body
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      if (blob.size === 0) {
        throw new Error('Compression produced an empty file.');
      }

      const origHeader = Number(response.headers.get('X-Original-Bytes'));
      const newHeader = Number(response.headers.get('X-Compressed-Bytes'));
      const origSize = Number.isFinite(origHeader) && origHeader > 0 ? origHeader : files[0].size;
      const newSize = Number.isFinite(newHeader) && newHeader > 0 ? newHeader : blob.size;

      setResult({
        blob,
        filename: replaceExtension(files[0].name, outputSuffix),
        origSize,
        newSize,
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Compression cancelled.');
      } else {
        setError(
          err instanceof Error
            ? err.message
            : 'Compression failed. Ensure the DOCUFORGE backend server is running.'
        );
      }
    } finally {
      setProcessing(false);
      abortRef.current = null;
    }
  };

  const handleReset = () => {
    abortRef.current?.abort();
    setFiles([]);
    setResult(null);
    setError(null);
  };

  const savedPct =
    result && result.origSize > 0
      ? Math.max(0, Math.round(((result.origSize - result.newSize) / result.origSize) * 100))
      : 0;

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
            <span className="font-semibold text-[#222222]">Compression Settings</span>
            <span className="font-mono text-[#777777]">
              Original: {formatFileSize(files[0].size)} &middot; Target reduction: ~{compressionPct}%
            </span>
          </div>

          <div className="p-4 space-y-4 text-xs">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="compression-slider" className="font-medium text-[#222222]">
                  Compression Level: <span className="font-mono font-bold">{compressionPct}%</span>
                </label>
                <span className="text-[#777777]">
                  {compressionPct <= 30
                    ? 'Light (High quality)'
                    : compressionPct <= 60
                    ? 'Balanced (Recommended)'
                    : 'Strong (Maximum size reduction)'}
                </span>
              </div>

              <input
                id="compression-slider"
                type="range"
                min={10}
                max={85}
                step={5}
                value={compressionPct}
                onChange={(e) => {
                  setCompressionPct(Number(e.target.value));
                  setResult(null);
                }}
                className="w-full accent-[#222222] cursor-pointer"
              />

              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  { label: '25% Light', val: 25 },
                  { label: '50% Balanced', val: 50 },
                  { label: '75% Strong', val: 75 },
                  { label: '85% Max', val: 85 },
                ].map((preset) => (
                  <button
                    key={preset.val}
                    type="button"
                    onClick={() => {
                      setCompressionPct(preset.val);
                      setResult(null);
                    }}
                    className={`px-2.5 py-1 border text-xs cursor-pointer ${
                      compressionPct === preset.val
                        ? 'bg-[#222222] text-white border-[#222222]'
                        : 'bg-white text-[#222222] border-[#E5E5E5] hover:bg-[#F5F5F5]'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
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
                {processing ? 'Compressing...' : actionLabel}
              </button>

              {processing ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="df-btn-light px-3 py-2 text-xs inline-flex items-center gap-1 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleReset}
                  className="df-btn-light px-3 py-2 text-xs inline-flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset
                </button>
              )}
            </div>

            {result && (
              <button
                type="button"
                onClick={() => triggerBlobDownload(result.blob, result.filename)}
                className="df-btn-dark px-4 py-2 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download ({formatFileSize(result.newSize)})
              </button>
            )}
          </div>
        </div>
      )}

      {processing && (
        <StatusBanner type="loading" message={`Compressing file at ${compressionPct}% target level...`} />
      )}

      {result && (
        <StatusBanner
          type="success"
          message={`Compressed "${result.filename}": ${formatFileSize(result.origSize)} → ${formatFileSize(
            result.newSize
          )} (${savedPct}% smaller).`}
        />
      )}
    </div>
  );
};
