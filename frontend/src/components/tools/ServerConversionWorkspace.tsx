import React, { useRef, useState } from 'react';
import { Download, RotateCcw, X } from 'lucide-react';
import { ToolDefinition } from '../../types/tools';
import { FileDropzone } from '../common/FileDropzone';
import { StatusBanner } from '../common/StatusBanner';
import { useStagedToolFiles } from '../../hooks/useStagedToolFiles';
import { formatFileSize, replaceExtension, triggerBlobDownload } from '../../utils/fileValidation';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

interface ServerConversionWorkspaceProps {
  tool: ToolDefinition;
  endpoint: string;
  outputExtension: string;
  actionLabel: string;
  processingLabel: string;
}

export const ServerConversionWorkspace: React.FC<ServerConversionWorkspaceProps> = ({
  tool,
  endpoint,
  outputExtension,
  actionLabel,
  processingLabel,
}) => {
  const [files, setFiles] = useState<File[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; filename: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
  });

  const handleConvert = async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    setResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const formData = new FormData();
      formData.append('file', files[0]);

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
        throw new Error('Conversion produced an empty file.');
      }

      const outName = replaceExtension(files[0].name, outputExtension);
      setResult({ blob, filename: outName });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Conversion cancelled.');
      } else {
        setError(
          err instanceof Error
            ? err.message
            : 'Conversion failed. Ensure the DOCUFORGE backend server is running.'
        );
      }
    } finally {
      setProcessing(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleReset = () => {
    abortRef.current?.abort();
    setFiles([]);
    setResult(null);
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
          setResult(null);
          setError(null);
        }}
        onError={setError}
        onReset={handleReset}
      />

      {error && <StatusBanner type="error" message={error} />}

      {files.length > 0 && (
        <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={processing}
              onClick={handleConvert}
              className="df-btn-dark px-4 py-2 text-xs font-medium cursor-pointer"
            >
              {processing ? 'Processing...' : actionLabel}
            </button>

            {processing && (
              <button
                type="button"
                onClick={handleCancel}
                className="df-btn-light px-3 py-2 text-xs font-medium inline-flex items-center gap-1 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
            )}

            {!processing && (
              <button
                type="button"
                onClick={handleReset}
                className="df-btn-light px-3 py-2 text-xs font-medium inline-flex items-center gap-1 cursor-pointer"
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
              Download {outputExtension.toUpperCase().replace('.', '')} ({formatFileSize(result.blob.size)})
            </button>
          )}
        </div>
      )}

      {processing && <StatusBanner type="loading" message={processingLabel} />}

      {result && (
        <StatusBanner
          type="success"
          message={`Ready: "${result.filename}" (${formatFileSize(result.blob.size)}). Temporary server files were automatically removed.`}
        />
      )}
    </div>
  );
};
