import React from 'react';
import { Link } from 'react-router-dom';

export const AboutPage: React.FC = () => {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <div className="border-b border-[#E5E5E5] pb-5">
        <div className="text-xs font-mono uppercase tracking-wider text-[#777777] mb-1">About</div>
        <h1 className="text-2xl font-bold text-[#222222]">About DOCUFORGE</h1>
        <p className="text-sm text-[#777777] mt-1.5">
          A free, open-source document utility workspace designed for college students, researchers, and everyday academic work.
        </p>
      </div>

      <div className="mt-6 space-y-6">
        <section className="border border-[#E5E5E5] bg-white p-5">
          <h2 className="text-base font-semibold text-[#222222] mb-2">Privacy &amp; File Processing</h2>
          <p className="text-xs text-[#777777] leading-relaxed mb-3">
            DOCUFORGE never requires accounts, tracks user behavior, or stores documents permanently. Every tool clearly indicates how your file is processed:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-3.5">
              <div className="font-semibold text-[#222222] mb-1">Local Browser Processing</div>
              <p className="text-[#777777] leading-relaxed">
                PDF Viewer, PDF Editor, PDF Resizer, Image to PDF, PDF to Image, Image Compressor, and Word Editor (DOCX export) run entirely in your browser. Files never leave your computer.
              </p>
            </div>
            <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-3.5">
              <div className="font-semibold text-[#222222] mb-1">Stateless Backend Processing</div>
              <p className="text-[#777777] leading-relaxed">
                PDF to Word, Word to PDF, PDF to PowerPoint, PDF/Word Compressors, and the high-fidelity PPTX Viewer use the FastAPI backend. Uploaded files are validated by size, MIME type, and signature, with source temp files removed immediately and slide PNG previews cached by SHA-256 hash.
              </p>
            </div>
          </div>
        </section>

        <section className="border border-[#E5E5E5] bg-white p-5">
          <h2 className="text-base font-semibold text-[#222222] mb-2">Transparency on Formatting Limitations</h2>
          <p className="text-xs text-[#777777] leading-relaxed mb-2">
            Document formats such as PDF, DOCX, and PPTX represent content differently. PDFs store absolute visual coordinates, whereas Word documents use reflowable paragraphs and PowerPoint uses slide object trees.
          </p>
          <ul className="list-disc pl-5 text-xs text-[#777777] space-y-1.5 leading-relaxed">
            <li>
              <strong className="text-[#222222]">PDF to Word:</strong> Extracts text blocks, font sizes, bold/italic styling, and page structure into DOCX paragraphs. Complex multi-column magazine layouts or embedded vector diagrams may simplify.
            </li>
            <li>
              <strong className="text-[#222222]">Word to PDF:</strong> Converts DOCX headings, paragraphs, bold/italic runs, alignments, lists, and tables into clean vector PDFs using standard metric-compatible fonts.
            </li>
            <li>
              <strong className="text-[#222222]">PDF to PowerPoint:</strong> Renders each PDF page cleanly onto a matching slide to guarantee exact visual fidelity, while attaching extracted page text as slide notes.
            </li>
            <li>
              <strong className="text-[#222222]">PPTX Viewer:</strong> Converts `.pptx` decks server-side via LibreOffice headless and Poppler (`pdftoppm`) into per-slide PNG images for high-fidelity viewing. Animations, slide transitions, and embedded video/audio are not preserved.
            </li>
          </ul>
        </section>

        <div className="pt-2">
          <Link to="/tools" className="df-btn-dark px-4 py-2 text-xs font-medium inline-block">
            Browse All 13 Tools
          </Link>
        </div>
      </div>
    </div>
  );
};
