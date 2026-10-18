# Pre-deployment Testing Guide — Board of Revenue (Bahawalpur pilot)

The guide takes about 1–2 days. It covers every feature, tested from the account of the person who would really use it.

**How to use it:**
- Work through the sections in order. Later sections reuse data entered earlier.
- Tick ☐ → ☑ when the **Expected** result matches.
- Record any failure in the **Defect log** (§24), with the test ID, what happened and a screenshot.

---

## 0. Preparation

### 0.1 Environment
| Item | Value |
|---|---|
| Web app | `http://localhost:5173` (local) or the staging URL |
| Board of Revenue sign-in link | `/login?org=bor-bahawalpur` |
| Platform console | `/login`, then sign in with the super-admin account |
| Test password (all Board of Revenue accounts) | `Password123` |
| Super-admin | `super@kpi.local` / `SuperAdmin123` (change this before go-live) |
 
### 0.2 Fresh data (recommended before a full run)
```bash
cd server
npm run seed            # rebuilds the Bahawalpur pilot with test data
npm run seed:assigned   # sample assigned targets
npm run migrate         # blueprint, phone numbers, indexes
npm run dev             # API on :4000   (and in /web: npm run dev)
```

### 0.3 Automated checks (must all pass first)
Run these from `server`, with the API running:

| Command | Expect |
|---|---|
| `npx tsc --noEmit` (server and web) | no errors |
| `npx tsx scripts/check-templates.ts` | 27 templates, 0 invalid |
| `node scripts/e2e-tenant.mjs` | 28 checks passed |
| `node scripts/e2e-access.mjs` | 17 checks passed |
| `node scripts/check-rollups.mjs` | 10 checks passed |
| `node scripts/e2e-whatsapp.mjs` | 17 checks passed |
| `node scripts/e2e-litigation.mjs` | 36 checks passed |
| `node scripts/e2e-stateland.mjs` | 33 checks passed |

### 0.4 Test accounts — one per role
| Role | Email (`@bwp.test`) | Works on |
|---|---|---|
| Organisation admin | `admin` | Everything |
| Commissioner | `commissioner` | Bahawalpur Division |
| Deputy Commissioner | `dc.bahawalpur` (or `dc.bahawalnagar`) | District |
| ADC (Revenue) | `adc.bahawalpur` | District |
| Assistant Commissioner | `ac.hasilpur` (or `ac.yazman`) | Tehsil |
| Tehsildar | `tehsildar.hasilpur` | Tehsil and own qanungois |
| Naib Tehsildar | `naib1.hasilpur`, `naib2.hasilpur` | Qanungoi (sees the tehsil) |
| Wasil Baqi Navees | `wasilbaqi.hasilpur` | Tehsil: targets, verification, Wasil Baqi KPIs |
| Service Centre In-charge | `sci.hasilpur` | Tehsil: GPC, Inheritance, KMI, Missing mutations |
| Girdawar | `girdawar1.hasilpur` | Qanungoi |
| Patwari | `patwari1.hasilpur`, `patwari2.hasilpur` | Patwar circle |

Use **separate browsers or private windows** for different accounts, so their sessions don't overwrite each other.

---

## 1. Sign-in and sessions
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| A-01 | Open `/login?org=bor-bahawalpur` | Punjab logo, "Government of the Punjab", "Board of Revenue" | ☐ |
| A-02 | Sign in as `patwari1` with a wrong password | "Invalid email or password"; no detail about which part was wrong | ☐ |
| A-03 | Sign in correctly with **Remember me** ticked, close the browser and reopen | Still signed in | ☐ |
| A-04 | Sign in with **Remember me** unticked, close the browser and reopen | Asked to sign in again | ☐ |
| A-05 | Enter a wrong password 10 times for one account | Blocked for 15 minutes with a clear message; other accounts on the same network are unaffected | ☐ |
| A-06 | Click the eye icon in the password field | Password becomes visible | ☐ |
| A-07 | Sign out (top-right icon, or **More › Sign out** on a phone) | Returns to sign-in; pressing Back does not show data | ☐ |
| A-08 | Profile › change password, then sign in on another device with the old password | Old password rejected; other sessions are signed out | ☐ |
| A-09 | On the Board of Revenue link, sign in as the super-admin | Opens the **Platform console**, not the Board of Revenue dashboard | ☐ |

