import JSZip from 'jszip';

export interface ParsedSlideElement {
  id: string;
  type: 'text' | 'shape' | 'image';
  x: number; // percentage 0..100
  y: number; // percentage 0..100
  w: number; // percentage 0..100
  h: number; // percentage 0..100
  text?: string;
  paragraphs?: Array<{
    text: string;
    bold?: boolean;
    italic?: boolean;
    fontSizePx?: number;
    color?: string;
    align?: 'left' | 'center' | 'right';
  }>;
  shapeKind?: 'rect' | 'ellipse' | 'line';
  fillColor?: string;
  strokeColor?: string;
  imageUrl?: string;
}

export interface ParsedPresentation {
  widthPx: number;
  heightPx: number;
  slides: Array<{
    index: number;
    backgroundColor: string;
    elements: ParsedSlideElement[];
  }>;
}

function getElementsByTagLocal(parent: Element | Document, localName: string): Element[] {
  const result: Element[] = [];
  const all = parent.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.localName === localName) {
      result.push(el);
    }
  }
  return result;
}

function getFirstByLocal(parent: Element | Document, localName: string): Element | null {
  const all = parent.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) return all[i];
  }
  return null;
}

function parseColorFromFill(el: Element | null): string | undefined {
  if (!el) return undefined;
  const srgb = getFirstByLocal(el, 'srgbClr');
  if (srgb) {
    const val = srgb.getAttribute('val');
    if (val) return `#${val}`;
  }
  return undefined;
}

