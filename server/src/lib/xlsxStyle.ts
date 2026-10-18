import type { Worksheet } from 'exceljs';

const GREEN = 'FF187A43';
const BORDER = { style: 'thin' as const, color: { argb: 'FFB8C2BC' } };

/**
 * Finishes an export sheet so it looks like the screen and prints without cutting columns:
 * green header with white bold text, borders, wrapped text, sensible widths, dates as dd-mmm-yyyy,
 * frozen header, landscape page one page wide (A3 when wide), header row repeated on every page.
 */
export function finishSheet(ws: Worksheet, opts: { headerRow: number; keyCols?: number; maxWidth?: number }) {
  const { headerRow } = opts;
  const ncols = ws.getRow(headerRow).cellCount;
  const head = ws.getRow(headerRow);
  head.height = 30;
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  const widths = Array<number>(ncols).fill(8);
  ws.eachRow((row, r) => {
    if (r < headerRow) return;
    for (let i = 1; i <= ncols; i++) {
      const c = row.getCell(i);
      c.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
      if (r === headerRow) { widths[i - 1] = Math.max(widths[i - 1], Math.min(18, String(c.value ?? '').length + 2)); continue; }
      if (c.value instanceof Date) c.numFmt = 'dd-mmm-yyyy';
      c.alignment = { vertical: 'top', wrapText: true, ...(typeof c.value === 'number' ? { horizontal: 'right' } : {}) };
      const len = c.value instanceof Date ? 12 : String(c.value ?? '').length;
      widths[i - 1] = Math.max(widths[i - 1], Math.min(opts.maxWidth ?? 40, len + 2));
    }
  });
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const total = widths.reduce((a, b) => a + b, 0);
  ws.views = [{ state: 'frozen', ySplit: headerRow, xSplit: opts.keyCols ?? 0 }];
  ws.pageSetup = {
    orientation: 'landscape', paperSize: (total > 150 ? 8 : 9) as any, // A3 / A4
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    printTitlesRow: `${headerRow}:${headerRow}`,
  };
  ws.headerFooter = { oddFooter: '&LPage &P of &N&R&D' };
}
