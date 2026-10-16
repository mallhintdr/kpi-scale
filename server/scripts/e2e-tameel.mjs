// End-to-end check of Tameel (information requests) — Board of Revenue seed, API on :4000.
// Builds a sample Excel format, issues it to Hasilpur patwaris, fills / submits / returns / resubmits,
// checks the stored tehsil Excel, then deletes the test Tameel.
import ExcelJS from 'exceljs';

const API = process.env.API ?? 'http://localhost:4000/api';
let ok = 0;
const check = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); ok++; console.log('  ✓', m); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); const ct = r.headers.get('content-type') ?? ''; return { s: r.status, b: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
const login = async (e) => (await call(null, 'POST', '/auth/login', { email: e, password: 'Password123' })).b.accessToken;

// The government's format: a title line, then the header row, then a sample row
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('State Land');
ws.addRow(['Information regarding State Land']);
ws.addRow(['Mouza', 'Khasra No.', 'Area (Kanal)', 'Area (Marla)', 'Nature of Land', 'Under Encroachment (Yes/No)', 'Remarks']);
ws.addRow(['Sample', '123', '4', '10', 'Barani', 'No', '']);
const file = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

const adm = await login('admin@bwp.test');
const p1 = await login('patwari1.hasilpur@bwp.test');
const p2 = await login('patwari2.hasilpur@bwp.test');

console.log('Admin issues a Tameel');
const parsed = await call(adm, 'POST', '/tameel/parse', { file, name: 'state-land.xlsx' });
check(parsed.s === 200 && parsed.b.columns.length === 7 && parsed.b.columns[1].label === 'Khasra No.', `header row found under the title line: ${parsed.b.columns.map((c) => c.label).join(' | ')}`);
check((await call(p1, 'POST', '/tameel/parse', { file })).s === 403, 'a patwari cannot issue a Tameel');
const tehsil = (await call(adm, 'GET', '/org/units?search=Hasilpur')).b.find((u) => u.type === 'tehsil');
const created = await call(adm, 'POST', '/tameel', {
  title: 'State Land Information (test)', description: 'Provide every khasra of state land in your circle with its area and whether it is under encroachment.',
  deadline: new Date(Date.now() + 5 * 86_400_000).toISOString(), columns: parsed.b.columns, unitId: tehsil._id, posts: ['patwari'], sourceFile: 'state-land.xlsx',
});
check(created.s === 201, 'Tameel issued to the patwaris of Hasilpur tehsil');
const id = created.b._id;

console.log('Patwari fills the sheet');
const list = (await call(p1, 'GET', '/tameel')).b;
const mine = list.find((t) => t._id === id);
check(mine && mine.mine.length >= 1, `the patwari sees it (${mine.mine.map((m) => m.unitName).join(', ')}) with the instructions`);
const circle = mine.mine[0].unitId;
const c = Object.fromEntries(parsed.b.columns.map((x) => [x.label, x.key]));
let r = await call(p1, 'PUT', `/tameel/${id}/sheet/${circle}/rows`, { values: { [c['Mouza']]: 'Chak 12', [c['Khasra No.']]: '45/2', [c['Area (Kanal)']]: '8', [c['Nature of Land']]: 'Nehri', [c['Under Encroachment (Yes/No)']]: 'Yes' } });
r = await call(p1, 'PUT', `/tameel/${id}/sheet/${circle}/rows`, { values: { [c['Mouza']]: 'Chak 12', [c['Khasra No.']]: '46', [c['Area (Kanal)']]: '3' } });
r = await call(p1, 'PUT', `/tameel/${id}/sheet/${circle}/rows`, { values: { [c['Mouza']]: 'Wrong', [c['Khasra No.']]: 'x' } });
check(r.b.rows.length === 3, 'three rows added');
const row1 = r.b.rows[0]._id;
r = await call(p1, 'PUT', `/tameel/${id}/sheet/${circle}/rows/${row1}`, { values: { ...r.b.rows[0].values, [c['Remarks']]: 'FIR lodged' } });
check(r.b.rows[0].values[c['Remarks']] === 'FIR lodged', 'a row is edited and saved');
r = await call(p1, 'DELETE', `/tameel/${id}/sheet/${circle}/rows/${r.b.rows[2]._id}`);
check(r.b.rows.length === 2, 'a row is deleted');
check((await call(p2, 'PUT', `/tameel/${id}/sheet/${circle}/rows`, { values: { [c['Mouza']]: 'x' } })).s === 403, 'another patwari cannot edit this circle');
check((await call(p1, 'POST', `/tameel/${id}/sheet/${circle}/submit`)).s === 200, 'the patwari submits');
check((await call(p1, 'PUT', `/tameel/${id}/sheet/${circle}/rows`, { values: { [c['Mouza']]: 'late' } })).s === 400, 'after submitting the sheet is locked for him');

console.log('Tehsil Excel on the server');
let det = (await call(adm, 'GET', `/tameel/${id}`)).b;
check(det.files.length === 1 && det.files[0].rows === 2, `combined file kept for ${det.files[0]?.groupId?.name}: ${det.files[0]?.rows} rows`);
const xf = await call(adm, 'GET', `/tameel/${id}/files/${det.files[0].groupId._id}`);
const back = new ExcelJS.Workbook();
await back.xlsx.load(xf.b);
const hdr = back.worksheets[0].getRow(3).values.slice(1);
check(hdr.includes('Khasra No.') && hdr.includes('Unit') && back.worksheets[0].getRow(4).values.includes('45/2'), 'the Excel has the same headers and the submitted data');

console.log('Admin returns, patwari corrects and resubmits');
check((await call(adm, 'POST', `/tameel/${id}/sheet/${circle}/review`, { action: 'return', note: 'Add the area in marla for khasra 46' })).s === 200, 'admin returns it with a note');
const sh = (await call(p1, 'GET', `/tameel/${id}/sheet/${circle}`)).b;
check(sh.sheet.status === 'returned' && sh.canEdit && /marla/.test(sh.sheet.returnNote), 'the patwari sees the note and can edit again');
await call(p1, 'PUT', `/tameel/${id}/sheet/${circle}/rows/${sh.sheet.rows[1]._id}`, { values: { ...sh.sheet.rows[1].values, [c['Area (Marla)']]: '15' } });
await call(p1, 'POST', `/tameel/${id}/sheet/${circle}/submit`);
await call(adm, 'PUT', `/tameel/${id}/sheet/${circle}/rows/${sh.sheet.rows[0]._id}`, { values: { ...sh.sheet.rows[0].values, [c['Remarks']]: 'FIR lodged; case in court' } });
check((await call(adm, 'POST', `/tameel/${id}/sheet/${circle}/review`, { action: 'accept' })).b.status === 'accepted', 'admin edits a row himself and accepts');
det = (await call(adm, 'GET', `/tameel/${id}`)).b;
check(det.progress.find((p) => p.unitId === circle).status === 'accepted', 'progress table shows it accepted');
const all = await call(adm, 'GET', `/tameel/${id}/export`);
check(all.s === 200 && all.b.length > 1000, 'combined Excel of all units downloads');

await call(adm, 'DELETE', `/tameel/${id}`);
console.log(`\n${ok} checks passed (test Tameel deleted)`);
