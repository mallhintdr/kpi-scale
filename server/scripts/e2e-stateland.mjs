// End-to-end check of the State Land Directory (Board of Revenue seed, API on :4000).
// Patwari enters holdings, Girdawar verifies, Tehsildar approves; edits go back for verification;
// encroachment, litigation link, documents, mouza listing, summary and Excel; then removes the test data.
import ExcelJS from 'exceljs';

const API = process.env.API ?? 'http://localhost:4000/api';
let ok = 0;
const check = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); ok++; console.log('  ✓', m); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); const ct = r.headers.get('content-type') ?? ''; return { s: r.status, b: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
const login = async (e) => (await call(null, 'POST', '/auth/login', { email: e, password: 'Password123' })).b.accessToken;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');

const p1 = await login('patwari1.hasilpur@bwp.test');
const py = await login('patwari1.yazman@bwp.test');
const tsd = await login('tehsildar.hasilpur@bwp.test');
const adm = await login('admin@bwp.test');
const girdawars = (await Promise.all([1, 2, 3, 4, 5, 6].map((i) => login(`girdawar${i}.hasilpur@bwp.test`)))).filter(Boolean);
const made = [];

console.log('Entry');
const meta = (await call(p1, 'GET', '/state-land/meta')).b;
check(meta.canEnter && !meta.canVerify && meta.categories.length === 11, 'the Patwari can enter (11 categories), not verify');
check((await call(tsd, 'GET', '/state-land/meta')).b.canApprove, 'the Tehsildar can approve');
const mouzas = (await call(p1, 'GET', '/state-land/mouzas')).b;
check(mouzas.length > 0, `the Patwari picks from his own mouzas (${mouzas.length})`);
const body = {
  unitId: mouzas[0]._id, khewat: '112', khatauni: '140-141', land: { parcels: [{ murabba: '45', khasras: ['12', '13'] }, { murabba: '46', khasras: ['7'] }] },
  area: { kanal: 24, marla: 10 }, linear: { lengthFt: 3200, widthFt: 40 }, category: 'provincial_dept', subType: 'Canal', ownerRecord: 'Mehkma Nehar', custodian: 'Irrigation Department',
  possession: 'part_encroached', encroachment: { area: { kanal: 2 }, encroachers: ['Test Encroacher s/o X'], nature: 'Cultivation', since: 2019, action: 'Notice issued' },
  record: { status: 'mutated', mutationNos: '1234' }, gps: { lat: 29.69, lng: 72.54 },
};
const c1 = await call(p1, 'POST', '/state-land', body);
check(c1.s === 201 && /^[A-Z0-9]+-[A-Z0-9]+-SL-\d{4}$/.test(c1.b.holdingId), `holding created with ID ${c1.b.holdingId}`);
made.push(c1.b._id);
check(c1.b.acres === 3.0625 && c1.b.encroachment.acres === 0.25, `area in acres derived (${c1.b.acres} acres, ${c1.b.encroachment.acres} encroached)`);
check(c1.b.land.khasraNos.join() === '12,13,7', 'several murabbas with their killas');
check((await call(p1, 'POST', '/state-land', body)).s === 409, 'same category + overlapping khasra is flagged as a possible duplicate');
check((await call(tsd, 'POST', '/state-land', body)).s === 403, 'the Tehsildar does not enter holdings');
check((await call(py, 'GET', `/state-land/${c1.b._id}`)).s === 403, 'a Patwari of another tehsil cannot see it');
check((await call(p1, 'POST', '/state-land', { ...body, category: 'nonsense' })).s === 400, 'category must be from the list');

console.log('Two-step verification');
check((await call(tsd, 'POST', `/state-land/${c1.b._id}/approve`, {})).s === 400, 'cannot approve before the Girdawar verifies');
check((await call(p1, 'POST', `/state-land/${c1.b._id}/verify`, {})).s === 403, 'the Patwari cannot verify his own entry');
let g = null;
for (const t of girdawars) { const r = await call(t, 'POST', `/state-land/${c1.b._id}/verify`, {}); if (r.s === 200) { g = t; break; } }
check(g, 'the Girdawar of the area verifies');
const ap = await call(tsd, 'POST', `/state-land/${c1.b._id}/approve`, { remarks: 'ok' });
check(ap.s === 200 && ap.b.status === 'approved', 'the Tehsildar approves');
const ed = await call(p1, 'PATCH', `/state-land/${c1.b._id}`, { structures: 'Kacha rooms' });
check(ed.b.status === 'entered' && !ed.b.approvedBy, 'an edit after approval sends it back for verification');
const rt = await call(g, 'POST', `/state-land/${c1.b._id}/return`, { remarks: 'Check khasra 13' });
check(rt.b.status === 'returned', 'the Girdawar returns it with remarks');
check((await call(g, 'POST', `/state-land/${c1.b._id}/verify`, {})).s === 400, 'a returned holding must be corrected before verification');

console.log('Categories, litigation, documents');
const acq = await call(p1, 'POST', '/state-land', { unitId: mouzas[0]._id, land: { parcels: [{ khasras: ['301'] }] }, area: { kanal: 8 }, category: 'acquired', subType: 'For road', possession: 'department', record: { status: 'not_mutated' }, acquisition: { department: 'Communication & Works (Highways)', awardNo: 'AW-7', awardDate: '2015-04-01', compensation: 'yes' } });
check(acq.s === 201 && acq.b.acquisition.awardNo === 'AW-7' && acq.b.acres === 1, 'acquired land with award details (khasra-only)');
made.push(acq.b._id);
const lease = await call(p1, 'POST', '/state-land', { unitId: mouzas[0]._id, land: { parcels: [{ murabba: '50', khasras: ['1', '2'] }] }, area: { kanal: 16 }, category: 'scheme', subType: 'Temporary cultivation lease', possession: 'allottee', record: { status: 'mutated' }, allotment: { allottee: 'Test Lessee', leaseFrom: '2020-01-01', leaseTo: '2025-12-31' }, underLitigation: true });
check(lease.s === 201, 'leased land under a scheme');
made.push(lease.b._id);
const lit = await call(p1, 'POST', '/litigation', { unitId: mouzas[0]._id, caseType: 'Encroachment / state land', institutedOn: '2025-01-10', court: 'civil_court', courtCaseNo: 'SL-TEST-1', applicants: ['Test Lessee'], respondents: ['Province of Punjab'], land: { parcels: [{ murabba: '50', khasras: ['1'] }] } });
const cases = (await call(p1, 'GET', `/state-land/mouza-cases?unitId=${mouzas[0]._id}`)).b;
check(cases.some((x) => x._id === lit.b._id), 'the mouza\'s litigation cases are offered for linking');
await call(p1, 'PATCH', `/state-land/${lease.b._id}`, { litigationIds: [lit.b._id] });
const full = (await call(tsd, 'GET', `/state-land/${lease.b._id}`)).b;
check(full.cases[0]?.caseId === lit.b.caseId && full.holding.underLitigation, 'the linked case shows on the holding');
const d = await call(p1, 'POST', `/state-land/${c1.b._id}/docs`, { category: 'photo', title: 'Site', files: [{ name: 'a.png', mime: 'image/png', data: png }, { name: 'b.png', mime: 'image/png', data: png }] });
check(d.s === 201 && d.b.pages === 2, 'two site photos become one 2-page PDF');
check((await call(tsd, 'GET', `/state-land/${c1.b._id}/docs/${d.b._id}`)).b.subarray(0, 4).toString() === '%PDF', 'the document downloads');

console.log('Directory, summary, listing, Excel');
check((await call(tsd, 'GET', '/state-land?possession=any_encroached')).b.items.some((x) => x._id === c1.b._id), 'filter: encroached');
check((await call(tsd, 'GET', '/state-land?leases=expired')).b.items.some((x) => x._id === lease.b._id), 'filter: lease expired');
check((await call(tsd, 'GET', '/state-land?search=Test%20Encroacher')).b.items.some((x) => x._id === c1.b._id), 'search by encroacher name');
const sum = (await call(tsd, 'GET', '/state-land/summary')).b;
check(sum.totals.holdings >= 3 && sum.totals.encroachedAcres >= 0.25 && sum.totals.notMutated >= 1 && sum.totals.leasesExpired >= 1 && sum.totals.litigation >= 1, `summary: ${sum.totals.holdings} holdings, ${sum.totals.acres} acres, ${sum.totals.encroachedAcres} encroached`);
check(sum.byCategory.some((c) => c._id === 'acquired') && sum.byMouza.some((m) => m._id === mouzas[0]._id), 'category-wise and mouza-wise summary');
check((await call(g, 'POST', `/state-land/mouza/${mouzas[0]._id}`, { action: 'confirm' })).s === 400, 'the Girdawar cannot confirm before the Patwari marks it complete');
await call(p1, 'POST', `/state-land/mouza/${mouzas[0]._id}`, { action: 'complete' });
const cf = await call(g, 'POST', `/state-land/mouza/${mouzas[0]._id}`, { action: 'confirm' });
check(cf.s === 200 && cf.b.confirmed, 'the Patwari marks the mouza listing complete and the Girdawar confirms');
const x = await call(tsd, 'GET', '/state-land/export/xlsx');
const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.b);
const ws = wb.worksheets[0];
check(ws.getRow(1).values.includes('Holding ID') && ws.getCell(1, 1).fill?.fgColor?.argb === 'FF187A43' && ws.rowCount >= 4, 'the directory exports to formatted Excel');

// Clean up
await call(p1, 'POST', `/state-land/mouza/${mouzas[0]._id}`, { action: 'reopen' });
for (const id of made) await call(adm, 'DELETE', `/state-land/${id}`);
await call(adm, 'DELETE', `/litigation/${lit.b._id}`);
console.log(`\n${ok} checks passed`);
