/**
 * Title Case for headings, labels, tabs and buttons ("Good morning, Ali" → "Good Morning, Ali").
 * Short connecting words stay lowercase unless first ("Rank of Staff in the Division"); words already
 * containing capitals or digits are left alone (KPI, FY, Rs, AIT, 236-C, iPhone); names are untouched
 * because they are already capitalised. Sentences (help text, messages) should not be passed here.
 */
import { Children, isValidElement, type ReactNode } from 'react';

const MINOR = new Set(['a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'vs', 'per', 'with', 'from', 'as', 'via', 'into']);

export function titleCase(s: string): string {
  let first = true;
  return s.replace(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu, (word, offset: number) => {
    const before = s.slice(0, offset);
    // Start of the text, or right after a separator such as "—", ":", "·", "(" or "/": capitalise
    const startsPhrase = first || /[—–:·(/|•]\s*$/.test(before);
    first = false;
    if (/[A-Z\d]/.test(word.slice(1)) || /^\d/.test(word) || /[^\x00-\x7F]/.test(word[0])) return word; // acronyms, codes, non-Latin
    const lower = word.toLowerCase();
    if (!startsPhrase && MINOR.has(lower)) return lower;
    return word[0].toUpperCase() + word.slice(1);
  });
}

/** Title-case plain strings inside a ReactNode, leaving elements (icons, links, numbers) as they are. */
export function titleNode(node: ReactNode): ReactNode {
  if (typeof node === 'string') return titleCase(node);
  if (Array.isArray(node)) return Children.map(node, (c) => (typeof c === 'string' ? titleCase(c) : c));
  if (isValidElement(node)) return node;
  return node;
}
