import mongoose, { Schema, type InferSchemaType, type Types } from 'mongoose';
import { dataVersionPlugin } from '../lib/dataVersion.js';
import { tenantPlugin } from '../lib/tenantPlugin.js';
import { normalizePhone } from '../modules/whatsapp/phone.js';

const opts = { timestamps: true } as const;
const tenantField = { tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true } } as const;
const ref = (model: string, required = false) => ({ type: Schema.Types.ObjectId, ref: model, required });

/* ---------------- Tenant (global, not tenant-scoped) ---------------- */
const tenantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
    /** The platform's own tenant holds the super-admins; it has no blueprint. */
    isPlatform: { type: Boolean, default: false },
    industry: { type: String, trim: true, maxlength: 60 },
    contact: { name: String, email: String, phone: String },
    branding: {
      shortName: { type: String, maxlength: 40 },
      tagline: { type: String, maxlength: 120 },
      logoUrl: { type: String, maxlength: 500 },
    },
    limits: {
      maxUsers: { type: Number, default: 5000 },
      maxUnits: { type: Number, default: 50000 },
    },
    settings: {
      timezone: { type: String, default: 'Asia/Karachi' },
      currency: { type: String, default: 'PKR' },
      ratingScale: { type: Number, default: 5 },
    },
    /** Litigation settings: case types and appeal periods (days) per court. */
    litigation: { type: Schema.Types.Mixed, default: {} },
    /** State Land settings: categories with their sub-types, and departments (admin-managed, uniform names). */
    stateLand: { type: Schema.Types.Mixed, default: {} },
    /** Daily WhatsApp coaching: morning goals, follow-ups, evening summary, escalation ladder. */
    whatsapp: {
      enabled: { type: Boolean, default: false },
      language: { type: String, enum: ['english', 'urdu', 'bilingual'], default: 'english' },
      morningAt: { type: String, default: '08:30' },
      followupsAt: { type: [String], default: ['11:30', '14:30'] },
      eveningAt: { type: String, default: '18:00' },
      /** 0 = Sunday … 6 = Saturday */
      workdays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
      holidays: { type: [String], default: [] }, // YYYY-MM-DD
      /** Who receives it: scored staff only, or everyone with a posting */
      audience: { type: String, enum: ['scored', 'all'], default: 'scored' },
      escalation: {
        enabled: { type: Boolean, default: true },
        /** A day is "behind" when achievement trails the year's pace by more than this many points … */
        paceGap: { type: Number, default: 15 },
        /** … or overdue tasks reach this many */
        overdueTasks: { type: Number, default: 3 },
        /** Consecutive behind days for level 2 (review notice); level 3 at twice this */
        days: { type: Number, default: 3 },
        notifySupervisor: { type: Boolean, default: true },
      },
      allowOptOut: { type: Boolean, default: false },
    },
  },
  opts,
);
export const Tenant = mongoose.model('Tenant', tenantSchema);

/* ---------------- User ---------------- */
// App-level role. Operational authority comes from postings (Charge), not from this role.
// 'superadmin' exists only in the platform tenant: it creates organisations and their first admin.
export const ROLES = ['superadmin', 'owner', 'admin', 'manager', 'employee'] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    ...tenantField,
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: 'employee' },
    designation: { type: String, trim: true, maxlength: 100 },
    employeeCode: { type: String, trim: true, maxlength: 40 },
    bps: { type: Number, min: 1, max: 22 },
    phone: { type: String, trim: true, maxlength: 30 },
    /** E.164 form of phone (set automatically) — used to match WhatsApp replies. */
    phoneE164: { type: String, index: true },
    whatsappOptOut: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'invited', 'disabled'], default: 'active' },
    lastLoginAt: Date,
    tokenVersion: { type: Number, default: 0 },
  },
  opts,
);
userSchema.plugin(tenantPlugin);
userSchema.pre('save', function () {
  if (this.isModified('phone')) this.set('phoneE164', normalizePhone(this.get('phone')) || undefined);
});
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
userSchema.index({ email: 1 });
userSchema.index({ tenantId: 1, status: 1, name: 1 });
export const User = mongoose.model('User', userSchema);
export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };

/* ---------------- Session (refresh tokens) — looked up before tenant is known ---------------- */
const sessionSchema = new Schema(
  {
    userId: ref('User', true),
    tenantId: ref('Tenant', true),
    tokenHash: { type: String, required: true, unique: true },
    userAgent: String,
    ip: String,
    remember: { type: Boolean, default: true },
    expiresAt: { type: Date, required: true },
    /** All sessions rotated from one sign-in share a family; reuse of a rotated token revokes the family. */
    familyId: { type: String, index: true },
    /** Set when this token has been exchanged; the row stays as a tombstone to detect reuse. */
    rotatedAt: Date,
    /** Guest demo session: every write is refused. */
    readOnly: { type: Boolean, default: false },
  },
  opts,
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1 });
export const Session = mongoose.model('Session', sessionSchema);

