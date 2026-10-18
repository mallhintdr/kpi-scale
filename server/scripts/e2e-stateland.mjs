// End-to-end check of the State Land Directory, khasra-wise (Board of Revenue seed, API on :4000).
// A Patwari enters killas (and sub-killas) of murabbas in one go, the Girdawar verifies, the Tehsildar
// approves (one by one and in bulk); edits go back for verification; admin-managed type lists; litigation
// link, documents, mouza listing, summary and Excel; then removes the test data.
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

console.log('Lists');
const meta = (await call(p1, 'GET', '/state-land/meta')).b;
check(meta.canEnter && !meta.canVerify && meta.categories.some((c) => c.label === 'Provincial Government'), 'the Patwari can enter; "Provincial Government" is a category');
check(meta.categories.find((c) => c.key === 'scheme').subTypes.includes('Lamberdari scheme'), 'the Lamberdari scheme is a sub-type');
const mouzas = (await call(p1, 'GET', '/state-land/mouzas')).b;
const mouza = mouzas[0]._id;
const details = { category: 'provincial', subType: 'Banjar qadeem', ownerRecord: 'Sarkar Daulatmadar', custodian: 'Provincial Government', kasht: { type: 'Banjar (no cultivator)' }, site: { possessedBy: 'vacant', nature: ['Tibba (sand dune)'] }, record: { status: 'mutated', mutationNos: '1234' } };
check((await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '999', killas: [{ killa: 1, area: { kanal: 8 } }] }], details: { ...details, subType: 'Something new' } })).s === 400, 'a sub-type not in the list is refused (ask the admin)');

console.log('Entry: murabba → killas → sub-killas');
const batch = await call(p1, 'POST', '/state-land/batch', {
  unitId: mouza, khewat: '112', khatauni: '140',
  murabbas: [
    { murabba: '999', killas: [{ killa: 1, area: { kanal: 8 } }, { killa: 2, area: { kanal: 8 } }, { killa: 3, subKilla: '1', area: { kanal: 4 } }, { killa: 3, subKilla: '2', area: { kanal: 3, marla: 19, feet: 100 } }] },
    { murabba: '998', khewat: '113', killas: [{ killa: 25, area: { kanal: 7, marla: 10 } }] },
  ],
  details,
});
check(batch.s === 201 && batch.b.created === 5, `5 khasras entered in one go (${batch.b.acres} acres)`);
const rows = (await call(adm, 'GET', `/state-land?unitId=${mouza}`)).b.items.filter((x) => ['999', '998'].includes(x.murabba));
made.push(...rows.map((r) => r._id));
const k31 = rows.find((r) => r.khasraNo === '999/3/1');
check(k31 && rows.some((r) => r.khasraNo === '999/3/2') && rows.some((r) => r.khasraNo === '998/25'), 'khasra numbers murabba/killa/sub-killa (45/3/1)');
const ur = await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '993', killas: [{ killa: 9, subKilla: 'الف', area: { kanal: 4 } }, { killa: 9, subKilla: 'ب', area: { kanal: 4 } }] }], details });
check(ur.s === 201, 'sub-killas named in Urdu (993/9/الف, 993/9/ب)');
made.push(...ur.b.ids);
check((await call(adm, 'GET', `/state-land/${ur.b.ids[0]}`)).b.khasra.khasraNo === '993/9/الف', 'the Urdu sub-killa name is kept as written');
check(rows.find((r) => r.khasraNo === '998/25').khewat === '113' && rows.find((r) => r.khasraNo === '999/1').khewat === '112', 'khewat given once, overridden for one murabba');
check(Math.abs(rows.find((r) => r.khasraNo === '999/3/2').acres - (3 / 8 + 19 / 160 + 100 / 43560)) < 1e-4, 'area of each khasra in kanal / marla / feet → acres');
check((await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '999', killas: [{ killa: 2, area: { kanal: 8 } }] }], details })).s === 409, 'a khasra already entered is refused');
check((await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '999', killas: [{ killa: 1, subKilla: '1', area: { kanal: 4 } }] }], details })).s === 409, 'a sub-killa of a killa entered whole is refused');
check((await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '997', killas: [{ killa: 4, area: { kanal: 8 } }, { killa: 4, subKilla: '1', area: { kanal: 2 } }] }], details })).s === 400, 'a killa cannot be both whole and split');
check((await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '997', killas: [{ killa: 5, area: {} }] }], details })).s === 400, 'every khasra needs an area');
const taken = (await call(p1, 'GET', `/state-land/taken?unitId=${mouza}&murabba=999`)).b;
check(taken.length === 4, 'the picker knows which killas are already entered');
check((await call(tsd, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '996', killas: [{ killa: 1, area: { kanal: 8 } }] }], details })).s === 403, 'the Tehsildar does not enter state land');
check((await call(py, 'GET', `/state-land/${k31._id}`)).s === 403, 'a Patwari of another tehsil cannot see it');

