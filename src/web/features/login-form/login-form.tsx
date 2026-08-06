'use client';

import { Alert, Button, Card, Form, Input, Tooltip, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { sessionApi } from '../../entities/session';
import { safeReturnTo, useErrorMessage } from '../../shared/lib';

// Login card (docs/11 §11.2). Errors are localized by code and shown inline; there is no
// self-service recovery in the MVP, so "forgot password" is a static hint (docs/08 §8.1.7).
export function LoginForm({ returnTo }: { returnTo?: string }) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useErrorMessage();

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (values: { email: string; password: string }) => {
      setBusy(true);
      setError(null);
      try {
        await sessionApi.login({ email: values.email, password: values.password });
        // The guard sits here rather than where the query is read, so nothing reaches the router
        // that did not come back from it (docs/tasks/security-audit-2026-08.md SEC-02).
        router.replace(safeReturnTo(returnTo));
        router.refresh();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusy(false);
      }
    },
    [describeError, returnTo, router],
  );

  return (
    <Card style={{ maxWidth: 400, margin: '4rem auto' }}>
      <Typography.Title level={3}>{t('auth.login.title')}</Typography.Title>

      {error !== null && (
        <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} role="alert" />
      )}

      <Form
        layout="vertical"
        onFinish={(values: { email: string; password: string }) => void submit(values)}
      >
        <Form.Item
          label={t('auth.fields.email')}
          name="email"
          rules={[{ required: true, message: t('auth.login.emailRequired') }]}
        >
          <Input type="email" autoComplete="email" aria-label={t('auth.fields.email')} />
        </Form.Item>

        <Form.Item
          label={t('auth.fields.password')}
          name="password"
          rules={[{ required: true, message: t('auth.login.passwordRequired') }]}
        >
          <Input.Password autoComplete="current-password" aria-label={t('auth.fields.password')} />
        </Form.Item>

        {/* Turnstile mounts here when NEXT_PUBLIC_TURNSTILE_SITE_KEY is configured (docs/08 §8.4). */}
        <div data-testid="captcha-slot" />

        <Button type="primary" htmlType="submit" loading={busy} block>
          {t('auth.login.submit')}
        </Button>
      </Form>

      <Tooltip title={t('auth.login.forgotHint')}>
        <Typography.Link style={{ display: 'inline-block', marginTop: 12 }}>
          {t('auth.login.forgot')}
        </Typography.Link>
      </Tooltip>
    </Card>
  );
}
