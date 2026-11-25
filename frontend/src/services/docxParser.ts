import JSZip from 'jszip';

function getByLocal(parent: Element | Document, localName: string): Element[] {
  const out: Element[] = [];
  const all = parent.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) out.push(all[i]);
  }
  return out;
}

function firstByLocal(parent: Element | Document, localName: string): Element | null {
  const all = parent.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) return all[i];
  }
  return null;
}

function directChildrenByLocal(parent: Element, localName: string): Element[] {
  return Array.from(parent.children).filter((el) => el.localName === localName);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mimeFromExt(path: string): string {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/png';
}

function isTruthyToggle(el: Element | null): boolean {
  if (!el) return false;
  const val = el.getAttribute('w:val') ?? el.getAttribute('val');
  return val !== '0' && val !== 'false';
}

function mapHighlight(val: string | null): string | null {
  if (!val || val === 'none') return null;
  const map: Record<string, string> = {
    yellow: '#FEF08A',
    green: '#BBF7D0',
    cyan: '#BAE6FD',
    magenta: '#F5D0FE',
    lightGray: '#E5E5E5',
    darkYellow: '#FDE047',
  };
  return map[val] || '#FEF08A';
}

export async function parseDocxToHtml(arrayBuffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docEntry = zip.file('word/document.xml');
  if (!docEntry) {
    throw new Error('Invalid DOCX file: missing word/document.xml.');
  }

  const parser = new DOMParser();
  const docXml = parser.parseFromString(await docEntry.async('text'), 'application/xml');

  // 1. Load image relationships
  const relImages = new Map<string, string>();
  const relsEntry = zip.file('word/_rels/document.xml.rels');
  if (relsEntry) {
    const relsXml = parser.parseFromString(await relsEntry.async('text'), 'application/xml');
    for (const rel of getByLocal(relsXml, 'Relationship')) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      const type = rel.getAttribute('Type') || '';
      if (id && target && type.includes('/image')) {
        const cleanPath = target.startsWith('/')
          ? target.slice(1)
          : target.startsWith('word/')
          ? target
          : `word/${target.replace(/^\.\//, '')}`;
        const imgEntry = zip.file(cleanPath);
        if (imgEntry) {
          const b64 = await imgEntry.async('base64');
          relImages.set(id, `data:${mimeFromExt(cleanPath)};base64,${b64}`);
        }
      }
    }
  }

  // 2. Load style names
  const styleNames = new Map<string, string>();
  const stylesEntry = zip.file('word/styles.xml');
  if (stylesEntry) {
    const stylesXml = parser.parseFromString(await stylesEntry.async('text'), 'application/xml');
    for (const st of getByLocal(stylesXml, 'style')) {
      const id = st.getAttribute('w:styleId') || st.getAttribute('styleId');
      const nameEl = firstByLocal(st, 'name');
      const nameVal = nameEl?.getAttribute('w:val') || nameEl?.getAttribute('val') || id || '';
      if (id) styleNames.set(id, nameVal.toLowerCase());
    }
  }

  // 3. Load numbering formats (bullet vs ordered)
  const numIdToAbstract = new Map<string, string>();
  const abstractToFmt = new Map<string, string>();
  const numEntry = zip.file('word/numbering.xml');
  if (numEntry) {
    const numXml = parser.parseFromString(await numEntry.async('text'), 'application/xml');
    for (const abs of getByLocal(numXml, 'abstractNum')) {
      const absId = abs.getAttribute('w:abstractNumId') || abs.getAttribute('abstractNumId');
      const lvl = firstByLocal(abs, 'lvl');
      const fmtEl = lvl ? firstByLocal(lvl, 'numFmt') : null;
      const fmt = fmtEl?.getAttribute('w:val') || fmtEl?.getAttribute('val') || 'bullet';
      if (absId) abstractToFmt.set(absId, fmt);
    }
    for (const num of getByLocal(numXml, 'num')) {
      const numId = num.getAttribute('w:numId') || num.getAttribute('numId');
      const absRef = firstByLocal(num, 'abstractNumId');
      const absId = absRef?.getAttribute('w:val') || absRef?.getAttribute('val');
      if (numId && absId) numIdToAbstract.set(numId, absId);
    }
  }

  const renderParagraph = (pEl: Element): { html: string; listTag: 'ul' | 'ol' | null } => {
    const pPr = directChildrenByLocal(pEl, 'pPr')[0] || null;
    const pStyleEl = pPr ? firstByLocal(pPr, 'pStyle') : null;
    const styleId = pStyleEl?.getAttribute('w:val') || pStyleEl?.getAttribute('val') || '';
    const styleName = (styleNames.get(styleId) || styleId).toLowerCase();

    const jcEl = pPr ? firstByLocal(pPr, 'jc') : null;
    const jcVal = (jcEl?.getAttribute('w:val') || jcEl?.getAttribute('val') || '').toLowerCase();
    const align =
      jcVal === 'center'
        ? 'center'
        : jcVal === 'right' || jcVal === 'end'
        ? 'right'
        : jcVal === 'both' || jcVal === 'distribute'
        ? 'justify'
        : '';

    const numPr = pPr ? firstByLocal(pPr, 'numPr') : null;
    let listTag: 'ul' | 'ol' | null = null;
    if (numPr) {
      const numIdEl = firstByLocal(numPr, 'numId');
      const numId = numIdEl?.getAttribute('w:val') || numIdEl?.getAttribute('val') || '';
      const absId = numIdToAbstract.get(numId);
      const fmt = absId ? abstractToFmt.get(absId) : 'bullet';
      listTag = fmt === 'bullet' ? 'ul' : 'ol';
    } else if (styleName.includes('list bullet')) {
      listTag = 'ul';
    } else if (styleName.includes('list number')) {
      listTag = 'ol';
    }

    const innerParts: string[] = [];
    for (const child of Array.from(pEl.children)) {
      if (child.localName === 'r') {
        const rPr = directChildrenByLocal(child, 'rPr')[0] || null;
        const isBold = rPr ? isTruthyToggle(firstByLocal(rPr, 'b')) : false;
        const isItalic = rPr ? isTruthyToggle(firstByLocal(rPr, 'i')) : false;
        const uEl = rPr ? firstByLocal(rPr, 'u') : null;
        const uVal = uEl?.getAttribute('w:val') || uEl?.getAttribute('val');
        const isUnderline = Boolean(uEl && uVal !== 'none');
        const isStrike = rPr ? isTruthyToggle(firstByLocal(rPr, 'strike')) : false;

        const szEl = rPr ? firstByLocal(rPr, 'sz') : null;
        const szHalfPt = Number(szEl?.getAttribute('w:val') || szEl?.getAttribute('val') || 0);
        const fontSizePt = szHalfPt > 0 ? Math.round((szHalfPt / 2) * 10) / 10 : 0;

        const colorEl = rPr ? firstByLocal(rPr, 'color') : null;
        const colorHex = colorEl?.getAttribute('w:val') || colorEl?.getAttribute('val');
        const hlEl = rPr ? firstByLocal(rPr, 'highlight') : null;
        const hlColor = hlEl ? mapHighlight(hlEl.getAttribute('w:val') || hlEl.getAttribute('val')) : null;

        let runHtml = '';
        for (const rChild of Array.from(child.children)) {
          if (rChild.localName === 't') {
            runHtml += escapeHtml(rChild.textContent || '');
          } else if (rChild.localName === 'tab') {
            runHtml += '&nbsp;&nbsp;&nbsp;&nbsp;';
          } else if (rChild.localName === 'br') {
            runHtml += '<br />';
          } else if (rChild.localName === 'drawing' || rChild.localName === 'pict') {
            const blip = firstByLocal(rChild, 'blip');
            const rId =
              blip?.getAttribute('r:embed') ||
              blip?.getAttributeNS(
                'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
                'embed'
              );
            if (rId && relImages.has(rId)) {
              runHtml += `<img src="${relImages.get(rId)}" alt="Embedded document image" />`;
            }
          }
        }

        if (!runHtml) continue;
        if (isBold) runHtml = `<strong>${runHtml}</strong>`;
        if (isItalic) runHtml = `<em>${runHtml}</em>`;
        if (isUnderline) runHtml = `<u>${runHtml}</u>`;
        if (isStrike) runHtml = `<s>${runHtml}</s>`;

        const spanStyles: string[] = [];
        if (fontSizePt > 0 && fontSizePt !== 11 && !styleName.includes('heading') && styleName !== 'title') {
          spanStyles.push(`font-size:${fontSizePt}pt`);
        }
        if (colorHex && colorHex !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(colorHex)) {
          spanStyles.push(`color:#${colorHex}`);
        }
        if (hlColor) {
          spanStyles.push(`background-color:${hlColor}`);
        }

        if (spanStyles.length > 0) {
          runHtml = `<span style="${spanStyles.join(';')}">${runHtml}</span>`;
        }
        innerParts.push(runHtml);
      } else if (child.localName === 'hyperlink') {
        const text = getByLocal(child, 't')
          .map((t) => escapeHtml(t.textContent || ''))
          .join('');
        if (text) innerParts.push(`<u>${text}</u>`);
      }
    }

    const content = innerParts.join('') || '<br />';
    const styleAttr = align ? ` style="text-align:${align}"` : '';

    if (listTag) {
      return { html: `<li${styleAttr}>${content}</li>`, listTag };
    }

    let tag = 'p';
    if (styleName.includes('heading 1') || styleName === 'title' || styleId === 'Heading1') tag = 'h1';
    else if (styleName.includes('heading 2') || styleName === 'subtitle' || styleId === 'Heading2') tag = 'h2';
    else if (styleName.includes('heading 3') || styleId === 'Heading3') tag = 'h3';

    return { html: `<${tag}${styleAttr}>${content}</${tag}>`, listTag: null };
  };

  const renderTable = (tblEl: Element): string => {
    const rowsHtml: string[] = [];
    const trList = directChildrenByLocal(tblEl, 'tr');
    for (let rIdx = 0; rIdx < trList.length; rIdx++) {
      const cellsHtml: string[] = [];
      for (const tc of directChildrenByLocal(trList[rIdx], 'tc')) {
        const tcPr = directChildrenByLocal(tc, 'tcPr')[0] || null;
        const gridSpanEl = tcPr ? firstByLocal(tcPr, 'gridSpan') : null;
        const colspan = Number(gridSpanEl?.getAttribute('w:val') || gridSpanEl?.getAttribute('val') || 1);
        const shdEl = tcPr ? firstByLocal(tcPr, 'shd') : null;
        const fill = shdEl?.getAttribute('w:fill') || shdEl?.getAttribute('fill');
        const bgStyle =
          fill && fill !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(fill)
            ? ` style="background-color:#${fill}"`
            : rIdx === 0
            ? ' style="background-color:#F5F5F5"'
            : '';

        const cellPs = directChildrenByLocal(tc, 'p').map((p) => renderParagraph(p).html);
        const cellTag = rIdx === 0 ? 'th' : 'td';
        const spanAttr = colspan > 1 ? ` colspan="${colspan}"` : '';
        cellsHtml.push(`<${cellTag}${spanAttr}${bgStyle}>${cellPs.join('') || '<p></p>'}</${cellTag}>`);
      }
      rowsHtml.push(`<tr>${cellsHtml.join('')}</tr>`);
    }
    return `<table><tbody>${rowsHtml.join('')}</tbody></table>`;
  };

  const body = firstByLocal(docXml, 'body');
  if (!body) return '<p></p>';

  const htmlOut: string[] = [];
  let activeList: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (activeList) {
      htmlOut.push(`</${activeList}>`);
      activeList = null;
    }
  };

  for (const child of Array.from(body.children)) {
    if (child.localName === 'p') {
      const { html, listTag } = renderParagraph(child);
      if (listTag) {
        if (activeList !== listTag) {
          closeList();
          activeList = listTag;
          htmlOut.push(`<${listTag}>`);
        }
        htmlOut.push(html);
      } else {
        closeList();
        htmlOut.push(html);
      }
    } else if (child.localName === 'tbl') {
      closeList();
      htmlOut.push(renderTable(child));
    }
  }
  closeList();

  return htmlOut.join('') || '<p></p>';
}
