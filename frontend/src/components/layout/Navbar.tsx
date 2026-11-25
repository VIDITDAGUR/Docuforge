import React, { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Menu, X } from 'lucide-react';

export const Navbar: React.FC = () => {
  const [mobileOpen, setMobileOpen] = useState(false);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 text-sm font-medium border transition-colors ${
      isActive
        ? 'bg-[#222222] text-white border-[#222222]'
        : 'bg-white text-[#222222] border-transparent hover:bg-[#F5F5F5] hover:border-[#E5E5E5]'
    }`;

  return (
    <header className="w-full bg-white border-b border-[#E5E5E5] sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <Link
          to="/"
          className="flex items-center gap-2.5 text-[#222222] font-bold tracking-tight text-base"
          onClick={() => setMobileOpen(false)}
        >
          <span className="inline-flex items-center justify-center w-7 h-7 bg-[#222222] text-white text-xs font-mono">
            DF
          </span>
          <span>DOCUFORGE</span>
        </Link>

        <nav className="hidden md:flex items-center gap-1" aria-label="Main navigation">
          <NavLink to="/" end className={linkClass}>
            Home
          </NavLink>
          <NavLink to="/tools" className={linkClass}>
            All Tools
          </NavLink>
          <NavLink to="/about" className={linkClass}>
            About
          </NavLink>
          <NavLink to="/github" className={linkClass}>
            GitHub
          </NavLink>
        </nav>

        <button
          type="button"
          className="md:hidden df-btn-light p-2"
          aria-label="Toggle navigation menu"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((prev) => !prev)}
        >
          {mobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
        </button>
      </div>

      {mobileOpen && (
        <nav
          className="md:hidden bg-white border-t border-[#E5E5E5] px-4 py-3 flex flex-col gap-1"
          aria-label="Mobile navigation"
        >
          <NavLink to="/" end className={linkClass} onClick={() => setMobileOpen(false)}>
            Home
          </NavLink>
          <NavLink to="/tools" className={linkClass} onClick={() => setMobileOpen(false)}>
            All Tools
          </NavLink>
          <NavLink to="/pdf-tools" className={linkClass} onClick={() => setMobileOpen(false)}>
            PDF Tools
          </NavLink>
          <NavLink to="/document-tools" className={linkClass} onClick={() => setMobileOpen(false)}>
            Document Tools
          </NavLink>
          <NavLink to="/presentation-tools" className={linkClass} onClick={() => setMobileOpen(false)}>
            Presentation Tools
          </NavLink>
          <NavLink to="/about" className={linkClass} onClick={() => setMobileOpen(false)}>
            About
          </NavLink>
          <NavLink to="/github" className={linkClass} onClick={() => setMobileOpen(false)}>
            GitHub
          </NavLink>
        </nav>
      )}
    </header>
  );
};
