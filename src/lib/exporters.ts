interface ExportData {
  projectName: string;
  chapters: Array<{ id: string; title: string; content: unknown; wordCount: number; kind: string }>;
  characters: Array<{ name: string; faction: string | null }>;
  locations: Array<{ name: string; kind: string }>;
}

export function manuscriptChapters(
  chapters: Array<{
    id: string;
    title: string;
    content: unknown;
    wordCount: number;
    kind: string;
    parentId: string | null;
    orderIndex: number;
  }>,
) {
  const roots = chapters.filter((c) => !c.parentId).sort((a, b) => a.orderIndex - b.orderIndex);
  const ordered: typeof chapters = [];
  const used = new Set<string>();
  for (const root of roots) {
    ordered.push(root);
    used.add(root.id);
    for (const child of chapters.filter((c) => c.parentId === root.id).sort((a, b) => a.orderIndex - b.orderIndex)) {
      ordered.push(child);
      used.add(child.id);
    }
  }
  for (const chapter of chapters) {
    if (!used.has(chapter.id)) ordered.push(chapter);
  }
  return ordered.map((c) => ({
    id: c.id,
    title: c.title,
    content: c.content,
    wordCount: c.wordCount,
    kind: c.kind,
  }));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Извлечь plain text из TipTap JSON */
function tipapToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const node = content as { type?: string; text?: string; content?: unknown[] };
  if (node.text) return node.text;
  if (node.content) return node.content.map(tipapToText).join('\n');
  return '';
}