/* ---------------- Org Blueprint: hierarchy, posts, KPIs, scoring (one live version per organisation) ---------------- */
const blueprintSchema = new Schema(
  {
    ...tenantField,
    version: { type: Number, required: true, default: 1 },
    template: String,
    doc: { type: Schema.Types.Mixed, required: true },
    updatedBy: ref('User'),
  },
  { ...opts, minimize: false },
);
blueprintSchema.plugin(tenantPlugin);
blueprintSchema.index({ tenantId: 1 }, { unique: true });
export const Blueprint = mongoose.model('Blueprint', blueprintSchema);

/** Every saved version, so a KPI change can be reviewed or rolled back. */
const blueprintHistorySchema = new Schema(
  {
    ...tenantField,
    version: { type: Number, required: true },
    doc: { type: Schema.Types.Mixed, required: true },
    note: { type: String, maxlength: 300 },
    updatedBy: ref('User'),
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
blueprintHistorySchema.plugin(tenantPlugin);
blueprintHistorySchema.index({ tenantId: 1, version: -1 });
export const BlueprintHistory = mongoose.model('BlueprintHistory', blueprintHistorySchema);

/* ---------------- Import runs (bulk units / users / postings from CSV) ---------------- */
const importRunSchema = new Schema(
  {
    ...tenantField,
    kind: { type: String, enum: ['units', 'users', 'charges'], required: true },
    dryRun: { type: Boolean, default: false },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    total: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    errors: [{ row: Number, message: String, _id: false }],
    /** The uploaded CSV and options, kept here (not in the job queue) and cleared once the run ends. */
    payload: { type: { csv: String, defaultPasswordHash: String, actorRole: String }, select: false, default: undefined, _id: false },
    createdBy: ref('User'),
    finishedAt: Date,
  },
  { ...opts, suppressReservedKeysWarning: true },
);
importRunSchema.plugin(tenantPlugin);
importRunSchema.index({ tenantId: 1, createdAt: -1 });
export const ImportRun = mongoose.model('ImportRun', importRunSchema);

/* ---------------- Territory: the organisation's hierarchy (levels come from its blueprint) ---------------- */
const unitSchema = new Schema(
  {
    ...tenantField,
    /** Level key from the blueprint (e.g. 'district', 'branch'). */
    type: { type: String, required: true, trim: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, trim: true, maxlength: 40 },
    parentId: ref('Unit'),
    /** Ancestors including self, root first. Any roll-up matches with { anc: unitId }. */
    anc: [{ type: Schema.Types.ObjectId, ref: 'Unit' }],
    active: { type: Boolean, default: true },
  },
  opts,
);
unitSchema.plugin(tenantPlugin);
unitSchema.plugin(dataVersionPlugin);
unitSchema.index({ tenantId: 1, parentId: 1, name: 1 });
unitSchema.index({ tenantId: 1, type: 1, code: 1 });
unitSchema.index({ tenantId: 1, anc: 1, type: 1 });
export const Unit = mongoose.model('Unit', unitSchema);

/* ---------------- Charge: who holds which unit, and when ---------------- */
const chargeSchema = new Schema(
  {
    ...tenantField,
    userId: ref('User', true),
    unitId: ref('Unit', true),
    /** Post key from the blueprint. A post may be held at several levels (e.g. Tehsildar on a tehsil and on qanungois). */
    post: { type: String, required: true, trim: true, maxlength: 40 },
    chargeType: { type: String, enum: ['regular', 'additional', 'look_after'], default: 'regular' },
    from: { type: Date, required: true },
    to: { type: Date, default: null },
  },
  opts,
);
chargeSchema.plugin(tenantPlugin);
chargeSchema.plugin(dataVersionPlugin);
chargeSchema.index({ tenantId: 1, userId: 1, to: 1 });
chargeSchema.index({ tenantId: 1, unitId: 1, post: 1, to: 1 });
export const Charge = mongoose.model('Charge', chargeSchema);

/* ---------------- Target / demand set by Wasil Baqi (per circle, or per revenue officer) ---------------- */
const targetSchema = new Schema(
  {
    ...tenantField,
    fy: { type: String, required: true },
    head: { type: String, required: true },
    unitId: ref('Unit', true), // circle (or tehsil for revenue-officer registers)
    roUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // revenue-officer registers only
    anc: [{ type: Schema.Types.ObjectId }],
    target: { type: Number, default: 0 }, // current-year demand (revenue heads)
    arrearDemand: { type: Number, default: 0 }, // uncollected from previous years (revenue heads)
    opening: { type: Number, default: 0 }, // opening pending cases (case heads)
    setBy: ref('User'),
  },
  opts,
);
targetSchema.plugin(tenantPlugin);
targetSchema.plugin(dataVersionPlugin);
targetSchema.index({ tenantId: 1, fy: 1, head: 1, unitId: 1, roUserId: 1 }, { unique: true });
targetSchema.index({ tenantId: 1, fy: 1, anc: 1 });
export const RevTarget = mongoose.model('RevTarget', targetSchema);

/* ---------------- Monthly entry (collections / case movement) ---------------- */
const entrySchema = new Schema(
  {
    ...tenantField,
    fy: { type: String, required: true },
    month: { type: String, required: true }, // YYYY-MM
    head: { type: String, required: true },
    unitId: ref('Unit', true),
    roUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    anc: [{ type: Schema.Types.ObjectId }],
    // revenue heads
    current: { type: Number, default: 0, min: 0 },
    arrear: { type: Number, default: 0, min: 0 },
    // case heads
    received: { type: Number, default: 0, min: 0 },
    disposed: { type: Number, default: 0, min: 0 },
    note: { type: String, maxlength: 500 },
    ref: { type: String, maxlength: 60 }, // challan / PSID
    status: { type: String, enum: ['submitted', 'verified', 'rejected'], default: 'submitted' },
    enteredBy: ref('User', true),
    verifiedBy: ref('User'),
    verifiedAt: Date,
  },
  opts,
);
entrySchema.plugin(tenantPlugin);
entrySchema.plugin(dataVersionPlugin);
entrySchema.index({ tenantId: 1, fy: 1, head: 1, unitId: 1, roUserId: 1, month: 1 }, { unique: true });
entrySchema.index({ tenantId: 1, fy: 1, anc: 1, status: 1 });
entrySchema.index({ tenantId: 1, status: 1, anc: 1 });
export const RevEntry = mongoose.model('RevEntry', entrySchema);

/* ---------------- Register items, e.g. audit paras (entered manually; independent of arrears) ---------------- */
const auditParaSchema = new Schema(
  {
    ...tenantField,
    /** Register key from the blueprint ('audit' for audit paras). */
    register: { type: String, required: true, default: 'audit', maxlength: 40 },
    unitId: ref('Unit', true),
    anc: [{ type: Schema.Types.ObjectId }],
    category: { type: String, required: true, maxlength: 80 },
    auditYear: { type: String, required: true }, // e.g. 2023-24
    paraNo: { type: String, required: true, maxlength: 30 },
    subject: { type: String, maxlength: 300 },
    amount: { type: Number, required: true, min: 0 }, // recoverable amount (demand)
    recovered: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['pending', 'settled'], default: 'pending' },
    settledAt: Date,
    remarks: { type: String, maxlength: 1000 },
    enteredBy: ref('User'),
  },
  opts,
);
auditParaSchema.plugin(tenantPlugin);
auditParaSchema.plugin(dataVersionPlugin);
auditParaSchema.index({ tenantId: 1, anc: 1, status: 1 });
auditParaSchema.index({ tenantId: 1, register: 1, unitId: 1, auditYear: 1, paraNo: 1 }, { unique: true });
export const AuditPara = mongoose.model('AuditPara', auditParaSchema);

/* ---------------- Tasks ---------------- */
const taskSchema = new Schema(
  {
    ...tenantField,
    title: { type: String, required: true, maxlength: 200 },
    details: { type: String, maxlength: 2000 },
    assignedBy: ref('User', true),
    assigneeId: ref('User', true),
    unitId: ref('Unit', true), // unit of the assignee's charge (drives roll-up)
    anc: [{ type: Schema.Types.ObjectId }],
    dueDate: { type: Date, required: true },
    priority: { type: String, enum: ['normal', 'high', 'urgent'], default: 'normal' },
    status: { type: String, enum: ['open', 'done'], default: 'open' },
    completedAt: Date,
    completionNote: { type: String, maxlength: 1000 },
  },
  opts,
);
taskSchema.plugin(tenantPlugin);
taskSchema.plugin(dataVersionPlugin);
taskSchema.index({ tenantId: 1, assigneeId: 1, status: 1, dueDate: 1 });
taskSchema.index({ tenantId: 1, assignedBy: 1, createdAt: -1 });
taskSchema.index({ tenantId: 1, anc: 1, dueDate: 1 });
export const Task = mongoose.model('Task', taskSchema);

/* ---------------- Assigned targets: short-term drives set by a supervisory officer ---------------- */
const assignedTargetSchema = new Schema(
  {
    ...tenantField,
    head: { type: String, required: true },
    assigneeId: ref('User', true),
    unitId: ref('Unit', true), // the assignee's charge unit
    anc: [{ type: Schema.Types.ObjectId }],
    assignedBy: ref('User', true),
    period: { type: String, enum: ['week', 'fortnight', 'month'], required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    targetValue: { type: Number, required: true, min: 1 }, // Rs for revenue heads, count for case heads
    achieved: { type: Number, default: 0, min: 0 },
    progress: [
      new Schema(
        {
          date: { type: Date, required: true },
          value: { type: Number, required: true, min: 0 },
          note: String,
          by: ref('User', true),
          // Progress counts only once verified by Wasil Baqi (revenue heads) or SCI (case heads)
          status: { type: String, enum: ['submitted', 'verified', 'rejected'], default: 'submitted' },
          verifiedBy: ref('User'),
          verifiedAt: Date,
        },
        { _id: true, timestamps: { createdAt: true, updatedAt: false } },
      ),
    ],
    achievedPending: { type: Number, default: 0 }, // submitted, not yet verified
    note: { type: String, maxlength: 500 },
    status: { type: String, enum: ['active', 'cancelled', 'stopped'], default: 'active' },
    stoppedAt: Date, // drive stopped early: share judged pro rata up to this date
    /** Set when this target is one circle's share of an area drive. */
    driveId: { type: Schema.Types.ObjectId, ref: 'TargetDrive', default: null },
    remainingAtAssign: { type: Number }, // the circle's remaining balance used for its share
  },
  opts,
);
assignedTargetSchema.plugin(tenantPlugin);
assignedTargetSchema.plugin(dataVersionPlugin);
assignedTargetSchema.index({ tenantId: 1, assigneeId: 1, endDate: -1 });
assignedTargetSchema.index({ tenantId: 1, assignedBy: 1, createdAt: -1 });
assignedTargetSchema.index({ tenantId: 1, anc: 1, startDate: 1 });
export const AssignedTarget = mongoose.model('AssignedTarget', assignedTargetSchema);

/* ---------------- Area drive: one target for an area, distributed to its circles by remaining balance ---------------- */
const targetDriveSchema = new Schema(
  {
    ...tenantField,
    head: { type: String, required: true },
    unitId: ref('Unit', true), // qanungoi / tehsil / district / division the drive is set for
    anc: [{ type: Schema.Types.ObjectId }],
    assignedBy: ref('User', true),
    period: { type: String, enum: ['week', 'fortnight', 'month'], required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    basis: { type: String, enum: ['percent', 'amount'], required: true },
    value: { type: Number, required: true, min: 0 }, // % of remaining, or total amount
    includeArrears: { type: Boolean, default: true },
    remainingTotal: { type: Number, required: true }, // remaining balance across staffed circles at assignment
    targetTotal: { type: Number, required: true }, // sum of the distributed shares
    shares: { type: Number, default: 0 },
    vacantCircles: { type: Number, default: 0 }, // circles skipped because no Patwari holds them
    note: { type: String, maxlength: 500 },
    status: { type: String, enum: ['active', 'cancelled', 'stopped'], default: 'active' },
    stoppedAt: Date,
    stoppedBy: ref('User'),
  },
  opts,
);
targetDriveSchema.plugin(tenantPlugin);
targetDriveSchema.plugin(dataVersionPlugin);
targetDriveSchema.index({ tenantId: 1, assignedBy: 1, createdAt: -1 });
targetDriveSchema.index({ tenantId: 1, anc: 1, startDate: -1 });
// DB guard: at most one active drive per KPI and area
targetDriveSchema.index({ tenantId: 1, head: 1, unitId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
export const TargetDrive = mongoose.model('TargetDrive', targetDriveSchema);

/* ---------------- Scoring overrides (organisation default, or per area) — weights per profile and block ---------------- */
const scoreConfigSchema = new Schema(
  {
    ...tenantField,
    scopeUnitId: { type: Schema.Types.ObjectId, ref: 'Unit', default: null },
    /** { [profileKey]: { [blockKey]: weight } } — keys come from the blueprint. */
    blocks: { type: Schema.Types.Mixed, default: {} },
    heads: { type: Map, of: Number },
    updatedBy: ref('User'),
  },
  opts,
);
scoreConfigSchema.plugin(tenantPlugin);
scoreConfigSchema.plugin(dataVersionPlugin);
scoreConfigSchema.index({ tenantId: 1, scopeUnitId: 1 }, { unique: true });
export const ScoreConfig = mongoose.model('ScoreConfig', scoreConfigSchema);

/* ---------------- Notification ---------------- */
const notificationSchema = new Schema(
  {
    ...tenantField,
    userId: ref('User', true),
    type: { type: String, required: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, maxlength: 1000 },
    link: String,
    readAt: Date,
  },
  opts,
);
notificationSchema.plugin(tenantPlugin);
notificationSchema.index({ tenantId: 1, userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });
export const Notification = mongoose.model('Notification', notificationSchema);

/* ---------------- WhatsApp messages (outbox + inbox) ---------------- */
const waMessageSchema = new Schema(
  {
    ...tenantField,
    userId: ref('User'),
    phone: { type: String, required: true },
    direction: { type: String, enum: ['out', 'in'], required: true },
    kind: { type: String, required: true }, // morning | followup | evening | warning | supervisor | reply | test | inbound
    text: { type: String, maxlength: 4096 },
    status: { type: String, enum: ['queued', 'sending', 'retrying', 'sent', 'failed', 'received', 'skipped'], default: 'queued' },
    provider: String,
    providerId: String,
    error: String,
    day: String, // YYYY-MM-DD in the organisation's timezone
    sentAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
waMessageSchema.plugin(tenantPlugin);
waMessageSchema.index({ tenantId: 1, createdAt: -1 });
waMessageSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
waMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });
export const WaMessage = mongoose.model('WaMessage', waMessageSchema);

/** Escalation ladder state per person. */
const waStateSchema = new Schema(
  {
    ...tenantField,
    userId: ref('User', true),
    behindDays: { type: Number, default: 0 },
    level: { type: Number, default: 0 }, // 0 ok · 1 nudge · 2 under review · 3 disciplinary warning
    lastDay: String,
    lastReason: String,
    history: [{ day: String, level: Number, reason: String, _id: false }],
    /** On leave (YYYY-MM-DD, inclusive): no messages, days not counted towards warnings. */
    leaveFrom: String,
    leaveUntil: String,
    leaveNote: { type: String, maxlength: 200 },
    leaveSetBy: ref('User'),
  },
  opts,
);
waStateSchema.plugin(tenantPlugin);
waStateSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
waStateSchema.index({ tenantId: 1, level: -1 });
export const WaState = mongoose.model('WaState', waStateSchema);

/* ---------------- Access grants: rights given to a person directly, on top of their posts ----------------
 * A grant covers a unit and everything below it, optionally only some KPIs, optionally until a date.
 */
export const GRANT_RIGHTS = ['view', 'enter', 'edit', 'verify', 'set_targets', 'assign_targets', 'compare', 'manage_registers', 'litigation', 'state_land', 'state_land_verify', 'state_land_approve'] as const;
export type GrantRight = (typeof GRANT_RIGHTS)[number];
const accessGrantSchema = new Schema(
  {
    ...tenantField,
    userId: ref('User', true),
    unitId: ref('Unit', true),
    anc: [{ type: Schema.Types.ObjectId }],
    rights: [{ type: String, enum: GRANT_RIGHTS }],
    /** KPI codes the grant is limited to (empty = every KPI). */
    metrics: [{ type: String }],
    expiresAt: { type: Date, default: null },
    note: { type: String, maxlength: 300 },
    grantedBy: ref('User'),
  },
  opts,
);
accessGrantSchema.plugin(tenantPlugin);
accessGrantSchema.plugin(dataVersionPlugin);
accessGrantSchema.index({ tenantId: 1, userId: 1 });
accessGrantSchema.index({ tenantId: 1, unitId: 1 });
export const AccessGrant = mongoose.model('AccessGrant', accessGrantSchema);

/* ---------------- Pre-computed period statistics (rebuilt by the "rollup" job) ----------------
 * One document per unit × period. Every unit holds the totals of its whole subtree, so any view of
 * any area for any period is a single indexed read.
 *   period  w = week · f = 15 days (1st–15th, 16th–end) · m = month · q = quarter · h = half year · y = year
 *   heads   per KPI: cur / arr achieved (target KPIs), rec / disp (workload KPIs), pend = awaiting verification
 *           year documents also carry the annual t (target), ad (arrears demand) and open (opening pending)
 * Month and longer periods use the month the figures belong to; week and 15-day periods use the date
 * figures were verified, plus verified progress against assigned targets.
 */
const rollupSchema = new Schema(
  {
    ...tenantField,
    unitId: ref('Unit', true),
    fy: { type: String, required: true },
    period: { type: String, enum: ['w', 'f', 'm', 'q', 'h', 'y'], required: true },
    key: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    heads: { type: Schema.Types.Mixed, default: {} },
    tasks: { due: Number, onTime: Number },
    progress: { type: Number, default: 0 }, // verified assigned-target progress (w / f)
    builtAt: { type: Date, required: true },
  },
  { minimize: false },
);
rollupSchema.plugin(tenantPlugin);
// fy is part of the key: an ISO week spanning the year start exists once in each year
rollupSchema.index({ tenantId: 1, unitId: 1, fy: 1, period: 1, key: 1 }, { unique: true });
rollupSchema.index({ tenantId: 1, fy: 1, period: 1, key: 1 });
export const Rollup = mongoose.model('Rollup', rollupSchema);

/* ---------------- Audit log ---------------- */
const auditSchema = new Schema(
  {
    ...tenantField,
    actorId: ref('User'),
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: Schema.Types.ObjectId,
    meta: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.plugin(tenantPlugin);
auditSchema.index({ tenantId: 1, createdAt: -1 });
export const Audit = mongoose.model('Audit', auditSchema);

/* ---------------- Tameel: information requests (an Excel format filled in by staff, per unit) ---------------- */
const tameelSchema = new Schema(
  {
    ...tenantField,
    title: { type: String, required: true, trim: true, maxlength: 200 },
    /** Clear instructions shown to everyone who must fill it in. */
    description: { type: String, required: true, maxlength: 5000 },
    deadline: { type: Date, required: true },
    /** Columns from the uploaded Excel header row (key = stable id, label = header text). */
    /** proforma: an Excel format filled in row by row · task: a to-do / directive marked Done with a note */
    kind: { type: String, enum: ['proforma', 'task'], default: 'proforma' },
    columns: [{ key: { type: String, required: true }, label: { type: String, required: true }, _id: false }],
    sourceFile: String,
    /** Area covered, and the posts that must fill it in (one sheet per unit they hold inside the area). */
    unitId: ref('Unit', true),
    anc: [{ type: Schema.Types.ObjectId }],
    posts: { type: [String], default: ['patwari'] },
    /** Level whose combined Excel file is kept (e.g. tehsil). */
    groupLevel: { type: String, required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    createdBy: ref('User', true),
  },
  opts,
);
tameelSchema.plugin(tenantPlugin);
tameelSchema.index({ tenantId: 1, status: 1, deadline: 1 });
tameelSchema.index({ tenantId: 1, anc: 1 });
export const Tameel = mongoose.model('Tameel', tameelSchema);

/** One unit's sheet for a Tameel. */
const tameelSheetSchema = new Schema(
  {
    ...tenantField,
    tameelId: ref('Tameel', true),
    unitId: ref('Unit', true),
    anc: [{ type: Schema.Types.ObjectId }],
    groupId: ref('Unit'), // e.g. the tehsil
    rows: [{ values: { type: Schema.Types.Mixed, default: {} }, updatedBy: ref('User'), updatedAt: Date }],
    status: { type: String, enum: ['draft', 'submitted', 'returned', 'accepted'], default: 'draft' },
    returnNote: { type: String, maxlength: 1000 },
    /** To-do tasks: what was done (written when marking Done). */
    doneNote: { type: String, maxlength: 2000 },
    submittedBy: ref('User'),
    submittedAt: Date,
    history: [{ at: Date, by: ref('User'), action: String, note: String, _id: false }],
  },
  opts,
);
tameelSheetSchema.plugin(tenantPlugin);
tameelSheetSchema.index({ tenantId: 1, tameelId: 1, unitId: 1 }, { unique: true });
tameelSheetSchema.index({ tenantId: 1, tameelId: 1, groupId: 1 });
export const TameelSheet = mongoose.model('TameelSheet', tameelSheetSchema);

/** Combined Excel file per group (e.g. tehsil), rebuilt on every submission and kept on the server. */
const tameelFileSchema = new Schema(
  {
    ...tenantField,
    tameelId: ref('Tameel', true),
    groupId: ref('Unit', true),
    name: String,
    data: { type: Buffer, required: true },
    rows: Number,
    builtAt: Date,
  },
  opts,
);
tameelFileSchema.plugin(tenantPlugin);
tameelFileSchema.index({ tenantId: 1, tameelId: 1, groupId: 1 }, { unique: true });
export const TameelFile = mongoose.model('TameelFile', tameelFileSchema);

/* ---------------- Litigation: court cases affecting land in a jurisdiction ---------------- */
const hearingSchema = new Schema(
  {
    date: { type: Date, required: true },
    court: String,
    proceedingsDone: { type: String, maxlength: 3000 },
    nextAction: { type: String, maxlength: 3000 },
    nextDate: Date,
    attendedBy: { type: String, maxlength: 200 },
    by: ref('User'),
  },
  { _id: true, timestamps: { createdAt: true, updatedAt: false } },
);
const stageSchema = new Schema(
  {
    stage: { type: Number, required: true },
    court: { type: String, required: true },
    courtOther: String,
    bench: String,
    courtCaseNo: String,
    institutedOn: Date,
    decidedOn: Date,
    result: String,
    summary: { type: String, maxlength: 3000 },
  },
  { _id: false },
);
const litigationCaseSchema = new Schema(
  {
    ...tenantField,
    caseId: { type: String, required: true }, // TEHSIL-MOUZA-NNNN, permanent
    serial: { type: Number, required: true }, // per tehsil
    unitId: ref('Unit', true), // mouza
    anc: [{ type: Schema.Types.ObjectId }],
    tehsilId: ref('Unit'),
    caseType: { type: String, required: true, maxlength: 120 },
    institutedOn: { type: Date, required: true },
    court: { type: String, required: true },
    courtOther: { type: String, maxlength: 200 },
    bench: { type: String, maxlength: 200 },
    courtCaseNo: { type: String, maxlength: 100 },
    applicants: { type: [String], default: [] },
    respondents: { type: [String], default: [] },
    land: { kanal: Number, marla: Number, feet: Number, murabba: String, khasraNos: { type: [String], default: [] }, parcels: { type: [{ _id: false, murabba: String, khasras: [String] }], default: [] }, khewat: String, khatauni: String },
    landSpec: { type: String, maxlength: 1000 },
    governmentParty: { type: Boolean, default: false },
    hearings: [hearingSchema],
    lastHearing: Date,
    nextHearing: Date,
    lastProceedings: String,
    nextAction: String,
    status: { type: String, enum: ['pending', 'decided'], default: 'pending' },
    decision: { date: Date, result: String, summary: { type: String, maxlength: 3000 } },
    appeal: { filed: { type: String, enum: ['yes', 'no', 'undecided'], default: 'undecided' }, court: String, courtOther: String, filedOn: Date, appealNo: String, reasonNotFiled: { type: String, maxlength: 1000 } },
    stage: { type: Number, default: 1 },
    stages: [stageSchema],
    note: { type: String, maxlength: 3000 },
    notes: [{ text: { type: String, maxlength: 2000 }, by: ref('User'), at: Date, _id: false }],
    history: [{ at: Date, by: ref('User'), action: String, fields: [String], _id: false }],
    createdBy: ref('User'),
    updatedBy: ref('User'),
    deleted: { type: Boolean, default: false },
  },
  opts,
);
litigationCaseSchema.plugin(tenantPlugin);
litigationCaseSchema.index({ tenantId: 1, caseId: 1 }, { unique: true });
litigationCaseSchema.index({ tenantId: 1, anc: 1, status: 1, nextHearing: 1 });
litigationCaseSchema.index({ tenantId: 1, deleted: 1, updatedAt: -1 });
litigationCaseSchema.index({ caseId: 'text', applicants: 'text', respondents: 'text', courtCaseNo: 'text', 'land.khasraNos': 'text' });
export const LitigationCase = mongoose.model('LitigationCase', litigationCaseSchema);

/** Atomic running numbers (e.g. litigation serial per tehsil). */
const counterSchema = new Schema({ ...tenantField, key: { type: String, required: true }, seq: { type: Number, default: 0 } });
counterSchema.plugin(tenantPlugin);
counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });
export const Counter = mongoose.model('Counter', counterSchema);

/** A document attached to a case; the file itself lives in storage (GridFS now, cloud later). */
const litigationDocSchema = new Schema(
  {
    ...tenantField,
    caseRef: ref('LitigationCase', true),
    stage: { type: Number, default: 1 },
    category: { type: String, enum: ['plaint', 'reply', 'order_sheet', 'judgment', 'evidence', 'notice', 'other'], required: true },
    title: { type: String, maxlength: 200 },
    docDate: Date,
    backend: { type: String, default: 'gridfs' },
    storageKey: { type: String, required: true },
    mime: { type: String, required: true },
    size: Number,
    pages: Number,
    uploadedBy: ref('User'),
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
litigationDocSchema.plugin(tenantPlugin);
litigationDocSchema.index({ tenantId: 1, caseRef: 1, category: 1 });
export const LitigationDoc = mongoose.model('LitigationDoc', litigationDocSchema);

/* ---------------- State Land Directory: every state-owned holding in each mouza ---------------- */
const areaFields = { kanal: Number, marla: Number, feet: Number };
const stateLandSchema = new Schema(
  {
    ...tenantField,
    // One record per khasra: Murabba / Mustateel no. → killa (1–25) → optional sub-killa
    holdingId: { type: String, required: true }, // TEHSIL-MOUZA-MURABBA//KILLA[/SUB], readable reference
    unitId: ref('Unit', true), // mouza
    anc: [{ type: Schema.Types.ObjectId }],
    tehsilId: ref('Unit'),
    murabba: { type: String, required: true },
    killa: { type: Number, required: true, min: 1, max: 25 },
    subKilla: { type: String, default: '' },
    khasraNo: { type: String, required: true }, // "45//12" or "45//12/1"
    khewat: String,
    khatauni: String,
    jamabandiYear: String,
    // Area of this khasra (kanal / marla / square feet)
    area: areaFields,
    acres: Number, // derived from area
    // Classification and ownership
    category: { type: String, required: true },
    subType: String,
    // As per record (jamabandi): khana malkiyat (ownership) and khana kasht (possession as recorded)
    ownerRecord: { type: String, maxlength: 200 },
    ownerShare: String,
    kasht: { type: { type: String }, names: { type: [String], default: [] } },
    // Physical possession at site, and the nature of the land there
    site: { possessedBy: String, names: { type: [String], default: [] }, nature: { type: [String], default: [] } },
    custodian: { type: String, maxlength: 200 },
    landClass: String,
    use: String,
    structures: { type: String, maxlength: 500 },
    // Acquisition (Land Acquisition Act)
    acquisition: { department: String, purpose: String, awardNo: String, awardDate: Date, compensation: { type: String, enum: ['yes', 'no', 'partly', null] }, compensationAmount: Number, mutationNo: String, mutationDate: Date },
    // Allotment / lease (rent and arrears stay with the Lease Money KPI)
    allotment: { scheme: String, allottee: String, parentage: String, orderNo: String, orderDate: Date, authority: String, leaseFrom: Date, leaseTo: Date, conditionsMet: { type: String, enum: ['yes', 'no', 'review', null] }, proprietary: { type: String, enum: ['granted', 'pending', 'na', null] }, mutationNo: String },
    // Possession and encroachment
    possession: { type: String, required: true },
    encroachment: { area: areaFields, acres: Number, encroachers: { type: [String], default: [] }, nature: String, since: Number, action: String, retrievedOn: Date, retrievedArea: areaFields },
    // Litigation
    underLitigation: { type: Boolean, default: false },
    litigationIds: [{ type: Schema.Types.ObjectId, ref: 'LitigationCase' }],
    // Record and digitisation
    record: { status: { type: String, required: true }, mutationNos: String, demarcation: { type: String, enum: ['yes', 'no', null] }, demarcationDate: Date, demarcationRef: String, computerised: { type: String, enum: ['yes', 'no', 'unchecked', null] }, discrepancy: { type: String, maxlength: 1000 } },
    lastVisit: Date,
    note: { type: String, maxlength: 2000 },
    /** Note on litigation / encroachment, and encumbrance (mortgage, stay order, lease …) as entered in the table. */
    issueNote: { type: String, maxlength: 1000 },
    encumbrance: { type: String, maxlength: 500 },
    // Two-step verification: Girdawar verifies, Tehsildar / Naib Tehsildar approves
    status: { type: String, enum: ['entered', 'verified', 'approved', 'returned'], default: 'entered' },
    verifiedBy: ref('User'),
    verifiedAt: Date,
    approvedBy: ref('User'),
    approvedAt: Date,
    returnRemarks: { type: String, maxlength: 1000 },
    history: [{ at: Date, by: ref('User'), action: String, remarks: String, _id: false }],
    createdBy: ref('User'),
    updatedBy: ref('User'),
    deleted: { type: Boolean, default: false },
  },
  opts,
);
stateLandSchema.plugin(tenantPlugin);
// A khasra is entered once per mouza (removed entries do not block re-entry)
stateLandSchema.index({ tenantId: 1, unitId: 1, murabba: 1, killa: 1, subKilla: 1 }, { unique: true, partialFilterExpression: { deleted: false } });
stateLandSchema.index({ tenantId: 1, holdingId: 1 });
stateLandSchema.index({ tenantId: 1, anc: 1, category: 1, status: 1 });
stateLandSchema.index({ tenantId: 1, deleted: 1, updatedAt: -1 });
export const StateLand = mongoose.model('StateLand', stateLandSchema);

const stateLandDocSchema = new Schema(
  {
    ...tenantField,
    holdingRef: ref('StateLand', true),
    category: { type: String, enum: ['fard', 'shajra', 'mutation', 'award', 'allotment', 'demarcation', 'photo', 'other'], required: true },
    title: { type: String, maxlength: 200 },
    docDate: Date,
    backend: { type: String, default: 'gridfs' },
    storageKey: { type: String, required: true },
    mime: { type: String, required: true },
    size: Number,
    pages: Number,
    uploadedBy: ref('User'),
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
stateLandDocSchema.plugin(tenantPlugin);
stateLandDocSchema.index({ tenantId: 1, holdingRef: 1, category: 1 });
export const StateLandDoc = mongoose.model('StateLandDoc', stateLandDocSchema);

/** Per mouza: the Patwari marks the state land listing complete, the Girdawar confirms it. */
const stateLandMouzaSchema = new Schema(
  {
    ...tenantField,
    unitId: ref('Unit', true),
    anc: [{ type: Schema.Types.ObjectId }],
    complete: { type: Boolean, default: false },
    completedBy: ref('User'),
    completedAt: Date,
    confirmed: { type: Boolean, default: false },
    confirmedBy: ref('User'),
    confirmedAt: Date,
  },
  opts,
);
stateLandMouzaSchema.plugin(tenantPlugin);
stateLandMouzaSchema.index({ tenantId: 1, unitId: 1 }, { unique: true });
stateLandMouzaSchema.index({ tenantId: 1, anc: 1 });
export const StateLandMouza = mongoose.model('StateLandMouza', stateLandMouzaSchema);
