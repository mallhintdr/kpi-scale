// End-to-end check of WhatsApp coaching in mock mode (Board of Revenue seed, API on :4000).
// Enables coaching, previews and sends each slot to one patwari, simulates replies, runs the
// escalation ladder over several days, then restores the settings.
const API = process.env.API ?? 'http://localhost:4000/api';
let ok = 0;
const check = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); ok++; console.log('  ✓', m); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); const x = await r.text(); return { s: r.status, b: x ? JSON.parse(x) : null }; };
const login = async (e) => (await call(null, 'POST', '/auth/login', { email: e, password: 'Password123' })).b.accessToken;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const adm = await login('admin@bwp.test');
const p1 = (await call(adm, 'GET', '/users?search=patwari1.hasilpur')).b.items[0];
const original = (await call(adm, 'GET', '/org/whatsapp')).b;
const settings = {
  enabled: true, language: 'english', morningAt: '08:30', followupsAt: ['11:30', '14:30'], eveningAt: '18:00', workdays: [1, 2, 3, 4, 5, 6], holidays: [],
  audience: 'scored', allowOptOut: false, escalation: { enabled: true, paceGap: 15, overdueTasks: 3, days: 2, notifySupervisor: true },
};
check((await call(adm, 'PUT', '/org/whatsapp', settings)).s === 200, 'admin turns on daily coaching');
const info = (await call(adm, 'GET', '/org/whatsapp')).b;
check(info.mode === 'mock' && info.stats.recipients > 0, `${info.stats.recipients} staff will receive messages (mode: ${info.mode})`);

console.log('Messages');
for (const slot of ['morning', 'followup', 'evening']) {
  const p = await call(adm, 'GET', `/org/whatsapp/preview?userId=${p1._id}&slot=${slot}`);
  check(p.s === 200 && p.b.text.length > 40, `${slot} preview:\n${p.b.text.split('\n').map((l) => '      │ ' + l).join('\n')}`);
}
const sent = await call(adm, 'POST', '/org/whatsapp/send', { slot: 'morning', userId: p1._id });
check(sent.b.queued === 1, 'morning message sent to the patwari');
await wait(1500);
let log = (await call(adm, 'GET', `/org/whatsapp/messages?userId=${p1._id}`)).b;
check(log.items.some((m) => m.kind === 'morning' && m.status === 'sent'), 'it is logged as sent');

console.log('Replies');
await call(adm, 'POST', '/org/whatsapp/simulate', { userId: p1._id, text: 'status' });
await call(adm, 'POST', '/org/whatsapp/simulate', { userId: p1._id, text: 'tasks' });
await call(adm, 'POST', '/org/whatsapp/simulate', { userId: p1._id, text: 'hello' });
await wait(4000);
log = (await call(adm, 'GET', `/org/whatsapp/messages?userId=${p1._id}`)).b;
check(log.items.filter((m) => m.direction === 'in').length >= 3, 'his replies are recorded');
check(log.items.filter((m) => m.kind === 'reply').length >= 3, 'each reply is answered (status, task list, help)');

console.log('Escalation ladder');
// The patwari is behind the year's pace in the seed data, so each evening counts as a "behind" day.
const before = (await call(adm, 'GET', '/org/whatsapp/escalations')).b.find((x) => x.userId?._id === p1._id);
await call(adm, 'POST', `/org/whatsapp/escalations/${p1._id}/reset`);
const evenings = [];
for (const day of ['2099-01-01', '2099-01-02', '2099-01-03', '2099-01-04']) {
  // run the evening slot for one person on successive (test) days
  const r = await call(adm, 'POST', '/org/whatsapp/send', { slot: 'evening', userId: p1._id, day });
  evenings.push(r.b.queued);
}
await wait(1500);
const st = (await call(adm, 'GET', '/org/whatsapp/escalations')).b.find((x) => x.userId?._id === p1._id);
check(st && st.history.length >= 1, `escalation recorded (now level ${st?.level}, ${st?.behindDays} day(s) behind: ${st?.lastReason ?? 'n/a'})`);
void before;
log = (await call(adm, 'GET', `/org/whatsapp/messages?userId=${p1._id}&kind=evening`)).b;
const finalText = log.items.find((m) => /Final Warning/.test(m.text))?.text ?? '';
check(/competent authority may initiate administrative and\/or disciplinary proceedings/.test(finalText), `final warning is in formal language:\n${finalText.split('────────')[1]?.trim().split('\n').map((l) => '      │ ' + l).join('\n')}`);

console.log('Withdrawal and leave');
check((await call(adm, 'POST', `/org/whatsapp/escalations/${p1._id}/reset`, { reason: 'On approved leave', inform: true })).b.withdrawn, 'admin withdraws the warning');
await wait(1200);
log = (await call(adm, 'GET', `/org/whatsapp/messages?userId=${p1._id}`)).b;
check(log.items.some((m) => m.kind === 'notice' && /Warning Withdrawn/.test(m.text)), 'the person receives a formal withdrawal notice');
check((await call(adm, 'PUT', `/org/whatsapp/leave/${p1._id}`, { from: '2099-02-01', until: '2099-02-10', note: 'Earned leave' })).s === 200, 'admin marks him on leave 1–10 Feb');
const onLeaveRun = await call(adm, 'POST', '/org/whatsapp/send', { slot: 'evening', userId: p1._id, day: '2099-02-05' });
check(onLeaveRun.b.queued === 0, 'during leave he receives nothing');
const st2 = (await call(adm, 'GET', '/org/whatsapp/escalations')).b.find((x) => x.userId?._id === p1._id);
check(!st2, 'and his leave day does not count towards a warning');
const afterLeave = await call(adm, 'POST', '/org/whatsapp/send', { slot: 'evening', userId: p1._id, day: '2099-02-11' });
check(afterLeave.b.queued === 1, 'after leave, messages resume');
await call(adm, 'DELETE', `/org/whatsapp/leave/${p1._id}`);

// Restore
await call(adm, 'PUT', '/org/whatsapp', { ...settings, ...(original.settings ?? {}), enabled: false });
await call(adm, 'POST', `/org/whatsapp/escalations/${p1._id}/reset`);
console.log(`\n${ok} checks passed (coaching switched off again)`);
