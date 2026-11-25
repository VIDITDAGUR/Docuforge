import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { ToolDefinition } from '../../types/tools';

interface ToolCardProps {
  tool: ToolDefinition;
}

export const ToolCard: React.FC<ToolCardProps> = ({ tool }) => {
  const [hovered, setHovered] = useState(false);

  return (
    <Link
      to={`/tools/${tool.slug}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        backgroundColor: hovered ? tool.theme.hoverBg : tool.theme.bg,
        borderColor: hovered ? '#222222' : tool.theme.border,
      }}
      className="group block border p-4 transition-colors flex flex-col justify-between h-full"
    >
      <div>
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <span
            style={{
              backgroundColor: tool.theme.tagBg,
              borderColor: tool.theme.border,
            }}
            className="text-[11px] font-mono uppercase tracking-wide text-[#555555] border px-1.5 py-0.5"
          >
            {tool.groupLabel}
          </span>
          <span className="text-[11px] font-mono text-[#777777]">
            {tool.processingMode === 'local' ? 'Local' : 'Server'}
          </span>
        </div>

        <h3 className="text-sm font-semibold text-[#222222] mb-1.5 flex items-center justify-between">
          <span>{tool.name}</span>
          <ArrowRight className="w-3.5 h-3.5 text-[#777777] group-hover:text-[#222222] transition-colors shrink-0" />
        </h3>

        <p className="text-xs text-[#666666] leading-relaxed">{tool.description}</p>
      </div>

      <div
        style={{ borderColor: tool.theme.border }}
        className="mt-4 pt-2.5 border-t flex items-center justify-between text-[11px] text-[#666666]"
      >
        <span>{tool.formatsLabel}</span>
        <span className="text-[#222222] font-medium">Open &rarr;</span>
      </div>
    </Link>
  );
};
