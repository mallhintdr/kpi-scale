// End-to-end check of the multi-organisation flow against a running API:
// super-admin creates an organisation from a template → its admin imports hierarchy, staff and
// postings → targets, entries, verification → scores; and the two organisations stay isolated.
const API = process.env.API ?? 'http://localhost:4000/api';
let ok = 0;
const check = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); ok++; console.log('  ✓', msg); };

async function call(token, method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const login = async (email, password, tenantSlug) => {
  const r = await call(null, 'POST', '/auth/login', { email, password, tenantSlug });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
};
const waitImport = async (t, id) => {
  for (let i = 0; i < 60; i++) {
    const r = await call(t, 'GET', `/org/imports/${id}`);
    if (['done', 'failed'].includes(r.body.status)) return r.body;
    await new Promise((s) => setTimeout(s, 250));
  }
  throw new Error('import timed out');
};

const stamp = Date.now().toString(36);
console.log('Platform');
const sup = await login('super@kpi.local', 'SuperAdmin123');
const tpls = await call(sup, 'GET', '/platform/templates');
check(tpls.status === 200 && tpls.body.some((t) => t.key === 'sales_company'), 'super-admin lists templates');
const created = await call(sup, 'POST', '/platform/tenants', {
  name: `Acme Marketing ${stamp}`, slug: `acme-${stamp}`, template: 'sales_company', plan: 'pro',
  admin: { name: 'Acme Admin', email: `admin@acme-${stamp}.test`, password: 'AcmeAdmin123' },
});
check(created.status === 201, 'organisation created from the Sales & Marketing template');
const bor = await login('admin@bwp.test', 'Password123');
check((await call(bor, 'GET', '/platform/tenants')).status === 403, 'an organisation admin cannot reach the platform console');

console.log('Organisation admin');
const adm = await login(`admin@acme-${stamp}.test`, 'AcmeAdmin123');
const meta = (await call(adm, 'GET', '/rev/meta')).body;
check(meta.levels.map((l) => l.key).join('>') === 'company>region>branch>territory', 'hierarchy comes from the blueprint');
check(meta.calendar.fyStartMonth === 1 && /^\d{4}$/.test(meta.currentFy), `calendar-year financial year (${meta.currentFy})`);

const units = `level,name,code,parent_code
company,Acme,ACME,
region,North,N,ACME
region,South,S,ACME
branch,Lahore,LHR,N
branch,Karachi,KHI,S
territory,Gulberg,LHR-1,LHR
territory,DHA,LHR-2,LHR
territory,Clifton,KHI-1,KHI
territory,Bad row,XX,NOPE`;
let run = await call(adm, 'POST', '/org/imports', { kind: 'units', csv: units, dryRun: true });
let res = await waitImport(adm, run.body._id);
check(res.status === 'done' && res.created === 8 && res.errors.length === 1, `dry run: 8 units valid, 1 error ("${res.errors[0]?.message}")`);
check((await call(adm, 'GET', '/org/units')).body.length === 0, 'dry run wrote nothing');
run = await call(adm, 'POST', '/org/imports', { kind: 'units', csv: units.split('\n').slice(0, -1).join('\n'), dryRun: false });
res = await waitImport(adm, run.body._id);
check(res.created === 8 && !res.errors.length, 'units imported');

const users = `name,email,role,designation
Sara Rep,sara@acme-${stamp}.test,employee,Sales Representative
Omar Rep,omar@acme-${stamp}.test,employee,Sales Representative
Hina Rep,hina@acme-${stamp}.test,employee,Sales Representative
Bilal BM,bilal@acme-${stamp}.test,manager,Branch Manager
Asma Admin,asma@acme-${stamp}.test,employee,Sales Administrator`;
res = await waitImport(adm, (await call(adm, 'POST', '/org/imports', { kind: 'users', csv: users, dryRun: false, defaultPassword: 'Welcome123' })).body._id);
check(res.created === 5, 'staff imported');
const charges = `email,unit_code,post
sara@acme-${stamp}.test,LHR-1,sales_rep
omar@acme-${stamp}.test,LHR-2,sales_rep
hina@acme-${stamp}.test,KHI-1,sales_rep
bilal@acme-${stamp}.test,LHR,branch_manager
asma@acme-${stamp}.test,LHR,sales_admin
omar@acme-${stamp}.test,LHR,branch_manager
sara@acme-${stamp}.test,N,sales_rep`;
res = await waitImport(adm, (await call(adm, 'POST', '/org/imports', { kind: 'charges', csv: charges, dryRun: false })).body._id);
check(res.created === 5 && res.errors.length === 2, `postings imported; blueprint rules rejected 2 (${res.errors.map((e) => e.message).join(' | ')})`);

console.log('Targets, entries, verification, scores');
const asma = await login(`asma@acme-${stamp}.test`, 'Welcome123');
const lhr = (await call(adm, 'GET', '/org/units?search=Lahore')).body[0];
const grid = await call(asma, 'GET', `/rev/targets?tehsilId=${lhr._id}&fy=${meta.currentFy}&head=NEW_SALES`);
check(grid.status === 200 && grid.body.canEdit && grid.body.rows.length === 2, 'sales admin opens the Lahore target grid (2 territories)');
const put = await call(asma, 'PUT', '/rev/targets', { tehsilId: lhr._id, fy: meta.currentFy, head: 'NEW_SALES', rows: grid.body.rows.map((r, i) => ({ unitId: r.unitId, target: (i + 1) * 1_000_000, arrearDemand: 0, opening: 0 })) });
check(put.status === 200 && put.body.saved === 2, 'targets saved');
const sara = await login(`sara@acme-${stamp}.test`, 'Welcome123');
const gulberg = grid.body.rows.find((r) => r.label === 'Gulberg').unitId;
const month = new Date().toISOString().slice(0, 7);
const sheet = await call(sara, 'GET', `/rev/entries?unitId=${gulberg}&month=${month}`);
if (process.env.DEBUG) console.log(sheet.status, JSON.stringify(sheet.body).slice(0, 600));
check(sheet.status === 200 && sheet.body.items.some((i) => i.head.code === 'NEW_SALES') && !sheet.body.items.some((i) => i.head.code === 'COLLECTIONS'), 'rep sees only the KPIs her post may enter');
const entry = await call(sara, 'PUT', '/rev/entries', { unitId: gulberg, month, items: [{ head: 'NEW_SALES', current: 400_000 }] });
check(entry.body.status === 'submitted', 'rep entry waits for verification');
const before = (await call(sara, 'GET', `/rev/my-score?fy=${meta.currentFy}`)).body.items[0];
check(before.heads.NEW_SALES?.done === 0 || before.heads.NEW_SALES?.done === undefined || before.heads.NEW_SALES.done === 0, 'unverified figures do not count');
const queue = await call(asma, 'GET', '/rev/verify');
check(queue.body.length === 1 && queue.body[0].head === 'NEW_SALES', 'sales admin sees it in the verification queue');
check((await call(sara, 'POST', '/rev/verify', { ids: [queue.body[0]._id], action: 'verify' })).status === 403, 'the rep cannot verify her own figures');
await call(asma, 'POST', '/rev/verify', { ids: [queue.body[0]._id], action: 'verify' });
const after = (await call(sara, 'GET', `/rev/my-score?fy=${meta.currentFy}`)).body.items[0];
console.log('    ', JSON.stringify(after.heads.NEW_SALES));
check(after.heads.NEW_SALES.done === 400_000 && after.heads.NEW_SALES.pct === 20, 'after verification: 400k of 2M = 20%, score updates immediately (cache follows data version)');
const league = (await call(adm, 'GET', `/rev/league?unitId=${lhr._id}&post=sales_rep&fy=${meta.currentFy}`)).body;
check(league.items.length === 2 && league.items[0].user.name === 'Sara Rep', 'league of sales reps in Lahore');

console.log('Blueprint changes');
const bpNow = (await call(adm, 'GET', '/org/blueprint')).body;
const doc = structuredClone(bpNow.doc);
doc.metrics.push({ code: 'DEMOS', name: 'Product demos', group: 'Pipeline', block: 'pipeline', unit: 'count', level: 'territory', enterPosts: ['sales_rep'], verifyPosts: ['sales_admin'] });
let save = await call(adm, 'PUT', '/org/blueprint', { doc, note: 'Add demos KPI' });
check(save.status === 200 && save.body.version === bpNow.version + 1, `KPI added (version ${save.body.version})`);
check((await call(sara, 'GET', '/rev/meta')).body.heads.some((h) => h.code === 'DEMOS'), 'new KPI visible to staff at once');
const bad = structuredClone(doc);
bad.metrics = bad.metrics.filter((m) => m.code !== 'NEW_SALES');
save = await call(adm, 'PUT', '/org/blueprint', { doc: bad });
check(save.status === 409, 'removing a KPI with data is refused (retire it instead)');
const bad2 = structuredClone(doc);
bad2.metrics[0].verifyPosts = ['nobody'];
save = await call(adm, 'PUT', '/org/blueprint', { doc: bad2 });
check(save.status === 400 && save.body.error.details.some((d) => d.includes('nobody')), 'invalid blueprint rejected with reasons');
check((await call(sara, 'PUT', '/org/blueprint', { doc })).status === 403, 'staff cannot edit the blueprint');

console.log('Isolation');
const borMeta = (await call(bor, 'GET', '/rev/meta')).body;
check(borMeta.levels[0].key === 'division' && !borMeta.heads.some((h) => h.code === 'NEW_SALES'), 'Board of Revenue keeps its own blueprint');
check((await call(bor, 'GET', `/rev/units/${lhr._id}`)).status === 404, 'another organisation\'s unit is invisible');
check((await call(sup, 'PATCH', `/platform/tenants/${created.body.tenant._id}`, { status: 'suspended' })).status === 200, 'super-admin suspends the organisation');
check((await call(sara, 'GET', '/rev/meta')).status === 403, 'suspended organisation is locked out');
await call(sup, 'PATCH', `/platform/tenants/${created.body.tenant._id}`, { status: 'active' });
console.log(`\n${ok} checks passed`);