console.log('Verification');
check((await call(tsd, 'POST', `/state-land/${k31._id}/approve`, {})).s === 400, 'cannot approve before the Girdawar verifies');
let g = null;
for (const t of girdawars) { if ((await call(t, 'POST', `/state-land/${k31._id}/verify`, {})).s === 200) { g = t; break; } }
check(g, 'the Girdawar of the area verifies one khasra');
const bv = (await call(g, 'POST', '/state-land/bulk', { ids: made, action: 'verify' })).b;
check(bv.done >= 4 && bv.skipped.length >= 1, 'the Girdawar verifies the rest in bulk (the verified one is skipped)');
const ba = (await call(tsd, 'POST', '/state-land/bulk', { ids: made, action: 'approve' })).b;
check(ba.done >= 5, 'the Tehsildar approves them in bulk');
const ed = (await call(p1, 'PATCH', `/state-land/${k31._id}`, { area: { kanal: 4, marla: 2 } })).b;
check(ed.status === 'entered' && ed.acres === 0.5125, 'editing an approved khasra sends it back for verification');
check((await call(g, 'POST', `/state-land/${k31._id}/return`, { remarks: 'Check area' })).b.status === 'returned', 'the Girdawar returns it with remarks');
check((await call(p1, 'DELETE', `/state-land/${rows.find((r) => r.khasraNo === '999/1')._id}`)).s === 403, 'the Patwari cannot remove an approved khasra');

console.log('Encroachment, allotment, litigation, documents');
const enc = await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '995', killas: [{ killa: 7, area: { kanal: 8 }, encroachedArea: { kanal: 2 } }, { killa: 8, area: { kanal: 8 }, encroachedArea: { kanal: 1 } }] }], details: { ...details, site: { possessedBy: 'unauthorised', names: ['Test Encroacher'], nature: ['Cultivated (crop)'] }, encroachment: { nature: 'Cultivation', action: 'Notice issued' } } });
check(enc.s === 201, 'partly encroached killas with their own encroached areas');
const encRows = (await call(adm, 'GET', `/state-land?unitId=${mouza}&search=995`)).b.items;
made.push(...encRows.map((r) => r._id));
check(encRows.reduce((s, r) => s + r.encroachment.acres, 0) === 0.375 && encRows.every((r) => r.possession === 'part_encroached'), 'unauthorised possession at site → partly encroached, 2 K + 1 K = 0.375 acres');
check((await call(adm, 'GET', `/state-land/${encRows[0]._id}`)).b.khasra.encroachment.encroachers[0] === 'Test Encroacher', 'the person in possession is recorded as the encroacher');
const mixed = await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '992', killas: [{ killa: 1, area: { kanal: 8 } }, { killa: 2, area: { kanal: 8 }, possessedBy: 'unauthorised', nature: ['Structure (house / shop / wall)'] }] }], details: { ...details, site: { ...details.site, names: ['Squatter X'] } } });
check(mixed.s === 201, 'one entry: killa 1 vacant tibba (as below), killa 2 encroached with a structure (per killa)');
made.push(...mixed.b.ids);
const mx = (await call(adm, 'GET', `/state-land?unitId=${mouza}&search=992`)).b.items;
check(mx.find((r) => r.khasraNo === '992/1').possession === 'vacant' && mx.find((r) => r.khasraNo === '992/2').possession === 'encroached' && mx.find((r) => r.khasraNo === '992/2').site.nature[0].startsWith('Structure'), 'per-killa possession and nature are kept');
check((await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '991', killas: [{ killa: 1, area: { kanal: 8 } }] }], details: { ...details, site: { possessedBy: 'vacant', nature: [] } } })).s === 400, 'both parts are required (nature at site missing → refused)');
const lam = await call(p1, 'POST', '/state-land/batch', { unitId: mouza, murabbas: [{ murabba: '994', killas: [{ killa: 1, area: { kanal: 8 } }] }], details: { ...details, category: 'scheme', subType: 'Lamberdari scheme', kasht: { type: 'Allottee', names: ['Test Lamberdar'] }, site: { possessedBy: 'recorded', nature: ['Cultivated (crop)'] }, allotment: { scheme: 'Lamberdari scheme', allottee: 'Test Lamberdar', leaseTo: '2024-06-30' }, underLitigation: true } });
check(lam.s === 201, 'land under the Lamberdari scheme');
made.push(...lam.b.ids);
const lit = await call(p1, 'POST', '/litigation', { unitId: mouza, caseType: 'Encroachment / state land', institutedOn: '2025-01-10', court: 'civil_court', courtCaseNo: 'SL-TEST-2', applicants: ['Test Lamberdar'], respondents: ['Province of Punjab'], land: { parcels: [{ murabba: '994', khasras: ['1'] }] } });
await call(p1, 'PATCH', `/state-land/${lam.b.ids[0]}`, { litigationIds: [lit.b._id] });
check((await call(tsd, 'GET', `/state-land/${lam.b.ids[0]}`)).b.cases[0]?.caseId === lit.b.caseId, 'the linked litigation case shows on the khasra');
const d = await call(p1, 'POST', `/state-land/${k31._id}/docs`, { category: 'photo', files: [{ name: 'a.png', mime: 'image/png', data: png }] });
check(d.s === 201, 'a document is attached to a khasra');

