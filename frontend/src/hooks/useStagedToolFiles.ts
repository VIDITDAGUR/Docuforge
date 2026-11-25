import { useEffect } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { validateFile } from '../utils/fileValidation';

export function useStagedToolFiles(
  acceptedExtensions: string[],
  maxSizeMB: number,
  multiple: boolean,
  onFiles: (files: File[]) => void
): void {
  const { stagedFiles, clearStagedFiles } = useWorkspace();

  useEffect(() => {
    if (stagedFiles.length === 0) return;
    const matching = stagedFiles.filter(
      (f) => validateFile(f, acceptedExtensions, maxSizeMB).valid
    );
    if (matching.length > 0) {
      onFiles(multiple ? matching : [matching[0]]);
    }
    clearStagedFiles();
    // Only run on mount when coming from homepage staged upload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
