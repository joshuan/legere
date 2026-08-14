'use client';

import { useEffect, useState } from 'react';

// A value that settles before it is acted on. The search overlay reads results as the query is
// typed (docs/11 §11.1a), and a word typed at speed must cost one request rather than six.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (settled === value) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs, settled]);

  return settled;
}
