import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';

export interface AccessPayload {
  sub: string;
  tid: string;
  role: string;
  tv: number;
  /** Read-only guest (demo) session. */
  ro?: boolean;
}

export const signAccessToken = (p: AccessPayload) =>
  jwt.sign(p, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'], issuer: 'kpi' });

export const verifyAccessToken = (token: string) =>
  jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'kpi' }) as AccessPayload;

export const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');

export const hashToken = (token: string) =>
  crypto.createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex');
