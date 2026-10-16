# Litigation Module — Implementation Plan (for review)

**Goal:** one central record of every court case affecting land in each officer's jurisdiction.

- Each case keeps **one permanent ID for its whole life**, including hearings, decision, appeal and onward appeals.
- Each case holds its **documents**: plaint, reply, order sheets, judgments and the like.
- The whole file can be downloaded as **one PDF**.

Patwaris record and update cases from their phones. Officers see and monitor everything in their area.

---

## 1. What the user sees

### 1.1 Menu: "Litigation"
Available to everyone, scoped to their jurisdiction (the same rules as the rest of the app):

| Who | Sees | Can add / edit |
|---|---|---|
| Patwari | Cases in their mouzas | Yes (their mouzas) |
| Girdawar, Naib Tehsildar, Tehsildar, AC | Their qanungoi or tehsil | Yes |
| ADC(R), DC, Commissioner | District or division (monitoring) | View + notes (edit optional, by right) |
| Admin | All | All |
| Extra people | via **Access Rights** (new right: "Litigation") | as granted |

### 1.2 Litigation home: a dashboard and a list
- **Cards:**
  - Total / Pending (sub judice) / Decided.
  - **Hearings this week**.
  - **Overdue updates**: the hearing date has passed but the proceedings weren't recorded.
  - **Appeal deadline approaching**: decided against the government, no appeal yet.
- **Filters:** tehsil, mouza, court, case type, status, appeal status, hearing date range, free text (case ID, party names, khasra).
- **Table:** Case ID · Mouza · Type · Court · Applicant v. Respondent · Next hearing · Status. Tap a row to open the case.
- **Calendar view (cause list):** hearings by date, so an officer can plan the week.
- **Export:** the filtered list as Excel. Print a cause list for any date.

### 1.3 Case page (one screen, sections)
1. **Header:** Case ID, status chip (Pending / Decided / In Appeal), next hearing countdown.
2. **Case details:** the form in §2.
3. **Hearings timeline:** every hearing, newest first: date, proceedings done, what is to be done next, next date.
   - **Add Hearing** moves "Next date" into the history and asks for the new next date. This keeps one record instead of new entries.
4. **Decision:** decision date, result (in favour of the government or against it; for or against the applicant), summary.
5. **Appeal:**
   - Filed? **Yes:** appellate court, date filed, appeal number. The appeal continues as a **linked stage of the same case** (§2.4). **No:** reason (mandatory).
6. **Documents:** attach from the camera or from files, grouped by category (§3).
7. **Notes:** free-text information notes, with author and time.
8. **Download PDF:** the complete case file (§4).

Everything is mobile-first: a single column on phones, large tap targets, and pickers instead of typing where possible.

---

## 2. Data model

### 2.1 Case (`LitigationCase`)
| Field | Notes |
|---|---|
| `caseId` | **Readable permanent ID**, e.g. `HSP-0007` (§2.3). Never changes. |
| `serial` | Running number per tehsil |
| `unitId` (mouza) + `anc` | **Selected from the user's assigned mouzas**. `anc` gives tehsil, district and division automatically, for filtering and access. |
| `caseType` | Pick list (§2.5), plus "Other" (text) |
| `institutedOn` | Date of institution |
| `court` | Court of the current stage (§2.6); "Other" needs a name |
| `courtCaseNo` | The court's own case number (optional, useful for searching) |
| `applicants[]`, `respondents[]` | Several names each |
| `land` | `{ kanal, marla, feet }` (or acres), plus `khasraNos[]`, `khewat`, `khatauni` |
| `landSpec` | Land specification: state land / private / evacuee / Nazool …, nature (barani, nehri…), free text |
| `lastHearing` / `nextHearing` | Derived from the hearing timeline (always consistent) |
| `lastProceedings` / `nextAction` | From the latest hearing |
| `status` | `pending` · `decided` |
| `decision` | `{ date, result, summary }`; required when status = decided |
| `appeal` | `{ filed: yes/no, court, filedOn, appealNo, reasonNotFiled }` |
| `stages[]` | Court history (§2.4) |
| `governmentParty` | Is the government (Board of Revenue, Collector …) a party? Drives the "decided against government" alert |
| `notes[]` | `{ text, by, at }` |
| `createdBy`, `updatedBy`, timestamps, `deleted` (soft delete only) | |

