import React from 'react';
import { AlertCircle, CheckSquare, Loader2, ShieldCheck } from 'lucide-react';

interface StatusBannerProps {
  type: 'loading' | 'error' | 'success' | 'info';
  message: string;
}

export const StatusBanner: React.FC<StatusBannerProps> = ({ type, message }) => {
  const styles =
    type === 'error'
      ? 'bg-[#F5F5F5] border-[#222222] text-[#222222]'
      : type === 'success'
      ? 'bg-[#F5F5F5] border-[#222222] text-[#222222]'
      : 'bg-[#F5F5F5] border-[#E5E5E5] text-[#222222]';

  return (
    <div className={`border px-3.5 py-2.5 text-xs flex items-start gap-2.5 ${styles}`} role="status">
      {type === 'loading' && <Loader2 className="w-4 h-4 animate-spin text-[#222222] shrink-0 mt-0.5" />}
      {type === 'error' && <AlertCircle className="w-4 h-4 text-[#222222] shrink-0 mt-0.5" />}
      {type === 'success' && <CheckSquare className="w-4 h-4 text-[#222222] shrink-0 mt-0.5" />}
      {type === 'info' && <ShieldCheck className="w-4 h-4 text-[#777777] shrink-0 mt-0.5" />}
      <span className="leading-relaxed">{message}</span>
    </div>
  );
};