function mimeFromExt(path: string): string {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

export async function parsePptxFile(file: File): Promise<ParsedPresentation> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();

  // Read presentation.xml for slide dimensions and slide order
  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) {
    throw new Error('Invalid PPTX file: missing ppt/presentation.xml.');
  }
  const presDoc = parser.parseFromString(await presFile.async('text'), 'application/xml');

  // Default 16:9 EMU (12192000 x 6858000 => 960 x 540 at 72/96 scale)
  let slideCx = 12192000;
  let slideCy = 6858000;
  const sldSz = getFirstByLocal(presDoc, 'sldSz');
  if (sldSz) {
    const cx = Number(sldSz.getAttribute('cx'));
    const cy = Number(sldSz.getAttribute('cy'));
    if (cx > 0 && cy > 0) {
      slideCx = cx;
      slideCy = cy;
    }
  }

  const widthPx = 960;
  const heightPx = Math.round((slideCy / slideCx) * widthPx);

  // Determine ordered slide paths from presentation.xml.rels
  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');
  const rIdToTarget = new Map<string, string>();
  if (presRelsFile) {
    const relsDoc = parser.parseFromString(await presRelsFile.async('text'), 'application/xml');
    const rels = getElementsByTagLocal(relsDoc, 'Relationship');
    for (const rel of rels) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (id && target) {
        const normalized = target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\.\//, '')}`;
        rIdToTarget.set(id, normalized);
      }
    }
  }

  const orderedSlidePaths: string[] = [];
  const sldIdLst = getElementsByTagLocal(presDoc, 'sldId');
  for (const sldId of sldIdLst) {
    const rId =
      sldId.getAttribute('r:id') ||
      sldId.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id'
      );
    if (rId && rIdToTarget.has(rId)) {
      orderedSlidePaths.push(rIdToTarget.get(rId)!);
    }
  }

  // Fallback if sldIdLst resolution failed
  if (orderedSlidePaths.length === 0) {
    const slideFiles = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] || 0);
        const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] || 0);
        return na - nb;
      });
    orderedSlidePaths.push(...slideFiles);
  }

  const slides: ParsedPresentation['slides'] = [];

  for (let sIdx = 0; sIdx < orderedSlidePaths.length; sIdx++) {
    const slidePath = orderedSlidePaths[sIdx];
    const slideZipEntry = zip.file(slidePath);
    if (!slideZipEntry) continue;

    const slideDoc = parser.parseFromString(await slideZipEntry.async('text'), 'application/xml');

    // Load slide relationships for images
    const slideFileName = slidePath.split('/').pop()!;
    const slideRelsPath = `ppt/slides/_rels/${slideFileName}.rels`;
    const slideRelMap = new Map<string, string>();
    const slideRelsEntry = zip.file(slideRelsPath);
    if (slideRelsEntry) {
      const sRelsDoc = parser.parseFromString(await slideRelsEntry.async('text'), 'application/xml');
      for (const rel of getElementsByTagLocal(sRelsDoc, 'Relationship')) {
        const id = rel.getAttribute('Id');
        const target = rel.getAttribute('Target');
        if (id && target) {
          const cleanTarget = target.startsWith('../')
            ? `ppt/${target.slice(3)}`
            : target.startsWith('/')
            ? target.slice(1)
            : `ppt/slides/${target}`;
          slideRelMap.set(id, cleanTarget);
        }
      }
    }

    // Background color
    let backgroundColor = '#FFFFFF';
    const bgEl = getFirstByLocal(slideDoc, 'bg');
    if (bgEl) {
      const solidFill = getFirstByLocal(bgEl, 'solidFill');
      const parsed = parseColorFromFill(solidFill);
      if (parsed) backgroundColor = parsed;
    }

    const elements: ParsedSlideElement[] = [];
    const spTree = getFirstByLocal(slideDoc, 'spTree');
    if (spTree) {
      const children = Array.from(spTree.children);
      for (let cIdx = 0; cIdx < children.length; cIdx++) {
        const node = children[cIdx];
        const ln = node.localName;
        if (ln !== 'sp' && ln !== 'pic') continue;

        const xfrm = getFirstByLocal(node, 'xfrm');
        const off = xfrm ? getFirstByLocal(xfrm, 'off') : null;
        const ext = xfrm ? getFirstByLocal(xfrm, 'ext') : null;

        const xEmu = Number(off?.getAttribute('x') || 0);
        const yEmu = Number(off?.getAttribute('y') || 0);
        const cxEmu = Number(ext?.getAttribute('cx') || 0);
        const cyEmu = Number(ext?.getAttribute('cy') || 0);

        const x = Math.max(0, Math.min(100, (xEmu / slideCx) * 100));
        const y = Math.max(0, Math.min(100, (yEmu / slideCy) * 100));
        const w = Math.max(1, Math.min(100, (cxEmu / slideCx) * 100));
        const h = Math.max(1, Math.min(100, (cyEmu / slideCy) * 100));

        if (ln === 'pic') {
          const blip = getFirstByLocal(node, 'blip');
          const rEmbed =
            blip?.getAttribute('r:embed') ||
            blip?.getAttributeNS(
              'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
              'embed'
            );
          if (rEmbed && slideRelMap.has(rEmbed)) {
            const imgPath = slideRelMap.get(rEmbed)!;
            const imgEntry = zip.file(imgPath);
            if (imgEntry) {
              const b64 = await imgEntry.async('base64');
              elements.push({
                id: `el-${sIdx}-${cIdx}`,
                type: 'image',
                x,
                y,
                w,
                h,
                imageUrl: `data:${mimeFromExt(imgPath)};base64,${b64}`,
              });
            }
          }
          continue;
        }

        // Shape or text box (`sp`)
        const spPr = getFirstByLocal(node, 'spPr');
        let fillColor: string | undefined;
        let strokeColor: string | undefined;
        if (spPr) {
          for (const ch of Array.from(spPr.children)) {
            if (ch.localName === 'solidFill') {
              fillColor = parseColorFromFill(ch);
            } else if (ch.localName === 'ln') {
              const lnFill = getFirstByLocal(ch, 'solidFill');
              strokeColor = parseColorFromFill(lnFill);
            }
          }
        }

        const prstGeom = spPr ? getFirstByLocal(spPr, 'prstGeom') : null;
        const prst = prstGeom?.getAttribute('prst') || 'rect';
        const shapeKind: 'rect' | 'ellipse' | 'line' =
          prst === 'ellipse' ? 'ellipse' : prst === 'line' ? 'line' : 'rect';

        const txBody = getFirstByLocal(node, 'txBody');
        const paragraphs: NonNullable<ParsedSlideElement['paragraphs']> = [];
        if (txBody) {
          for (const pNode of getElementsByTagLocal(txBody, 'p')) {
            const pPr = getFirstByLocal(pNode, 'pPr');
            const algnAttr = pPr?.getAttribute('algn');
            const align: 'left' | 'center' | 'right' =
              algnAttr === 'ctr' ? 'center' : algnAttr === 'r' ? 'right' : 'left';

            let lineText = '';
            let bold = false;
            let italic = false;
            let fontSizePx = 18;
            let color = '#222222';

            const runs = getElementsByTagLocal(pNode, 'r');
            for (const rNode of runs) {
              const rPr = getFirstByLocal(rNode, 'rPr');
              if (rPr) {
                if (rPr.getAttribute('b') === '1') bold = true;
                if (rPr.getAttribute('i') === '1') italic = true;
                const sz = Number(rPr.getAttribute('sz'));
                if (sz > 0) {
                  fontSizePx = Math.max(10, Math.round((sz / 100) * 1.1));
                }
                const rFill = getFirstByLocal(rPr, 'solidFill');
                const parsedClr = parseColorFromFill(rFill);
                if (parsedClr) color = parsedClr;
              }
              const tEl = getFirstByLocal(rNode, 't');
              if (tEl && tEl.textContent) {
                lineText += tEl.textContent;
              }
            }

            if (lineText.trim().length > 0) {
              paragraphs.push({
                text: lineText,
                bold,
                italic,
                fontSizePx,
                color,
                align,
              });
            }
          }
        }

        if (paragraphs.length > 0 || fillColor || strokeColor) {
          elements.push({
            id: `el-${sIdx}-${cIdx}`,
            type: paragraphs.length > 0 && !fillColor ? 'text' : 'shape',
            x,
            y,
            w,
            h,
            shapeKind,
            fillColor,
            strokeColor,
            paragraphs,
            text: paragraphs.map((p) => p.text).join('\n'),
          });
        }
      }
    }

    slides.push({
      index: sIdx,
      backgroundColor,
      elements,
    });
  }

  return { widthPx, heightPx, slides };
}
