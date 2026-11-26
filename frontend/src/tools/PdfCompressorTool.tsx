import React from 'react';
import { ToolDefinition } from '../types/tools';
import { ServerCompressionWorkspace } from '../components/tools/ServerCompressionWorkspace';

const PdfCompressorTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => (
  <ServerCompressionWorkspace
    tool={tool}
    endpoint="/api/compress/pdf"
    outputSuffix="-compressed.pdf"
    actionLabel="Compress PDF"
  />
);

export default PdfCompressorTool;
