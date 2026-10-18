# State Land Directory — Proposal (for review)

**Status:** built (phases 1–2 and the summary from phase 3).

**Changes after review (19 Oct 2026):**
- **Khasra-wise records.** The directory now holds one record per khasra: Murabba / Mustateel no. → killa (1–25) → optional sub-killa, each with its own area in Kanal / Marla / Feet.
- **Entry.** Entering a murabba shows its 25 killas; the user ticks any or all of them and splits a killa into sub-killas where needed. Khewat and khatauni are given once for all the killas, with an override for a murabba.
- **Removed fields.** GPS, location, boundaries and hadbast are removed; the cadastral mapping system will be linked later.
- **Uniform type names.** Categories, sub-types and departments come from lists that only the administrator edits, so every user picks the same names. "Provincial Government" is a category and a department.
- **Lamberdari scheme** is added under schemes.
- **Bulk verification.** The Girdawar and Tehsildar can verify and approve in bulk.

**Decisions taken (§10):**
- the categories in §3 are accepted;
- shamilat deh is included (category J);
- verification has two steps: the Girdawar verifies, then the Tehsildar or Naib Tehsildar approves;
- no CNICs are recorded;
- rent and arrears stay with the Lease Money KPI, so only the lease period is recorded here;
- GPS is optional;
- visibility is the same as for KPIs (own jurisdiction).

**Not built yet:**
- Excel import of existing registers;
- the holding PDF file;
- lease-expiry reminders;
- the map view;
- the Tameel survey drive;
- KPI links.

## 1. Purpose

The directory is one authoritative register of **every piece of state-owned land in every mouza**. It records:
- **what** the land is (category and owning department);
- **where** it is (khewat, khatauni, khasra, murabba / killa);
- **how much** there is;
- **who holds it**, and whether that matches the record;
- **what has gone wrong**: encroachment, litigation, an unmutated acquisition, a lapsed lease.

The Patwari of each mouza collects it once and keeps it up to date. Supervisors verify it, and officers from the Tehsildar to the Commissioner can see it.

**Questions it answers**
- How much state land is in this tehsil or district, and of which kind?
- How much of it is encroached?
- Which departments hold land that is not yet mutated in their name?
- Which parcels are under litigation?
- Which leases have expired or have rent outstanding?

---

## 2. Design principle: one row per *holding*

The basic record is a **holding**. A holding is one piece of state land in a mouza with one category, one owner or custodian department and one status. For example:
- the canal strip running through khasras 12–40;
- the Government Primary School on khasra 118;
- 25 kanal of unallotted colony land in murabba 45.

- A mouza has many holdings, and a holding can cover several murabbas and killas or khasras. This reuses the Murabba → Killa/Khasra entry already built for Litigation, and works for khasra-only tehsils too.
- **Category-specific fields** (lease, acquisition award, allotment, encroachment and so on) appear only when they apply, so the form stays short.
- A **mouza summary** (§6) is calculated from the holdings, not typed in separately.

---

## 3. Classification: every type of state land

Each holding gets a **Category** and a **Sub-type**, plus the **Owner / Custodian** (department). These are proposed lists; admins can extend them from Settings.

| # | Category | Sub-types (examples) | Typical owner / custodian |
|---|---|---|---|
| A | **Provincial Government land (Sarkar Daulatmadar / BoR)** | Banjar qadeem, banjar jadeed, ghair mumkin, culturable waste, unculturable, nazool (urban state land), abadi deh (state-owned part), resumed land | Board of Revenue / Collector |
| B | **Colony land** (Colonization of Government Lands Act 1912) | Unallotted, allotted (proprietary rights pending), proprietary rights granted, under temporary cultivation lease, reserved for public purpose, resumed | Colonies Dept / Collector |
| C | **Land Reforms / Land Commission** (MLR 64, MLR 115 of 1972, Act II of 1977) | Resumed – unallotted, resumed – allotted to tenants, dispute pending | Land Commission / BoR |
| D | **Evacuee property** | Evacuee trust property (ETPB), ex-evacuee settled land, unsettled evacuee land | Evacuee Trust Property Board / Settlement |
| E | **Auqaf** | Shrine, mosque, waqf agricultural land, waqf urban property | Punjab Auqaf & Religious Affairs |
| F | **Federal departments** | Railway line / station / yard / colony; WAPDA grid, line or colony; Military / cantonment / defence land; NHA national highway; Pak PWD; post, telecom; other federal | Pakistan Railways, WAPDA, MoD / ML&C, NHA, etc. |
| G | **Provincial departments (public use)** | Road / highway (C&W), canal / distributary / minor / drain / irrigation colony / rest house (Irrigation), school / college (Education), BHU / RHC / hospital (Health), forest – reserved / protected / linear plantation (Forest), police station / post (Police), livestock farm / vet hospital (L&DD), agriculture farm, fisheries, union council / municipal (LG), Cholistan land (CDA) | Respective department |
| H | **Acquired land** (Land Acquisition Act 1894) | Acquired for road, canal, school, housing scheme, industrial estate, defence, other | Acquiring department |
| I | **Allotted / leased under schemes** | Jinnah Abadi / 5- or 7-marla scheme, landless tenants, ex-servicemen / gallantry award, Cholistan allotment, horse / camel breeding grant, temporary cultivation lease, commercial / industrial lease, other scheme | Collector / scheme authority |
| J | **Community / public purpose** | Graveyard, eidgah, pond / johar, playground, rasta (path), shamilat deh (record if state-owned or vested in government), Sufi / public building | Village / LG / Collector |
| K | **Other / unclassified** | Free text, for review by the Tehsildar | — |

