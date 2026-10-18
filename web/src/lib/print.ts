/**
 * Print / Save as PDF without cutting columns off.
 *  - A table that fits reasonably is scaled down to the page width (CSS zoom), on A4 landscape or,
 *    when A4 would need text smaller than ~65 %, on A3 landscape.
 *  - A table too wide even for that (e.g. every KPI × target / done / %) is split into column
 *    sections, one after the other: each section repeats the identifying columns (#, Name, Area — the
 *    sticky columns on screen) and its own green header, and is labelled "Columns part 1 of 3".
 * Everything is undone after printing.
 */
const MM = 96 / 25.4; // CSS px per mm
const MARGIN = 8; // mm, matches @page in index.css
const A4 = { size: 'A4 landscape', width: (297 - 2 * MARGIN) * MM };
const A3 = { size: 'A3 landscape', width: (420 - 2 * MARGIN) * MM };
const MIN_FIT = 0.65; // smallest scale for a whole table on one page width
const SECTION_SCALE = 0.8; // scale of each column section on A4

let pageStyle: HTMLStyleElement | null = null;
let undo: (() => void)[] = [];

const tablesIn = (root: ParentNode) => [...root.querySelectorAll<HTMLTableElement>('table')].filter((t) => !t.closest('.print\\:hidden') && t.offsetParent !== null);
const printableTables = () => [...document.querySelectorAll<HTMLElement>('main, [role=dialog]')].flatMap(tablesIn);

/** Grid position of every cell (honours rowSpan / colSpan). */
function layout(table: HTMLTableElement) {
  const taken = new Set<string>();
  const out: { cell: HTMLTableCellElement; c: number; cs: number }[][] = [];
  Array.from(table.rows).forEach((tr, r) => {
    const row: { cell: HTMLTableCellElement; c: number; cs: number }[] = [];
    let c = 0;
    for (const cell of Array.from(tr.cells)) {
      while (taken.has(`${r}:${c}`)) c++;
      for (let i = 0; i < (cell.rowSpan || 1); i++) for (let j = 0; j < (cell.colSpan || 1); j++) taken.add(`${r + i}:${c + j}`);
      row.push({ cell, c, cs: cell.colSpan || 1 });
      c += cell.colSpan || 1;
    }
    out.push(row);
  });
  return out;
}

/** Splits a very wide table into column sections placed after it; returns false if it can't be split. */
function splitColumns(table: HTMLTableElement): boolean {
  const grid = layout(table);
  const ncols = Math.max(...grid.map((r) => r.reduce((n, x) => Math.max(n, x.c + x.cs), 0)));
  // Column widths from a body row that has one cell per column
  const bodyStart = table.tHead ? table.tHead.rows.length : 0;
  const full = grid.slice(bodyStart).find((r) => r.length === ncols && r.every((x) => x.cs === 1));
  if (!full) return false;
  const widths = full.map((x) => x.cell.getBoundingClientRect().width);
  // Identifying columns: the sticky ones on screen (#, Name …), else the first column
  const keys = Math.max(1, full.findIndex((x) => !x.cell.classList.contains('sticky')));
  // Section edges may not cut through a merged header (e.g. a KPI over Target / Done / %)
  const blocked = new Set<number>();
  for (const r of grid) for (const x of r) for (let b = x.c + 1; b < x.c + x.cs; b++) blocked.add(b);
  const keyWidth = widths.slice(0, keys).reduce((a, b) => a + b, 0);
  const room = A4.width / SECTION_SCALE - keyWidth;
  if (room < 200) return false;

  const sections: [number, number][] = [];
  let start = keys, used = 0, lastEdge = -1;
  for (let c = keys; c < ncols; c++) {
    if (!blocked.has(c) && c > start) lastEdge = c;
    used += widths[c];
    if (used > room && lastEdge > start) { sections.push([start, lastEdge]); start = lastEdge; used = widths.slice(start, c + 1).reduce((a, b) => a + b, 0); lastEdge = -1; }
  }
  sections.push([start, ncols]);
  if (sections.length < 2) return false;

  const holder = document.createElement('div');
  holder.className = 'print-sections';
  sections.forEach(([from, to], i) => {
    const clone = table.cloneNode(true) as HTMLTableElement;
    const g = layout(clone);
    for (const row of g) for (const x of row) {
      const inKeys = x.c < keys;
      const inSection = x.c >= from && x.c + x.cs <= to;
      if (!inKeys && !inSection) {
        // A full-width row (e.g. "REVENUE" group label) stays, narrowed to this section
        if (x.c < keys && x.c + x.cs > keys) continue;
        if (x.c <= from && x.c + x.cs >= to && x.cs > 1) { x.cell.colSpan = Math.min(x.c + x.cs, to) - Math.max(x.c, from) + (x.c < keys ? keys - x.c : 0); continue; }
        x.cell.remove();
      }
    }
    clone.removeAttribute('id');
    const label = document.createElement('div');
    label.textContent = `Columns — part ${i + 1} of ${sections.length}`;
    label.style.cssText = 'font: 600 11px sans-serif; color: #475569; margin: 0 0 4px';
    const block = document.createElement('div');
    block.style.cssText = i ? 'break-before: page; page-break-before: always;' : '';
    block.append(label, clone);
    holder.append(block);
  });
  table.after(holder);
  const prev = table.style.display;
  table.style.display = 'none';
  undo.push(() => { holder.remove(); table.style.display = prev; });
  return true;
}

function fit() {
  restore();
  let tables = printableTables();
  for (const t of tables) if (t.scrollWidth * MIN_FIT > A3.width) splitColumns(t);
  tables = printableTables();
  const widest = Math.max(0, ...tables.map((t) => t.scrollWidth));
  const page = widest * MIN_FIT <= A4.width ? A4 : A3;
  pageStyle = document.createElement('style');
  pageStyle.textContent = `@page { size: ${page.size}; margin: ${MARGIN}mm; }`;
  document.head.appendChild(pageStyle);
  for (const t of tables) {
    const scale = page.width / t.scrollWidth;
    if (scale >= 1) continue;
    const prev = t.style.zoom;
    t.style.zoom = String(Math.floor(scale * 1000) / 1000);
    undo.push(() => { t.style.zoom = prev; });
  }
}

function restore() {
  for (const u of undo.reverse()) u();
  undo = [];
  pageStyle?.remove();
  pageStyle = null;
}

export function installPrintFit() {
  window.addEventListener('beforeprint', fit);
  window.addEventListener('afterprint', restore);
}
