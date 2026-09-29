'use client';

import { Typography } from 'antd';
import type { ReactNode } from 'react';

/** The screen owns its title and actions; the application shell owns navigation (docs/16). */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="legere-page-head">
      <div className="legere-page-heading">
        <Typography.Title level={1}>{title}</Typography.Title>
        {description !== undefined && <p className="legere-page-description">{description}</p>}
      </div>
      {actions !== undefined && <div className="legere-page-actions">{actions}</div>}
    </header>
  );
}
