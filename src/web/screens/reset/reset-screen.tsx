'use client';

import { useQuery } from '@tanstack/react-query';
import { Result, Spin } from 'antd';
import { useTranslations } from 'next-intl';
import { sessionApi, sessionKeys } from '../../entities/session';
import { AuthWizard } from '../../features/auth-wizard';

// /reset/[token] (docs/11 §11.2). The preview only ever reveals a masked address, so it is shown as
// guidance rather than pre-filled: the server derives the real recipient from the link itself, and a
// typo here still delivers the code to the right mailbox.
export function ResetScreen({ token }: { token: string }) {
  const t = useTranslations();
  const { data, isPending, isError } = useQuery({
    queryKey: sessionKeys.passwordReset(token),
    queryFn: () => sessionApi.previewPasswordReset(token),
    retry: false,
  });

  if (isPending) return <Spin fullscreen />;

  if (isError || !data.valid) {
    return (
      <Result
        status="warning"
        title={t('auth.reset.invalidTitle')}
        subTitle={t('auth.reset.invalidDescription')}
      />
    );
  }

  return (
    <AuthWizard
      mode="reset"
      token={token}
      emailHint={t('auth.reset.emailHint', { masked: data.email })}
    />
  );
}