## 2. Jurisdiction and visibility
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| J-01 | As `patwari1` open **Performance** | Opens their own patwar circle | ☐ |
| J-02 | As `patwari1` browse to another tehsil (e.g. Yazman) using the area picker | Visible read-only (default setting: everyone views the whole organisation) | ☐ |
| J-03 | As `naib1` open Staff performance | Lists every patwari and girdawar in **Hasilpur tehsil**, not just their own qanungoi | ☐ |
| J-04 | As `dc.bahawalpur` open Staff performance | All officers of Bahawalpur district | ☐ |
| J-05 | As `commissioner` open Performance | The division, with all 3 districts ranked | ☐ |
| J-06 | As `admin` go to Organisation setup › General › **Who can view what** → "Each person sees only their own jurisdiction", then save | Saved | ☐ |
| J-07 | Repeat J-02 as `patwari1` | Other tehsils are **refused**; their own circle, tehsil, district and division are visible | ☐ |
| J-08 | Set J-06 back to "Everyone sees the whole organisation" | Restored | ☐ |

## 3. Home, view modes and navigation
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| H-01 | As `commissioner` open Home | Greeting, "My performance" card (Target / Recovered / Balance), KPI table grouped as Revenue / Case registers / Registers & tasks | ☐ |
| H-02 | Check the units | Amounts in millions, with one "(Rs in Millions)" caption per card or table | ☐ |
| H-03 | Click a KPI row (officer accounts) | Opens Staff performance focused on that KPI | ☐ |
| H-04 | Switch the view: **Performance → Targets → KPI evaluation** (bottom of the side menu; the strip above the tabs on a phone) | Figures change to target achievement, then to weighted scores and grade bands; the choice is remembered | ☐ |
| H-05 | Collapse and expand the side menu | Only icons show when collapsed; the state is remembered | ☐ |
| H-06 | As `patwari1`, check the menu | No Manage section; Verify and Annual targets are hidden | ☐ |

## 4. Area performance (unit view)
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| U-01 | As `commissioner` open the division › Bahawalpur district › Hasilpur | Breadcrumb path; score or achievement gauge; block tiles; cards for Revenue, Arrears, Case registers and Audit paras | ☐ |
| U-02 | Tabs: KPIs / Ranking / Arrears / Officers | Each loads; arrears are shown crop-wise (Rabi / Kharif) and in total | ☐ |
| U-03 | Trend chart: switch Cumulative ↔ Monthly | This year against last year, with an even-pace target line | ☐ |
| U-04 | Click a bar in the Ranking chart | Drills down to that unit | ☐ |
| U-05 | Open a patwar circle with no patwari posted | Shown as "Vacant" | ☐ |

## 5. Lists: Staff performance, League tables, Report builder
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| L-01 | As `dc.bahawalpur` › Staff performance › Area = district, Staff = Patwaris | Rows: # · Tehsil (only when more than one tehsil) · Name · Area · overall figures · each KPI split into **Target / Recovered / Balance / %** | ☐ |
| L-02 | Click a row | The whole row is highlighted | ☐ |
| L-03 | Hover over or click a name | Underlined; opens that officer's profile | ☐ |
| L-04 | An officer holding an **additional charge** | One row per charge, tagged "Addl. charge" | ☐ |
| L-05 | Click a KPI column header | Sorts by that KPI | ☐ |
| L-06 | Click **CSV** | Downloads a file whose columns match the screen | ☐ |
| L-07 | League tables › Tehsildars / Naib Tehsildars / Girdawars | Ranked, with band chips in KPI mode | ☐ |
| L-08 | Report builder: tick details, KPIs and figures › Generate › **Print** | Printable report with the Government of the Punjab · Board of Revenue header | ☐ |
| L-09 | Table headers | Green, white text, centred, slightly larger than body text | ☐ |

