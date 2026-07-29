// jsdom test setup: register jest-dom matchers (toBeInTheDocument, etc.) for the `web` project.
import '@testing-library/jest-dom/vitest';

// jsdom implements no media queries, but antd's responsive observer and our own theme provider both
// subscribe to matchMedia on mount. A minimal non-matching stub keeps components renderable.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}
