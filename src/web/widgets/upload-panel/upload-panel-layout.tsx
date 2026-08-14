'use client';

import type { ReactNode } from 'react';
import { useUploadQueue } from '../../features/upload-queue';
import { UploadPanel } from './upload-panel';

// The screen and the upload panel, side by side (docs/11 §11.3). While nothing is being uploaded
// this is the screen and nothing else — not a wrapper that is merely empty, because a flex row round
// a page with one child in it is already a different page.
export function UploadPanelLayout({ children }: { children: ReactNode }) {
  const { items } = useUploadQueue();
  if (items.length === 0) return <>{children}</>;

  return (
    <div className="legere-upload-layout">
      <div className="legere-upload-content">{children}</div>
      <UploadPanel />
    </div>
  );
}