## 6. Trends (period statistics)
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| T-01 | As `commissioner` › Trends › Month | Chart of recovered against pro-rated target; table of months × KPIs | ☐ |
| T-02 | Switch to Week, 15 days, Quarter, 6 months, Year | Each loads in under a second | ☐ |
| T-03 | Add up the monthly figures for one KPI | Equal to the quarter, half-year and year totals | ☐ |
| T-04 | Tap a month | Districts ranked for that month | ☐ |
| T-05 | Seasonal KPIs (Water Rate, Tawan) in a month | Target shows "—" (compared only for the full year) | ☐ |

## 7. Compare areas
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| C-01 | As `commissioner` › Compare › division › Tehsils, tick 3–4 KPIs | Grouped chart plus table with Target / Achieved / Balance / % | ☐ |
| C-02 | As `patwari1` open `/compare` | "Available to senior officers"; no data shown | ☐ |

## 8. Annual targets (Wasil Baqi Navees)
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| G-01 | As `wasilbaqi.hasilpur` › Annual targets › KPI = Mutation Fee | Grid of all Hasilpur patwar circles | ☐ |
| G-02 | Change 2 targets and the arrears for one circle › Save | Saved; Home and Staff figures update within seconds | ☐ |
| G-03 | KPI = Pending Registries | Rows are the **Tehsildar and Naib Tehsildars**, not circles | ☐ |
| G-04 | As `patwari1` open `/targets` | "Your posting does not set targets" | ☐ |

## 9. Monthly data entry
Use the **current month**; future months are refused.

| ID | Steps | Expected | ☐ |
|---|---|---|---|
| E-01 | As `patwari1` › Enter figures | Their circle; shows **only** Water Rate, AIT, Lease, and the Audit paras link; no Tawan, Mutation Fee or case KPIs | ☐ |
| E-02 | Enter Water Rate (current + arrears) and AIT › Submit | Status **Submitted** (awaiting verification) | ☐ |
| E-03 | Check Home or Staff | The figure is **not** counted yet; it shows as "unverified" | ☐ |
| E-04 | As `wasilbaqi.hasilpur` › Enter figures | Picks any Hasilpur circle; Tawan, Mutation Fee, Condonation, Stamp Duty, FBR, plus the patwari KPIs | ☐ |
| E-05 | Enter Mutation Fee for a circle | Saved as **Verified** straight away (Wasil Baqi is the verifier) | ☐ |
| E-06 | As `sci.hasilpur` › Enter figures | Only GPC, Inheritance, KMI, Missing mutations (received / disposed); saved as verified | ☐ |
| E-07 | As `naib1` › Enter figures › **My own registers** | Pending Registries and Partition Cases (received / disposed) | ☐ |
| E-08 | Try a future month (change the URL or picker) | Refused | ☐ |

## 10. Verification
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| V-01 | As `wasilbaqi.hasilpur` › Verify › Monthly entries | The patwari's E-02 entry is listed | ☐ |
| V-02 | Verify it | It disappears from the queue; Home and Staff now count it | ☐ |
| V-03 | `patwari1` submits again; Wasil Baqi **Returns** it with a reason | Patwari gets an alert; the entry shows "Rejected: reason"; it can be corrected and resubmitted | ☐ |
| V-04 | As `patwari1` try to change the verified month | Refused: "already verified" | ☐ |

