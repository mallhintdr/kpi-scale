// Validates every starter template against the blueprint schema and prints a summary.
// Usage: npx tsx scripts/check-templates.ts
import { blueprintSchema } from '../src/modules/org/blueprint.js';
import { TEMPLATES } from '../src/modules/org/templates.js';

let bad = 0;
for (const [key, t] of Object.entries(TEMPLATES)) {
  const r = blueprintSchema.safeParse(t.blueprint);
  if (!r.success) {
    bad++;
    console.log(`✗ ${key}\n   ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('\n   ')}`);
    continue;
  }
  const b = r.data;
  const weights = b.profiles.map((p) => Object.values(p.weights).reduce((s, w) => s + w, 0));
  console.log(`✓ ${t.category.padEnd(22)} ${key.padEnd(24)} ${b.levels.length} levels · ${b.posts.length} posts · ${b.metrics.length} KPIs · ${b.registers.length} register · weights ${weights.join('/')}`);
}
console.log(`\n${Object.keys(TEMPLATES).length} templates, ${bad} invalid`);
process.exit(bad ? 1 : 0);
