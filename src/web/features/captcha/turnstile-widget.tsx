'use client';

import { useEffect, useRef } from 'react';

// The Cloudflare script (docs/08 §8.4), fetched once per page and only where a widget is actually
// wanted: an instance with no site key loads nothing at all, which matters on a self-hosted archive
// that may have no way out to the internet.
//
// `render=explicit` rather than the implicit mode: the widget is drawn into an element React owns,
// at the moment React says it exists, instead of the script scanning the document for a class name
// and injecting a hidden input into whatever form it lands in.
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile-script';

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
  const siteKey = turnstileSiteKey();
  const host = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | undefined>(undefined);
  // The callback the script holds is the one from the render that drew the widget; keeping it in a
  // ref means a parent that re-renders does not cost a redraw and a fresh challenge.
  const latest = useRef(onToken);

  useEffect(() => {
    latest.current = onToken;
  }, [onToken]);

  useEffect(() => {
    const element = host.current;
    if (siteKey === '' || element === null) return;

    let cancelled = false;

    const draw = (): void => {
      const api = window.turnstile;
      if (cancelled || api === undefined || widget.current !== undefined) return;
      widget.current = api.render(element, {
        sitekey: siteKey,
        callback: (token: string) => latest.current(token),
        'expired-callback': () => latest.current(null),
        'error-callback': () => latest.current(null),
      });
    };

    if (window.turnstile !== undefined) {
      draw();
      return () => {
        cancelled = true;
        remove(widget);
      };
    }

    const script = document.getElementById(SCRIPT_ID) ?? appendScript();
    script.addEventListener('load', draw);
    return () => {
      cancelled = true;
      script.removeEventListener('load', draw);
      remove(widget);
    };
  }, [siteKey]);

  useEffect(() => {
    // Nothing has been spent before the first request, and resetting a widget that has just been
    // drawn would throw the challenge away for no reason.
    if (resetKey === 0) return;
    const api = window.turnstile;
    const id = widget.current;
    if (api === undefined || id === undefined) return;
    api.reset(id);
  }, [resetKey]);

  if (siteKey === '') return null;
  return <div ref={host} data-testid="captcha-slot" style={{ marginBottom: 16 }} />;
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
