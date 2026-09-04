import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFragmentToken } from './use-fragment-token';

const TOKEN = 'a'.repeat(43);

describe('useFragmentToken (SEC-38)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/invite');
  });

  it('reads a valid token once in StrictMode and removes the fragment from history', async () => {
    window.history.replaceState(null, '', `/invite?from=admin#token=${TOKEN}`);

    const { result } = renderHook(() => useFragmentToken(), { wrapper: StrictMode });

    await waitFor(() => expect(result.current).toBe(TOKEN));
    expect(window.location.pathname).toBe('/invite');
    expect(window.location.search).toBe('?from=admin');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('rejects an absent or malformed fragment and still scrubs it', async () => {
    window.history.replaceState(null, '', '/invite#token=short');

    const { result } = renderHook(() => useFragmentToken());

    await waitFor(() => expect(result.current).toBeNull());
    expect(window.location.hash).toBe('');
  });
});
