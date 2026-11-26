import React from 'react';
import { ToolDefinition } from '../types/tools';
import { ServerCompressionWorkspace } from '../components/tools/ServerCompressionWorkspace';

const WordCompressorTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => (
  <ServerCompressionWorkspace
    tool={tool}
    endpoint="/api/compress/word"
    outputSuffix="-compressed.docx"
    actionLabel="Compress Word Document"
  />
);

export default WordCompressorTool;