## 11. Assigned targets and area drives
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| D-01 | As `tehsildar.hasilpur` › Assigned targets › New › **Individual**: patwari2, Water Rate, 1 week | Created; patwari2 gets an alert | ☐ |
| D-02 | New › **Area drive**: Hasilpur, AIT Land, 20% of remaining, 15 days › **Preview** | Shares split **in proportion to each circle's remaining balance**; vacant circles are skipped | ☐ |
| D-03 | Confirm the drive | Every patwari gets their share | ☐ |
| D-04 | Start another AIT drive on an overlapping area | Blocked: "drive already running", with a **Stop it and start this one** option | ☐ |
| D-05 | Stop the running drive and start the new one | The new drive uses the remaining balance; the stopped drive is judged pro rata | ☐ |
| D-06 | As `patwari1` › To me › log progress | Status "submitted" | ☐ |
| D-07 | As `wasilbaqi` › Verify › Target progress › verify it | It now counts; the target card % rises | ☐ |
| D-08 | Switch to **Targets** mode › Staff / League | Ranked by assigned-target achievement | ☐ |

## 12. Tasks, registers (audit paras) and alerts
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| K-01 | As `ac.hasilpur` › Tasks › New › assign to patwari1, due tomorrow | patwari1 gets an alert | ☐ |
| K-02 | As `patwari1` complete the task | The AC gets an alert; the task counts as **on time** | ☐ |
| K-03 | A task completed after its due date | Counts as late in the Tasks score | ☐ |
| K-04 | As `patwari1` › Enter figures › Audit paras › New para: category, year, number, amount, recovered | Saved; the Audit paras card on the unit view updates | ☐ |
| K-05 | Mark the para Settled | Settled count rises | ☐ |
| K-06 | As `patwari1` try to delete a para | Not allowed (Wasil Baqi or admin only) | ☐ |
| K-07 | The bell icon | Unread count; opening the list marks items read | ☐ |

### 12A. Litigation
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| L-01 | As `patwari1.hasilpur` › Litigation › New Case: mouza, type, court, parties, land (incl. Murabba), next hearing | Saved with an ID like `HSL-<MOUZA>-0001`; the serial runs per tehsil | ☐ |
| L-02 | Enter the same court case no. again | Duplicate warning; can save anyway | ☐ |
| L-03 | As `tehsildar.hasilpur` open the case; try New Case | Sees it; cannot enter cases. A Yazman patwari cannot see it | ☐ |
| L-04 | Record a hearing with the next date | Next hearing moves forward; shown in Cause List and Calendar | ☐ |
| L-05 | Mark Decided without a date; then Appeal "No" without a reason | Both refused | ☐ |
| L-06 | Decide, appeal Yes, then Start Appeal Stage | Same Case ID, stage 2, status Pending | ☐ |
| L-07 | Attach 2 camera photos, then a PDF; try a non-PDF file | Photos become one small PDF; PDF kept; other file refused | ☐ |
| L-08 | Case File PDF and Documents ZIP buttons; names in Urdu | PDF has cover, hearings, dividers, documents; Urdu joined and right-to-left | ☐ |
| L-09 | Import: download the template, fill a row with a wrong mouza, Check | Row-level problem shown; nothing saved until corrected | ☐ |
| L-10 | Calendar tab: move between months | Each day shows its hearings; today outlined | ☐ |
| L-11 | Monitoring tab | Counts by court, type and tehsil; oldest pending; pending with no hearing; decided against government with appeal undecided | ☐ |
| L-12 | As `admin` › Settings: appeal period for a court | Cases decided in that court show "Appeal period ending" alerts | ☐ |
| L-13 | New Case › Land: Murabba + Killa / Khasra, add 2 murabbas with their killas; then switch to Khasra Only | Each murabba keeps its own killas on the case page and PDF; khasra-only saves khasras without murabba | ☐ |
| L-14 | As `admin` › Settings › tick a tehsil under "Tehsils without murabbas"; open New Case for a mouza there | The form opens with Khasra Only | ☐ |

