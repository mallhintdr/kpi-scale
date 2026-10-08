import mongoose, { Schema, type InferSchemaType, type Types } from 'mongoose';
import { tenantPlugin } from '../lib/tenantPlugin.js';
import { AUDIT_CATEGORIES, BLOCKS, LEVELS, POSTS, UNIT_TYPES } from '../modules/revenue/catalog.js';

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
    settings: {
      timezone: { type: String, default: 'Asia/Karachi' },
      currency: { type: String, default: 'PKR' },
      ratingScale: { type: Number, default: 5 },
    },
  },
  opts,
);
export const Tenant = mongoose.model('Tenant', tenantSchema);

/* ---------------- User ---------------- */
// App-level role. Operational authority comes from postings (Charge), not from this role.
export const ROLES = ['owner', 'admin', 'manager', 'employee'] as const;
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
    status: { type: String, enum: ['active', 'invited', 'disabled'], default: 'active' },
    lastLoginAt: Date,
    tokenVersion: { type: Number, default: 0 },
  },
  opts,
);
userSchema.plugin(tenantPlugin);
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
  },
  opts,
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1 });
export const Session = mongoose.model('Session', sessionSchema);

/* ---------------- Territory: Division › District › Tehsil › Qanungoi › Patwar Circle › Mouza ---------------- */
const unitSchema = new Schema(
  {
    ...tenantField,
    type: { type: String, enum: UNIT_TYPES, required: true },
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
unitSchema.index({ tenantId: 1, parentId: 1, name: 1 });
unitSchema.index({ tenantId: 1, anc: 1, type: 1 });
export const Unit = mongoose.model('Unit', unitSchema);

/* ---------------- Charge: who holds which unit, and when ---------------- */
const chargeSchema = new Schema(
  {
    ...tenantField,
    userId: ref('User', true),
    unitId: ref('Unit', true),
    post: { type: String, enum: POSTS, required: true },
    /** A Tehsildar's directly-held qanungois are recorded as post 'tehsildar' on a qanungoi unit. */
    chargeType: { type: String, enum: ['regular', 'additional', 'look_after'], default: 'regular' },
    from: { type: Date, required: true },
    to: { type: Date, default: null },
  },
  opts,
);
chargeSchema.plugin(tenantPlugin);
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
entrySchema.index({ tenantId: 1, fy: 1, head: 1, unitId: 1, roUserId: 1, month: 1 }, { unique: true });
entrySchema.index({ tenantId: 1, fy: 1, anc: 1, status: 1 });
entrySchema.index({ tenantId: 1, status: 1, anc: 1 });
export const RevEntry = mongoose.model('RevEntry', entrySchema);

/* ---------------- Audit paras (entered manually; independent of arrears) ---------------- */
const auditParaSchema = new Schema(
  {
    ...tenantField,
    unitId: ref('Unit', true), // tehsil or patwar circle
    anc: [{ type: Schema.Types.ObjectId }],
    category: { type: String, enum: AUDIT_CATEGORIES, required: true },
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
auditParaSchema.index({ tenantId: 1, anc: 1, status: 1 });
auditParaSchema.index({ tenantId: 1, unitId: 1, auditYear: 1, paraNo: 1 }, { unique: true });
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
targetDriveSchema.index({ tenantId: 1, assignedBy: 1, createdAt: -1 });
targetDriveSchema.index({ tenantId: 1, anc: 1, startDate: -1 });
export const TargetDrive = mongoose.model('TargetDrive', targetDriveSchema);

/* ---------------- Scoring configuration (organisation default, or per division / district / tehsil) ---------------- */
const blockShape = Object.fromEntries(BLOCKS.map((b) => [b, { type: Number, min: 0, max: 100 }]));
const scoreConfigSchema = new Schema(
  {
    ...tenantField,
    scopeUnitId: { type: Schema.Types.ObjectId, ref: 'Unit', default: null },
    blocks: new Schema(Object.fromEntries(LEVELS.map((l) => [l, new Schema(blockShape, { _id: false })])), { _id: false }),
    heads: { type: Map, of: Number },
    updatedBy: ref('User'),
  },
  opts,
);
scoreConfigSchema.plugin(tenantPlugin);
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
