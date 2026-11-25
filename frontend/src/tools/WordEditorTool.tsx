import React, { useRef, useState } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Download,
  FilePlus2,
  Italic,
  List,
  ListOrdered,
  Redo2,
  Table as TableIcon,
  Underline,
  Undo2,
  Upload,
} from 'lucide-react';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import mammoth from 'mammoth';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ToolDefinition } from '../types/tools';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { parseDocxToHtml } from '../services/docxParser';
import { triggerBlobDownload, validateFile } from '../utils/fileValidation';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

interface ParsedRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
  fontSizePt?: number;
}

interface ParsedBlock {
  kind: 'h1' | 'h2' | 'h3' | 'p' | 'ul_item' | 'ol_item' | 'table';
  align: 'left' | 'center' | 'right' | 'justify';
  runs: ParsedRun[];
  text: string;
  index: number;
  rows?: string[][];
}

function rgbStringToHex(val: string): string | undefined {
  if (!val) return undefined;
  if (val.startsWith('#') && /^#[0-9A-Fa-f]{6}$/.test(val)) return val;
  const m = val.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/i);
  if (!m) return undefined;
  const toHex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
}

function extractInlineRuns(
  node: Node,
  inherited: { bold: boolean; italic: boolean; underline: boolean; color?: string; fontSizePt?: number }
): ParsedRun[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const val = node.textContent || '';
    return val ? [{ text: val, ...inherited }] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return [{ text: '\n', ...inherited }];

  const style = el.style;
  const parsedColor = rgbStringToHex(style.color || el.getAttribute('color') || '');
  let fontSizePt = inherited.fontSizePt;
  if (style.fontSize) {
    const num = parseFloat(style.fontSize);
    if (Number.isFinite(num) && num > 0) {
      fontSizePt = style.fontSize.includes('px') ? Math.round(num * 0.75) : num;
    }
  }

  const next = {
    bold: inherited.bold || tag === 'b' || tag === 'strong' || style.fontWeight === 'bold' || Number(style.fontWeight) >= 600,
    italic: inherited.italic || tag === 'i' || tag === 'em' || style.fontStyle === 'italic',
    underline: inherited.underline || tag === 'u' || style.textDecoration.includes('underline'),
    color: parsedColor || inherited.color,
    fontSizePt,
  };

  const out: ParsedRun[] = [];
  for (const child of Array.from(el.childNodes)) {
    out.push(...extractInlineRuns(child, next));
  }
  return out;
}

function getAlign(el: HTMLElement): 'left' | 'center' | 'right' | 'justify' {
  const ta = el.style.textAlign || el.getAttribute('align') || 'left';
  if (ta === 'center' || ta === 'right' || ta === 'justify') return ta;
  return 'left';
}

function parseEditorDomToBlocks(root: HTMLElement): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];

  const pushBlock = (el: HTMLElement, kind: Exclude<ParsedBlock['kind'], 'table'>, index = 1) => {
    const runs = extractInlineRuns(el, { bold: false, italic: false, underline: false });
    const text = runs.map((r) => r.text).join('');
    blocks.push({
      kind,
      align: getAlign(el),
      runs,
      text,
      index,
    });
  };

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const txt = child.textContent?.trim();
      if (txt) {
        blocks.push({
          kind: 'p',
          align: 'left',
          runs: [{ text: txt, bold: false, italic: false, underline: false }],
          text: txt,
          index: 1,
        });
      }
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      pushBlock(el, tag);
    } else if (tag === 'ul') {
      const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'li') as HTMLElement[];
      items.forEach((li) => pushBlock(li, 'ul_item'));
    } else if (tag === 'ol') {
      const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'li') as HTMLElement[];
      items.forEach((li, i) => pushBlock(li, 'ol_item', i + 1));
    } else if (tag === 'table') {
      const rows: string[][] = [];
      for (const tr of Array.from(el.querySelectorAll('tr'))) {
        const cells = Array.from(tr.children).filter(
          (c) => c.tagName.toLowerCase() === 'td' || c.tagName.toLowerCase() === 'th'
        );
        if (cells.length > 0) {
          rows.push(cells.map((c) => (c.textContent || '').trim()));
        }
      }
      if (rows.length > 0) {
        blocks.push({ kind: 'table', align: 'left', runs: [], text: '', index: 1, rows });
      }
    } else {
      pushBlock(el, 'p');
    }
  }

  return blocks;
}