### 2.2 Hearing (`hearings[]` inside the case)
`{ date, court, proceedingsDone, nextAction, nextDate, attendedBy, by, at }`.
The case's last and next hearing dates are always taken from here.

### 2.3 Case ID format
`<TEHSIL>-<NNNN>`, e.g. **`HSP-0007`**.
- **Tehsil code:** a short `code` field on the tehsil, set once in the Hierarchy page. If none is set, it's generated automatically (first letters, made unique).
- **`NNNN`:** a running number **per tehsil**, allocated safely with an atomic counter so two people saving at once never get the same number.
- **The mouza is a field and a filter**, not part of the ID.
- **Appeals keep the same ID with a stage label**, e.g. `HSP-0007` · Stage 2 (High Court).

### 2.4 Appeals and higher stages (same case, one ID)
`stages[]` records each forum the case passed through: `{ stage: 1, court, courtCaseNo, institutedOn, decision, appealFiled… }`.
- When an appeal is filed, **Start Appeal Stage** closes the current stage with its decision and opens stage 2 in the appellate court. The main fields (court, hearings, status) now refer to stage 2.
- The full chain stays visible, e.g. Civil Court → District & Sessions Judge → High Court → Supreme Court.
- Status = **decided** only when the final stage is decided with no further appeal.

### 2.5 Case types (editable list)
Partition · Correction of record (Fard Badar) · Mutation / review of mutation · Demarcation · Possession / ejectment · Declaration · Injunction · Encroachment / state land · Colony / allotment · Consolidation · Inheritance · Lease · Writ petition · Revision · Review · Appeal · Execution · Contempt · Other.

The admin can edit this list (stored in organisation settings).

### 2.6 Courts (fixed list plus "Other")
| Group | Courts |
|---|---|
| Revenue | Naib Tehsildar · Tehsildar · Assistant Commissioner · ADC (Revenue) · Deputy Commissioner · Additional Commissioner (Revenue) · Additional Commissioner (Consolidation) · Commissioner |
| Board of Revenue | Member Judicial-BOR · Member Colonies-BOR · Senior Member-BOR · Full Board-BOR |
| Civil / judicial | Civil Court · Senior Civil Judge · Additional District & Sessions Judge · District & Sessions Judge · High Court · Supreme Court |
| Other | Ombudsman · **Other** (court name typed in) |

Each court record also allows an optional **station or bench**, e.g. "Lahore High Court, Bahawalpur Bench".

### 2.7 Document (`LitigationDoc`)
`{ caseId, stage, category, title, date, file (stored), mime, size, pages, uploadedBy, at }`

**Categories:** Plaint / Dawa / Writ Petition / Appeal · Reply / Jawab Dawa · Order Sheet · Judgment / Order · Evidence · Notices / Summons · Other.

---

## 3. Attachments: camera or file, small and efficient

### 3.1 Capture (phone)
- **Attach** opens the camera directly (`capture="environment"`) or the file picker (PDF, JPG, PNG).
- **Multi-page scanning:** take several photos, reorder or delete them, then **save as one document** (e.g. a 6-page order sheet).

### 3.2 Compress on the phone, before upload
- Resize to a maximum of **1600 px** on the long side.
- Convert to **grayscale** by default. An optional "colour" toggle keeps colour, e.g. for maps.
- Encode as JPEG at quality **≈ 0.6**.
- Result: about **120–250 KB per page** instead of 3–6 MB, and uploads are fast on mobile data.
- PDFs over **10 MB** are refused with a message. Optionally the server re-saves PDFs to compact them.

