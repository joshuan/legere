'use client';

import { Alert } from 'antd';
import { useTranslations } from 'next-intl';
import { useEffect, useReducer, useRef } from 'react';

// The Cloudflare script (docs/08 §8.4), fetched once per page and only where a widget is actually
// wanted: an instance with no site key loads nothing at all, which matters on a self-hosted archive
// that may have no way out to the internet.
//
// `render=explicit` rather than the implicit mode: the widget is drawn into an element React owns,
// at the moment React says it exists, instead of the script scanning the document for a class name
// and injecting a hidden input into whatever form it lands in.
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile-script';

// 🔒 How long the challenge is given to arrive before the form says so in words. A self-hosted
// instance may sit behind a firewall, an extension or a `script-src` that has never heard of
// `challenges.cloudflare.com`, and then nothing else would ever speak: `error-callback` belongs to a
// widget that was never rendered, so the token would stay `null`, the button would stay off for
// ever, and the only thing on the screen would be an empty gap (docs/08 §8.4). Generous, because a
// slow line is not a blocked one.
const LOAD_TIMEOUT_MS = 15_000;

type TurnstileOptions = {
  sitekey: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
};

// Only what this file calls. The script defines more; a type is a claim about what we depend on.
type TurnstileApi = {
  render: (element: HTMLElement, options: TurnstileOptions) => string | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

// 🔒 Whether this build has a CAPTCHA at all. The site key is read by the browser, so Next inlines
// it into the bundle when the image is built (docs/12 §12.6) — an instance built without it renders
// no widget and cannot grow one from a runtime variable, which is what `/admin/instance` warns
// about on that row. Written as a literal `process.env.X` because that is what the inlining
// recognises; anything computed would survive the build and read `undefined` in the browser.
export function turnstileSiteKey(): string {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
}

export function isTurnstileConfigured(): boolean {
  return turnstileSiteKey() !== '';
}

export type TurnstileWidgetProps = {
  // Called with a token the moment one is minted, and with `null` when the one held goes stale or
  // the challenge fails: the form reads it as "not passable right now" and keeps its button off.
  onToken: (token: string | null) => void;
  // Bumped by the form after a request that spent the token — a Turnstile token is single-use, so
  // an attempt that failed for any other reason (a wrong password) must not leave the form holding
  // a spent one and no way to ask for another.
  resetKey: number;
};

export function TurnstileWidget({ onToken, resetKey }: TurnstileWidgetProps) {
  const t = useTranslations();
  const siteKey = turnstileSiteKey();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<string | undefined>(undefined);
  // The callback the script holds is the one from the render that drew the widget; keeping it in a
  // ref means a parent that re-renders does not cost a redraw and a fresh challenge.
  const latestRef = useRef(onToken);
  // 🔒 What `resetKey` said when the widget now on screen was drawn. A widget is reset because the
  // form spent its token, and a widget drawn *after* the last request holds a challenge nobody has
  // spent — so only a count that has moved past this one means anything. Comparing against zero
  // covered the first mount of the first widget and nothing else: the wizard draws the challenge in
  // two mutually exclusive slots, so stepping from the address to the code unmounts one widget and
  // mounts another, which the already-bumped counter then reset the instant it appeared — two
  // challenges per step change, the second of them visibly restarting under the person.
  const drawnAtRef = useRef(resetKey);
  const attemptRef = useRef(resetKey);
  // Whether the script could be reached at all. Not a failed challenge — there is no challenge —
  // and never a way past one: the token stays `null` and the form stays off (docs/08 §8.4).
  const [unreachable, setUnreachable] = useReducer(
    (_current: boolean, next: boolean) => next,
    false,
  );

  useEffect(() => {
    latestRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    attemptRef.current = resetKey;
  }, [resetKey]);

  useEffect(() => {
    const element = hostRef.current;
    if (siteKey === '' || element === null) return;

    let cancelled = false;

    const draw = (): void => {
      const api = window.turnstile;
      if (cancelled || api === undefined || widgetRef.current !== undefined) return;
      widgetRef.current = api.render(element, {
        sitekey: siteKey,
        callback: (token: string) => latestRef.current(token),
        'expired-callback': () => latestRef.current(null),
        'error-callback': () => latestRef.current(null),
      });
      if (widgetRef.current === undefined) return;
      // Drawn now, so it answers for every request made up to now and for none before it.
      drawnAtRef.current = attemptRef.current;
      setUnreachable(false);
    };

    if (window.turnstile !== undefined) {
      draw();
      return () => {
        cancelled = true;
        remove(widgetRef);
      };
    }

    // The two ways the script never arrives: the browser refuses it outright — a blocked domain, an
    // extension, a `script-src` without that origin — or it simply never answers.
    const giveUp = (): void => {
      if (cancelled || widgetRef.current !== undefined) return;
      setUnreachable(true);
      latestRef.current(null);
    };
    const timer = setTimeout(giveUp, LOAD_TIMEOUT_MS);

    const script = document.getElementById(SCRIPT_ID) ?? appendScript();
    script.addEventListener('load', draw);
    script.addEventListener('error', giveUp);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      script.removeEventListener('load', draw);
      script.removeEventListener('error', giveUp);
      remove(widgetRef);
    };
  }, [siteKey]);

  useEffect(() => {
    // Nothing this widget drew has been spent yet, and resetting a challenge that has just appeared
    // would throw it away for no reason — and, in interactive mode, in front of the person solving
    // it.
    if (resetKey <= drawnAtRef.current) return;
    const api = window.turnstile;
    const id = widgetRef.current;
    if (api === undefined || id === undefined) return;
    api.reset(id);
    drawnAtRef.current = resetKey;
  }, [resetKey]);

  if (siteKey === '') return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div ref={hostRef} data-testid="captcha-slot" />
      {unreachable && (
        <Alert
          type="error"
          role="alert"
          showIcon
          message={t('auth.captcha.unreachable')}
          description={t('auth.captcha.unreachableHint')}
        />
      )}
    </div>
  );
}

function appendScript(): HTMLScriptElement {
  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.src = SCRIPT_SRC;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
  return script;
}

function remove(widget: { current: string | undefined }): void {
  const api = window.turnstile;
  const id = widget.current;
  widget.current = undefined;
  if (api === undefined || id === undefined) return;
  api.remove(id);
}
