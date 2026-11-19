// Minimal, dependency-free .xlsx writer (Office Open XML).
// Supports: multiple sheets, bold header row, frozen header, autofilter,
// column widths, numbers, text, hyperlinks (via HYPERLINK formula), and a few
// fill styles for score highlighting. Enough for a job log; nothing more.

import { writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import zlib from 'zlib';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // XML 1.0 forbids most control characters
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

// Style indexes (must match cellXfs order in STYLES_XML)
export const STYLE = {
  default: 0,
  header: 1,
  wrap: 2,
  scoreHigh: 3,   // >= 4.5
  scoreGood: 4,   // >= 4.0
  scoreLow: 5,    // < 4.0
  link: 6,
  bold: 7,
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="6">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF63BE7B"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="3" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="4" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function colName(i) { // 0 -> A
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/**
 * A cell may be:
 *   null/undefined/''  -> empty
 *   number             -> numeric cell
 *   string             -> text
 *   { link, text }     -> clickable hyperlink
 *   { value, style }   -> value with explicit STYLE index
 */
function cellXml(ref, cell, defaultStyle) {
  if (cell == null || cell === '') return '';
  if (typeof cell === 'number') {
    return Number.isFinite(cell) ? `<c r="${ref}" s="${defaultStyle}"><v>${cell}</v></c>` : '';
  }
  if (typeof cell === 'object' && cell.link) {
    const url = String(cell.link).slice(0, 255).replace(/"/g, '%22');
    const text = String(cell.text ?? cell.link).slice(0, 255).replace(/"/g, "'");
    return `<c r="${ref}" s="${STYLE.link}" t="str"><f>${esc(`HYPERLINK("${url}","${text}")`)}</f><v>${esc(text)}</v></c>`;
  }
  if (typeof cell === 'object' && 'value' in cell) {
    const style = cell.style ?? defaultStyle;
    if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return `<c r="${ref}" s="${style}"><v>${cell.value}</v></c>`;
    if (cell.value == null || cell.value === '') return style ? `<c r="${ref}" s="${style}"/>` : '';
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.value).slice(0, 32000))}</t></is></c>`;
  }
  return `<c r="${ref}" s="${defaultStyle}" t="inlineStr"><is><t xml:space="preserve">${esc(String(cell).slice(0, 32000))}</t></is></c>`;
}

function sheetXml({ columns, rows }) {
  const lastCol = colName(Math.max(columns.length - 1, 0));
  const lastRow = rows.length + 1;
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 14}" customWidth="1"/>`).join('');
  const header = `<row r="1" ht="20" customHeight="1">${columns.map((c, i) => cellXml(`${colName(i)}1`, c.header, STYLE.header)).join('')}</row>`;
  const body = rows.map((row, r) => {
    const cells = columns.map((c, i) => cellXml(`${colName(i)}${r + 2}`, row[i], c.wrap ? STYLE.wrap : STYLE.default)).join('');
    return `<row r="${r + 2}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${header}${body}</sheetData>
${rows.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : ''}
</worksheet>`;
}

function zip(files) { // files: [{name, data: Buffer}]
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = f.data;
    const comp = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * Build the workbook bytes.
 * @param {{name:string, columns:{header:string,width?:number,wrap?:boolean}[], rows:any[][]}[]} sheets
 */
export function buildXlsx(sheets) {
  const safeName = (n) => String(n).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  const files = [];
  const add = (name, s) => files.push({ name, data: Buffer.from(s, 'utf8') });
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`);
  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${esc(safeName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
${sheets.map((s, i) => s.rows.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(safeName(s.name))}'!$A$1:$${colName(s.columns.length - 1)}$${s.rows.length + 1}</definedName></definedNames>` : '').find(Boolean) ?? ''}
</workbook>`);
  add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  add('xl/styles.xml', STYLES_XML);
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zip(files);
}

/**
 * Write atomically. If the target is locked (open in Excel), writes a
 * side-by-side copy instead and returns its path.
 */
export function writeXlsx(path, sheets) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = buildXlsx(sheets);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, bytes);
  try {
    renameSync(tmp, path);
    return { path, locked: false };
  } catch (err) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const alt = path.replace(/\.xlsx$/i, ` (locked copy ${stamp}).xlsx`);
    renameSync(tmp, alt);
    return { path: alt, locked: true };
  }
}

export function scoreCell(score) {
  if (score == null || !Number.isFinite(score)) return '';
  const style = score >= 4.5 ? STYLE.scoreHigh : score >= 4.0 ? STYLE.scoreGood : STYLE.scoreLow;
  return { value: score, style };
}
