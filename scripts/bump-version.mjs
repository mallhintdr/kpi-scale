#!/usr/bin/env node
// Next version for every update: 2.1.8 → 2.1.9 → 2.2.0 … 2.9.9 → 3.0.0 (each part runs 0–9).
// Writes VERSION and the server / web package.json versions.   Usage: node scripts/bump-version.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'VERSION');
const [major, minor, patch] = readFileSync(file, 'utf8').trim().split('.').map(Number);
let v = [major, minor, patch + 1];
if (v[2] > 9) v = [v[0], v[1] + 1, 0];
if (v[1] > 9) v = [v[0] + 1, 0, 0];
const next = v.join('.');
writeFileSync(file, `${next}\n`);
for (const pkg of ['server/package.json', 'web/package.json']) {
  const p = join(root, pkg);
  const json = readFileSync(p, 'utf8');
  writeFileSync(p, json.replace(/"version": "[^"]*"/, `"version": "${next}"`));
}
console.log(`${major}.${minor}.${patch} → ${next}`);
