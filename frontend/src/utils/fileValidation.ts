import { FileValidationResult } from '../types/tools';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function getFileExtension(fileName: string): string {
  const parts = fileName.toLowerCase().split('.');
  return parts.length > 1 ? `.${parts.pop()}` : '';
}

export function validateFile(
  file: File,
  acceptedExtensions: string[],
  maxSizeMB: number
): FileValidationResult {
  if (!file || file.size === 0) {
    return { valid: false, error: 'Selected file is empty (0 bytes).' };
  }

  const ext = getFileExtension(file.name);
  if (!acceptedExtensions.includes(ext)) {
    return {
      valid: false,
      error: `Unsupported file format "${ext || 'unknown'}". Expected: ${acceptedExtensions.join(', ')}.`,
    };
  }

  const maxBytes = maxSizeMB * 1024 * 1024;
  if (file.size > maxBytes) {
    return {
      valid: false,
      error: `File size (${formatFileSize(file.size)}) exceeds the ${maxSizeMB} MB limit.`,
    };
  }

  return { valid: true };
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function replaceExtension(filename: string, newExt: string): string {
  const cleanExt = newExt.startsWith('.') ? newExt : `.${newExt}`;
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return `${filename}${cleanExt}`;
  return `${filename.slice(0, idx)}${cleanExt}`;
}