/** === EPUB === (минимальный валидный EPUB 3 — ZIP без сжатия mimetype) */
export function generateEpub(data: ExportData): Buffer {
  const chapters = data.chapters.filter((c) => c.kind === 'scene' || c.wordCount > 0);
  const items: Array<{ id: string; href: string; title: string; html: string }> = chapters.map((c, i) => ({
    id: `ch${i + 1}`,
    href: `chapter${i + 1}.xhtml`,
    title: c.title,
    html: `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(c.title)}</title></head><body><h2>${esc(c.title)}</h2>${tipapToText(c.content).split('\n').map((p) => `<p>${esc(p)}</p>`).join('')}</body></html>`,
  }));

  const mimetype = 'application/epub+zip';
  const containerXml = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:${Date.now()}</dc:identifier>
<dc:title>${esc(data.projectName)}</dc:title>
<dc:language>ru</dc:language>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${items.map((i) => `<item id="${i.id}" href="${i.href}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine>${items.map((i) => `<itemref idref="${i.id}"/>`).join('')}</spine>
</package>`;
  const navXhtml = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Содержание</title></head><body><nav epub:type="toc"><h1>Содержание</h1><ol>${items.map((i) => `<li><a href="${i.href}">${esc(i.title)}</a></li>`).join('')}</ol></nav></body></html>`;

  return createZip([
    { name: 'mimetype', data: Buffer.from(mimetype), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from(containerXml) },
    { name: 'OEBPS/content.opf', data: Buffer.from(contentOpf) },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navXhtml) },
    ...items.map((i) => ({ name: `OEBPS/${i.href}`, data: Buffer.from(i.html) })),
  ]);
}

interface WordNode {
  type?: string;
  text?: string;
  attrs?: { level?: number; alt?: string; textAlign?: string };
  marks?: { type?: string }[];
  content?: WordNode[];
}

function wordText(value: string): string {
  return esc(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
}

const WORD_MARKS = new Map([
  ['bold', '<w:b/>'], ['italic', '<w:i/>'], ['underline', '<w:u w:val="single"/>'], ['strike', '<w:strike/>'],
  ['subscript', '<w:vertAlign w:val="subscript"/>'], ['superscript', '<w:vertAlign w:val="superscript"/>'],
]);

function wordRun(text: string, marks: WordNode['marks'] = []): string {
  const props = marks.map((mark) => WORD_MARKS.get(mark?.type ?? '') ?? '').join('');
  const contents = text.split(/\r?\n/).map((line) => '<w:t xml:space="preserve">' + wordText(line) + '</w:t>').join('<w:br/>');
  return '<w:r>' + (props ? '<w:rPr>' + props + '</w:rPr>' : '') + contents + '</w:r>';
}

function wordInline(node: WordNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'hardBreak') return '<w:r><w:br/></w:r>';
  if (typeof node.text === 'string') return wordRun(node.text, Array.isArray(node.marks) ? node.marks : []);
  if (node.type === 'image' && typeof node.attrs?.alt === 'string') return wordRun(node.attrs.alt);
  return Array.isArray(node.content) ? node.content.map(wordInline).join('') : '';
}

function wordParagraph(runs: string, style?: string, align?: string): string {
  const props = (style ? '<w:pStyle w:val="' + style + '"/>' : '')
    + (align && ['left', 'right', 'center', 'justify'].includes(align)
      ? '<w:jc w:val="' + (align === 'justify' ? 'both' : align) + '"/>' : '');
  return '<w:p>' + (props ? '<w:pPr>' + props + '</w:pPr>' : '') + runs + '</w:p>';
}

function wordBlocks(node: WordNode | null | undefined): string {
  if (!node) return '';
  const children = Array.isArray(node.content) ? node.content : [];
  if (node.type === 'heading') {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
    return wordParagraph(wordInline(node), 'Heading' + Math.floor(level), node.attrs?.textAlign);
  }
  if (node.type === 'paragraph') return wordParagraph(wordInline(node), undefined, node.attrs?.textAlign);
  if (node.type === 'doc' || node.type === 'blockquote') return children.map(wordBlocks).join('');
  if (node.type === 'table') {
    const rows = children.filter((row) => row?.type === 'tableRow' && Array.isArray(row.content) && row.content.length);
    if (!rows.length) return '';
    const columns = Math.max(...rows.map((row) => row.content!.length));
    const grid = '<w:tblGrid>' + '<w:gridCol/>'.repeat(columns) + '</w:tblGrid>';
    const body = rows.map((row) => '<w:tr>' + row.content!.map((cell) => {
      const content = wordBlocks(cell);
      return '<w:tc>' + (content.endsWith('</w:p>') ? content : content + '<w:p/>') + '</w:tc>';
    }).join('') + '</w:tr>').join('');
    return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' + grid + body + '</w:tbl>';
  }
  if (children.length) return children.map(wordBlocks).join('');
  const text = wordInline(node);
  return text ? wordParagraph(text) : '';
}

/** === DOCX === */
export function generateDocx(data: ExportData): Buffer {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const pack = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const book = data.chapters.map((chapter) => {
    const body = typeof chapter.content === 'string'
      ? chapter.content.split(/\r?\n/).map((paragraph) => wordParagraph(wordRun(paragraph))).join('')
      : wordBlocks(chapter.content as WordNode | null);
    return wordParagraph(wordRun(chapter.title), chapter.kind === 'scene' ? 'Heading2' : 'Heading1') + body;
  }).join('');
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="' + ns + '"><w:body>'
    + wordParagraph(wordRun(data.projectName), 'Title') + book + '</w:body></w:document>';
  const styles = '<w:styles xmlns:w="' + ns + '"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>'
    + [36, 30, 26, 24, 22, 20].map((size, index) =>
      '<w:style w:type="paragraph" w:styleId="Heading' + (index + 1) + '"><w:name w:val="heading ' + (index + 1)
      + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="'
      + index + '"/></w:pPr><w:rPr><w:b/><w:sz w:val="' + size + '"/></w:rPr></w:style>').join('')
    + '</w:styles>';
  const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
  return createZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from('<Relationships xmlns="' + pack + '"><Relationship Id="rId1" Type="' + office + '/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: Buffer.from(document) },
    { name: 'word/styles.xml', data: Buffer.from(styles) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from('<Relationships xmlns="' + pack + '"><Relationship Id="rId1" Type="' + office + '/styles" Target="styles.xml"/></Relationships>') },
  ]);
}

/** === PDF === (простой text-based PDF с Helvetica) */
export function generatePdf(data: ExportData): Buffer {
  const chapters = data.chapters.filter((c) => c.kind === 'scene' || c.wordCount > 0);
  const pages: string[] = [];
  let current = `BT /F1 24 Tf 72 720 Td (${esc(data.projectName)}) Tj ET\n`;

  function newPage(text: string, fontSize = 12) {
    pages.push(current);
    current = `BT /F1 ${fontSize} Tf 72 720 Td (${esc(text)}) Tj ET\n`;
  }
  function addLine(text: string, fontSize = 12) {
    current += `BT /F1 ${fontSize} Tf 72 ${720 - 20 * (current.split('Tj').length)} Td (${esc(text)}) Tj ET\n`;
    // Простая пагинация: ~30 строк на страницу
    if (current.split('Tj').length > 30) {
      newPage('...');
    }
  }

  for (const ch of chapters) {
    addLine(ch.title, 16);
    for (const line of tipapToText(ch.content).split('\n')) {
      addLine(line);
    }
    addLine('');
  }
  pages.push(current);

  const objects: string[] = [];
  // Object 1: Catalog
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  // Object 2: Pages
  const pageRefs = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
  // Page + Content objects
  for (let i = 0; i < pages.length; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2 + 1} 0 R >> >> >>`);
    const content = pages[i] ?? '';
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  // Font object
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

/** Минимальный ZIP writer (store + deflate через zlib) */
import { deflateRawSync } from 'node:zlib';

interface ZipEntry { name: string; data: Buffer; store?: boolean }

export function createZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    let compressed: Buffer;
    let method: number;

    if (entry.store) {
      compressed = entry.data;
      method = 0;
    } else {
      compressed = deflateRawSync(entry.data);
      method = 8;
    }

    // Local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, compressed);

    // Central directory
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralDir.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralDir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/** CRC32 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c as number;
  }
  return table;
})();

/** FictionBook 2 — плоский список глав и сцен в порядке рукописи. */
export function generateFb2(data: ExportData): Buffer {
  const chapters = data.chapters.filter((c) => c.kind === 'scene' || c.wordCount > 0);
  const sections = chapters.map((c) => {
    const paras = tipapToText(c.content)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${esc(line)}</p>`)
      .join('');
    return `<section><title><p>${esc(c.title)}</p></title>${paras || '<empty-line/>'}</section>`;
  }).join('');
  const today = new Date().toISOString().slice(0, 10);
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
<genre>prose</genre>
<author><first-name></first-name><last-name>Автор</last-name></author>
<book-title>${esc(data.projectName)}</book-title>
<lang>ru</lang>
</title-info>
<document-info>
<author><nickname>OpenWritter</nickname></author>
<program-used>OpenWritter</program-used>
<date value="${today}">${today}</date>
<id>openwritter-${Date.now()}</id>
<version>1.0</version>
</document-info>
</description>
<body>${sections || '<section><p></p></section>'}</body>
</FictionBook>`;
  return Buffer.from(xml, 'utf8');
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
