import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.isProd ? 'info' : 'debug',
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash'],
  transport: env.isProd ? undefined : { target: 'pino-pretty', options: { colorize: true } },
});

const SECRET_PARAMS = /([?&](?:secret|token|access_token|hub\.verify_token|hub%2Everify_token)=)[^&#]*/gi;
export const maskUrl = (url: string) => url.replace(SECRET_PARAMS, '$1[REDACTED]');

/** pino-http req serializer: masks secrets passed in query strings (e.g. webhook ?secret=). */
export const redactReqUrl = (req: any) => {
  if (req && typeof req.url === 'string') req.url = maskUrl(req.url);
  if (req?.query && typeof req.query === 'object') {
    req.query = { ...req.query }; // serialized req shares the live query object: copy before masking
    for (const k of Object.keys(req.query)) if (/^(secret|token|access_token|hub\.verify_token)$/i.test(k)) req.query[k] = '[REDACTED]';
  }
  return req;
};
