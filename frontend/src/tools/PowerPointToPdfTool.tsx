import React from 'react';
import { ToolDefinition } from '../types/tools';
import { ServerConversionWorkspace } from '../components/tools/ServerConversionWorkspace';

const PowerPointToPdfTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => (
  <ServerConversionWorkspace
    tool={tool}
    endpoint="/api/convert/pptx-to-pdf"
    outputExtension=".pdf"
    actionLabel="Convert PowerPoint to PDF"
    processingLabel="Converting PPTX slides into PDF pages..."
  />
);

export default PowerPointToPdfTool;
