'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, InputNumber, Space, Switch, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { QUEUE_CONCURRENCY_MAX } from '../../../../shared/contracts/queue';
import { processingApi, processingKeys } from '../../../entities/processing';
import { useErrorMessage } from '../../../shared/lib';
import { type QueueRow } from '../model/types';
import { ResolvedSetting, ResolvedBooleanSetting } from './settings';

export type NumberDraft = { value: number; baseRevision: number };

export function QueueControls({ row, revision }: { row: QueueRow; revision: number }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [draft, setDraft] = useState<NumberDraft | null>(null);
  const update = useMutation({
    mutationFn: (change: {
      expectedRevision: number;
      concurrency?: number | null;
      paused?: boolean;
    }) => processingApi.updateQueue(row.name, change),
    onSuccess: () => {
      setDraft(null);
      void message.success(t('admin.queue.settings.saved'), 2);
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
    },
    onError: (error: unknown) => {
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
      void message.error(describeError(error));
    },
  });
  const control = row.control.concurrency;
  return (
    <Space direction="vertical" size={4}>
      <Space size={4} wrap>
        <InputNumber
          min={1}
          max={QUEUE_CONCURRENCY_MAX}
          style={{ width: 72 }}
          aria-label={t('admin.queue.settings.concurrencyFor', {
            stage: t(`admin.queue.names.${row.name}`),
          })}
          value={draft?.value ?? control.effective}
          disabled={update.isPending}
          onChange={(value) =>
            setDraft((current) => ({
              value: value ?? control.effective,
              baseRevision: current?.baseRevision ?? revision,
            }))
          }
        />
        <Button
          size="small"
          type="primary"
          disabled={draft === null}
          loading={update.isPending}
          onClick={() => {
            if (draft !== null) {
              update.mutate({ expectedRevision: draft.baseRevision, concurrency: draft.value });
            }
          }}
        >
          {t('common.actions.save')}
        </Button>
        {control.source === 'OVERRIDE' && (
          <Button
            size="small"
            disabled={update.isPending}
            onClick={() => update.mutate({ expectedRevision: revision, concurrency: null })}
          >
            {t('admin.queue.settings.useDefault')}
          </Button>
        )}
      </Space>
      <ResolvedSetting setting={control} />
      <Space size={6} wrap>
        <Switch
          size="small"
          checked={!row.control.paused.effective}
          loading={update.isPending}
          aria-label={t('admin.queue.pause.switch', { queue: row.name })}
          onChange={(runs) => update.mutate({ expectedRevision: revision, paused: !runs })}
        />
        <Typography.Text type="secondary">{t('admin.queue.pause.title')}</Typography.Text>
        <ResolvedBooleanSetting setting={row.control.paused} />
      </Space>
    </Space>
  );
}
