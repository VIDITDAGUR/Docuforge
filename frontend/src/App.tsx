import React from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { WorkspaceProvider } from './context/WorkspaceContext';
import { Layout } from './components/layout/Layout';
import { HomePage } from './pages/HomePage';
import { CategoryToolsPage } from './pages/CategoryToolsPage';
import { AboutPage } from './pages/AboutPage';
import { GitHubPage } from './pages/GitHubPage';
import { ToolPage } from './pages/ToolPage';

export const App: React.FC = () => {
  return (
    <WorkspaceProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route
              path="/tools"
              element={
                <CategoryToolsPage
                  title="All Tools"
                  description="All 14 document converters, viewers, editors, compressors, and PDF utilities."
                />
              }
            />
            <Route
              path="/pdf-tools"
              element={
                <CategoryToolsPage
                  category="pdf"
                  title="PDF Tools"
                  description="View, edit, resize, and convert PDF documents."
                />
              }
            />
            <Route
              path="/document-tools"
              element={
                <CategoryToolsPage
                  category="document"
                  title="Document Tools"
                  description="Create, edit, and convert Word (.docx) documents."
                />
              }
            />
            <Route
              path="/presentation-tools"
              element={
                <CategoryToolsPage
                  category="presentation"
                  title="Presentation Tools"
                  description="View, edit, and convert PowerPoint (.pptx) presentations."
                />
              }
            />
            <Route path="/tools/:slug" element={<ToolPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/github" element={<GitHubPage />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </WorkspaceProvider>
  );
};

export default App;
