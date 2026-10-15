# Backport Plan: Refining the Pre-Scaling App

**Purpose.** Some of the work done after scaling began also improves the single-department Board of Revenue app. This plan lists that work, so it can be brought into the earlier version first. The multi-organisation features stay for the later scaling phase.

**Base version.** Commit `8a2d9f7` on `mallhintdr/kpi` (`main`), the last version before scaling.
**Scaled version.** `mallhintdr/kpi-scale` (`main`), commits `88e4965` → `734e6b8`. That is 10 commits touching 97 files (+9,643 / −1,470 lines).

This is a plan only. Nothing has been changed.

---

## 1. Every change made after the base

| # | Commit | Change | Type | Backport? |
|---|---|---|---|---|
| 1 | 88e4965 | Org Blueprint: hierarchy, posts, KPIs and scoring stored as data per organisation | Scaling (core) | **Partly**: see B-1 |
| 2 | 88e4965 | Platform super-admin console, organisation creation, templates | Scaling | No |
| 3 | 88e4965 | Organisation setup editor, Hierarchy manager | Scaling | **Hierarchy manager: yes** (B-4) |
| 4 | 88e4965 | CSV bulk import (units / users / postings, dry run) | General | **Yes** (B-5) |
| 5 | 88e4965 | Redis two-tier cache, data-version invalidation, BullMQ jobs, worker process | Scaling infrastructure | **Optional, light version only** (B-11) |
| 6 | 88e4965 | Login rate limit per account instead of per IP | Security | **Yes** (B-7) |
| 7 | 88e4965 | Notifications sent through a queue | Scaling | No (keep direct inserts) |
| 8 | 88e4965 | Dockerfiles, docker-compose, nginx | Deployment | **Yes, simplified** (B-12) |
| 9 | 88e4965 | Migration script, index sync | Operations | **Yes** (B-12) |
| 10 | 88e4965 | Seed refactor, score baseline and e2e scripts | Testing | **Yes**, adapted (B-13) |
| 11 | 30886b6 | Period rollups (week / 15-day / month / quarter / half / year) and the **Trends** page | Feature | **Yes** (B-2) |
| 12 | 30886b6 | Super-admin login fix (organisation slug as preference) | Scaling | No |
| 13 | 30886b6 | View-mode switch moved into the side menu and the phone bottom bar | UI | **Yes** (B-8) |
| 14 | 30886b6 | Seed records `verifiedAt` | Data | **Yes** (B-2) |
| 15 | 2a54c78 | 22 Pakistan-market templates | Scaling | No |
| 16 | 1705732 | Access rights: per-person grants (view / enter / edit / verify / targets…) and a view-scope setting | Feature | **Yes** (B-3) |
| 17 | 489b1d9 | WhatsApp daily coaching (morning, follow-ups, evening, escalation, replies) | Feature | **Yes** (B-6) |
| 18 | 554f23d | Formal notices; leave and warning withdrawal | Feature | **Yes** (with B-6) |
| 19 | 69b4d28 | TESTING_GUIDE.md; owner role cannot be escalated through import | Testing / security | **Yes** (B-13, B-5) |
| 20 | a353d40 | Title Case helper across headings, labels and menus | UI | **Yes** (B-8) |
| 21 | 7a7807f | Official's Home as structured tables (My Performance + KPI table on phones) | UI | **Yes** (B-8) |
| 22 | 734e6b8 | Root `package.json` (`npm run dev` starts both) | Developer experience | **Yes** (B-12) |
| — | (analysis) | Security and performance review: S1–S8, P1–P11 | Hardening | **Yes**, the relevant items (B-7, B-9, B-10) |

**Key rule for every backport:** the earlier app keeps its fixed catalogue (`catalog.ts`: `HEADS`, `POSTS`, `UNIT_TYPES`). Code ported from the scaled version must read from that catalogue, not from a blueprint (`bp`). Where scaled code calls `bp.metric`, `bp.postsWithCap()` or `bp.fy`, swap in the catalogue equivalent.

---

## 2. Backport work packages (in recommended order)