### 12B. State Land Directory (khasra-wise)
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| S-01 | As `patwari1.hasilpur` › State Land › Enter State Land: mouza, khewat / khatauni, murabba 45 | The 25 killas of murabba 45 appear as a grid | ☐ |
| S-02 | Tick killas 1, 2, 7 and "Select all"; then "+ Sub-killa" on killa 6 | Each ticked killa gets a row (8 kanal by default); killa 6 becomes 6/1 and 6/2, each with its own area; totals in K · M · Ft and acres | ☐ |
| S-03 | "+ Add another murabba"; tick "Different khewat / khatauni" for it | The second murabba uses its own khewat / khatauni, the first keeps the common one | ☐ |
| S-04 | Category, sub-type, department: try to type a name that is not in the list | Only listed names can be chosen ("ask the administrator") | ☐ |
| S-05 | Possession "Partly encroached" | An encroached-area column appears for each khasra | ☐ |
| S-06 | Save; enter the same murabba again | Saved killas are greyed out; re-entering one is refused | ☐ |
| S-07 | As the Girdawar tick several khasras in the directory › Verify; as the Tehsildar › Approve | Verified, then approved, in bulk; approving before verification is refused | ☐ |
| S-08 | The Patwari edits an approved khasra; the Girdawar returns one with remarks | Edit sends it back for verification; returned shows the remarks | ☐ |
| S-09 | As `admin` › State Land › Settings: add a sub-type and a department | Every user can pick them at once; a category in use cannot be removed | ☐ |
| S-10 | Summary tab; Mouza Listing (Patwari marks complete, Girdawar confirms); Excel | Mouza-wise murabbas / khasras / acres; Excel has Murabba, Killa, Sub-killa columns | ☐ |

## 13. Officer profile
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| O-01 | Click any officer's name | Their posts, breakdown and trend; posts switch if they hold more than one | ☐ |
| O-02 | A Tehsildar who holds qanungois directly | Scored on their own qanungois plus their own registers (not the whole tehsil) | ☐ |

## 14. Admin — Organisation setup (blueprint)
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| B-01 | As `admin` › Organisation setup | Tabs: General, Hierarchy, Posts & roles, KPIs, Scoring, Registers | ☐ |
| B-02 | KPIs › add "Test KPI" (Revenue, Patwar Circle, entered by Patwari, verified by Wasil Baqi) › Save with a note | Saved as a new version; it appears for `patwari1` in Enter figures | ☐ |
| B-03 | Clear "Verified by" on any KPI | Red problem count; Save is disabled | ☐ |
| B-04 | Delete **Water Rate — Rabi** (it has data) › Save | Refused: "still in use … mark it inactive instead" | ☐ |
| B-05 | Untick **Active** on Test KPI › Save | It disappears from screens; past data is kept | ☐ |
| B-06 | General › change a term (e.g. "Recovered" → "Collected") › Save | Column headers across the app change | ☐ |
| B-07 | **History** › restore the version before B-02 | Restored as a new version; screens match the earlier setup | ☐ |
| B-08 | Scoring › change one profile so its weights don't total 100 | Saved with a warning that weights are applied proportionally | ☐ |

## 15. Admin — Hierarchy, People, Postings, Bulk import
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| P-01 | Hierarchy › division › district › Hasilpur › a qanungoi › **Add Patwar Circle** "Test Circle" | Created under the qanungoi | ☐ |
| P-02 | Move "Test Circle" to another qanungoi | Moved; its data moves with it | ☐ |
| P-03 | Delete "Test Circle" (it has no postings) | Deleted; a unit with postings cannot be deleted | ☐ |
| P-04 | People › add a user | Created | ☐ |
| P-05 | Postings › post the new user as Patwari to a circle that already has a patwari | Allowed (several patwaris can share a circle) | ☐ |
| P-06 | Post a second **Tehsildar** to Hasilpur | Refused: "already has a Tehsildar" | ☐ |
| P-07 | Post a Naib Tehsildar to a qanungoi that the Tehsildar holds | Refused (only one revenue officer per qanungoi) | ☐ |
| P-08 | Post a Patwari to a tehsil | Refused: "Patwari is posted to a Patwar Circle" | ☐ |
| P-09 | Bulk import › People › download the Template › add 2 rows › Check (dry run) | Problems listed by row; Import unlocks only when every row is valid | ☐ |
| P-10 | Import › then Postings for the same 2 | Created; re-running the import updates instead of duplicating | ☐ |
| P-11 | As `admin` (not owner) import a user with role **owner** | Refused or ignored (only owners can create owners) | ☐ |

