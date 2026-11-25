import React from 'react';
import { Link } from 'react-router-dom';

export const Footer: React.FC = () => {
  return (
    <footer className="w-full bg-[#F5F5F5] border-t border-[#E5E5E5] mt-auto">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 text-sm">
          <div>
            <div className="font-bold text-[#222222] mb-2">DOCUFORGE</div>
            <p className="text-[#777777] text-xs leading-relaxed">
              Free, open-source document management and conversion workspace built for students and academic work.
            </p>
          </div>

          <div>
            <div className="font-semibold text-[#222222] mb-2 text-xs uppercase tracking-wider">Categories</div>
            <ul className="space-y-1.5 text-xs">
              <li>
                <Link to="/tools" className="text-[#777777] hover:text-[#222222]">
                  All Tools (12)
                </Link>
              </li>
              <li>
                <Link to="/pdf-tools" className="text-[#777777] hover:text-[#222222]">
                  PDF Tools
                </Link>
              </li>
              <li>
                <Link to="/document-tools" className="text-[#777777] hover:text-[#222222]">
                  Document Tools
                </Link>
              </li>
              <li>
                <Link to="/presentation-tools" className="text-[#777777] hover:text-[#222222]">
                  Presentation Tools
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <div className="font-semibold text-[#222222] mb-2 text-xs uppercase tracking-wider">Project</div>
            <ul className="space-y-1.5 text-xs">
              <li>
                <Link to="/about" className="text-[#777777] hover:text-[#222222]">
                  About &amp; Privacy
                </Link>
              </li>
              <li>
                <Link to="/github" className="text-[#777777] hover:text-[#222222]">
                  GitHub &amp; Open Source
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <div className="font-semibold text-[#222222] mb-2 text-xs uppercase tracking-wider">Privacy Policy</div>
            <p className="text-[#777777] text-xs leading-relaxed">
              Browser tools process files locally without uploading. Server conversions delete temporary files immediately after response.
            </p>
          </div>
        </div>

        <div className="mt-8 pt-4 border-t border-[#E5E5E5] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-[#777777]">
          <span>DOCUFORGE &mdash; MIT Licensed Open-Source Software</span>
          <span>No tracking. No permanent file storage.</span>
        </div>
      </div>
    </footer>
  );
};