async function generateLocalFallbackPdf(blocks: ParsedBlock[]): Promise<Blob> {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageW = 612;
  const pageH = 792;
  const margin = 56;
  const maxWidth = pageW - margin * 2;
  let page = pdfDoc.addPage([pageW, pageH]);
  let y = pageH - margin;

  for (const b of blocks) {
    if (b.kind === 'table' && b.rows) {
      for (const row of b.rows) {
        if (y < margin + 20) {
          page = pdfDoc.addPage([pageW, pageH]);
          y = pageH - margin;
        }
        const rowLine = row.join('  |  ');
        page.drawText(rowLine.slice(0, 95), { x: margin, y, size: 10, font: regular, color: rgb(0.13, 0.13, 0.13) });
        y -= 16;
      }
      y -= 8;
      continue;
    }

    const fontSize = b.kind === 'h1' ? 18 : b.kind === 'h2' ? 14 : b.kind === 'h3' ? 12 : 11;
    const font = b.kind.startsWith('h') ? boldFont : regular;
    const prefix = b.kind === 'ul_item' ? '•  ' : b.kind === 'ol_item' ? `${b.index}.  ` : '';
    const fullText = `${prefix}${b.text}`.trim();

    if (!fullText) {
      y -= 10;
      continue;
    }

    const words = fullText.split(/\s+/);
    let line = '';
    const lines: string[] = [];
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);

    for (const ln of lines) {
      if (y < margin + fontSize * 1.4) {
        page = pdfDoc.addPage([pageW, pageH]);
        y = pageH - margin;
      }
      const lineW = font.widthOfTextAtSize(ln, fontSize);
      let x = margin;
      if (b.align === 'center') x = (pageW - lineW) / 2;
      if (b.align === 'right') x = pageW - margin - lineW;

      page.drawText(ln, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(0.133, 0.133, 0.133),
      });
      y -= fontSize * 1.45;
    }
    y -= 6;
  }

  const out = await pdfDoc.save();
  return new Blob([new Uint8Array(out)], { type: 'application/pdf' });
}

const WordEditorTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [docTitle, setDocTitle] = useState('assignment-draft');
  const [zoom, setZoom] = useState(100);
  const [status, setStatus] = useState<{ type: 'loading' | 'error' | 'success'; message: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const loadDocxFile = async (file: File) => {
    const check = validateFile(file, tool.acceptedExtensions, tool.maxSizeMB);
    if (!check.valid) {
      setStatus({ type: 'error', message: check.error || 'Invalid DOCX file.' });
      return;
    }
    setStatus({ type: 'loading', message: `Loading "${file.name}"...` });
    try {
      const arrayBuffer = await file.arrayBuffer();
      let html = '';
      try {
        html = await parseDocxToHtml(arrayBuffer);
      } catch {
        const fallback = await mammoth.convertToHtml({ arrayBuffer });
        html = fallback.value || '<p></p>';
      }
      if (editorRef.current) {
        editorRef.current.innerHTML = html || '<p></p>';
      }
      setDocTitle(file.name.replace(/\.docx$/i, ''));
      setStatus({ type: 'success', message: `Loaded "${file.name}" with headings, alignment, tables, and styles.` });
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unable to open DOCX file.',
      });
    }
  };

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    if (incoming[0]) void loadDocxFile(incoming[0]);
  });

  const exec = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
  };

  const handleInsertTable = () => {
    exec(
      'insertHTML',
      '<table><tbody><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr><tr><td>Item</td><td>Details</td><td>Notes</td></tr><tr><td>Item</td><td>Details</td><td>Notes</td></tr></tbody></table><p><br/></p>'
    );
  };

  const handleNewDoc = () => {
    if (editorRef.current) {
      editorRef.current.innerHTML = '<h1>Untitled Document</h1><p>Start typing your assignment or notes here...</p>';
    }
    setDocTitle('untitled-document');
    setStatus(null);
  };

  const handleExportDocx = async () => {
    if (!editorRef.current) return;
    setExporting(true);
    setStatus({ type: 'loading', message: 'Generating DOCX file...' });
    try {
      const blocks = parseEditorDomToBlocks(editorRef.current);
      const alignMap = {
        left: AlignmentType.LEFT,
        center: AlignmentType.CENTER,
        right: AlignmentType.RIGHT,
        justify: AlignmentType.JUSTIFIED,
      };

      const docChildren: Array<Paragraph | Table> = blocks.map((b): Paragraph | Table => {
        if (b.kind === 'table' && b.rows) {
          const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
          return new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: b.rows.map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (cellText) =>
                      new TableCell({
                        borders: { top: border, bottom: border, left: border, right: border },
                        children: [new Paragraph({ children: [new TextRun(cellText)] })],
                      })
                  ),
                })
            ),
          });
        }

        const runs =
          b.runs.length > 0
            ? b.runs.map(
                (r) =>
                  new TextRun({
                    text: r.text,
                    bold: r.bold,
                    italics: r.italic,
                    underline: r.underline ? {} : undefined,
                    color: r.color ? r.color.replace('#', '') : undefined,
                    size: r.fontSizePt ? Math.round(r.fontSizePt * 2) : undefined,
                  })
              )
            : [new TextRun('')];

        if (b.kind === 'h1') {
          return new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: alignMap[b.align], children: runs });
        }
        if (b.kind === 'h2') {
          return new Paragraph({ heading: HeadingLevel.HEADING_2, alignment: alignMap[b.align], children: runs });
        }
        if (b.kind === 'h3') {
          return new Paragraph({ heading: HeadingLevel.HEADING_3, alignment: alignMap[b.align], children: runs });
        }
        if (b.kind === 'ul_item') {
          return new Paragraph({ bullet: { level: 0 }, alignment: alignMap[b.align], children: runs });
        }
        if (b.kind === 'ol_item') {
          return new Paragraph({
            alignment: alignMap[b.align],
            children: [new TextRun({ text: `${b.index}. ` }), ...runs],
          });
        }
        return new Paragraph({ alignment: alignMap[b.align], children: runs });
      });

      const doc = new Document({
        sections: [{ children: docChildren.length > 0 ? docChildren : [new Paragraph('')] }],
      });
      const blob = await Packer.toBlob(doc);
      const filename = `${docTitle.trim() || 'document'}.docx`;
      triggerBlobDownload(blob, filename);
      setStatus({ type: 'success', message: `Exported "${filename}" locally.` });
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'DOCX export failed.',
      });
    } finally {
      setExporting(false);
    }
  };

  const handleExportPdf = async () => {
    if (!editorRef.current) return;
    setExporting(true);
    setStatus({ type: 'loading', message: 'Exporting PDF document...' });

    const blocks = parseEditorDomToBlocks(editorRef.current);
    const filename = `${docTitle.trim() || 'document'}.pdf`;

    try {
      const response = await fetch(`${API_BASE}/api/export/editor-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: docTitle || 'document', blocks }),
      });

      if (response.ok) {
        const blob = await response.blob();
        triggerBlobDownload(blob, filename);
        setStatus({ type: 'success', message: `Exported "${filename}" via server renderer.` });
        return;
      }
      throw new Error('Backend PDF renderer unavailable');
    } catch {
      try {
        const fallbackBlob = await generateLocalFallbackPdf(blocks);
        triggerBlobDownload(fallbackBlob, filename);
        setStatus({ type: 'success', message: `Exported "${filename}" locally.` });
      } catch (err) {
        setStatus({
          type: 'error',
          message: err instanceof Error ? err.message : 'PDF export failed.',
        });
      }
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void loadDocxFile(f);
          e.target.value = '';
        }}
      />

      {/* File & Export Header Bar */}
      <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-[#777777]">Title:</label>
          <input
            type="text"
            value={docTitle}
            onChange={(e) => setDocTitle(e.target.value)}
            aria-label="Document filename"
            className="border border-[#E5E5E5] bg-white px-2.5 py-1.5 text-xs font-mono text-[#222222] w-44"
          />
          <button
            type="button"
            onClick={handleNewDoc}
            className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
            New Blank
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Open DOCX
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={exporting}
            onClick={handleExportDocx}
            className="df-btn-dark px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export DOCX
          </button>
          <button
            type="button"
            disabled={exporting}
            onClick={handleExportPdf}
            className="df-btn-light px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export PDF
          </button>
        </div>
      </div>

      {status && <StatusBanner type={status.type} message={status.message} />}

      {/* Rich Text Formatting Toolbar */}
      <div className="border border-[#E5E5E5] bg-white">
        <div className="border-b border-[#E5E5E5] bg-[#F5F5F5] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => exec('undo')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Undo"
              aria-label="Undo"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => exec('redo')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Redo"
              aria-label="Redo"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>

            <span className="w-px h-5 bg-[#E5E5E5] mx-1" />

            <button
              type="button"
              onClick={() => exec('formatBlock', '<p>')}
              className="df-btn-light px-2 py-1 text-xs font-medium cursor-pointer"
            >
              Normal
            </button>
            <button
              type="button"
              onClick={() => exec('formatBlock', '<h1>')}
              className="df-btn-light px-2 py-1 text-xs font-bold cursor-pointer"
            >
              H1
            </button>
            <button
              type="button"
              onClick={() => exec('formatBlock', '<h2>')}
              className="df-btn-light px-2 py-1 text-xs font-bold cursor-pointer"
            >
              H2
            </button>
            <button
              type="button"
              onClick={() => exec('formatBlock', '<h3>')}
              className="df-btn-light px-2 py-1 text-xs font-bold cursor-pointer"
            >
              H3
            </button>

            <span className="w-px h-5 bg-[#E5E5E5] mx-1" />

            <button
              type="button"
              onClick={() => exec('bold')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Bold"
              aria-label="Bold"
            >
              <Bold className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => exec('italic')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Italic"
              aria-label="Italic"
            >
              <Italic className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => exec('underline')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Underline"
              aria-label="Underline"
            >
              <Underline className="w-3.5 h-3.5" />
            </button>

            <input
              type="color"
              defaultValue="#222222"
              onChange={(e) => exec('foreColor', e.target.value)}
              title="Text Color"
              aria-label="Text color"
              className="w-7 h-7 border border-[#E5E5E5] bg-white p-0 cursor-pointer"
            />

            <span className="w-px h-5 bg-[#E5E5E5] mx-1" />

            <button
              type="button"
              onClick={() => exec('justifyLeft')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Align Left"
              aria-label="Align Left"
            >
              <AlignLeft className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => exec('justifyCenter')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Align Center"
              aria-label="Align Center"
            >
              <AlignCenter className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => exec('justifyRight')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Align Right"
              aria-label="Align Right"
            >
              <AlignRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => exec('justifyFull')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Justify"
              aria-label="Justify"
            >
              <AlignJustify className="w-3.5 h-3.5" />
            </button>

            <span className="w-px h-5 bg-[#E5E5E5] mx-1" />

            <button
              type="button"
              onClick={() => exec('insertUnorderedList')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Bullet List"
              aria-label="Bullet List"
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => exec('insertOrderedList')}
              className="df-btn-light p-1.5 cursor-pointer"
              title="Numbered List"
              aria-label="Numbered List"
            >
              <ListOrdered className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleInsertTable}
              className="df-btn-light px-2 py-1 text-xs inline-flex items-center gap-1 cursor-pointer"
              title="Insert 3x3 Table"
            >
              <TableIcon className="w-3.5 h-3.5" />
              Table
            </button>
          </div>

          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-[#777777]">View:</span>
            <select
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="border border-[#E5E5E5] bg-white px-2 py-1 text-xs font-mono"
            >
              <option value={80}>80%</option>
              <option value={100}>100%</option>
              <option value={120}>120%</option>
            </select>
          </label>
        </div>

        {/* Realistic Paper Page Workspace */}
        <div className="bg-[#E5E5E5] p-4 sm:p-8 overflow-auto flex justify-center">
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            style={{
              width: `${Math.round(794 * (zoom / 100))}px`,
              fontSize: `${Math.round(14 * (zoom / 100))}px`,
            }}
            className="df-editor-surface shrink-0 min-h-[760px] bg-white border border-[#CCCCCC] p-8 sm:p-14 text-[#222222] focus:border-[#222222]"
          >
            <h1>Academic Assignment Draft</h1>
            <p>
              Use this workspace to write reports, open existing <strong>.docx</strong> files with tables and formatting preserved, and export to DOCX or PDF.
            </p>
            <h2>Key Sections</h2>
            <ul>
              <li>Introduction and problem statement</li>
              <li>Methodology and analysis</li>
              <li>Conclusion and references</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WordEditorTool;
