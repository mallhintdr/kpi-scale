// Verifies pre-computed period stats against the live scoring engine and timing.
// Usage: node scripts/check-rollups.mjs   (API on :4000, Board of Revenue seed)
const API = process.env.API ?? 'http://localhost:4000/api';
const login = async (email) => (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Password123' }) })).json()).accessToken;
const t = await login('admin@bwp.test');
const h = { authorization: `Bearer ${t}`, 'content-type': 'application/json' };
const get = async (p) => (await fetch(API + p, { headers: h })).json();
let ok = 0;
const check = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); ok++; console.log('  ✓', m); };

const me = await get('/rev/me');
const meta = await get('/rev/meta');
const fy = meta.currentFy;
const div = me.browseRoots[0]._id;

// Build (manual trigger) and wait until the year document exists
await fetch(`${API}/rev/stats/rebuild`, { method: 'POST', headers: h, body: JSON.stringify({ fy }) });
let year;
for (let i = 0; i < 120; i++) {
  year = await get(`/rev/stats?unitId=${div}&period=y&fy=${fy}`);
  if (!year.building && year.builtAt) break;
  await new Promise((r) => setTimeout(r, 500));
}
check(year.builtAt, `rollups built for FY ${fy}`);

// Year rollup must equal the live engine for the division and for every district
const units = [{ _id: div, name: 'division' }, ...(await get(`/rev/units/${div}/descendants?type=district`))];
for (const u of units) {
  const live = await get(`/rev/units/${u._id}?fy=${fy}`);
  const y = (await get(`/rev/stats?unitId=${u._id}&period=y&fy=${fy}`)).rows[0];
  for (const r of live.revenue) {
    const c = y.heads[r.code];
    if (!r.target && !r.collected) continue;
    if (!c || c.done !== r.collected || (c.of ?? 0) !== Math.round(r.target)) throw new Error(`${u.name} ${r.code}: rollup ${JSON.stringify(c)} vs live ${r.collected}/${r.target}`);
  }
  for (const k of live.cases) {
    const c = y.heads[k.code];
    if (!k.opening && !k.received) continue;
    if (!c || c.done !== k.disposed || c.of !== k.opening + k.received) throw new Error(`${u.name} ${k.code}: rollup ${JSON.stringify(c)} vs live ${k.disposed}/${k.opening + k.received}`);
  }
  check(true, `${u.name}: year figures match the live engine for every KPI`);
}

// Months add up to quarters, halves and the year
const sum = (rows, code) => rows.reduce((s, r) => s + (r.heads[code]?.done ?? 0), 0);
const months = (await get(`/rev/stats?unitId=${div}&period=m&fy=${fy}`)).rows;
const quarters = (await get(`/rev/stats?unitId=${div}&period=q&fy=${fy}`)).rows;
const halves = (await get(`/rev/stats?unitId=${div}&period=h&fy=${fy}`)).rows;
for (const code of ['WR_KHARIF', 'MUT_FEE', 'KMI']) {
  check(sum(months, code) === year.rows[0].heads[code].done && sum(quarters, code) === sum(months, code) && sum(halves, code) === sum(months, code), `${code}: months = quarters = halves = year`);
}

// Weeks and 15-day periods exist and children rank for a period
const weeks = (await get(`/rev/stats?unitId=${div}&period=w&fy=${fy}`)).rows;
const fort = (await get(`/rev/stats?unitId=${div}&period=f&fy=${fy}`)).rows;
check(weeks.length > 0 && fort.length > 0, `${weeks.length} weeks and ${fort.length} fifteen-day periods so far this year`);
const kids = await get(`/rev/stats/children?unitId=${div}&period=m&key=${months[0].key}&fy=${fy}`);
check(kids.items.length === 3, `districts ranked for ${kids.label}`);

// Speed: series reads
const time = async (p) => { const s = performance.now(); await get(p); return Math.round(performance.now() - s); };
const ts = [];
for (const p of ['w', 'f', 'm', 'q', 'h', 'y']) ts.push(`${p} ${await time(`/rev/stats?unitId=${div}&period=${p}&fy=${fy}`)}ms`);
console.log('  read times (division):', ts.join(' · '));
console.log(`\n${ok} checks passed`);
