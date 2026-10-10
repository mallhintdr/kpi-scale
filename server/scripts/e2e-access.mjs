// End-to-end check of access grants and the view setting (Board of Revenue seed, API on :4000).
// Creates grants and October test entries, then removes them.
const API = process.env.API ?? 'http://localhost:4000/api';
let ok = 0;
const check = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); ok++; console.log('  ✓', m); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); const x = await r.text(); return { s: r.status, b: x ? JSON.parse(x) : null }; };
const login = async (e) => { const r = await call(null, 'POST', '/auth/login', { email: e, password: 'Password123' }); if (r.s !== 200) throw new Error(`login ${e} ${r.s}`); return r.b.accessToken; };

const adm = await login('admin@bwp.test');
const p1 = await login('patwari1.hasilpur@bwp.test');
const p2 = await login('patwari2.hasilpur@bwp.test');
const me1 = (await call(p1, 'GET', '/rev/me')).b;
const circle = me1.charges[0].unit;
const tehsil = (await call(adm, 'GET', '/org/units?search=Hasilpur')).b.find((u) => u.type === 'tehsil');
const p1id = (await call(adm, 'GET', '/users?search=patwari1.hasilpur')).b.items[0]._id;
const p2id = (await call(adm, 'GET', '/users?search=patwari2.hasilpur')).b.items[0]._id;
const month = new Date().toISOString().slice(0, 7);
const created = [];

console.log('Enter right');
let sheet = (await call(p1, 'GET', `/rev/entries?unitId=${circle._id}&month=${month}`)).b;
check(!sheet.items.some((i) => i.head.code === 'MUT_FEE'), 'a patwari cannot enter Mutation Fee (a Wasil Baqi KPI) by post');
check((await call(p1, 'POST', '/org/access', { userId: p1id, unitId: tehsil._id, rights: ['enter'] })).s === 403, 'a patwari cannot give himself rights');
let g = await call(adm, 'POST', '/org/access', { userId: p1id, unitId: tehsil._id, rights: ['enter'], metrics: ['MUT_FEE'], note: 'test' });
check(g.s === 201, 'admin grants "Enter figures" for Mutation Fee on Hasilpur tehsil');
created.push(g.b._id);
sheet = (await call(p1, 'GET', `/rev/entries?unitId=${circle._id}&month=${month}`)).b;
check(sheet.items.some((i) => i.head.code === 'MUT_FEE') && !sheet.items.some((i) => i.head.code === 'STAMP'), 'now Mutation Fee appears — and only that extra KPI');
const put = await call(p1, 'PUT', '/rev/entries', { unitId: circle._id, month, items: [{ head: 'MUT_FEE', current: 12345, ref: 'GRANT-TEST' }] });
check(put.s === 200 && put.b.status === 'submitted', 'the entry is saved and waits for verification');

console.log('Verify right');
const before = (await call(p2, 'GET', '/rev/verify')).b;
check(!before.some((e) => e.ref === 'GRANT-TEST'), 'another patwari does not see it to verify');
g = await call(adm, 'POST', '/org/access', { userId: p2id, unitId: tehsil._id, rights: ['verify'], metrics: ['MUT_FEE'] });
created.push(g.b._id);
const queue = (await call(p2, 'GET', '/rev/verify')).b;
const mine = queue.find((e) => e.ref === 'GRANT-TEST');
check(mine, 'after "Verify" is granted, it is in their queue');
check((await call(p2, 'POST', '/rev/verify', { ids: [mine._id], action: 'verify' })).s === 200, 'they verify it');

console.log('Edit right');
let again = await call(p1, 'PUT', '/rev/entries', { unitId: circle._id, month, items: [{ head: 'MUT_FEE', current: 99999, ref: 'GRANT-TEST' }] });
check(again.s === 403, 'verified figures cannot be changed with only "Enter"');
await call(adm, 'PATCH', `/org/access/${created[0]}`, { rights: ['enter', 'edit'] });
again = await call(p1, 'PUT', '/rev/entries', { unitId: circle._id, month, items: [{ head: 'MUT_FEE', current: 99999, ref: 'GRANT-TEST' }] });
check(again.s === 200 && again.b.status === 'submitted', 'with "Edit verified figures" the correction is saved and goes back for verification');

console.log('View setting');
const otherTehsil = (await call(adm, 'GET', '/org/units?search=Yazman')).b.find((u) => u.type === 'tehsil');
check((await call(p1, 'GET', `/rev/units/${otherTehsil._id}`)).s === 200, 'by default everyone can view any area');
const bp = (await call(adm, 'GET', '/org/blueprint')).b;
const restricted = { ...bp.doc, access: { viewScope: 'jurisdiction' } };
check((await call(adm, 'PUT', '/org/blueprint', { doc: restricted, note: 'test: restrict viewing' })).s === 200, 'admin limits viewing to jurisdiction');
check((await call(p1, 'GET', `/rev/units/${otherTehsil._id}`)).s === 403, 'now another tehsil is hidden from the patwari');
check((await call(p1, 'GET', `/rev/units/${tehsil._id}`)).s === 200, 'his granted tehsil stays visible');
check((await call(p1, 'GET', `/rev/units/${me1.browseRoots[0]._id}`)).s === 200, 'the division above him stays visible (to see where he stands)');
g = await call(adm, 'POST', '/org/access', { userId: p1id, unitId: otherTehsil._id, rights: ['view'] });
created.push(g.b._id);
check((await call(p1, 'GET', `/rev/units/${otherTehsil._id}`)).s === 200, 'a "View" grant opens that tehsil to him');
await call(adm, 'PUT', '/org/blueprint', { doc: bp.doc, note: 'test: restore viewing' });

console.log('Effective rights');
const eff = (await call(adm, 'GET', `/org/access/user/${p1id}`)).b;
check(eff.fromPosts.length >= 1 && eff.grants.length === 2, `admin sees his posting rights (${eff.fromPosts[0].rights.join(', ')}) and 2 direct grants`);

// Clean up
for (const id of created) await call(adm, 'DELETE', `/org/access/${id}`);
console.log(`\n${ok} checks passed (grants removed)`);
