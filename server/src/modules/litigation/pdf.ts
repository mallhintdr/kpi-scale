/** PDF helpers for litigation: photos → one PDF document, and the structured case file. */
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { shapeUrdu } from './urdu.js';

const A4: [number, number] = [595.28, 841.89];
/** Amiri (SIL OFL) for Urdu text; Latin text keeps the standard Helvetica. */
const FONT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');
let fontCache: { regular: Buffer; bold: Buffer } | null = null;
const fontBytes = () => (fontCache ??= { regular: readFileSync(resolve(FONT_DIR, 'Amiri-Regular.ttf')), bold: readFileSync(resolve(FONT_DIR, 'Amiri-Bold.ttf')) });
/** Text is pre-shaped, so the font's own substitutions and kerning are switched off (they misplace glyphs in PDF). */
const NO_FEATURES = { liga: false, clig: false, dlig: false, calt: false, kern: false, rlig: false, init: false, medi: false, fina: false, isol: false, ccmp: false, mark: false, mkmk: false, curs: false };
const latin = (s: unknown) => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
const ARABIC = '؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿';
const RTL = new RegExp(`[${ARABIC}]`);
const FIRST_STRONG = new RegExp(`[A-Za-z${ARABIC}]`);
const RUNS = new RegExp(`[${ARABIC}][${ARABIC}\\s]*|[^${ARABIC}]+`, 'g');

/**
 * Draw one line. Lines containing Urdu are right-to-left: Urdu runs and Latin / number runs are placed
 * from the right edge in reading order, each run shaped by the font.
 */