## 16. Admin — Access rights
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| R-01 | Access rights › Give access: patwari1, Hasilpur tehsil, **Enter figures**, only Mutation Fee | Saved; patwari1 is notified | ☐ |
| R-02 | As `patwari1` › Enter figures | Mutation Fee now appears; enter it → Submitted | ☐ |
| R-03 | Give patwari2 **Verify** on Hasilpur, Mutation Fee | patwari2 sees Verify, with that entry | ☐ |
| R-04 | As `patwari1` change the verified entry | Refused; after granting **Edit verified figures** it is accepted and goes back for verification | ☐ |
| R-05 | Give access with an **Until** date of yesterday | Has no effect | ☐ |
| R-06 | Click patwari1's name in Access rights | Effective rights: from their posting plus direct grants | ☐ |
| R-07 | Remove all test grants | Removed; the rights disappear within about 2 minutes | ☐ |

## 17. Admin — Scoring weights (area overrides)
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| W-01 | Scoring weights › Applies to: Hasilpur tehsil › change the Patwari profile › Save | "Custom weights for this tehsil"; Hasilpur patwari scores change; other tehsils don't | ☐ |
| W-02 | Remove override | Hasilpur goes back to the organisation default | ☐ |

## 18. WhatsApp coaching (test mode: nothing is delivered)
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| WA-01 | Admin › WhatsApp coaching | Banner "Test mode: … not delivered"; recipients count ≈ scored staff with phones | ☐ |
| WA-02 | Settings: tick **Send daily**, language **Bilingual**, check the times and working days (Sun off), add a holiday › Save | Saved | ☐ |
| WA-03 | Preview & test › person: patwari1 › Morning / Follow-up / Evening | Personal goals (per-day amounts), tasks, pace, rank (e.g. "15 of 21 Patwaris in Hasilpur") | ☐ |
| WA-04 | Send this now | Appears in the conversation and the Message log as **sent** | ☐ |
| WA-05 | Simulate replies: `STATUS`, `TASKS`, `DONE 1`, `HELP` | Each is answered; DONE 1 closes the first task and alerts the assigning officer | ☐ |
| WA-06 | Evening preview for a patwari who is behind | Ends with a formal **Notice** | ☐ |
| WA-07 | Set "Working days before review" = 1, then send evening to patwari1 on two days | Day 1: **Official Notice — Performance Under Review**, and the supervisor alert ("Performance Alert — For Necessary Action"). Day 2: **Final Warning** (disciplinary wording), and admins are alerted | ☐ |
| WA-08 | Under review › **Withdraw warning** with a reason | Back to on track; the person gets "Notice — Warning Withdrawn" | ☐ |
| WA-09 | **Mark on leave** today to +3 days › send evening | Nothing is sent to them; no warning is counted | ☐ |
| WA-10 | Set working days back to 3, untick **Send daily** (until go-live) | Saved | ☐ |

## 19. Platform console (multi-organisation)
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| M-01 | As super-admin › New organisation › template **Microfinance** › first admin | Created; card shows people / units / setup version | ☐ |
| M-02 | Sign in as the new admin (sign-in link) | Their own levels (Region › Area › Branch › Portfolio), KPIs and terms; **no Board of Revenue data** anywhere | ☐ |
| M-03 | As `admin@bwp.test` open `/platform` | Redirected; no platform data | ☐ |
| M-04 | Super-admin › **Suspend** the test organisation | Its users are signed out and cannot sign in | ☐ |
| M-05 | Reactivate (or remove) the test organisation | Restored | ☐ |

