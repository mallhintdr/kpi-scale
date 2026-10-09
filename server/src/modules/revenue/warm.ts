/**
 * Cache warm-up: after an organisation's data changes, recompute the top-level fact sets in the
 * background so the next dashboard view is served from cache instead of five fresh aggregations.
 * Bursts of writes (a sheet of entries, an import) coalesce into one job per 5-second window.
 */
import { onDataChange } from '../../lib/dataVersion.js';
import { logger } from '../../lib/logger.js';
import { defineJob, enqueue } from '../../lib/queue.js';
import { Unit } from '../../models/index.js';
import { getBlueprint } from '../org/service.js';
import { loadFacts } from './scoring.js';

defineJob('warm', async (d) => {
  const bp = await getBlueprint(String(d.tenantId));
  if (!bp) return;
  const fy = bp.fy.of(new Date());
  const tops = await Unit.find({ type: bp.topLevel }).select('_id').lean();
  for (const t of tops) await loadFacts(t._id, fy, bp);
});

const recent = new Map<string, number>();
onDataChange((tenantId) => {
  const slot = Math.floor(Date.now() / 5000);
  if (recent.get(tenantId) === slot) return;
  recent.set(tenantId, slot);
  enqueue('warm', { tenantId }, { jobId: `warm-${tenantId}-${slot}`, delay: 5000 }).catch((err) => logger.warn({ err }, 'warm enqueue failed'));
});
