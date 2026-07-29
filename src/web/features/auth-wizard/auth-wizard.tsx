'use client';

import { Alert, Button, Card, Form, Input, Steps, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  emailSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
} from '../../../shared/contracts/auth';
import { sessionApi } from '../../entities/session';
import { isApiError } from '../../shared/api';
import { useErrorMessage } from '../../shared/lib';

// The one wizard behind onboarding, invite acceptance and password reset (docs/11 §11.2): the three
// flows differ only in which token they carry and whether the address is fixed.
export type AuthWizardMode = 'onboarding' | 'invite' | 'reset';

export type AuthWizardProps = {
  mode: AuthWizardMode;
  token?: string;
  initialEmail?: string;
  // Shown under the email field; reset links only expose a masked address (docs/11 §11.2).
  emailHint?: string;
  returnTo?: string;
};

const RESEND_COOLDOWN_SECONDS = 60;
// Mirrors the server's code lifetime (docs/08 §8.1.3), used to derive when the code was sent.
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_LENGTH = 6;

export function AuthWizard({
  mode,
  token,
  initialEmail = '',
  emailHint,
  returnTo,
}: AuthWizardProps) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useErrorMessage();

  const [step, setStep] = useState(0);
  const [email, setEmail] = useState(initialEmail);
  const [ticket, setTicket] = useState('');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tokenPayload = useMemo(() => {
    if (token === undefined) return {};
    return mode === 'reset' ? { resetToken: token } : { inviteToken: token };
  }, [mode, token]);

  const sendCode = useCallback(
    async (address: string) => {
      setBusy(true);
      setError(null);
      try {
        const parsed = emailSchema.safeParse(address);
        if (!parsed.success) {
          setError(t('auth.wizard.email.invalid'));
          return false;
        }
        const started = await sessionApi.registerStart({ email: parsed.data, ...tokenPayload });
        setEmail(parsed.data);
        setExpiresAt(started.expiresAt);
        setNotice(t('auth.wizard.code.sent', { email: parsed.data }));
        return true;
      } catch (caught) {
        setError(describeError(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [describeError, t, tokenPayload],
  );

  const submitEmail = useCallback(
    async (values: { email: string }) => {
      if (await sendCode(values.email)) setStep(1);
    },
    [sendCode],
  );

  const submitCode = useCallback(
    async (code: string) => {
      setBusy(true);
      setError(null);
      try {
        const verified = await sessionApi.registerVerify({ email, code });
        setTicket(verified.ticket);
        setNotice(null);
        setStep(2);
      } catch (caught) {
        setError(describeError(caught));
        // A burned series cannot be retried: send the user back to request a new code.
        if (isApiError(caught) && caught.code === 'EMAIL_CODE_TOO_MANY_ATTEMPTS') {
          setStep(0);
          setExpiresAt(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [describeError, email],
  );

  const submitPassword = useCallback(
    async (values: { password: string }) => {
      setBusy(true);
      setError(null);
      try {
        await sessionApi.registerComplete({ ticket, password: values.password });
        router.replace(returnTo !== undefined && returnTo !== '' ? returnTo : '/documents');
      } catch (caught) {
        setError(describeError(caught));
        // An expired or spent ticket means starting over.
        if (isApiError(caught) && caught.code === 'REGISTRATION_TICKET_INVALID') setStep(0);
      } finally {
        setBusy(false);
      }
    },
    [describeError, returnTo, router, ticket],
  );

  return (
    <Card style={{ maxWidth: 480, margin: '3rem auto' }}>
      <Typography.Title level={3}>{t(`auth.wizard.title.${mode}`)}</Typography.Title>

      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 24 }}
        items={[
          { title: t('auth.wizard.steps.email') },
          { title: t('auth.wizard.steps.code') },
          { title: t('auth.wizard.steps.password') },
        ]}
      />

      {error !== null && (
        <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} role="alert" />
      )}

      {step === 0 && (
        <EmailStep
          initialEmail={email}
          {...(emailHint === undefined ? {} : { hint: emailHint })}
          busy={busy}
          onSubmit={submitEmail}
        />
      )}

      {step === 1 && (
        <CodeStep
          notice={notice}
          expiresAt={expiresAt}
          busy={busy}
          onSubmit={submitCode}
          onResend={() => void sendCode(email)}
        />
      )}

      {step === 2 && <PasswordStep busy={busy} onSubmit={submitPassword} />}
    </Card>
  );
}

function EmailStep({
  initialEmail,
  hint,
  busy,
  onSubmit,
}: {
  initialEmail: string;
  hint?: string;
  busy: boolean;
  onSubmit: (values: { email: string }) => Promise<void>;
}) {
  const t = useTranslations();

  return (
    <Form
      layout="vertical"
      initialValues={{ email: initialEmail }}
      onFinish={(values: { email: string }) => void onSubmit(values)}
    >
      <Form.Item
        label={t('auth.fields.email')}
        name="email"
        {...(hint === undefined ? {} : { extra: hint })}
      >
        <Input type="email" autoComplete="email" aria-label={t('auth.fields.email')} />
      </Form.Item>
      {/* Turnstile mounts here when NEXT_PUBLIC_TURNSTILE_SITE_KEY is configured (docs/08 §8.4). */}
      <div data-testid="captcha-slot" />
      <Button type="primary" htmlType="submit" loading={busy} block>
        {t('auth.wizard.actions.sendCode')}
      </Button>
    </Form>
  );
}

function CodeStep({
  notice,
  expiresAt,
  busy,
  onSubmit,
  onResend,
}: {
  notice: string | null;
  expiresAt: string | null;
  busy: boolean;
  onSubmit: (code: string) => Promise<void>;
  onResend: () => void;
}) {
  const t = useTranslations();
  const remaining = useCountdown(expiresAt);
  const cooldown = useResendCooldown(expiresAt);

  return (
    <div>
      {notice !== null && (
        <Alert type="info" message={notice} showIcon style={{ marginBottom: 16 }} />
      )}

      <Typography.Paragraph type="secondary">
        {remaining > 0
          ? t('auth.wizard.code.expiresIn', { seconds: remaining })
          : t('auth.wizard.code.expired')}
      </Typography.Paragraph>

      <Input.OTP
        length={CODE_LENGTH}
        disabled={busy}
        aria-label={t('auth.fields.code')}
        // Auto-submit on the sixth digit (docs/11 §11.2).
        onChange={(value) => {
          if (value.length === CODE_LENGTH) void onSubmit(value);
        }}
      />

      <Button
        type="link"
        disabled={cooldown > 0 || busy}
        onClick={onResend}
        style={{ paddingLeft: 0, marginTop: 12 }}
      >
        {cooldown > 0
          ? t('auth.wizard.actions.resendIn', { seconds: cooldown })
          : t('auth.wizard.actions.resend')}
      </Button>
    </div>
  );
}

function PasswordStep({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (values: { password: string }) => Promise<void>;
}) {
  const t = useTranslations();

  return (
    <Form layout="vertical" onFinish={(values: { password: string }) => void onSubmit(values)}>
      <Form.Item
        label={t('auth.fields.password')}
        name="password"
        rules={[
          {
            validator: (_rule, value: unknown) => {
              const parsed = passwordSchema.safeParse(value);
              return parsed.success
                ? Promise.resolve()
                : Promise.reject(new Error(t('auth.wizard.password.rules')));
            },
          },
        ]}
        extra={t('auth.wizard.password.hint', {
          min: PASSWORD_MIN_LENGTH,
          max: PASSWORD_MAX_LENGTH,
        })}
      >
        <Input.Password autoComplete="new-password" aria-label={t('auth.fields.password')} />
      </Form.Item>

      <Form.Item
        label={t('auth.fields.passwordConfirm')}
        name="passwordConfirm"
        dependencies={['password']}
        rules={[
          ({ getFieldValue }) => ({
            validator: (_rule, value: unknown) =>
              value === getFieldValue('password')
                ? Promise.resolve()
                : Promise.reject(new Error(t('auth.wizard.password.mismatch'))),
          }),
        ]}
      >
        <Input.Password autoComplete="new-password" aria-label={t('auth.fields.passwordConfirm')} />
      </Form.Item>

      <Button type="primary" htmlType="submit" loading={busy} block>
        {t('auth.wizard.actions.finish')}
      </Button>
    </Form>
  );
}

// Seconds left until the code expires; ticks once a second (docs/11 §11.2).
function useCountdown(until: string | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);

  if (until === null) return 0;
  return Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
}

// Resend is blocked for a minute after a code was sent — the same window the server enforces. The
// send time is derived from the code's own expiry rather than tracked separately, so the countdown
// stays correct even if the component remounts.
function useResendCooldown(expiresAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (expiresAt === null) return 0;
  const sentAt = new Date(expiresAt).getTime() - CODE_TTL_MS;
  const elapsed = Math.floor((now - sentAt) / 1000);
  return Math.max(0, RESEND_COOLDOWN_SECONDS - elapsed);
}
