/**
 * Draw long lists a page at a time. Thousands of officers × KPIs would otherwise put ~100,000 elements
 * on the page and freeze a phone for half a minute. The first `step` items render immediately; more are
 * added as the user scrolls near the end (an invisible marker row is watched).
 *
 * Print and Excel need every row: call `withAll(fn)` — it renders everything, waits for the browser to
 * paint, runs `fn`, then returns to paged drawing. Printing from the browser menu is handled too.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export function useProgressive(total: number, step = 40, resetKey?: unknown) {
  const [count, setCount] = useState(step);
  const [all, setAll] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);

  // New data (another area, post or year): start again from the top
  useEffect(() => setCount(step), [resetKey, step]);

  // Watch the marker; when it nears the viewport, draw the next page
  const sentinel = useCallback((el: Element | null) => {
    observer.current?.disconnect();
    if (!el) return;
    observer.current = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setCount((c) => c + step);
    }, { rootMargin: '600px' });
    observer.current.observe(el);
  }, [step]);
  useEffect(() => () => observer.current?.disconnect(), []);

  // Browser "Print" from its own menu: draw everything first
  useEffect(() => {
    const before = () => setAll(true);
    const after = () => setAll(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);

  const withAll = useCallback(async (fn: () => unknown) => {
    setAll(true);
    // two frames: React commits, then the browser lays the rows out
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      await fn();
    } finally {
      setAll(false);
    }
  }, []);

  const shown = all ? total : Math.min(count, total);
  return { shown, more: shown < total, sentinel, withAll };
}
