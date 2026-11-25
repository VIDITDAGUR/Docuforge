import React from 'react';
import { Link } from 'react-router-dom';

export const GitHubPage: React.FC = () => {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <div className="border-b border-[#E5E5E5] pb-5">
        <div className="text-xs font-mono uppercase tracking-wider text-[#777777] mb-1">Open Source</div>
        <h1 className="text-2xl font-bold text-[#222222]">GitHub &amp; Self-Hosting</h1>
        <p className="text-sm text-[#777777] mt-1.5">
          DOCUFORGE is open-source under the MIT License. Inspect the code, run it locally on campus, or deploy your own instance.
        </p>
      </div>

      <div className="mt-6 space-y-5">
        <section className="border border-[#E5E5E5] bg-white p-5">
          <h2 className="text-base font-semibold text-[#222222] mb-3">Architecture &amp; Tech Stack</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-3.5">
              <div className="font-semibold text-[#222222] mb-1.5">Frontend (React + TypeScript)</div>
              <ul className="space-y-1 text-[#777777] font-mono">
                <li>React 18 + Vite + Tailwind CSS</li>
                <li>pdfjs-dist (PDF rendering)</li>
                <li>pdf-lib (PDF editing &amp; resizing)</li>
                <li>docx &amp; mammoth (DOCX I/O)</li>
                <li>pptxgenjs &amp; jszip (PPTX &amp; ZIP)</li>
              </ul>
            </div>
            <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-3.5">
              <div className="font-semibold text-[#222222] mb-1.5">Backend (Python FastAPI)</div>
              <ul className="space-y-1 text-[#777777] font-mono">
                <li>FastAPI + Uvicorn</li>
                <li>PyMuPDF (PDF parsing &amp; rendering)</li>
                <li>python-docx (DOCX reading/writing)</li>
                <li>python-pptx (PPTX reading/writing)</li>
                <li>ReportLab &amp; Pillow (Vector PDF/Images)</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="border border-[#E5E5E5] bg-white p-5">
          <h2 className="text-base font-semibold text-[#222222] mb-2">Quick Local Development</h2>
          <pre className="bg-[#F5F5F5] border border-[#E5E5E5] p-3.5 text-xs font-mono text-[#222222] overflow-x-auto leading-relaxed">
{`# 1. Start the FastAPI backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 2. Start the React frontend
cd frontend
npm install
npm run dev`}
          </pre>
        </section>

        <section className="border border-[#E5E5E5] bg-white p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-[#222222]">MIT License</h2>
            <p className="text-xs text-[#777777] mt-0.5">
              Free to use, modify, and distribute for academic, personal, or institutional deployments.
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/tools" className="df-btn-dark px-3.5 py-2 text-xs font-medium">
              Open Workspace
            </Link>
            <Link to="/about" className="df-btn-light px-3.5 py-2 text-xs font-medium">
              Privacy Details
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
};
