// Regression baseline: captures every score the API produces for the seeded organisation.
// Usage: node scripts/baseline.mjs <out.json>   (API on :4000, seeded with npm run seed)
import fs from 'node:fs';

const API = process.env.API ?? 'http://localhost:4000/api';
const out = process.argv[2] ?? 'baseline.json';
const LOGINS = ['admin@bwp.test', 'tehsildar.hasilpur@bwp.test', 'patwari1.hasilpur@bwp.test', 'girdawar1.hasilpur@bwp.test', 'commissioner@bwp.test'];

async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Password123' }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return (await r.json()).accessToken;
}
const getter = (token) => async (path) => {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return { status: r.status };
  return r.json();
};

// Keep only the figures that matter (drops ids / names that may change shape)
const pickUnit = (u) => ({
  score: u.score, band: u.band, blocks: u.blocks, totals: u.totals, arrears: u.arrears, audit: u.audit, tasks: u.tasks,
  revenue: u.revenue?.map((r) => [r.code, r.target, r.collected, r.arrearDemand, r.arrearCollected, r.pendingVerification]),
  cases: u.cases?.map((c) => [c.code, c.opening, c.received, c.disposed]),
  children: u.children?.map((c) => [c.name, c.score, c.target, c.collected]),
});
const pickLeague = (l) => l.items?.map((x) => [x.user?.name, x.charges?.join(','), x.score, x.target, x.collected, JSON.stringify(x.heads)]);

const res = {};
const adminGet = getter(await login('admin@bwp.test'));
const me = await adminGet('/rev/me');
const fy = (await adminGet('/rev/meta')).currentFy;
const division = me.browseRoots[0];
res.fy = fy;
const units = [division, ...(await adminGet(`/rev/units/${division._id}/descendants?type=district`)), ...(await adminGet(`/rev/units/${division._id}/descendants?type=tehsil`))];
const quals = await adminGet(`/rev/units/${division._id}/descendants?type=qanungoi`);
units.push(...quals.slice(0, 15));
for (const u of units) res[`unit:${u.name}`] = pickUnit(await adminGet(`/rev/units/${u._id}?fy=${fy}`));
for (const post of ['patwari', 'girdawar', 'tehsildar', 'naib_tehsildar', 'ac', 'dc', 'adc_rev', 'commissioner']) {
  res[`league:${post}`] = pickLeague(await adminGet(`/rev/league?fy=${fy}&unitId=${division._id}&post=${post}`));
}
for (const type of ['district', 'tehsil', 'qanungoi']) {
  const c = await adminGet(`/rev/compare?fy=${fy}&unitId=${division._id}&type=${type}`);
  res[`compare:${type}`] = c.items?.map((i) => [i.name, JSON.stringify(i.heads)]);
}
for (const email of LOGINS) {
  const g = getter(await login(email));
  res[`my:${email}`] = (await g(`/rev/my-score?fy=${fy}`)).items?.map((i) => [i.post, i.score, i.target, i.collected, JSON.stringify(i.heads)]);
}
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(`wrote ${out}: ${Object.keys(res).length} keys`);