## 20. Phones and installation (most officers use phones)
Test on **one Android and one iPhone**, plus Chrome device mode at 320 px and 390 px.

| ID | Steps | Expected | ☐ |
|---|---|---|---|
| X-01 | Open every page in the menu | No sideways scrolling of the page; wide tables scroll inside their own box | ☐ |
| X-02 | Bottom bar: Home / Performance / Entry or League / Tasks / More, plus the view strip above it | Easy to tap; nothing is hidden behind the bar | ☐ |
| X-03 | Enter figures on a phone | Number keypad appears; Save button reachable | ☐ |
| X-04 | Browser menu › **Install app / Add to Home screen** | Installs with the icon; opens full-screen | ☐ |
| X-05 | Turn on airplane mode and reopen | Last-seen data shown; entry is clearly unavailable | ☐ |
| X-06 | Dark mode (phone setting) | Readable everywhere | ☐ |

## 21. Security checks
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| S-01 | Signed out, open `/api/rev/meta` in the browser | 401 | ☐ |
| S-02 | As `patwari1` call an admin page (e.g. `/admin/org`) | Redirected to Home | ☐ |
| S-03 | As the Microfinance admin, open a Board of Revenue unit URL (copy one from §4) | Not found; no data | ☐ |
| S-04 | Change a user's password as admin; their other session refreshes | That user is signed out everywhere | ☐ |
| S-05 | Check the audit trail (database `audits` collection) after §14–§18 | Every admin action is recorded with who did it and when | ☐ |
| S-06 | Production `.env` | Strong, unique JWT secrets; super-admin password changed; `NODE_ENV=production`; HTTPS | ☐ |

## 22. Performance and load
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| Q-01 | Commissioner opens the division view (first time, then again) | First load ≤ 1 s; repeat ≤ 0.2 s | ☐ |
| Q-02 | Staff performance › division › Patwaris (about 580 rows) | Loads in ≤ 2 s; scrolls smoothly on a phone | ☐ |
| Q-03 | 30 testers open Home and Performance at the same time | No errors; responses stay under 2 s | ☐ |
| Q-04 | Enter a figure, then reopen Trends after about 1 minute | Updated (statistics rebuild about 1 minute after changes) | ☐ |
| Q-05 | Restart the API while browsing | The app reconnects; nothing is lost | ☐ |

## 23. Data integrity and recovery
| ID | Steps | Expected | ☐ |
|---|---|---|---|
| I-01 | Pick one patwar circle; add up its entries by hand for one KPI | Equal to the figure shown on Home, Staff and Trends | ☐ |
| I-02 | For one KPI, add up the 6 tehsils of Bahawalpur district | Equal to the district total | ☐ |
| I-03 | Take a backup (`mongodump`), restore it to a test database, open the app on it | All data present | ☐ |
| I-04 | Run `npm run migrate` twice | The second run changes nothing and logs no errors | ☐ |

---

## 24. Defect log
| # | Test ID | Account | What happened (expected vs actual) | Severity (Blocker / Major / Minor) | Screenshot | Fixed in | Retested ☐ |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |

**Go / no-go rule:** no open Blocker or Major defects; every test in §1, §8–§12, §14–§16, §19 and §21 passes.

## 25. Sign-off
| Area | Tested by | Date | Result |
|---|---|---|---|
| Field data entry and verification (§8–§12) | | | |
| Officer views and reports (§3–§7, §13) | | | |
| Administration (§14–§18) | | | |
| Platform and security (§19, §21) | | | |
| Phones (§20) | | | |
| Performance and data (§22–§23) | | | |
| **Approved for deployment** | | | |
1