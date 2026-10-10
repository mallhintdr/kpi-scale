/**
 * Phone numbers to E.164 ("+923001234567"). Pakistan rules first (03xx…, 92…), else a "+" prefix.
 * Returns '' for group / broadcast JIDs and invalid lengths — treat '' as "ignore".
 */
export function normalizePhone(input: unknown): string {
  if (input == null) return '';
  let s = String(input).trim();
  if (!s || /@g\.us$|@broadcast$|status@/.test(s)) return '';
  s = s.replace(/@.*$/, ''); // JID suffix
  const plus = s.startsWith('+');
  let d = s.replace(/[^\d]/g, '');
  if (!d) return '';
  if (!plus) {
    if (/^03\d{9}$/.test(d)) d = `92${d.slice(1)}`; // 0300-1234567 → 92300…
    else if (/^3\d{9}$/.test(d)) d = `92${d}`; // 300-1234567
    else if (d.startsWith('0092')) d = d.slice(2);
  }
  if (d.length < 8 || d.length > 15) return '';
  return `+${d}`;
}
