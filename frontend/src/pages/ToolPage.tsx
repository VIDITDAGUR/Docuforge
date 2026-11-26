import React, { Suspense, lazy } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Lock, Server } from 'lucide-react';
import { getToolBySlug } from '../data/tools';
import { StatusBanner } from '../components/common/StatusBanner';

const PdfViewerTool = lazy(() => import('../tools/PdfViewerTool'));
const PptxViewerTool = lazy(() => import('../tools/PptxViewerTool'));
const ImageToPdfTool = lazy(() => import('../tools/ImageToPdfTool'));
const PdfToImageTool = lazy(() => import('../tools/PdfToImageTool'));
const PdfToWordTool = lazy(() => import('../tools/PdfToWordTool'));
const WordToPdfTool = lazy(() => import('../tools/WordToPdfTool'));
const PdfToPowerPointTool = lazy(() => import('../tools/PdfToPowerPointTool'));
const PowerPointToPdfTool = lazy(() => import('../tools/PowerPointToPdfTool'));
const PdfResizerTool = lazy(() => import('../tools/PdfResizerTool'));
const WordEditorTool = lazy(() => import('../tools/WordEditorTool'));
const PdfEditorTool = lazy(() => import('../tools/PdfEditorTool'));
const PdfCompressorTool = lazy(() => import('../tools/PdfCompressorTool'));
const WordCompressorTool = lazy(() => import('../tools/WordCompressorTool'));
const ImageCompressorTool = lazy(() => import('../tools/ImageCompressorTool'));

export const ToolPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const tool = slug ? getToolBySlug(slug) : undefined;

  if (!tool) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-6">
          <h1 className="text-lg font-bold text-[#222222]">Tool Not Found</h1>
          <p className="text-xs text-[#777777] mt-1">
            The requested tool workspace does not exist.
          </p>
          <Link to="/tools" className="mt-4 inline-block df-btn-dark px-4 py-2 text-xs font-medium">
            Browse All Tools
          </Link>
        </div>
      </div>
    );
  }

  const renderToolWorkspace = () => {
    switch (tool.slug) {
      case 'pdf-viewer':
        return <PdfViewerTool tool={tool} />;
      case 'pptx-viewer':
        return <PptxViewerTool tool={tool} />;
      case 'image-to-pdf':
        return <ImageToPdfTool tool={tool} />;
      case 'pdf-to-image':
        return <PdfToImageTool tool={tool} />;
      case 'pdf-to-word':
        return <PdfToWordTool tool={tool} />;
      case 'word-to-pdf':
        return <WordToPdfTool tool={tool} />;
      case 'pdf-to-powerpoint':
        return <PdfToPowerPointTool tool={tool} />;
      case 'powerpoint-to-pdf':
        return <PowerPointToPdfTool tool={tool} />;
      case 'pdf-resizer':
        return <PdfResizerTool tool={tool} />;
      case 'word-editor':
        return <WordEditorTool tool={tool} />;
      case 'pdf-editor':
        return <PdfEditorTool tool={tool} />;
      case 'pdf-compressor':
        return <PdfCompressorTool tool={tool} />;
      case 'word-compressor':
        return <WordCompressorTool tool={tool} />;
      case 'image-compressor':
        return <ImageCompressorTool tool={tool} />;
      default:
        return null;
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
      {/* Workspace Header */}
      <div
        style={{
          backgroundColor: tool.theme.bg,
          borderColor: tool.theme.border,
        }}
        className="border p-4 mb-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <Link
            to="/tools"
            className="inline-flex items-center gap-1.5 text-xs text-[#555555] hover:text-[#222222]"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            All Tools
          </Link>

          <div className="flex items-center gap-2 text-xs">
            <span
              style={{
                backgroundColor: tool.theme.tagBg,
                borderColor: tool.theme.border,
              }}
              className="border px-2 py-0.5 font-mono text-[#555555]"
            >
              {tool.groupLabel}
            </span>
            <span className="border border-[#E5E5E5] bg-white px-2 py-0.5 font-mono text-[#222222] inline-flex items-center gap-1">
              {tool.processingMode === 'local' ? (
                <>
                  <Lock className="w-3 h-3" /> Processed locally in browser
                </>
              ) : (
                <>
                  <Server className="w-3 h-3" /> Stateless server conversion (auto-deleted)
                </>
              )}
            </span>
          </div>
        </div>

        <h1 className="text-xl sm:text-2xl font-bold text-[#222222]">{tool.name}</h1>
        <p className="text-xs sm:text-sm text-[#666666] mt-1">{tool.description}</p>
      </div>

      {tool.limitationNote && (
        <div className="mb-5">
          <StatusBanner type="info" message={`Formatting note: ${tool.limitationNote}`} />
        </div>
      )}

      <Suspense
        fallback={
          <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-6">
            <StatusBanner type="loading" message={`Loading ${tool.name} workspace...`} />
          </div>
        }
      >
        {renderToolWorkspace()}
      </Suspense>
    </div>
  );
};
