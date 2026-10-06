interface ExportData {
  projectName: string;
  chapters: Array<{ id: string; title: string; content: unknown; wordCount: number; kind: string }>;
  characters: Array<{ name: string; faction: string | null }>;
  locations: Array<{ name: string; kind: string }>;
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

/** === DOCX === (минимальный OOXML — word/document.xml в ZIP) */
export function generateDocx(data: ExportData): Buffer {
  const chapters = data.chapters.filter((c) => c.kind === 'scene' || c.wordCount > 0);
  const paras: string[] = [];
  for (const ch of chapters) {
    paras.push(`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">${esc(ch.title)}</w:t></w:r></w:p>`);
    for (const line of tipapToText(ch.content).split('\n')) {
      paras.push(`<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`);
    }
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${esc(data.projectName)}</w:t></w:r></w:p>
${paras.join('\n')}
</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  return createZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rels) },
    { name: 'word/document.xml', data: Buffer.from(document) },
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
import { deflateSync } from 'node:zlib';

interface ZipEntry { name: string; data: Buffer; store?: boolean }

function createZip(entries: ZipEntry[]): Buffer {
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
      compressed = deflateSync(entry.data);
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

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
