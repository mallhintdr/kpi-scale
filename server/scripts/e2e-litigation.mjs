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

console.log('Phase 2');
const urduCase = await call(p1, 'POST', '/litigation', { ...body, courtCaseNo: 'CS-T-URDU', applicants: ['محمد اسلم ولد غلام رسول'], respondents: ['حکومت پنجاب'], land: { kanal: 2, murabba: 'مربع نمبر 45', khasraNos: ['7'] }, nextHearing: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) });
check(urduCase.s === 201 && urduCase.b.land.murabba === 'مربع نمبر 45', 'Mustateel / Murabba is saved');
const upd = await call(tsd, 'GET', `/litigation/${urduCase.b._id}/pdf`);
check(upd.s === 200 && (await PDFDocument.load(upd.b)).getPageCount() >= 1, 'a case file with Urdu names builds as a PDF');
const cl = (await call(tsd, 'GET', '/litigation/causelist')).b;
check(cl.items.some((x) => x._id === urduCase.b._id), 'the cause list shows tomorrow\'s hearing');
const zip = await call(tsd, 'GET', `/litigation/${id}/zip`);
check(zip.s === 200 && zip.b.subarray(0, 2).toString() === 'PK', 'documents download as a ZIP');
const rem = (await call(adm, 'POST', '/litigation/reminders/run')).b;
check(rem.hearings >= 1 && rem.sent >= 1, `reminders sent for hearings today / tomorrow (${rem.sent} message(s))`);
check((await call(adm, 'PUT', '/litigation/settings', { appealDays: { civil_court: 30 } })).b.appealDays.civil_court === 30, 'admin sets the appeal period for a court');
const tpl = await call(p1, 'GET', '/litigation/import/template');
const twb = new ExcelJS.Workbook(); await twb.xlsx.load(tpl.b);
const sheet = twb.worksheets[0];
const mz = mouzas[0].name.replace(/^Mouza\s+/i, '').replace(/\s*\(test\)$/, '');
sheet.getRow(2).values = ['Hasilpur', mz, 'Partition', '2024-05-10', 'Civil Court', 'CS-T-IMP1', 'Ali Ahmad; Bashir', 'Province of Punjab', 4, 10, '', '45', '45/2', 'State land', '', '2026-12-01', '', 'Arguments', 'Pending'];
sheet.getRow(3).values = ['Hasilpur', 'No Such Mouza', 'Partition', '2024-05-10', 'Civil Court', 'CS-T-IMP2', 'X', 'Y'];
const bad = Buffer.from(await twb.xlsx.writeBuffer()).toString('base64');
const dry = (await call(p1, 'POST', '/litigation/import', { file: bad, dryRun: true })).b;
check(dry.valid === 1 && dry.errors.length === 1 && dry.errors[0].row === 3, `import check: 1 valid, 1 problem ("${dry.errors[0]?.message}")`);
sheet.spliceRows(3, 1);
const good = Buffer.from(await twb.xlsx.writeBuffer()).toString('base64');
const imp = (await call(p1, 'POST', '/litigation/import', { file: good, dryRun: false })).b;
check(imp.imported === 1, 'the corrected file imports 1 case with an automatic ID');
await call(adm, 'PUT', '/litigation/settings', { appealDays: {} });

console.log('Phase 3');
const lp = (await call(p1, 'PATCH', `/litigation/${second.b._id}`, { land: { kanal: 8, parcels: [{ murabba: '45', khasras: ['12', '13'] }, { murabba: '46', khasras: ['7'] }] } })).b;
check(lp.land.parcels.length === 2 && lp.land.murabba === '45 (12, 13); 46 (7)' && lp.land.khasraNos.join() === '12,13,7', 'several murabbas, each with its own killa / khasra nos.');
const ko = (await call(p1, 'PATCH', `/litigation/${second.b._id}`, { land: { parcels: [{ khasras: ['112', '113/2'] }] } })).b;
check(!ko.land.murabba && ko.land.khasraNos.join() === '112,113/2', 'khasra-only land (tehsils without murabbas)');
check((await call(p1, 'GET', '/litigation?search=113/2')).b.items.some((x) => x._id === second.b._id), 'search finds the case by khasra no.');
const sg = (await call(p1, 'GET', '/litigation/suggest')).b;
check(sg.respondents.includes('Province of Punjab through Collector') && sg.caseType.includes('Encroachment / state land'), 'earlier entries are offered as suggestions (parties, case types)');
await call(p1, 'PATCH', `/litigation/${second.b._id}`, { nextHearing: null });
const st = (await call(tsd, 'GET', '/litigation/stats')).b;
check(st.byCourt.some((g) => g.label && g.total >= 1) && st.byType.length && st.byTehsil.some((t) => t.label === 'Hasilpur'), 'monitoring groups cases by court, type and tehsil');
check(st.oldest.length >= 1 && typeof st.oldest[0].years === 'number', 'oldest pending cases are listed with their age');
check(st.noHearing.some((x) => x._id === second.b._id), 'a pending case with no next hearing is flagged');
await call(p1, 'PATCH', `/litigation/${urduCase.b._id}`, { status: 'decided', decision: { date: '2026-10-01', result: 'Against government' }, appeal: { filed: 'undecided' } });
check((await call(tsd, 'GET', '/litigation/stats')).b.againstGovt.some((x) => x._id === urduCase.b._id), 'decided against government with no appeal decision is flagged');

// Clean up: remove test cases completely
const imported = (await call(adm, 'GET', '/litigation?search=CS-T-IMP1')).b.items.map((x) => x._id);
for (const cid of [id, second.b._id, urduCase.b._id, ...imported]) await call(adm, 'DELETE', `/litigation/${cid}`);
console.log(`\n${ok} checks passed`);