/** Width of mixed Latin / Urdu text. */
const measure = (text: string, size: number, latinFont: PDFFont, urdu: PDFFont) =>
  (text.match(RUNS) ?? [text]).reduce((s, r) => s + (RTL.test(r) ? urdu.widthOfTextAtSize(shapeUrdu(r), size) : latinFont.widthOfTextAtSize(r.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?'), size)), 0);

/** Latin text uses the standard font (o.font); Urdu runs use the Urdu font (o.urdu), shaped and laid out right-to-left. */
function drawLine(page: PDFPage, text: string, o: { x: number; y: number; size: number; font: PDFFont; urdu?: PDFFont; width?: number; color?: [number, number, number] }) {
  const color = rgb(...(o.color ?? [0.1, 0.1, 0.1]));
  const safe = (s: string) => s.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…·]/g, '?');
  if (!RTL.test(text) || !o.urdu) {
    page.drawText(safe(text), { x: o.x, y: o.y, size: o.size, font: o.font, color });
    return;
  }
  const urdu = o.urdu;
  const runs = (text.match(RUNS) ?? [text]).map((r) => (RTL.test(r) ? { t: shapeUrdu(r.trim()), f: urdu, pad: true } : { t: safe(r), f: o.font, pad: false }));
  const w = (r: (typeof runs)[number]) => r.f.widthOfTextAtSize(r.t, o.size) + (r.pad ? o.font.widthOfTextAtSize(' ', o.size) : 0);
  const rtl = RTL.test(text.match(FIRST_STRONG)?.[0] ?? '');
  if (rtl) {
    // Right-to-left line: runs placed from the right edge in reading order
    let cursor = o.x + (o.width ?? A4[0] - o.x - 50);
    for (const r of runs) {
      cursor -= w(r);
      page.drawText(r.t, { x: cursor, y: o.y, size: o.size, font: r.f, color });
    }
  } else {
    let cursor = o.x;
    for (const r of runs) {
      page.drawText(r.t, { x: cursor, y: o.y, size: o.size, font: r.f, color });
      cursor += w(r);
    }
  }
}

/** Several page photos (JPEG / PNG) → one A4 PDF, one photo per page, scaled to fit. */
export async function imagesToPdf(images: { data: Buffer; mime: string }[]) {
  const pdf = await PDFDocument.create();
  for (const img of images) {
    const emb = img.mime.includes('png') ? await pdf.embedPng(img.data) : await pdf.embedJpg(img.data);
    const page = pdf.addPage(A4);
    const m = 18;
    const scale = Math.min((A4[0] - 2 * m) / emb.width, (A4[1] - 2 * m) / emb.height);
    const w = emb.width * scale;
    const h = emb.height * scale;
    page.drawImage(emb, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
  }
  return { data: Buffer.from(await pdf.save()), pages: images.length };
}

export const pdfPages = async (data: Buffer) => (await PDFDocument.load(data, { ignoreEncryption: true })).getPageCount();

/** Simple flowing text writer with wrapping and automatic new pages. */
class Writer {
  page!: PDFPage;
  y = 0;
  constructor(public pdf: PDFDocument, public font: PDFFont, public bold: PDFFont, public urdu: PDFFont, public urduBold: PDFFont) { this.newPage(); }
  newPage() { this.page = this.pdf.addPage(A4); this.y = A4[1] - 50; }
  ensure(h: number) { if (this.y - h < 50) this.newPage(); }
  text(t: string, o: { size?: number; bold?: boolean; color?: [number, number, number]; x?: number; width?: number } = {}) {
    const size = o.size ?? 10;
    const f = o.bold ? this.bold : this.font;
    const x = o.x ?? 50;
    const width = o.width ?? A4[0] - x - 50;
    for (const para of latin(t).split('\n')) {
      let line = '';
      const lines: string[] = [];
      for (const w of para.split(' ')) {
        const test = line ? `${line} ${w}` : w;
        if (measure(test, size, f, o.bold ? this.urduBold : this.urdu) > width && line) { lines.push(line); line = w; } else line = test;
      }
      lines.push(line);
      for (const l of lines) {
        this.ensure(size + 5);
        drawLine(this.page, l, { x, y: this.y, size, font: f, urdu: o.bold ? this.urduBold : this.urdu, width, color: o.color });
        this.y -= size + 5;
      }
    }
  }
  gap(h = 8) { this.y -= h; }
  rule() { this.ensure(6); this.page.drawLine({ start: { x: 50, y: this.y }, end: { x: A4[0] - 50, y: this.y }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) }); this.y -= 8; }
  pair(k: string, v: string) {
    const before = this.y;
    this.ensure(14);
    drawLine(this.page, latin(k), { x: 50, y: this.y, size: 9.5, font: this.bold, urdu: this.urduBold, color: [0.3, 0.3, 0.3] });
    const y0 = this.y;
    this.text(v || '—', { x: 200, size: 9.5 });
    if (this.y === y0) this.y -= 13;
    void before;
  }
}

const fmt = (d?: Date | string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export const CATEGORY_ORDER: [string, string][] = [
  ['plaint', 'Plaint / Dawa / Writ Petition / Appeal'],
  ['reply', 'Reply / Jawab Dawa'],
  ['order_sheet', 'Order Sheet'],
  ['judgment', 'Judgment / Order'],
  ['evidence', 'Evidence'],
  ['notice', 'Notices / Summons'],
  ['other', 'Other Documents'],
];

/** The complete case file: cover, hearings, then documents grouped in the prescribed order. */
export async function caseFilePdf(c: any, ctx: { mouza?: string; tehsil?: string; courtName: (code: string, other?: string) => string }, docs: { category: string; title?: string; docDate?: Date; data: Buffer }[]) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Case file ${c.caseId}`);
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const urdu = await pdf.embedFont(fontBytes().regular, { subset: false, features: NO_FEATURES });
  const urduBold = await pdf.embedFont(fontBytes().bold, { subset: false, features: NO_FEATURES });
  const w = new Writer(pdf, font, bold, urdu, urduBold);

  w.text('LITIGATION CASE FILE', { size: 9, bold: true, color: [0.09, 0.48, 0.26] });
  w.gap(6);
  w.text(c.caseId, { size: 20, bold: true });
  w.text(`${c.status === 'decided' ? 'DECIDED' : 'PENDING (SUB JUDICE)'}${c.stage > 1 ? ` · Stage ${c.stage}` : ''}`, { size: 10, bold: true, color: c.status === 'decided' ? [0.1, 0.45, 0.2] : [0.7, 0.4, 0] });
  w.gap(6);
  w.rule();
  w.pair('Tehsil / Mouza', `${ctx.tehsil ?? ''} / ${ctx.mouza ?? ''}`);
  w.pair('Type of case', c.caseType);
  w.pair('Court', `${ctx.courtName(c.court, c.courtOther)}${c.bench ? `, ${c.bench}` : ''}`);
  w.pair('Court case no.', c.courtCaseNo ?? '');
  w.pair('Date of institution', fmt(c.institutedOn));
  w.pair('Applicant(s)', (c.applicants ?? []).join('; '));
  w.pair('Respondent(s)', (c.respondents ?? []).join('; '));
  const l = c.land ?? {};
  w.pair('Land measuring', [l.kanal ? `${l.kanal} Kanal` : '', l.marla ? `${l.marla} Marla` : '', l.feet ? `${l.feet} Feet` : ''].filter(Boolean).join(' ') || '—');
  // With murabbas the khasras are listed under each murabba; otherwise (khasra-only tehsils) on their own line
  const loose = (l.parcels?.length ? l.parcels.filter((p: any) => !p.murabba).flatMap((p: any) => p.khasras) : l.murabba ? [] : l.khasraNos) ?? [];
  if (l.murabba) w.pair('Murabba (Killa / Khasra)', l.murabba);
  w.pair('Khasra / Khewat / Khatauni', [loose.join(', '), l.khewat, l.khatauni].filter(Boolean).join(' · '));
  w.pair('Land specification', c.landSpec ?? '');
  w.pair('Last hearing', fmt(c.lastHearing));
  w.pair('Next hearing', fmt(c.nextHearing));
  w.pair('Proceedings (last date)', c.lastProceedings ?? '');
  w.pair('To be done (next date)', c.nextAction ?? '');
  if (c.status === 'decided') {
    w.pair('Date of decision', fmt(c.decision?.date));
    w.pair('Decision', [c.decision?.result, c.decision?.summary].filter(Boolean).join(' — '));
  }
  const a = c.appeal ?? {};
  w.pair('Appeal', a.filed === 'yes' ? `Filed in ${ctx.courtName(a.court, a.courtOther)}${a.filedOn ? ` on ${fmt(a.filedOn)}` : ''}${a.appealNo ? ` (No. ${a.appealNo})` : ''}` : a.filed === 'no' ? `Not filed — ${a.reasonNotFiled ?? ''}` : '—');
  if (c.note) w.pair('Note', c.note);
  if (c.stages?.length) {
    w.gap(6);
    w.text('Court history', { size: 12, bold: true });
    for (const s of c.stages) w.text(`Stage ${s.stage}: ${ctx.courtName(s.court, s.courtOther)}${s.courtCaseNo ? ` (${s.courtCaseNo})` : ''} · instituted ${fmt(s.institutedOn)} · decided ${fmt(s.decidedOn)}${s.result ? ` · ${s.result}` : ''}`, { size: 9.5 });
  }
  w.gap(10);
  w.text('Hearings', { size: 12, bold: true });
  w.rule();
  const hs = [...(c.hearings ?? [])].sort((x: any, y: any) => +new Date(x.date) - +new Date(y.date));
  if (!hs.length) w.text('No hearings recorded.', { size: 9.5 });
  for (const h of hs) {
    w.text(`${fmt(h.date)}${h.court ? ` · ${ctx.courtName(h.court)}` : ''}${h.nextDate ? ` · next ${fmt(h.nextDate)}` : ''}`, { size: 9.5, bold: true });
    if (h.proceedingsDone) w.text(`Proceedings: ${h.proceedingsDone}`, { size: 9.5, x: 62 });
    if (h.nextAction) w.text(`For next date: ${h.nextAction}`, { size: 9.5, x: 62 });
    w.gap(3);
  }
  if (c.notes?.length) {
    w.gap(8);
    w.text('Notes', { size: 12, bold: true });
    for (const n of c.notes) w.text(`${fmt(n.at)}: ${n.text}`, { size: 9.5 });
  }
  w.gap(8);
  w.text(`Generated ${new Date().toLocaleString('en-GB')} · Documents follow in the order: ${CATEGORY_ORDER.map((x) => x[1]).join(' · ')}`, { size: 8, color: [0.45, 0.45, 0.45] });

  for (const [cat, label] of CATEGORY_ORDER) {
    const list = docs.filter((d) => d.category === cat);
    if (!list.length) continue;
    const div = pdf.addPage(A4);
    drawLine(div, latin(label), { x: 50, y: A4[1] / 2 + 20, size: 22, font: bold, urdu: urduBold, color: [0.09, 0.48, 0.26] });
    drawLine(div, latin(`${c.caseId} · ${list.length} document(s)`), { x: 50, y: A4[1] / 2 - 6, size: 11, font, urdu });
    list.forEach((d, i) => drawLine(div, latin(`${i + 1}. ${d.title ?? label}${d.docDate ? ` (${fmt(d.docDate)})` : ''}`), { x: 50, y: A4[1] / 2 - 32 - i * 15, size: 10, font, urdu }));
    for (const d of list) {
      try {
        const src = await PDFDocument.load(d.data, { ignoreEncryption: true });
        const pages = await pdf.copyPages(src, src.getPageIndices());
        pages.forEach((p) => pdf.addPage(p));
      } catch {
        const p = pdf.addPage(A4);
        drawLine(p, latin(`[${d.title ?? label}: could not be included — download it separately]`), { x: 50, y: A4[1] / 2, size: 11, font, urdu });
      }
    }
  }
  return Buffer.from(await pdf.save());
}
