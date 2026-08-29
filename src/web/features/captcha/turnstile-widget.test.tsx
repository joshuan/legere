import '@testing-library/jest-dom/vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { TurnstileWidget } from './turnstile-widget';

// The widget of docs/08 §8.4, on its own: what it draws, what it never draws, and the two ways a
// self-hosted instance can be locked out by it.

const SITE_KEY = '1x00000000000000000000AA';
const SCRIPT_ID = 'cf-turnstile-script';

const strings = enMessages.auth.captcha;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  delete window.turnstile;
  document.getElementById(SCRIPT_ID)?.remove();
});

function script(): HTMLScriptElement {
  const element = document.getElementById(SCRIPT_ID);
  if (!(element instanceof HTMLScriptElement)) throw new Error('the script was never appended');
  return element;
}

// The Cloudflare script as far as this widget is concerned: something that draws into the element it
// is given, calls back with a token, and can be reset and removed.
function fakeTurnstile(): { solve: (token: string) => void; resets: () => number } {
  let callback: (token: string) => void = () => {};
  let resets = 0;
  window.turnstile = {
    render: (_element, options) => {
      callback = options.callback;
      return 'widget-1';
    },
    reset: () => {
      resets += 1;
    },
    remove: () => {},
  };
  return {
    solve: (token: string) => act(() => callback(token)),
    resets: () => resets,
  };
}

describe('TurnstileWidget', () => {
  it('draws nothing and loads nothing on a build with no site key', () => {
    renderWithProviders(<TurnstileWidget onToken={vi.fn()} resetKey={0} />);

    expect(screen.queryByTestId('captcha-slot')).not.toBeInTheDocument();
    // 🔒 An instance with no key has no way out to the internet to need: the script is not fetched
    // at all (docs/08 §8.4).
    expect(document.getElementById(SCRIPT_ID)).toBeNull();
  });

  it('renders the challenge and hands its token over', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    const turnstile = fakeTurnstile();
    const onToken = vi.fn();

    renderWithProviders(<TurnstileWidget onToken={onToken} resetKey={0} />);
    await screen.findByTestId('captcha-slot');

    turnstile.solve('a-token');
    expect(onToken).toHaveBeenCalledWith('a-token');
    expect(screen.queryByText(strings.unreachable)).not.toBeInTheDocument();
  });

  // 🔒 The lockout this exists to prevent: the image carries a site key, the browser cannot reach
  // `challenges.cloudflare.com`, and nothing else ever speaks — `error-callback` belongs to a widget
  // that was never rendered. Sign in would be disabled for ever with an empty gap for an
  // explanation (docs/08 §8.4).
  it('says so in words when the browser refuses the script', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    const onToken = vi.fn();

    renderWithProviders(<TurnstileWidget onToken={onToken} resetKey={0} />);
    await screen.findByTestId('captcha-slot');

    act(() => {
      script().dispatchEvent(new Event('error'));
    });

    const said = await screen.findByText(strings.unreachable);
    expect(said).toBeInTheDocument();
    // The origin that has to be reachable is named, because "check your network" is not an action.
    expect(screen.getByText(/challenges\.cloudflare\.com/)).toBeInTheDocument();
    // 🔒 And it is not a way past the challenge: no token is minted, and the form is told the same
    // "not passable right now" it is told by a failed one.
    expect(onToken).not.toHaveBeenCalledWith(expect.any(String));
    expect(onToken).toHaveBeenCalledWith(null);
  });

  // The other way it never arrives: nothing refuses it, it simply never answers.
  it('says the same when the script never answers at all', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onToken = vi.fn();

    renderWithProviders(<TurnstileWidget onToken={onToken} resetKey={0} />);
    await screen.findByTestId('captcha-slot');

    expect(screen.queryByText(strings.unreachable)).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(await screen.findByText(strings.unreachable)).toBeInTheDocument();
    expect(onToken).toHaveBeenCalledWith(null);
  });

  // A script that arrives late still wins: the message is about a challenge that never came, not
  // about one that was slow.
  it('takes the message back when the script arrives after all', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    const onToken = vi.fn();

    renderWithProviders(<TurnstileWidget onToken={onToken} resetKey={0} />);
    await screen.findByTestId('captcha-slot');
    act(() => {
      script().dispatchEvent(new Event('error'));
    });
    expect(await screen.findByText(strings.unreachable)).toBeInTheDocument();

    const turnstile = fakeTurnstile();
    act(() => {
      script().dispatchEvent(new Event('load'));
    });

    await waitFor(() => expect(screen.queryByText(strings.unreachable)).not.toBeInTheDocument());
    turnstile.solve('late-token');
    expect(onToken).toHaveBeenCalledWith('late-token');
  });

  // 🔒 A widget drawn *after* the last request holds a challenge nobody has spent. The wizard draws
  // the challenge in two mutually exclusive slots, so a step change unmounts one widget and mounts
  // another with the counter already bumped — and a guard that only knew about zero threw the fresh
  // challenge away the instant it appeared (docs/08 §8.4).
  it('does not reset a widget drawn after the request that spent the last token', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    const turnstile = fakeTurnstile();

    renderWithProviders(<TurnstileWidget onToken={vi.fn()} resetKey={3} />);
    await screen.findByTestId('captcha-slot');

    expect(turnstile.resets()).toBe(0);
  });

  // And the reset it does exist for: the form spent this widget's token, so this widget needs a
  // fresh challenge.
  it('resets the widget once the count moves past the draw', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    const turnstile = fakeTurnstile();

    const { rerender } = renderWithProviders(<TurnstileWidget onToken={vi.fn()} resetKey={2} />);
    await screen.findByTestId('captcha-slot');
    expect(turnstile.resets()).toBe(0);

    rerender(<TurnstileWidget onToken={vi.fn()} resetKey={3} />);
    expect(turnstile.resets()).toBe(1);

    // And not again for the same count: one spend, one fresh challenge.
    rerender(<TurnstileWidget onToken={vi.fn()} resetKey={3} />);
    expect(turnstile.resets()).toBe(1);
  });
});
