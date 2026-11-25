import React, { useRef, useState } from 'react';
import { Upload, FileText, X } from 'lucide-react';
import { formatFileSize, validateFile } from '../../utils/fileValidation';

interface FileDropzoneProps {
  acceptedExtensions: string[];
  formatsLabel: string;
  maxSizeMB: number;
  multiple?: boolean;
  files: File[];
  onFilesSelected: (files: File[]) => void;
  onError: (msg: string | null) => void;
  onReset?: () => void;
  compact?: boolean;
  buttonLabel?: string;
}

export const FileDropzone: React.FC<FileDropzoneProps> = ({
  acceptedExtensions,
  formatsLabel,
  maxSizeMB,
  multiple = false,
  files,
  onFilesSelected,
  onError,
  onReset,
  compact = false,
  buttonLabel = 'Browse Files',
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleIncoming = (incomingList: FileList | null) => {
    if (!incomingList || incomingList.length === 0) return;
    const incoming = Array.from(incomingList);
    const chosen = multiple ? incoming : [incoming[0]];

    for (const file of chosen) {
      const check = validateFile(file, acceptedExtensions, maxSizeMB);
      if (!check.valid) {
        onError(check.error || 'Invalid file.');
        return;
      }
    }

    onError(null);
    if (multiple && files.length > 0) {
      onFilesSelected([...files, ...chosen]);
    } else {
      onFilesSelected(chosen);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    handleIncoming(e.dataTransfer.files);
  };

  const acceptAttr = acceptedExtensions.join(',');

  return (
    <div className="w-full">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`w-full border border-dashed transition-colors ${
          isDragging
            ? 'border-[#222222] bg-[#EBEBEB]'
            : 'border-[#CCCCCC] bg-[#F5F5F5] hover:border-[#222222]'
        } ${compact ? 'p-4 sm:p-5' : 'p-6 sm:p-8'}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={acceptAttr}
          multiple={multiple}
          className="hidden"
          onChange={(e) => {
            handleIncoming(e.target.files);
            e.target.value = '';
          }}
        />

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 bg-white border border-[#E5E5E5] flex items-center justify-center shrink-0">
              <Upload className="w-4 h-4 text-[#222222]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[#222222]">
                {multiple ? 'Drag and drop files here, or browse' : 'Drag and drop a file here, or browse'}
              </p>
              <p className="text-xs text-[#777777] mt-1">
                Supported: <span className="text-[#222222] font-medium">{formatsLabel}</span> &middot; Max {maxSizeMB} MB
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="df-btn-dark px-4 py-2 text-xs font-medium shrink-0 cursor-pointer"
          >
            {buttonLabel}
          </button>
        </div>
      </div>

      {files.length > 0 && (
        <div className="mt-3 border border-[#E5E5E5] bg-white">
          <div className="px-3 py-2 bg-[#F5F5F5] border-b border-[#E5E5E5] flex items-center justify-between">
            <span className="text-xs font-semibold text-[#222222]">
              Selected {files.length === 1 ? 'File' : `Files (${files.length})`}
            </span>
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                className="text-xs text-[#777777] hover:text-[#222222] flex items-center gap-1 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>
          <ul className="divide-y divide-[#E5E5E5]">
            {files.map((file, idx) => (
              <li
                key={`${file.name}-${idx}`}
                className="px-3 py-2 flex items-center justify-between gap-3 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="w-3.5 h-3.5 text-[#777777] shrink-0" />
                  <span className="font-medium text-[#222222] truncate">{file.name}</span>
                </div>
                <span className="text-[#777777] font-mono shrink-0">{formatFileSize(file.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
