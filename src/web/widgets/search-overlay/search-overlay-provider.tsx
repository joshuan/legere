'use client';

import { Modal } from 'antd';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SearchOverlay } from './search-overlay';

// What a screen may do with the overlay: raise it. Everything else — what it searches, where it
// goes, when it closes — is the overlay's own business (docs/11 §11.1a).
export type SearchOverlayApi = { open: () => void };

const SearchOverlayContext = createContext<SearchOverlayApi | null>(null);

export function useSearchOverlay(): SearchOverlayApi {
  const overlay = use(SearchOverlayContext);
  if (overlay === null) {
    throw new Error('useSearchOverlay is only available inside a SearchOverlayProvider.');
  }
  return overlay;
}

// The overlay, and the one listener that opens it (docs/10 §10.2, docs/11 §11.1a). Mounted by the
// `(app)` layout rather than by a screen: a hotkey registered by four screens is a hotkey that is a
// bug on the fifth, and an overlay owned by a screen would go down with it.
export function SearchOverlayProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // 🔒 Whatever had the focus when the overlay went up — the card, the menu item, the tab — gets it
  // back when it comes down: an overlay that dissolves and drops the focus ring on the document
  // body has silently ended a keyboard session that had not finished (docs/11 §11.1a).
  const openerRef = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    setOpen(false);
    const element = openerRef.current;
    openerRef.current = null;
    // Gone from the page while the overlay was up — a row that was re-rendered, say — is the one
    // case where there is nothing to give the focus back to.
    if (element !== null && element.isConnected) element.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      // The browser's own Cmd+K (a search bar, a link dialog) is not what was asked for here.
      event.preventDefault();
      // Already up: the chord must not re-record the opener as the overlay's own input.
      if (open) return;
      show();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, show]);

  const api = useMemo(() => ({ open: show }), [show]);

  return (
    <SearchOverlayContext value={api}>
      {children}
      {/* Centred over the current screen and dimming it rather than replacing it: closing changes
          nothing underneath, because that screen was dimmed and not left (docs/11 §11.1a, §11.15). */}
      <Modal
        open={open}
        onCancel={hide}
        footer={null}
        closeIcon={null}
        title={null}
        centered
        destroyOnHidden
        width={640}
        styles={{ body: { paddingBlock: 4 } }}
      >
        <SearchOverlay onClose={hide} />
      </Modal>
    </SearchOverlayContext>
  );
}
