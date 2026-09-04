// jsdom test setup: register jest-dom matchers (toBeInTheDocument, etc.) for the `web` project.
import '@ant-design/v5-patch-for-react-19';
import '@testing-library/jest-dom/vitest';

// jsdom reports every standards-valid pseudo-element argument as a noisy "not implemented" error.
// Ant Design asks for one only to measure the scrollbar; the base element's computed style is the
// useful part in a layout-free test environment, so discard the unsupported second argument.
if (typeof window !== 'undefined') {
  const readComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element: Element): CSSStyleDeclaration => readComputedStyle(element);
}

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
