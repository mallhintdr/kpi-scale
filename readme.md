# KPI Dashboard

Multi-organisation KPI and performance platform. Each organisation (a government department, a marketing company, an HR provider …) gets fully separate data and defines its **own** hierarchy, posts, KPIs, scoring and vocabulary. Mobile-first: most officers use it on their phones.

## Who does what
| Role | Where | Can |
|---|---|---|
| **Platform super-admin** | `/platform` | Create organisations from a template, create each organisation's first administrator, suspend / reactivate, set plan and limits. Sees no organisation data. |
| **Organisation admin** (owner / admin) | Manage menu | Edit the organisation's **blueprint** at any time (hierarchy, posts & roles, KPIs, scoring, registers, terms, calendar), build the unit tree, import people and postings from CSV, post officers, override scoring weights per area. |
| **Staff** | Everything else | Enter and verify figures, set and track targets, view performance — all according to the posts they hold. |

## The Org Blueprint
Everything that used to be hard-coded for the Board of Revenue is now data, one versioned document per organisation (`server/src/modules/org/blueprint.ts`):

- **Levels**: the hierarchy, top first, e.g. Division › District › Tehsil › Qanungoi › Patwar Circle › Mouza, or Company › Region › Branch › Territory.
- **Posts**: roles held through postings. Each post records:
  - the levels it may be held at;
  - one holder per unit, or many;
  - whether it is scored or a data post;
  - **capabilities**: set annual targets, assign short-term targets, compare areas, manage registers;
  - widened jurisdiction (e.g. a Naib Tehsildar sees the whole tehsil);
  - posts it cannot share a unit with;
  - supervisory-only levels.
- **Blocks**: scoring blocks of five kinds:
  - target vs achieved;
  - arrears;
  - workload (pending vs disposed);
  - register;
  - tasks on time.
- **KPIs**: each KPI records:
  - its block and unit (money, count or number);
  - the level it is recorded on, and whether it is kept per person;
  - **which posts enter it, and which posts verify it**;
  - its weight, whether it tracks arrears, and an optional tag (e.g. Rabi / Kharif);
  - whether it is active. A KPI with data can be retired but not deleted.
- **Registers**: itemised records such as audit paras, customer complaints or grievances, with categories and an amount.
- **Profiles**: block weights for each level or post.
- **Other settings**: bands, financial-year start month, money display (symbol, millions or lakhs, decimals), and the organisation's own **terms** ("Recovered" or "Achieved", "Case registers" or "Pipeline", …).

Every save is validated (unknown references and duplicate keys are listed by path). Removing anything still used by data is refused. Every version is kept and can be restored from History.

**Templates** (27, grouped by category, all validated by `npx tsx scripts/check-templates.ts` in `server`):
- **Public sector**: Revenue Department (Board of Revenue, the original framework exactly), Police, Excise & Taxation, Local Government, District Health Authority, School Education, Agriculture Extension, Electricity Distribution (DISCO), Public service.
- **Banking & finance**: Commercial bank branch network, Microfinance, Insurance / Takaful.
- **Sales & distribution**: FMCG distribution, Pharmaceutical sales force, Telecom franchise & retail, Real estate & housing society, Retail store chain, Sales & Marketing.
- **Services**: Private school / college chain, Hospital network, Courier & logistics, NGO / development programme, IT & software services, HR Services.
- **Industry**: Textile / manufacturing plant, Construction & projects.
- **Blank**, to build everything from scratch.

Each template sets the hierarchy, posts and their abilities, KPIs (who enters and who verifies each one), scoring weights, a register, the organisation's own terms and the financial-year start. Everything is editable after creation.

## Run locally
Requires Node 22, MongoDB and (recommended) Redis ≥ 5.
```bash
# API
cd server
cp .env.example .env        # set JWT secrets, REDIS_URL, SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD
npm install
npm run seed                # Board of Revenue — Bahawalpur pilot with test data
npm run migrate             # gives existing organisations a blueprint, syncs indexes (safe to re-run)
npm run dev                 # http://localhost:4000 — creates the super-admin on first start

# Web (new terminal)
cd web
npm install
npm run dev                 # http://localhost:5173 (proxies /api to :4000)
```
- **Super-admin**: sign in with the `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` from `.env`.
- **Organisation sign-in link**: `/login?org=<slug>`. The login page shows that organisation's name and logo, and remembers the last organisation used on the device.
- **Board of Revenue pilot**: all logins use the password `Password123`:
  - `admin@bwp.test`, `commissioner@bwp.test`, `dc.bahawalpur@bwp.test`;
  - `ac.hasilpur@bwp.test`, `tehsildar.hasilpur@bwp.test`, `naib1.hasilpur@bwp.test`;
  - `wasilbaqi.hasilpur@bwp.test`, `sci.hasilpur@bwp.test`, `girdawar1.hasilpur@bwp.test`, `patwari1.hasilpur@bwp.test`.