console.log('Settings, summary, listing, Excel');
check((await call(p1, 'PUT', '/state-land/settings', { categories: meta.categories, departments: meta.departments })).s === 403, 'only the admin edits the lists');
const cats = meta.categories.map((c) => (c.key === 'provincial' ? { ...c, subTypes: [...c.subTypes, 'Test new sub-type'] } : c));
check((await call(adm, 'PUT', '/state-land/settings', { categories: cats, departments: meta.departments })).b.categories.find((c) => c.key === 'provincial').subTypes.includes('Test new sub-type'), 'the admin adds a sub-type for everyone');
check((await call(adm, 'PUT', '/state-land/settings', { categories: cats.filter((c) => c.key !== 'provincial'), departments: meta.departments })).s === 400, 'a category in use cannot be removed');
await call(adm, 'PUT', '/state-land/settings', { categories: meta.categories, departments: meta.departments });
check((await call(tsd, 'GET', '/state-land?search=999/3')).b.items.length === 2, 'search by khasra number (999/3 finds both sub-killas)');
const sum = (await call(tsd, 'GET', '/state-land/summary')).b;
check(sum.totals.khasras >= 8 && sum.totals.encroachedAcres >= 0.375 && sum.totals.leasesExpired >= 1 && sum.byMouza.some((m) => m._id === mouza && m.murabbas >= 4), `summary: ${sum.totals.khasras} khasras, ${sum.totals.acres} acres`);
await call(p1, 'POST', `/state-land/mouza/${mouza}`, { action: 'complete' });
check((await call(g, 'POST', `/state-land/mouza/${mouza}`, { action: 'confirm' })).b.confirmed, 'mouza listing: Patwari marks complete, Girdawar confirms');
const x = await call(tsd, 'GET', '/state-land/export/xlsx');
const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.b);
const head = wb.worksheets[0].getRow(1).values;
check(head.includes('Murabba / Mustateel') && head.includes('Killa') && head.includes('Sub-killa') && wb.worksheets[0].getCell(1, 1).fill?.fgColor?.argb === 'FF187A43', 'khasra-wise Excel with green headers');

// Clean up
await call(p1, 'POST', `/state-land/mouza/${mouza}`, { action: 'reopen' });
for (const id of made) await call(adm, 'DELETE', `/state-land/${id}`);
await call(adm, 'DELETE', `/litigation/${lit.b._id}`);
console.log(`\n${ok} checks passed`);
