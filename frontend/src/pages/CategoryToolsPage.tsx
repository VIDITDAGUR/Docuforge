import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { TOOLS } from '../data/tools';
import { ToolCategory } from '../types/tools';
import { ToolCard } from '../components/common/ToolCard';

interface CategoryToolsPageProps {
  category?: ToolCategory;
  title: string;
  description: string;
}

export const CategoryToolsPage: React.FC<CategoryToolsPageProps> = ({
  category,
  title,
  description,
}) => {
  const [query, setQuery] = useState('');

  const tools = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TOOLS.filter((t) => {
      const catMatch = !category || t.category === category;
      const searchMatch =
        !q ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.formatsLabel.toLowerCase().includes(q);
      return catMatch && searchMatch;
    });
  }, [category, query]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <div className="border-b border-[#E5E5E5] pb-5 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="text-xs font-mono uppercase tracking-wider text-[#777777] mb-1">
            DOCUFORGE Directory
          </div>
          <h1 className="text-2xl font-bold text-[#222222]">{title}</h1>
          <p className="text-sm text-[#777777] mt-1">{description}</p>
        </div>

        <div className="flex items-center border border-[#E5E5E5] bg-white focus-within:border-[#222222] w-full md:w-72">
          <Search className="w-4 h-4 text-[#777777] ml-3 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tools..."
            className="w-full px-3 py-2 text-xs text-[#222222] placeholder-[#777777]"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <Link
          to="/tools"
          className={`px-3 py-1.5 text-xs font-medium border ${
            !category
              ? 'bg-[#222222] text-white border-[#222222]'
              : 'bg-white text-[#222222] border-[#E5E5E5] hover:bg-[#F5F5F5]'
          }`}
        >
          All Tools
        </Link>
        <Link
          to="/pdf-tools"
          className={`px-3 py-1.5 text-xs font-medium border ${
            category === 'pdf'
              ? 'bg-[#222222] text-white border-[#222222]'
              : 'bg-white text-[#222222] border-[#E5E5E5] hover:bg-[#F5F5F5]'
          }`}
        >
          PDF Tools
        </Link>
        <Link
          to="/document-tools"
          className={`px-3 py-1.5 text-xs font-medium border ${
            category === 'document'
              ? 'bg-[#222222] text-white border-[#222222]'
              : 'bg-white text-[#222222] border-[#E5E5E5] hover:bg-[#F5F5F5]'
          }`}
        >
          Document Tools
        </Link>
        <Link
          to="/presentation-tools"
          className={`px-3 py-1.5 text-xs font-medium border ${
            category === 'presentation'
              ? 'bg-[#222222] text-white border-[#222222]'
              : 'bg-white text-[#222222] border-[#E5E5E5] hover:bg-[#F5F5F5]'
          }`}
        >
          Presentation Tools
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </div>
    </div>
  );
};
