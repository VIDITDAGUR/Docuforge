import React from 'react';
import { ToolDefinition } from '../types/tools';
import { ServerConversionWorkspace } from '../components/tools/ServerConversionWorkspace';

const PdfToWordTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => (
  <ServerConversionWorkspace
    tool={tool}
    endpoint="/api/convert/pdf-to-word"
    outputExtension=".docx"
    actionLabel="Convert PDF to Word"
    processingLabel="Extracting text and document structure into DOCX..."
  />
);

export default PdfToWordTool;
