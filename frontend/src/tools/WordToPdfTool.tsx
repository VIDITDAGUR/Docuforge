import React from 'react';
import { ToolDefinition } from '../types/tools';
import { ServerConversionWorkspace } from '../components/tools/ServerConversionWorkspace';

const WordToPdfTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => (
  <ServerConversionWorkspace
    tool={tool}
    endpoint="/api/convert/word-to-pdf"
    outputExtension=".pdf"
    actionLabel="Convert Word to PDF"
    processingLabel="Rendering DOCX document into PDF..."
  />
);

export default WordToPdfTool;
