/**
 * Excel export of an on-screen table, formatted like the screen: green header with white bold text,
 * borders, merged header cells, frozen header, numbers stored as numbers. Page setup is landscape,
 * one page wide, with the header repeated on every page, so printing from Excel never cuts columns.
 */
import type { Worksheet } from 'exceljs';

const GREEN = 'FF187A43';
const GROUP = 'FFECF6EF';
const TOTAL = 'FFF1F5F9';
const BORDER = { style: 'thin' as const, color: { argb: 'FFB8C2BC' } };
const BOX = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

/** "1,234.5" → 1234.5, "45%" → 0.45 (percent format); anything else stays text. */
function parse(text: string): { v: string | number; fmt?: string } {
  const t = text.replace(/−/g, '-').trim();
  const pct = /^(-?[\d,]*\.?\d+)\s*%$/.exec(t);
  if (pct) return { v: Number(pct[1].replace(/,/g, '')) / 100, fmt: pct[1].includes('.') ? '0.0%' : '0%' };
  if (/^-?[\d,]*\.?\d+$/.test(t) && !/^0\d/.test(t)) {
    const n = Number(t.replace(/,/g, ''));
    if (Number.isFinite(n)) { const dp = t.includes('.') ? t.split('.')[1].length : 0; return { v: n, fmt: dp ? `#,##0.${'0'.repeat(dp)}` : '#,##0' }; }
  }
  return { v: t };
}

const textOf = (c: HTMLElement) => (c.innerText || c.textContent || '').replace(/\s*\n\s*/g, ' ').trim();

/** Lays the table's rows into a grid honouring rowSpan / colSpan. */
function grid(table: HTMLTableElement) {
  const rows: { kind: 'head' | 'body' | 'foot'; cells: { r: number; c: number; rs: number; cs: number; text: string; th: boolean }[] }[] = [];
  const taken = new Set<string>();
  let r = 0;
  for (const tr of Array.from(table.rows)) {
    if (tr.closest('.print\\:hidden') || tr.offsetParent === null && tr.getClientRects().length === 0) continue;
    const kind = tr.parentElement?.tagName === 'THEAD' ? 'head' : tr.parentElement?.tagName === 'TFOOT' ? 'foot' : 'body';
    const cells = [];
    let c = 0;
    for (const cell of Array.from(tr.cells)) {
      if (cell.classList.contains('print:hidden')) continue;
      while (taken.has(`${r}:${c}`)) c++;
      const rs = cell.rowSpan || 1, cs = cell.colSpan || 1;
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) taken.add(`${r + i}:${c + j}`);
      cells.push({ r, c, rs, cs, text: textOf(cell), th: cell.tagName === 'TH' });
      c += cs;
    }
    rows.push({ kind, cells });
    r++;
  }
  return rows;
}

export async function exportTableXlsx(table: HTMLTableElement | null, opts: { filename: string; title?: string; subtitle?: string; sheet?: string; freezeCols?: number }) {
  if (!table) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws: Worksheet = wb.addWorksheet((opts.sheet ?? 'Report').slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  const rows = grid(table);
  const ncols = Math.max(1, ...rows.flatMap((x) => x.cells.map((c) => c.c + c.cs)));

  // Title lines
  let top = 0;
  for (const [text, size] of [[opts.title, 14], [opts.subtitle, 10]] as const) {
    if (!text) continue;
    top++;
    ws.mergeCells(top, 1, top, ncols);
    const cell = ws.getCell(top, 1);
    cell.value = text;
    cell.font = { bold: size > 10, size, color: { argb: size > 10 ? GREEN : 'FF475569' } };
  }
  if (top) top++; // blank line under the title

  const widths = Array<number>(ncols).fill(6);
  let headRows = 0;
  for (const row of rows) {
    if (row.kind === 'head') headRows++;
    const isGroup = row.kind === 'body' && row.cells.length === 1 && row.cells[0].cs >= ncols - 1;
    for (const x of row.cells) {
      const R = top + x.r + 1, C = x.c + 1;
      if (x.rs > 1 || x.cs > 1) ws.mergeCells(R, C, R + x.rs - 1, C + x.cs - 1);
      const cell = ws.getCell(R, C);
      const p = row.kind === 'head' ? { v: x.text } : parse(x.text);
      cell.value = p.v === '' ? null : p.v;
      if (p.fmt) cell.numFmt = p.fmt;
      cell.border = BOX;
      cell.alignment = { vertical: 'middle', wrapText: true, horizontal: row.kind === 'head' ? 'center' : typeof p.v === 'number' ? 'right' : 'left' };
      if (row.kind === 'head') {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
      } else if (isGroup) {
        cell.font = { bold: true, color: { argb: 'FF146B3A' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP } };
      } else if (row.kind === 'foot') {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL } };
      }
      // Paint the merged area too (borders and fill on every covered cell)
      for (let i = 0; i < x.rs; i++) for (let j = 0; j < x.cs; j++) {
        if (!i && !j) continue;
        const m = ws.getCell(R + i, C + j);
        m.border = BOX;
        if (cell.fill) m.fill = cell.fill;
      }
      if (x.cs === 1 && !isGroup) widths[x.c] = Math.max(widths[x.c], Math.min(45, x.text.length + 2));
    }
  }
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  for (let i = 1; i <= headRows; i++) ws.getRow(top + i).height = 30;

  ws.views = [{ state: 'frozen', ySplit: top + headRows, xSplit: opts.freezeCols ?? 0 }];
  // Up to ~an A3 page of columns: one page wide. Wider: Excel pages across, repeating the identifying
  // columns (#, Name, Area…) on every page so each printed page can still be read on its own.
  const totalWidth = widths.reduce((a, b) => a + b, 0); // in characters
  const keys = opts.freezeCols ?? 0;
  const oneWide = totalWidth <= 260;
  ws.pageSetup = {
    orientation: 'landscape', paperSize: (totalWidth > 150 ? 8 : 9) as any, // A3 (8) when wide, else A4 (9); A3 is missing from the typings
    ...(oneWide ? { fitToPage: true, fitToWidth: 1, fitToHeight: 0 } : { fitToPage: false, scale: 80 }),
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    ...(headRows ? { printTitlesRow: `${top + 1}:${top + headRows}` } : {}),
    ...(!oneWide && keys ? { printTitlesColumn: `A:${ws.getColumn(keys).letter}` } : {}),
  };
  ws.headerFooter = { oddFooter: '&LPage &P of &N&R&D' };

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  Object.assign(document.createElement('a'), { href: url, download: opts.filename.endsWith('.xlsx') ? opts.filename : `${opts.filename}.xlsx` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
