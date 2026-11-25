import React, { createContext, useContext, useState } from 'react';

interface WorkspaceContextValue {
  stagedFiles: File[];
  setStagedFiles: (files: File[]) => void;
  clearStagedFiles: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export const WorkspaceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);

  const clearStagedFiles = () => setStagedFiles([]);

  return (
    <WorkspaceContext.Provider value={{ stagedFiles, setStagedFiles, clearStagedFiles }}>
      {children}
    </WorkspaceContext.Provider>
  );
};

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return ctx;
}
