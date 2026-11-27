import { createZip } from './exporters.js';

type Cell = string | number;

export function xlsxWorkbook(sheets: Array<{ name: string; rows: Cell[][] }>) {
  const xml = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const names = new Set<string>();
  const sheetNames = sheets.map(({ name }, index) => {
    const cleaned = name.replace(/[\[\]:*?\/\\]/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().replace(/^'+|'+$/g, '')
      || 'Лист ' + (index + 1);
    const first = cleaned.slice(0, 31);
    let candidate = first;
    let number = 2;
    while (names.has(candidate.toLowerCase())) {
      const suffix = ' (' + number++ + ')';
      candidate = cleaned.slice(0, 31 - suffix.length) + suffix;
    }
    names.add(candidate.toLowerCase());
    return candidate;
  });
  const files: Array<{ name: string; data: Buffer }> = [];
  const add = (name: string, data: string) => files.push({ name, data: Buffer.from(data) });
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const docs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const types = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const ids = sheets.map((_, i) => i + 1);
  add('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${types}.sheet.main+xml"/>${ids.map((id) => `<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="${types}.worksheet+xml"/>`).join('')}</Types>`);
  add('_rels/.rels', `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${docs}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add('xl/workbook.xml', `<workbook xmlns="${main}" xmlns:r="${docs}"><sheets>${sheetNames.map((name, i) =>
    `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${rels}">${ids.map((id) =>
    `<Relationship Id="rId${id}" Type="${docs}/worksheet" Target="worksheets/sheet${id}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach(({ rows }, i) => add(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet xmlns="${main}"><sheetData>${rows.map((row) =>
    `<row>${row.map((cell) => typeof cell === 'number' ? `<c><v>${cell}</v></c>` : `<c t="inlineStr"><is><t xml:space="preserve">${xml(cell.slice(0, 32767))}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`));
  return createZip(files);
}
