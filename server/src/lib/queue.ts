/**
 * Background jobs on BullMQ (Redis). Without REDIS_URL jobs run inline on the next tick so
 * development and single-instance installs work unchanged.
 *
 * Every job carries `tenantId` and runs inside that organisation's tenant scope.
 */
import { Queue, Worker, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { bullConnection } from './redis.js';
import { runAsTenant } from './tenantContext.js';

export interface JobData {
  tenantId: string;
  [k: string]: unknown;
}
type Handler = (data: JobData) => Promise<unknown>;

const QUEUE = 'kpi';
const handlers = new Map<string, Handler>();
let queue: Queue | null = null;
let worker: Worker | null = null;

export function defineJob(name: string, handler: Handler) {
  handlers.set(name, handler);
}

const run = (name: string, data: JobData) => {
  const h = handlers.get(name);
  if (!h) throw new Error(`No handler for job "${name}"`);
  // Platform-wide jobs (no tenant) handle their own scoping
  return data.tenantId ? runAsTenant(data.tenantId, () => h(data)) : h(data);
};

/**
 * Queue a job. `jobId` de-duplicates: while a job with that id is waiting, adding another is a no-op
 * (used to coalesce bursts, e.g. many entries saved → one cache warm-up).
 */
export async function enqueue(name: string, data: JobData, opts: Pick<JobsOptions, 'jobId' | 'delay' | 'priority'> = {}) {
  if (!env.REDIS_URL) {
    setTimeout(() => run(name, data).catch((err) => logger.error({ err, job: name }, 'inline job failed')), opts.delay ?? 0).unref?.();
    return;
  }
  queue ??= new Queue(QUEUE, { connection: bullConnection() });
  await queue.add(name, data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
    ...opts,
  });
}

const schedules: { name: string; pattern: string }[] = [];
/** Run a job on a daily cron pattern "m h * * *" (registered when a worker starts). */
export function schedule(name: string, pattern: string) {
  schedules.push({ name, pattern });
}

function startInlineSchedules() {
  let lastRun = '';
  setInterval(() => {
    const now = new Date();
    for (const s of schedules) {
      const [m, h] = s.pattern.split(' ').map(Number);
      const tag = `${s.name}${now.toDateString()}`;
      if (now.getHours() === h && now.getMinutes() >= m && !lastRun.includes(tag)) {
        lastRun += tag;
        const hdl = handlers.get(s.name);
        hdl?.({ tenantId: '' }).catch((err) => logger.error({ err, job: s.name }, 'scheduled job failed'));
      }
    }
  }, 60_000).unref();
}

/** Start processing jobs in this process. */
export function startWorker(concurrency = Number(process.env.WORKER_CONCURRENCY ?? 8)) {
  if (!env.REDIS_URL) {
    startInlineSchedules();
    return;
  }
  if (worker) return;
  queue ??= new Queue(QUEUE, { connection: bullConnection() });
  for (const s of schedules) {
    queue.upsertJobScheduler(`cron-${s.name}`, { pattern: s.pattern }, { name: s.name, data: { tenantId: '' } }).catch((err) => logger.warn({ err }, 'scheduler registration failed'));
  }
  worker = new Worker(QUEUE, async (job) => run(job.name, job.data as JobData), { connection: bullConnection(), concurrency });
  worker.on('failed', (job, err) => logger.error({ err, job: job?.name, id: job?.id }, 'job failed'));
  logger.info({ concurrency }, 'Job worker started');
}

export async function stopQueue() {
  await Promise.allSettled([worker?.close(), queue?.close()]);
  worker = null;
  queue = null;
}

/** Job status for the client (imports). */
export async function jobStatus(id: string) {
  if (!env.REDIS_URL) return null;
  queue ??= new Queue(QUEUE, { connection: bullConnection() });
  const job = await queue.getJob(id);
  if (!job) return null;
  return { id: job.id, name: job.name, state: await job.getState(), progress: job.progress, result: job.returnvalue, error: job.failedReason, tenantId: (job.data as JobData).tenantId };
}