### Onboarding a new organisation
1. **Super-admin**: go to Platform console › New organisation. Choose a template and create the first administrator.
2. **Organisation admin**: go to Organisation setup. Adjust levels, posts, KPIs, scoring and terms, then save.
3. Go to Bulk import. Load, in this order:
   - **Hierarchy**: `level,name,code,parent_code`
   - **People**: `name,email,role,designation,employee_code,phone,password`
   - **Postings**: `email,unit_code,post,charge_type,from`

   Each import runs a dry run first and lists every problem by row. Re-running updates records instead of duplicating them.
4. Share the sign-in link `/login?org=<slug>`.

### Tests
```bash
cd server
node scripts/e2e-tenant.mjs     # 28 checks: create org → import → targets → entry → verify → score → blueprint edits → isolation
node scripts/baseline.mjs out.json   # snapshot of every Board of Revenue score; diff two snapshots to prove a change is score-neutral
```

## Architecture

### Isolation
- Every tenant-owned collection carries a `tenantId`, and every index starts with it.
- `lib/tenantPlugin.ts` injects `tenantId` into every query, update, delete and aggregate. A query without a tenant in context throws.
- The tenant comes from the verified token, held in `AsyncLocalStorage`.
- Super-admins sit in a separate platform tenant, and organisation users can never reach `/api/platform`.
- Suspending an organisation signs everyone in it out.

### Performance and scale
These are built for 40+ organisations and many API instances:

| Concern | How |
|---|---|
| **Caching** | Two-tier cache (`lib/cache.ts`): an in-process LRU plus Redis. Fact sets, and whole read-only views (unit, league, compare), are cached under the organisation's **data version**. Any write to targets, entries, registers, tasks, postings or units bumps the version (`lib/dataVersion.ts`), so stale scores are never served and nothing is deleted by hand. Identical concurrent requests are computed once (single-flight). |
| **Period statistics** | `modules/revenue/rollup.ts` keeps one document for each unit and each week, 15-day period, month, quarter, half year and year (`Rollup` collection). Each unit's document holds the totals of its whole subtree.<br>A background job rebuilds an organisation-year from a few aggregations and writes **only the documents that changed**. This runs one minute after data changes, nightly at 02:00, and on demand. A Redis lock stops two builds running at once.<br>The **Trends** page and `/rev/stats` read these documents directly: 20–45 ms for a division. `node scripts/check-rollups.mjs` checks that they match the live scoring engine exactly. |
| **Blueprint** | Compiled once per organisation and cached. Edits are pushed to every API instance over Redis pub/sub. |
| **Jobs** | BullMQ (`lib/queue.ts`) handles notification fan-out, CSV imports and cache warm-up after data changes. Bursts are coalesced into one warm-up per 5-second window. Workers run inside the API (`RUN_WORKER=true`) or as separate processes (`npm run worker`). Without Redis, jobs run inline. |
| **Rate limits** | Stored in Redis and shared by all instances. API limits are keyed per signed-in session, because offices share one public IP. Login limits are set per account (failed attempts only) plus a generous cap per IP. |
| **Database** | Compound indexes lead with `tenantId`. `npm run migrate` syncs indexes on deploy (autoIndex is off in production). The connection pool is set with `MONGO_POOL`. |
| **Stateless API** | JWT access tokens and refresh sessions are kept in MongoDB, so any number of API replicas can run behind a load balancer. |

Measured on the Bahawalpur pilot (about 2,000 units and 118,000 entries):

| | Before caching | With caching |
|---|---|---|
| Division view | ~105 ms cold, ~25 ms warm | ~11 ms warm |
| 50 concurrent division views | 5.1 s | 0.54 s |

### Deploy
`docker compose up -d --build` starts:
- MongoDB and Redis;
- 2 API replicas;
- 1 job worker;
- the web app on nginx, at `http://localhost:8080`.

Scale with `docker compose up -d --scale api=4 --scale worker=2`.

**Next steps at larger scale:**
- a MongoDB replica set, with heavy reports read from secondaries;
- sharding on `{ tenantId: 1, _id: 1 }`;
- Redis with persistence;
- OpenTelemetry tracing.

## Stack
| | |
|---|---|
| API | Node 22, Express 5, TypeScript, Mongoose 8, Zod, ioredis, BullMQ, JWT with rotating refresh cookie, Helmet, Pino |
| Web | React 19, Vite, Tailwind CSS 4, TanStack Query, React Router 7, Recharts, PWA |
| Data | MongoDB, Redis |