### 3.3 Storage
| Option | Pros | Use |
|---|---|---|
| **MongoDB GridFS** | No new service, backed up with the database | **Recommended now** |
| Local disk volume | Simple | Single server only |
| S3-compatible object store (e.g. MinIO, Wasabi) | Scales cheaply | Later, with scaling |

Storage sits behind a small `storage.put/get/delete` interface, so switching later is a configuration change.

**Security:**
- Files are served only through the API, after the same access check as the case. There are no public links.
- File type is checked by its content, not only by its file extension.
- Size limits apply per file and per case.

---

## 4. Download the case file as a structured PDF
Generated on the server, using `pdf-lib` (embeds images and merges existing PDFs).

1. **Cover page:** Case ID, mouza, tehsil, court and stage chain, parties, land, status, decision, appeal.
2. **Hearings table:** date · court · proceedings · next action · next date.
3. **Documents in the order you set:**
   1. Plaint / Dawa / Writ Petition / Appeal
   2. Reply / Jawab Dawa
   3. Order Sheet
   4. Judgment / Order
   5. Others

   Each section starts with a divider page; uploaded PDFs are merged in and photos are placed one per page.
4. **Bookmarks and table of contents**, so readers can jump to sections.

Also: download a single document, and a **ZIP of the original files**.

---

## 5. Reminders and monitoring
- **Hearing reminders** (in the app, and on WhatsApp if coaching is on):
  - the day before and the morning of each hearing, to the patwari and their Tehsildar;
  - a weekly cause list to officers.
- **Overdue update:** two days after a hearing date with no proceedings recorded, the person responsible gets a reminder, and it is flagged on the dashboard.
- **Appeal watch:** when a case is decided against the government with appeal "not decided", a countdown runs against the limitation period (set per court in settings, e.g. 30 / 60 / 90 days). Alerts go out at 15 and 5 days left.
- **Supervisor view:** counts by court and type, oldest pending cases, and cases with no hearing date.

**Optional:** count litigation as a KPI register, e.g. "% of hearings updated on time" or "cases with documents complete". This is off by default.

---

## 6. Data entry quality
- **Mouza** is chosen only from the user's assigned list.
- **Khasra numbers** are entered as tags.
- **Land area** uses separate number fields (kanal / marla / feet), with a total shown.
- **Required fields:** mouza, case type, court, institution date, at least one applicant and one respondent.
- **Status = Decided** requires a decision date. **Appeal = No** requires a reason. **Appeal = Yes** requires a court.
- **Duplicate warning:** when the same court case number, or the same parties and khasra, already exist, the form asks "Possible duplicate: HSP-CHK12-0003?"
- **History of changes:** every edit is logged (who, when, which fields). Nothing is hard-deleted; an admin can restore.
- **Urdu names** are allowed in the parties and notes fields (right-to-left text supported).

---

## 7. Bulk start: import existing registers
- Many tehsils already keep litigation registers in Excel. **Bulk Import** gets a "Litigation cases" tab, with a downloadable template (the columns above), a dry run, and per-row errors.
- Case IDs are allocated during import. Hearings can be added afterwards.

---

