import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { TOOLS, getMatchingToolsForFile } from '../data/tools';
import { ToolCategory } from '../types/tools';
import { ToolCard } from '../components/common/ToolCard';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useWorkspace } from '../context/WorkspaceContext';

const HERO_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.jpg', '.jpeg', '.png', '.webp'];

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { setStagedFiles } = useWorkspace();

  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | ToolCategory>('all');
  const [heroFiles, setHeroFiles] = useState<File[]>([]);
  const [heroError, setHeroError] = useState<string | null>(null);

  const matchingToolsForHeroFile = useMemo(() => {
    if (heroFiles.length === 0) return [];
    return getMatchingToolsForFile(heroFiles[0].name);
  }, [heroFiles]);

  const filteredTools = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return TOOLS.filter((tool) => {
      const matchesCategory = activeCategory === 'all' || tool.category === activeCategory;
      const matchesSearch =
        !q ||
        tool.name.toLowerCase().includes(q) ||
        tool.description.toLowerCase().includes(q) ||
        tool.groupLabel.toLowerCase().includes(q) ||
        tool.formatsLabel.toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [searchQuery, activeCategory]);

  const handleOpenToolWithStagedFile = (slug: string) => {
    setStagedFiles(heroFiles);
    navigate(`/tools/${slug}`);
  };

  return (
    <div>
      {/* Compact Hero Section */}
      <section className="border-b border-[#E5E5E5] bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-7 sm:py-9">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-6">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#222222] leading-tight">
                Your documents. Your tools. One workspace.
              </h1>
              <p className="mt-2.5 text-sm text-[#777777] leading-relaxed max-w-xl">
                Everything you need to convert, edit, view, and manage documents. Free, simple, and built for productivity.
              </p>

              {/* Search Tools Input */}
              <div className="mt-5">
                <label htmlFor="tool-search" className="sr-only">
                  Search tools
                </label>
                <div className="flex items-center border border-[#E5E5E5] bg-white focus-within:border-[#222222]">
                  <Search className="w-4 h-4 text-[#777777] ml-3 shrink-0" />
                  <input
                    id="tool-search"
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search tools (e.g., PDF to Word, PPTX Viewer, Resizer)..."
                    className="w-full px-3 py-2 text-sm text-[#222222] placeholder-[#777777] bg-transparent"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear search"
                      className="px-2.5 py-2 text-[#777777] hover:text-[#222222] cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Link to="/pdf-tools" className="df-btn-light px-2.5 py-1">
                  PDF Tools
                </Link>
                <Link to="/document-tools" className="df-btn-light px-2.5 py-1">
                  Document Tools
                </Link>
                <Link to="/presentation-tools" className="df-btn-light px-2.5 py-1">
                  Presentation Tools
                </Link>
                <Link to="/tools/word-editor" className="df-btn-light px-2.5 py-1">
                  New Document
                </Link>
                <Link to="/tools/pptx-viewer" className="df-btn-light px-2.5 py-1">
                  PPTX Viewer
                </Link>
              </div>
            </div>

            <div className="lg:col-span-6">
              <FileDropzone
                acceptedExtensions={HERO_EXTENSIONS}
                formatsLabel="PDF, DOCX, PPTX, JPG, PNG, WebP"
                maxSizeMB={50}
                multiple={true}
                compact={true}
                files={heroFiles}
                onFilesSelected={setHeroFiles}
                onError={setHeroError}
                onReset={() => {
                  setHeroFiles([]);
                  setHeroError(null);
                }}
              />

              {heroError && (
                <div className="mt-2">
                  <StatusBanner type="error" message={heroError} />
                </div>
              )}

              {heroFiles.length > 0 && matchingToolsForHeroFile.length > 0 && (
                <div className="mt-2 border border-[#E5E5E5] bg-[#F5F5F5] p-3">
                  <div className="text-xs font-semibold text-[#222222] mb-2">
                    Open {heroFiles.length === 1 ? heroFiles[0].name : `${heroFiles.length} files`} with:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {matchingToolsForHeroFile.map((tool) => (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => handleOpenToolWithStagedFile(tool.slug)}
                        className="df-btn-dark px-2.5 py-1.5 text-xs cursor-pointer"
                      >
                        {tool.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Tool Directory */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-7">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#E5E5E5]">
          <div>
            <h2 className="text-base font-semibold text-[#222222]">Workspace Tools</h2>
            <p className="text-xs text-[#777777]">
              Showing {filteredTools.length} of {TOOLS.length} tools
            </p>
          </div>

          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Tool category filter">
            {(
              [
                { id: 'all', label: 'All Tools' },
                { id: 'pdf', label: 'PDF Tools' },
                { id: 'document', label: 'Document Tools' },
                { id: 'presentation', label: 'Presentation Tools' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeCategory === tab.id}
                onClick={() => setActiveCategory(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium border cursor-pointer ${
                  activeCategory === tab.id
                    ? 'bg-[#222222] text-white border-[#222222]'
                    : 'bg-white text-[#222222] border-[#E5E5E5] hover:bg-[#F5F5F5]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredTools.length === 0 ? (
          <div className="mt-6 border border-[#E5E5E5] bg-[#F5F5F5] p-6 text-center">
            <p className="text-sm text-[#222222] font-medium">No tools match &ldquo;{searchQuery}&rdquo;.</p>
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setActiveCategory('all');
              }}
              className="mt-3 df-btn-light px-3 py-1.5 text-xs cursor-pointer"
            >
              Reset filters
            </button>
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredTools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
