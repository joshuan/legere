'use client';

import { Card, Skeleton, Space } from 'antd';
import { useTranslations } from 'next-intl';

// Enough cards to fill the fold at a middling width and no more: a skeleton is a promise about the
// shape of what is coming, not a drawing of it (docs/11 §11.1).
const CARDS = 8;

// What stands in for a screen on the way in (docs/11 §11.1, §11.14). A heading and a field of cards
// — the shape this archive mostly takes — rather than a spinner, which says only that something is
// happening and nothing about what.
//
// 🔒 It is drawn on arriving at a screen and never over one somebody is already reading: where the
// route-level boundary that renders it may live is fixed in docs/10 §10.2, and the viewer's own tab
// switches sit deliberately below it.
export function ScreenSkeleton() {
  const t = useTranslations();

  return (
    <div role="status" aria-live="polite" aria-label={t('common.loading')}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Skeleton active title={{ width: 220 }} paragraph={{ rows: 1, width: ['30%'] }} />
        <div className="legere-card-grid">
          {Array.from({ length: CARDS }, (_, index) => (
            <Card
              key={index}
              styles={{ body: { padding: 12 } }}
              // The same well the real card draws its page against, so the grid does not change
              // colour underneath the reader when the documents arrive (docs/11 §11.15).
              cover={<div style={{ height: 168, background: 'var(--legere-well)' }} />}
            >
              <Skeleton active title={{ width: '70%' }} paragraph={{ rows: 2 }} />
            </Card>
          ))}
        </div>
      </Space>
    </div>
  );
}
