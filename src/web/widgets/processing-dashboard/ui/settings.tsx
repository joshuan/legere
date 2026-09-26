'use client';

import { Space, Tag, Tooltip, Typography } from 'antd';
import { useLocale, useTranslations } from 'next-intl';
import type { GlobalToken } from 'antd';
import { type StepStatus } from '../../../../shared/contracts/enums';
import type {
  ProcessingBlockerDto,
  ResolvedBooleanSettingDto,
  ResolvedNumberSettingDto,
} from '../../../../shared/contracts/processing';
import { type Translate } from '../model/types';

export function ResolvedSetting({
  setting,
  label,
}: {
  setting: ResolvedNumberSettingDto;
  label?: string;
}) {
  const t = useTranslations();
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {label === undefined ? '' : `${label}: `}
      {t('admin.queue.settings.effectiveDefault', {
        effective: setting.effective,
        default: setting.default,
      })}{' '}
      <SettingSource setting={setting} />
    </Typography.Text>
  );
}

function SettingSource({
  setting,
}: {
  setting: ResolvedNumberSettingDto | ResolvedBooleanSettingDto;
}) {
  const t = useTranslations();
  return <Tag>{t(`admin.queue.settings.source.${setting.source}`)}</Tag>;
}

export function ResolvedBooleanSetting({ setting }: { setting: ResolvedBooleanSettingDto }) {
  const t = useTranslations();
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {t('admin.queue.settings.effectiveDefault', {
        effective: t(
          setting.effective
            ? 'admin.queue.settings.state.paused'
            : 'admin.queue.settings.state.running',
        ),
        default: t('admin.queue.settings.state.running'),
      })}{' '}
      <SettingSource setting={setting} />
    </Typography.Text>
  );
}

export function Blockers({ blockers }: { blockers: readonly ProcessingBlockerDto[] }) {
  const t = useTranslations();
  if (blockers.length === 0) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  return (
    <Space size={3} wrap>
      {blockers.map((blocker) => (
        <Tag color="orange" key={JSON.stringify(blocker)}>
          {describeBlocker(blocker, t)}
        </Tag>
      ))}
    </Space>
  );
}

function describeBlocker(blocker: ProcessingBlockerDto, t: Translate): string {
  if (blocker.kind === 'QUEUE_PAUSED') {
    return t('admin.queue.blockers.queuePaused', { queue: blocker.queue });
  }
  if (blocker.kind === 'STEP_PAUSED') {
    return t('admin.queue.blockers.stepPaused', { step: t(`viewer.steps.${blocker.step}`) });
  }
  if (blocker.kind === 'DEPENDENCY_PAUSED') {
    return t('admin.queue.blockers.dependencyPaused', {
      path: blocker.path.map((step) => t(`viewer.steps.${step}`)).join(' → '),
    });
  }
  return t('admin.queue.blockers.runtimeDegraded', { detail: blocker.detail });
}

export function Timestamp({ value, empty }: { value: string | null; empty: string }) {
  const locale = useLocale();
  if (value === null) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return (
    <Tooltip title={new Date(value).toLocaleString(locale)}>{relativeTime(value, locale)}</Tooltip>
  );
}

function relativeTime(value: string, locale: string): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 60) return formatter.format(-elapsedMinutes, 'minute');
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 48) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.floor(hours / 24), 'day');
}

export function statusColor(status: StepStatus, token: GlobalToken): string {
  if (status === 'DONE') return token.colorSuccess;
  if (status === 'FAILED') return token.colorError;
  if (status === 'QUEUED' || status === 'RUNNING') return token.colorInfo;
  if (status === 'PENDING') return token.colorWarning;
  return token.colorTextTertiary;
}
