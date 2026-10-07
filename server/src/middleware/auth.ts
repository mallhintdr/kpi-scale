import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { runWithContext, runUnscoped } from '../lib/tenantContext.js';
import { Tenant, User, type Role } from '../models/index.js';

export interface AuthUser {
  id: string;
  tenantId: string;
  role: Role;
  name: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Verifies the bearer token, re-checks the user is still active, and binds the tenant context. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(header.slice(7));
  } catch {
    throw unauthorized('Session expired');
  }

  const [user, tenant] = await runUnscoped(() =>
    Promise.all([
      User.findOne({ _id: payload.sub, tenantId: payload.tid })
        .select('name email role status tokenVersion')
        .lean(),
      Tenant.findById(payload.tid).select('status').lean(),
    ]),
  );
  if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) throw unauthorized('Session revoked');
  if (!tenant || tenant.status !== 'active') throw forbidden('Organisation is suspended');

  req.user = {
    id: String(user._id),
    tenantId: payload.tid,
    role: user.role as Role,
    name: user.name,
    email: user.email,
  };
  runWithContext({ tenantId: payload.tid, userId: req.user.id }, () => next());
}

const RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2, owner: 3 };

/** Allow the request if the user's role is at least `min`. */
export const requireRole =
  (min: Role) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (RANK[req.user.role] < RANK[min]) throw forbidden();
    next();
  };

export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];
