'use client';

import { PageHeader as SharedPageHeader, type PageHeaderProps } from '@joshuan/design-system/react';

export function PageHeader(props: PageHeaderProps) {
  return (
    <SharedPageHeader
      {...props}
      className={`legere-page-head${props.className ? ` ${props.className}` : ''}`}
    />
  );
}
