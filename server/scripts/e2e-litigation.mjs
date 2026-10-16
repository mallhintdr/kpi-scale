// End-to-end check of the Litigation register (Board of Revenue seed, API on :4000).
// Creates a case as a patwari, records hearings, decides, files an appeal stage, attaches photos and a
// PDF, downloads the structured case file, checks access, then removes the test data.
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';

const API = process.env.API ?? 'http://localhost:4000/api';
let ok = 0;
const check = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); ok++; console.log('  ✓', m); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); const ct = r.headers.get('content-type') ?? ''; return { s: r.status, b: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
const login = async (e) => (await call(null, 'POST', '/auth/login', { email: e, password: 'Password123' })).b.accessToken;
// A tiny valid JPEG (1x1) and a one-page PDF for attachments
const jpg = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'); // 1x1 PNG
const onePage = await PDFDocument.create(); onePage.addPage([300, 300]); const pdf = Buffer.from(await onePage.save());

const p1 = await login('patwari1.hasilpur@bwp.test');
const p2y = await login('patwari1.yazman@bwp.test');
const tsd = await login('tehsildar.hasilpur@bwp.test');
const adm = await login('admin@bwp.test');

console.log('Entry');
const mouzas = (await call(p1, 'GET', '/litigation/mouzas')).b;
check(mouzas.length > 0 && mouzas.every((m) => m.tehsil === 'Hasilpur'), `the patwari picks from his own mouzas (${mouzas.length})`);
const body = { unitId: mouzas[0]._id, caseType: 'Encroachment / state land', institutedOn: '2025-03-10', court: 'civil_court', courtCaseNo: 'CS-T-001', applicants: ['Muhammad Aslam', 'Bashir Ahmad'], respondents: ['Province of Punjab through Collector'], land: { kanal: 12, marla: 5, khasraNos: ['45/2', '46'] }, landSpec: 'State land, nehri', governmentParty: true, nextHearing: '2026-11-20', note: 'Test case' };
const created = await call(p1, 'POST', '/litigation', body);
check(created.s === 201 && /^[A-Z0-9]+-[A-Z0-9]+-\d{4}$/.test(created.b.caseId), `case created with ID ${created.b.caseId} (tehsil-mouza-serial)`);
const id = created.b._id;
const second = await call(p1, 'POST', '/litigation', { ...body, courtCaseNo: 'CS-T-002', applicants: ['Other Person'], unitId: mouzas[1]?._id ?? mouzas[0]._id });
check(second.b.serial === created.b.serial + 1, `the serial runs per tehsil (${created.b.serial} → ${second.b.serial}) across mouzas`);
check((await call(p1, 'POST', '/litigation', body)).s === 409, 'a duplicate (same court case no.) is flagged');
check((await call(tsd, 'POST', '/litigation', body)).s === 403, 'the Tehsildar views but does not enter cases (not a litigation post)');
check((await call(p2y, 'GET', `/litigation/${id}`)).s === 403, 'a patwari of another tehsil cannot see it');
check((await call(tsd, 'GET', `/litigation/${id}`)).s === 200, 'the Tehsildar sees it (his jurisdiction)');

console.log('Hearings, decision, appeal');
let c = (await call(p1, 'POST', `/litigation/${id}/hearings`, { date: '2026-11-20', proceedingsDone: 'Reply filed', nextAction: 'Arguments', nextDate: '2026-12-15' })).b;
check(String(c.nextHearing).startsWith('2026-12-15') && c.lastProceedings === 'Reply filed', 'a hearing rolls the next date forward on the same case');
check((await call(p1, 'PATCH', `/litigation/${id}`, { status: 'decided' })).s === 400, 'Decided needs a date of decision');
check((await call(p1, 'PATCH', `/litigation/${id}`, { status: 'decided', decision: { date: '2026-12-15', result: 'Against government' }, appeal: { filed: 'no' } })).s === 400, 'Appeal "No" needs a reason');
c = (await call(p1, 'PATCH', `/litigation/${id}`, { status: 'decided', decision: { date: '2026-12-15', result: 'Against government' }, appeal: { filed: 'yes', court: 'district_judge', filedOn: '2026-12-20', appealNo: 'CA-9' } })).b;
check(c.status === 'decided' && c.appeal.filed === 'yes', 'decided, appeal filed in the District & Sessions Judge');
c = (await call(p1, 'POST', `/litigation/${id}/appeal-stage`, { court: 'district_judge', filedOn: '2026-12-20', courtCaseNo: 'CA-9', nextHearing: '2027-01-10' })).b;
check(c.caseId === created.b.caseId && c.stage === 2 && c.stages.length === 1 && c.status === 'pending' && c.court === 'district_judge', `the appeal continues as stage 2 of ${c.caseId}`);

console.log('Documents and PDF');
const d1 = await call(p1, 'POST', `/litigation/${id}/docs`, { category: 'plaint', title: 'Plaint', files: [{ name: 'p1.png', mime: 'image/png', data: jpg.toString('base64') }, { name: 'p2.png', mime: 'image/png', data: jpg.toString('base64') }] });
check(d1.s === 201 && d1.b.pages === 2, 'two camera pages become one 2-page PDF document');
const d2 = await call(p1, 'POST', `/litigation/${id}/docs`, { category: 'order_sheet', title: 'Order sheet', files: [{ name: 'os.pdf', mime: 'application/pdf', data: pdf.toString('base64') }] });
check(d2.s === 201, 'a PDF is attached as it is');
check((await call(p1, 'POST', `/litigation/${id}/docs`, { category: 'other', files: [{ name: 'x.exe', mime: 'application/pdf', data: Buffer.from('MZ fake').toString('base64') }] })).s === 400, 'a non-PDF/JPG file is refused by its content');
const file = await call(tsd, 'GET', `/litigation/${id}/pdf`);
const merged = await PDFDocument.load(file.b);
check(merged.getPageCount() >= 6, `the case-file PDF has cover + hearings + dividers + documents (${merged.getPageCount()} pages)`);
check((await call(tsd, 'DELETE', `/litigation/${id}/docs/${d2.b._id}`)).s === 403, 'the Tehsildar cannot delete documents');

console.log('List, dashboard, export');
const list = (await call(tsd, 'GET', '/litigation?search=Aslam')).b;
check(list.items.some((x) => x._id === id), 'search by party name finds it');
const dash = (await call(tsd, 'GET', '/litigation/dashboard')).b;
check(dash.total >= 2 && dash.pending >= 1, `dashboard: ${dash.total} total, ${dash.pending} pending`);
const x = await call(tsd, 'GET', '/litigation/export/xlsx');
const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.b);
check(wb.worksheets[0].getRow(1).values.includes('Case ID') && wb.worksheets[0].rowCount >= 3, 'the list exports to Excel');

// Clean up: remove test cases completely
for (const cid of [id, second.b._id]) await call(adm, 'DELETE', `/litigation/${cid}`);
console.log(`\n${ok} checks passed`);
