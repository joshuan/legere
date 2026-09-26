'use client';

import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  HourglassOutlined,
  MinusCircleOutlined,
  PauseCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { type ReactNode } from 'react';
import { type StepStatus } from '../../../../shared/contracts/enums';

// One shape and one colour per verdict (docs/11 §11.5), so the row that matters is found before it
// is read. The glyphs share one width — the CSS gives them a column of their own — and say nothing
// to a screen reader: the state is written out in words at the end of the same line.
export function stepGlyph(kind: StepStatus | 'INTERRUPTED' | 'PAUSED'): ReactNode {
  switch (kind) {
    case 'DONE':
      return <CheckCircleOutlined style={{ color: 'var(--ant-color-success)' }} />;
    case 'FAILED':
      return <CloseCircleOutlined style={{ color: 'var(--ant-color-error)' }} />;
    case 'RUNNING':
      return <SyncOutlined spin style={{ color: 'var(--ant-color-primary)' }} />;
    case 'QUEUED':
      return <ClockCircleOutlined style={{ color: 'var(--ant-color-text-tertiary)' }} />;
    case 'PENDING':
      return <HourglassOutlined style={{ color: 'var(--ant-color-text-tertiary)' }} />;
    case 'SKIPPED':
      return <MinusCircleOutlined style={{ color: 'var(--ant-color-text-quaternary)' }} />;
    case 'PAUSED':
      return <PauseCircleOutlined style={{ color: 'var(--ant-color-warning)' }} />;
    case 'INTERRUPTED':
      return <ExclamationCircleOutlined style={{ color: 'var(--ant-color-warning)' }} />;
  }
}