## 8. Technical design (fits the current code)
| Part | Where |
|---|---|
| Models | `LitigationCase`, `LitigationDoc` (GridFS file id), counter collection for serials, `code` on `Unit` |
| API | `modules/litigation/`: cases (list with filters, paging, get, create, update, soft delete), hearings (add / edit), stages (start appeal), notes, documents (upload, list, download, delete), PDF export, ZIP, calendar, dashboard counts |
| Access | `assertCanSee` for writes, read scope as today, plus a new grant right `litigation` in Access Rights |
| Indexes | `{tenantId, caseId}` unique · `{tenantId, anc, status, nextHearing}` · `{tenantId, 'appeal.filed', decision.date}` · text index on parties, court case no and khasra |
| Jobs | Daily reminder job (existing scheduler): hearings, overdue updates, appeal limitation |
| Web | `pages/Litigation.tsx` (dashboard + list + calendar), `pages/LitigationCase.tsx` (case page), `components/Scanner.tsx` (camera, compression, multi-page) |
| Libraries | `pdf-lib` (server PDF), `multer` (uploads), GridFS (built into the MongoDB driver). Image compression on the phone uses the browser canvas, so no extra library is needed there. |
| Tests | `scripts/e2e-litigation.mjs`: create, ID format, hearing roll-forward, decide, appeal stage keeps the ID, attach image and PDF, PDF export order, access scope, reminders |
| Docs | A new section in TESTING_GUIDE.md |

---

## 9. Delivery in phases
| Phase | Delivers | Effort |
|---|---|---|
| **1** | Case form, Case ID, list and filters, case page, hearings timeline, decision and appeal (including stages), notes, access, audit trail | 3 days |
| **2** | Attachments: camera multi-page scan with compression, file upload, GridFS, viewer, categories | 2 days |
| **3** | Structured PDF download, ZIP, Excel list export, cause-list print | 1.5 days |
| **4** | Dashboard, calendar, reminders (hearing / overdue / appeal limitation), WhatsApp hook | 1.5 days |
| **5** | Bulk import of existing registers, unit code editor, duplicate detection, testing-guide section | 1.5 days |

**Total: about 9–10 working days.** Each phase is usable on its own; phase 1 already gives a working central register.

---

## 10. Decisions (confirmed)
| # | Question | Decision | Effect on the plan |
|---|---|---|---|
| 1 | Case ID | **Serial runs per tehsil** | ID = `<TEHSIL>-<NNNN>`, e.g. `HSP-0007`. The mouza is a field and a filter. |
| 2 | Who enters | **Patwari, Admin, Reader, Colony Clerk, PA** | New posts Reader, Colony Clerk and PA (§11), each with a new **Litigation entry** right. Officers view and add notes; an admin can grant one entry rights through Access Rights. |
| 3 | Presiding officer sees cases in their court | **No** | Visibility follows jurisdiction only. There is no court-based routing. |
| 4 | Appeal limitation periods | **Yes, the admin adds them later** | A settings table "Appeal period (days) per court" is built, empty by default. Appeal-deadline alerts work only for courts that have a period entered. |
| 5 | Storage | **MongoDB (GridFS) now; cloud after deployment** | Everything goes through the `storage` interface, so moving to cloud later is a configuration change plus a copy script (§12). |
| 6 | Litigation in performance scores | **No** | No KPI or scoring link. |

## 11. New posts for litigation entry (proposed levels — adjustable in Posts & Roles)
| Post | Posted at | Enters cases for |
|---|---|---|
| Reader | Tehsil (Reader to Tehsildar / AC) or District (Reader to DC / ADC(R)) | Every mouza under that unit |
| Colony Clerk | District or Tehsil | Every mouza under that unit |
| PA | District (PA to DC / ADC(R)) or Tehsil (PA to AC) | Every mouza under that unit |
| Patwari | Patwar circle | Their circle's mouzas |
| Admin | — | All |

These are data-entry posts. They are **not scored** and don't appear in league tables.

## 12. Moving to cloud storage later (prepared now)
- Each stored document records `backend` (`gridfs` now) and `storageKey`.
- Later: set `STORAGE_BACKEND=s3` plus the bucket and keys, then run `npm run migrate-files`. This copies each file, verifies its checksum, switches `backend` and frees the GridFS copy.
- Downloads and PDFs read through the same interface, so nothing else changes.

## 13. Revised effort
Still **about 9–10 working days**. Removing court routing and scoring saves some time, which is used to add the three new posts and the "Litigation entry" right (Phase 1).
