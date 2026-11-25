import React from 'react';
import { ToolDefinition } from '../types/tools';
import { ServerConversionWorkspace } from '../components/tools/ServerConversionWorkspace';

const PdfToPowerPointTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => (
  <ServerConversionWorkspace
    tool={tool}
    endpoint="/api/convert/pdf-to-pptx"
    outputExtension=".pptx"
    actionLabel="Convert PDF to PowerPoint"
    processingLabel="Rendering PDF pages onto PowerPoint slides..."
  />
);

export default PdfToPowerPointTool;
