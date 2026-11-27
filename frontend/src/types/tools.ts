export type ToolCategory = 'pdf' | 'document' | 'presentation';

export type ProcessingMode = 'local' | 'server';

export interface ToolTheme {
  bg: string;
  hoverBg: string;
  border: string;
  tagBg: string;
}

export interface ToolDefinition {
  id: string;
  slug: string;
  name: string;
  category: ToolCategory;
  groupLabel:
    | 'Document Conversion'
    | 'Document Viewers'
    | 'Document Editors'
    | 'Academic Tools'
    | 'PDF Utilities'
    | 'Document Utilities'
    | 'Image Utilities';
  description: string;
  acceptedExtensions: string[];
  acceptedMimeTypes: string[];
  formatsLabel: string;
  maxSizeMB: number;
  multiple?: boolean;
  allowBlankStart?: boolean;
  processingMode: ProcessingMode;
  limitationNote?: string;
  theme: ToolTheme;
}

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}
