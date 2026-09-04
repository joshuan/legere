'use client';

import { useEffect, useRef, useState } from 'react';
import { opaqueTokenSchema } from '../../../shared/contracts/auth';

// A link hands a bearer credential to the browser through the fragment, which HTTP never sends.
// Read it once, scrub the current history entry, and keep the value only in component memory for
// the JSON requests that follow (docs/08 §8.1.2, SEC-38). `undefined` means the client has not read
// the browser yet; `null` means the fragment was absent or invalid.
export function useFragmentToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const consumedRef = useRef(false);

  useEffect(() => {
    // React development StrictMode replays effects without recreating their refs. The first pass
    // has already removed the fragment, so a second read would replace a valid credential with
    // `null`; keep this destructive read explicitly one-shot.
    if (consumedRef.current) return;
    consumedRef.current = true;
    const candidate = new URLSearchParams(window.location.hash.slice(1)).get('token');
    const parsed = opaqueTokenSchema.safeParse(candidate);
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    // This state is the client-side snapshot of an external source (the address bar), not derived
    // React state. The effect is intentionally the one boundary where that source is consumed.
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- required client snapshot of URL state
    setToken(parsed.success ? parsed.data : null);
  }, []);

  return token;
}
