# Performance Hub

Multi-tenant KPI and performance-review platform. It's mobile-first: field officers use it on phones, and managers and admins use it on any screen.

## Features
- **Organisations (tenants)**: self-service signup. Every record is isolated per organisation.
- **Roles**: owner › admin › manager › employee. Managers see their direct reports and the members of departments they head.
- **Departments**: hierarchy, department heads, member counts.
- **KPI library**: unit, direction (higher or lower is better), frequency, aggregation (sum, average, or latest), default weight.
- **Review cycles**: draft → active → closed. Starting a cycle auto-creates self and manager reviews and notifies everyone.
- **Targets**: assign one KPI to many people at once. People log progress and managers approve or reject entries.
- **Reviews**: self, manager and peer reviews. Peer reviewers stay anonymous to non-admins.
- **Scoring**: weighted KPI achievement (capped at 150%), blended with review ratings using the cycle's KPI weight, then banded from Outstanding to Needs focus.
- **Reports**: org and department overview, score distribution, KPI achievement, top and bottom performers, per-person trend, CSV export.
- **Notifications**: in-app, with an unread badge.
- **PWA**: installable on phones, works offline with the last-known data.

## Stack
| | |
|---|---|
| API | Node 22, Express 5, TypeScript, Mongoose 8, Zod, JWT + rotating refresh cookie, Helmet, rate limiting, Pino |
| Web | React 19, Vite, Tailwind CSS 4, TanStack Query, React Router 7, Recharts, PWA |
| DB | MongoDB |

## Run locally
```bash
# 1. API
cd server
cp .env.example .env          # then set real JWT secrets
npm install
npm run seed                  # Bahawalpur Division pilot with test data
npm run dev                   # http://localhost:4000

# 2. Web (new terminal)
cd web
npm install
npm run dev                   # http://localhost:5173  (proxies /api to :4000)
```
Test logins for the Bahawalpur pilot (password `Password123`): `admin@bwp.test` (BoR admin), `commissioner@bwp.test`, `dc.bahawalpur@bwp.test`, `adc.bahawalpur@bwp.test`, `ac.hasilpur@bwp.test`, `tehsildar.hasilpur@bwp.test`, `naib1.hasilpur@bwp.test`, `wasilbaqi.hasilpur@bwp.test`, `girdawar1.hasilpur@bwp.test`, `patwari1.hasilpur@bwp.test`. The same pattern works for every tehsil (e.g. `ac.yazman@bwp.test`).

Division, districts and tehsils are real; qanungois, patwar circles and mouzas are generated test names marked "(test)", and all figures are random test data.

## Architecture notes

### Tenant isolation
- Every tenant-owned collection has a `tenantId` field, and every index starts with it.
- `server/src/lib/tenantPlugin.ts` injects `tenantId` into **every** query, update, delete and aggregate. It also stamps it on inserts.
- A query that runs with no tenant in context **throws** rather than leaking data.
- The tenant comes from the verified access token. It is stored in `AsyncLocalStorage` (`lib/tenantContext.ts`).
- Cross-tenant code (login, token refresh, seeding) must opt out explicitly with `runUnscoped()`.
- `bulkWrite` bypasses Mongoose middleware, so it must set `tenantId` itself (see `targets.routes.ts`).

### Auth
- The access token is a short-lived JWT held only in memory.
- The refresh token is an httpOnly, SameSite=strict cookie. It is stored as an HMAC hash and rotated on every use.
- Changing a password or role, or disabling a user, bumps `tokenVersion` and deletes sessions, which revokes access right away.
- Every request re-checks the user's status and the tenant's status.

### Performance
- Each target stores its current `actualValue` and `achievement` directly on the document. These are updated when entries are written, so dashboards never re-aggregate raw entries.
- Reports use two aggregations per request.
- The dashboard loads in a single request.

## Scaling roadmap
1. **Redis**: cache report results per tenant, cycle and scope; distributed rate-limit store; cache the user and tenant lookups done on each request.
2. **Job queue (BullMQ)**: move cycle activation, bulk notifications and report pre-computation off the request path. Add email, SMS and web-push workers.
3. **MongoDB Atlas**: replica set first; shard on `{ tenantId: 1, _id: 1 }` once a single cluster is outgrown.
4. **Snapshots**: write a frozen score snapshot per person when a cycle closes, so history never changes.
5. **Ops**: Dockerfiles, CI (typecheck, build, tests), integration tests for tenant isolation, OpenTelemetry tracing, run `syncIndexes` in deploys (autoIndex is off in production).
6. **Product**: invitations by email, SSO, bulk CSV import of people and targets, custom review questions, per-tenant branding, audit log viewer.
