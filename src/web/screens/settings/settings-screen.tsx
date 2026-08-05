'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Card, Form, Input, Radio, Select, Space, Spin, Typography } from 'antd';
import type { RadioChangeEvent } from 'antd';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import type { UserDto } from '../../../shared/contracts/auth';
import { themeSchema } from '../../../shared/contracts/enums';
import type { UpdateMeRequest } from '../../../shared/contracts/users';
import { sessionApi, sessionKeys } from '../../entities/session';
import { useErrorMessage } from '../../shared/lib';
import { ApiTokensCard } from './api-tokens-card';

// /settings (docs/11 §11.9). Every control saves on change — there is no Save button — and a
// language switch takes effect immediately: the server rewrites NEXT_LOCALE and router.refresh()
// re-renders with the new catalog (docs/10 §10.3).
export function SettingsScreen() {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const { data: me, isPending } = useQuery({ queryKey: sessionKeys.me, queryFn: sessionApi.me });

  const save = useMutation({
    mutationFn: (patch: UpdateMeRequest) => sessionApi.updateMe(patch),
    onSuccess: (updated: UserDto, patch) => {
      queryClient.setQueryData(sessionKeys.me, updated);
      void message.success(t('settings.saved'), 2);
      // The locale cookie changed server-side; re-render so messages follow.
      if (patch.language !== undefined) router.refresh();
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  const patch = useCallback((next: UpdateMeRequest) => save.mutate(next), [save]);

  if (isPending || me === undefined) return <Spin />;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 720 }}>
      <Card>
      <Typography.Title level={4}>{t('settings.title')}</Typography.Title>

      <Form layout="vertical" initialValues={me}>
        <Form.Item label={t('settings.displayName')} name="displayName">
          <Input
            aria-label={t('settings.displayName')}
            onBlur={(event) => {
              const displayName = event.target.value.trim();
              if (displayName !== '' && displayName !== me.displayName) patch({ displayName });
            }}
          />
        </Form.Item>

        <Form.Item label={t('settings.email')}>
          <Input value={me.email} disabled aria-label={t('settings.email')} />
        </Form.Item>

        <Form.Item label={t('settings.language')} name="language">
          <Select
            aria-label={t('settings.language')}
            onChange={(language: 'EN' | 'RU') => patch({ language })}
            options={[
              { value: 'EN', label: 'English' },
              { value: 'RU', label: 'Русский' },
            ]}
          />
        </Form.Item>

        <Form.Item label={t('settings.theme')} name="theme">
          <Radio.Group
            onChange={(event: RadioChangeEvent) => {
              const theme = themeSchema.safeParse(event.target.value);
              if (theme.success) patch({ theme: theme.data });
            }}
            options={[
              { value: 'SYSTEM', label: t('settings.themes.SYSTEM') },
              { value: 'LIGHT', label: t('settings.themes.LIGHT') },
              { value: 'DARK', label: t('settings.themes.DARK') },
            ]}
          />
        </Form.Item>
        </Form>
      </Card>

      <ApiTokensCard />
    </Space>
  );
}