**Two "status" lists apply to every category**
- **Possession:** with the owner department; with an allottee or lessee; **encroached** (fully or partly); vacant / unused; mixed.
- **Record status:** mutated in favour of the owner; **not mutated** (record still shows the old owner); partly mutated; record not traceable.

---

## 4. The data table: fields per holding

**Bold** fields are mandatory. *Italic* sections appear only when relevant.

### 4.1 Identification and location
| Field | Type / notes |
|---|---|
| **Holding ID** | Automatic, e.g. `HSL-CHK12-SL-0007` (tehsil – mouza – serial), in the same style as Litigation case IDs |
| **Mouza** | From the Patwari's own mouzas; tehsil, qanungoi and patwar circle come from the hierarchy |
| Hadbast no. | Text |
| **Land record reference** | Khewat no(s)., khatauni no(s). |
| **Murabba → Killa / Khasra** | One or more rows, as in Litigation, or khasra-only |
| Jamabandi year | Year of the jamabandi the entry is taken from |
| Location description | E.g. "along Hasilpur–Bahawalpur road, north side" |
| GPS point | Captured on the phone at the site (optional), shown on a map later |
| Boundaries (optional) | North / South / East / West |

### 4.2 Area
| Field | Type / notes |
|---|---|
| **Total area** | Kanal, Marla, Feet; **acres** calculated automatically |
| Length × width | For linear land (roads, canals, railway): length in feet / km and width |
| Encroached area | Kanal / Marla / Feet, only if encroached |

### 4.3 Classification and ownership
| Field | Type / notes |
|---|---|
| **Category** | List A–K (§3) |
| **Sub-type** | List depending on category |
| **Owner as per record** | Name as written in the jamabandi (e.g. "Sarkar Daulatmadar", "Mehkma Nehar") |
| **Custodian / user department** | Department list; may differ from the record owner |
| Land classification | Chahi, nehri, barani, banjar qadeem, banjar jadeed, ghair mumkin (with nature: road, canal, abadi …) |
| **Present use** | Agriculture, building, road / canal in use, vacant, graveyard, commercial, residential, other |
| Structures on land | None / pucca / kacha, with a short description |

### 4.4 *Acquisition (category H, or wherever land was acquired)*
| Field | Notes |
|---|---|
| Acquiring department, purpose | |
| Award no., award date | Under the Land Acquisition Act |
| Compensation paid? | Yes / No / Partly; amount |
| Mutation in favour of department | Mutation no., date; or "not yet" |

### 4.5 *Allotment / lease (categories B, C, I)*
| Field | Notes |
|---|---|
| Scheme / policy | List |
| Allottee / lessee | Name, CNIC (optional), parentage |
| Order no., date, authority | |
| Lease period | From – to; **expiry is flagged automatically** |
| Rent / price | Annual rent or price; amount due, amount paid, **arrears** |
| Conditions met? | Yes / No / Under review (e.g. cultivation, construction deadline) |
| Proprietary rights | Granted / pending / not applicable; mutation no. |

### 4.6 *Possession and encroachment*
| Field | Notes |
|---|---|
| **Possession status** | Owner dept / allottee / lessee / encroached / vacant / mixed |
| Encroacher(s) | Names (several), nature of encroachment (cultivation, building, shop, other) |
| Since (year) | Approximate |
| Action taken | None / notice issued / FIR / case filed / retrieval operation |
| Retrieved | Date, area retrieved; this can feed a future "Retrieval" KPI |

### 4.7 *Litigation*
| Field | Notes |
|---|---|
| Under litigation? | Yes / No |
| Linked case(s) | **Pick from the Litigation register** by case ID, so the court, status and next hearing show here automatically and nothing is entered twice |

### 4.8 Record and digitisation
| Field | Notes |
|---|---|
| **Record status** | Mutated / not mutated / partly / not traceable |
| Mutation no(s). | In favour of the owner department |
| Demarcation done? | Yes / No; date; report reference |
| Computerised record | Matches PLRA / LRMIS? Yes / No / Not checked |
| Discrepancy note | Free text (e.g. area in record differs from site) |