### B-1. Small catalogue upgrades (no blueprint)
Bring over only the parts of the blueprint idea that help a single department:
- Add `enterPosts` / `verifyPosts` arrays to each `HeadDef`. This replaces `enteredBy` plus the `isWasilBaqiFor` / `isSciFor` special cases.
  - Generalise `canEnter`, `autoVerifies` and the verify queue to use these arrays (as in the scaled `access.ts`). This removes about 60 lines of if/else.
- Add a `unit: 'money' | 'count'` field, so totals never mix money with counts (`breakdown()` totals use money KPIs only).
- Add `TERMS` and `MONEY` constants (e.g. "Recovered", "Rs in Millions"), so labels live in one place.
- **Acceptance:** the score baseline is identical. Port `scripts/baseline.mjs` and compare before and after.

### B-2. Period statistics and the Trends page
- Port the `Rollup` model, `rollup.ts` (build, change-only writes, nightly run) and `stats.routes.ts`.
  - Swap `bp.fy` for the catalogue FY helpers, and `bp.kindOf` for `HEAD_BY_CODE.get().kind`.
- **Without Redis:** run the rebuild in-process with a simple debounce (60 s timer per change) and a nightly `setInterval`. The scaled `queue.ts` "inline" mode already does this, so port only that branch.
- Seed: record `verifiedAt` on verified entries (the position-derived dates from #14).
- Port `Trends.tsx`, the menu item and the route; port `scripts/check-rollups.mjs`.
- **Acceptance:** month totals = quarter = half = year; year totals match the live engine.

### B-3. Access rights (per-person grants)
- Port the `AccessGrant` model, the grant-aware `access.ts` functions (`grantsOf`, `hasGrant`, `canEditVerified`, `browseRootsFor`), `access.routes.ts` and `Access.tsx`.
- Replace the blueprint `viewScope` with a single setting: an environment variable, or a small `Settings` document.
- **Edit-verified-figures right:** verified figures can be corrected only by verifiers or people granted "edit". Port this from `entry.routes.ts`.
- Port `scripts/e2e-access.mjs` (17 checks).

### B-4. Hierarchy manager (admin)
- Port `admin/Units.tsx` and the unit routes: list, add, rename, move with `anc` rewrite, delete only when empty.
  - Use the fixed `UNIT_TYPES` order instead of blueprint levels.
- Useful for correcting the real hierarchy (e.g. renaming a tehsil to "AKAR-Cholistan") without the database console.

### B-5. CSV bulk import
- Port `imports.ts`, the import routes and `Import.tsx` (dry run first, errors by row, re-run safe). Include the owner-escalation fix.
- Without Redis, the import runs as an in-process job (inline mode). Limit to about 10,000 rows per file.
- Posting rules come from the catalogue: `POST_UNIT`, `SINGLE_HOLDER`, and one revenue officer per qanungoi.

### B-6. WhatsApp coaching
- Port `modules/whatsapp/*` (providers, phone, coach, engine, webhook, admin routes), the `WaMessage` / `WaState` models, `WhatsApp.tsx`, and the formal notices with leave and withdrawal.
- Store the settings in a `Settings` document (there is no `Tenant.whatsapp`).
- **Without Redis:** the scaled engine uses BullMQ only for rate-limited delivery and Redis for webhook dedupe. Replace them with:
  - an in-process queue, plus a MongoDB unique index on `providerId` / `waMessageId` for dedupe;
  - a scheduler using the existing `setInterval` slot check.
- Phone numbers normalised to E.164 (migration plus import).
- Port `scripts/e2e-whatsapp.mjs`.

### B-7. Security hardening (from the review)
| ID | Item | Action |
|---|---|---|
| S1 | Role escalation through import | Covered in B-5 |
| S2 | Phone and email visible to everyone | Return contact details only to admins and the person's chain of command (`/officers/:id`, `holdersOf`) |
| S3 | No 2FA for admins | TOTP (authenticator app) for admin accounts |
| S4 | Temporary passwords never expire | `mustChangePassword` flag on admin-set and imported passwords |
| S5 | No security headers in production | nginx: CSP, HSTS, X-Frame-Options, Referrer-Policy, HTTPS |
| S8 | Unlimited sessions | Cap at 10 sessions per user; "sign out other devices" button |
| #6 | Login rate limit per IP blocks whole offices | Per-account limit on failed attempts, generous per-IP limit (from `auth.routes.ts`) |

### B-8. UI refinements
- `lib/text.ts` Title Case, applied in shared components (#20).
- View-mode switch in the side menu and the phone strip (#13).
- Official's Home as structured tables (#21), plus a choice for patwaris with two circles: combined, or one table per circle.
- Leftover wording: `PageHeader` subtitle sentences stay in sentence case.

### B-9. Performance fixes that need no Redis
| ID | Fix |
|---|---|
| P3 | Officer scoring is O(n²). Index fact rows by unit once, so each officer reads only their rows (`officerFacts`) |
| P4 | Many queries per entry sheet. Load the user's charges and grants once per request and check rights in memory |
| P6 | Missing indexes: `RevEntry {verifiedAt}`, `AssignedTarget {'progress.date'}`, `User {phoneE164}` |
| P9 | Long lists. Page League / Staff on the server (top N plus search), and render only the visible rows on phones |
| — | Cache the computed area facts in process memory for ~60 s, keyed by a simple data version counter (the in-process half of the scaled `cache.ts`) |

### B-10. Data correctness items
- **Untargeted heads must not inflate scores.** The base version already has this; keep the regression test.
- **Week / 15-day stats use the verification date:** document it on the Trends page (already in the port).
- **A Tehsildar's tehsil-level charge counts as oversight only.** Keep the existing behaviour and add a test.

### B-11. Optional lightweight infrastructure (only if needed before scaling)
- No Redis or BullMQ in the earlier app. Use the inline queue and the in-process cache from the scaled `queue.ts` and `cache.ts`. The code paths are already written to work without `REDIS_URL`.
- **Keep the same function names** (`enqueue`, `defineJob`, `cached`), so adding Redis later is a configuration change, not a rewrite.

### B-12. Deployment and developer experience
- Root `package.json` with `concurrently` (`npm run dev`, `seed`, `migrate`, `build`).
- A single-container Dockerfile (API serves the built web app), or the nginx config from the scaled version without the Redis and worker services.
- `migrate.ts` for indexes and backfills (phone E.164, `verifiedAt`, `register` tag).

### B-13. Testing
- Port and adapt TESTING_GUIDE.md: drop §19 (Platform console) and the template parts of §14. Keep §1–§18 and §20–§23.
- Port the automated scripts: `baseline.mjs`, `check-rollups.mjs`, `e2e-access.mjs`, `e2e-whatsapp.mjs`. Drop `e2e-tenant.mjs` and `check-templates.ts`.

---

## 3. Deliberately left for the scaling phase
- Org Blueprint data model, the Organisation setup editor, templates (27), and per-organisation terms and branding.
- Platform console, super-admin, organisation suspension and limits.
- Redis cache, BullMQ workers, Redis rate-limit store, cross-instance invalidation.
- Data-version cache per subtree (P1), serving views from rollups (P2), incremental rollups (P5), split Redis (P7), byte-capped cache (P8).
- HR module (deferred; see memory note).
- Database sharding, replicas, Atlas.

## 4. Suggested sequence and effort
| Order | Package | Effort | Depends on |
|---|---|---|---|
| 1 | B-13 scripts (baseline) + B-12 tooling | 0.5 day | — |
| 2 | B-1 catalogue upgrades | 1 day | 1 |
| 3 | B-9 performance + B-7 security (S1, S2, #6, S8) | 1.5 days | 2 |
| 4 | B-8 UI refinements | 0.5 day | — |
| 5 | B-4 Hierarchy manager + B-5 Import | 1.5 days | 2 |
| 6 | B-3 Access rights | 1 day | 2 |
| 7 | B-2 Rollups + Trends | 1.5 days | 2, 3 |
| 8 | B-6 WhatsApp coaching | 2 days | 3, 6 |
| 9 | B-7 rest (2FA, password expiry, headers) | 1 day | — |
| 10 | Full run of TESTING_GUIDE (adapted) | 1–2 days | all |

**Total: about 11–13 working days.**

## 5. Way of working
- Branch from `8a2d9f7` on the `kpi` repo (e.g. `refine/pre-scale`). Use one commit per package.
- After each package: typecheck, the score baseline is identical, the relevant e2e script passes.
- Keep the module and function names the same as in kpi-scale. When scaling resumes, the scaled code then merges over the refined version with minimal conflicts.
