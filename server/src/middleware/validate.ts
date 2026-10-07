import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { z, type ZodTypeAny } from 'zod';

export const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');

/** Validates and replaces req.body / req.query / req.params with parsed (whitelisted) values. */
export const validate =
  (schemas: { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny }) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (schemas.params) req.params = schemas.params.parse(req.params);
    if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
    // req.query is a getter in Express 5; store parsed query separately.
    if (schemas.query) (req as any).q = schemas.query.parse(req.query);
    next();
  };

export const idParam = z.object({ id: objectId });

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
});

export const q = <T>(req: Request): T => (req as any).q as T;