### 4.9 Documents (attachments)
Using the same camera / PDF capture as Litigation, compressed:
- fard (extract of jamabandi);
- aks shajra / site plan;
- mutation;
- award / allotment order / lease deed;
- demarcation report;
- **site photos** (with GPS and date);
- others.

### 4.10 Verification trail
| Field | Notes |
|---|---|
| Entered by (Patwari), date | Automatic |
| Verified by Girdawar, date, remarks | |
| Approved by Tehsildar, date | Only approved records count in official totals |
| Last site visit date | Flag when older than e.g. 1 year |

---

## 5. Collection workflow

```
Patwari enters → Girdawar verifies (site / record) → Tehsildar approves → visible in official totals
              ↖ returned with remarks ↙
```
1. **Initial survey drive.** Each Patwari lists every state holding in his mouzas. This could be run as a **Tameel task** with a deadline, so progress per patwar circle is tracked.
2. **Bulk import.** Where a tehsil already keeps a state land register in Excel, it can be imported with a template, in the same way as Litigation import, with checks per row.
3. **Mouza completion.** The Patwari marks a mouza *"State land listing complete"* when every holding is entered. The Girdawar confirms it.
4. **Keeping it current.** Edits after approval go back for verification. Every change is kept in the history.
5. **Reminders.** Expiring leases (60 / 30 days), records not visited for a year, and holdings returned with remarks.

**Who does what** (to confirm):

| Role | Can |
|---|---|
| Patwari | Enter and edit his own mouzas, and attach documents |
| Girdawar | Verify or return records for his circle |
| Tehsildar / Naib Tehsildar | Approve; see the tehsil |
| AC / ADC(R) / DC / Commissioner | View, dashboards, exports |
| Admin | Settings: category and department lists, schemes |

---

## 6. Mouza summary (calculated, not typed)

For each mouza, from its holdings:

| Total state land (acres) | Encroached (acres, %) | Under litigation | Not mutated | Leases expired | Arrears (Rs) | Holdings verified % | Listing complete? |
|---|---|---|---|---|---|---|---|

The same figures roll up to qanungoi, tehsil, district and division, using the existing hierarchy, as on the KPI screens.

---

## 7. Screens and outputs

- **Directory list.** Filters for area, category, department, possession, record status and litigation; search by khasra, khewat or name.
- **Holding page.** All details, linked litigation, documents and history, plus a **Holding PDF** (cover sheet and attached documents, as for case files).
- **Dashboard.**
  - Area by category and by department.
  - Encroachment by tehsil.
  - Not mutated by department.
  - Leases expiring and in arrears.
  - Listing completion by patwar circle.
- **Exports.** Formatted Excel, with green headers and fit-to-page as just built: a mouza-wise register, department-wise statements (e.g. "all Irrigation land in the district") and an encroachment list.
- **Map (later).** GPS points on a map, coloured by category or encroachment.

---

## 8. Possible links to KPIs (optional, later)

These could become KPIs once the data is complete. They are not part of the first version:
- **Listing completion** (% of mouzas complete and verified);
- **Encroachment retrieved** (acres per quarter);
- **Mutations completed** for acquired land;
- **Lease rent recovered**, which may already overlap with the "Lease Money (State Land)" revenue KPI.

---

## 9. Suggested phases

| Phase | Contents |
|---|---|
| 1 | Holding register (§4.1–4.3, 4.6, 4.8), entry by Patwari, verification by Girdawar and Tehsildar, mouza summary, list, Excel export |
| 2 | Acquisition, allotment and lease sections, link to Litigation, documents and holding PDF, bulk import, reminders |
| 3 | Dashboard and roll-ups, Tameel survey drive, GPS capture and map, KPI links |

---

## 10. Decisions needed from you

1. **Categories (§3):** is the list complete for Bahawalpur Division? Add or remove sub-types (e.g. Cholistan-specific schemes).
2. **Shamilat deh:** include it in the directory (as community land), or leave it out because it isn't strictly state land?
3. **Verification:** Patwari → Girdawar → Tehsildar, or Patwari → Tehsildar only?
4. **Personal data:** record allottee and encroacher CNICs, or names only?
5. **Mandatory fields:** is the bold set in §4 right for the first collection drive?
6. **Rent and arrears:** track them here, or leave them to the existing Lease Money KPI?
7. **Initial collection:** run it as a Tameel task with a deadline? If so, what deadline?
8. **GPS and photos:** required on every holding, or optional?
9. **Existing registers:** are there Excel registers to import? If so, share a sample so the import template can match it.
10. **Visibility:** the same as KPIs (own jurisdiction upwards), or limited further?
