'use client';

import { Alert, Button, Card, Form, Input, Tooltip, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { sessionApi } from '../../entities/session';
import { safeReturnTo, useErrorMessage } from '../../shared/lib';
import { isTurnstileConfigured, TurnstileWidget } from '../captcha';

// Login card (docs/11 §11.2). Errors are localized by code and shown inline; there is no
// self-service recovery in the MVP, so "forgot password" is a static hint (docs/08 §8.1.7).
export function LoginForm({ returnTo }: { returnTo?: string }) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useErrorMessage();

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 🔒 The CAPTCHA, where the instance was built with one (docs/08 §8.4). The token the widget mints
  // travels with the credentials; until there is one the button below is off, so a configured
  // challenge is a step of the form rather than a refusal after the password has already been sent.
  const captchaRequired = isTurnstileConfigured();
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaAttempt, setCaptchaAttempt] = useState(0);

  const submit = useCallback(
    async (values: { email: string; password: string }) => {
      setBusy(true);
      setError(null);
      try {
        await sessionApi.login({
          email: values.email,
          password: values.password,
          ...(captchaToken === null ? {} : { captchaToken }),
        });
        // The guard sits here rather than where the query is read, so nothing reaches the router
        // that did not come back from it (docs/tasks/security-audit-2026-08.md SEC-02).
        router.replace(safeReturnTo(returnTo));
        router.refresh();
      } catch (caught) {
        setError(describeError(caught));
        // The token was spent by the attempt that failed, whatever it failed on. Ask the widget for
        // another rather than letting the next try carry one the server has already seen.
        setCaptchaToken(null);
        setCaptchaAttempt((attempt) => attempt + 1);
      } finally {
        setBusy(false);
      }
    },
    [captchaToken, describeError, returnTo, router],
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

        <TurnstileWidget onToken={setCaptchaToken} resetKey={captchaAttempt} />

        <Button
          type="primary"
          htmlType="submit"
          loading={busy}
          disabled={captchaRequired && captchaToken === null}
          block
        >
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
