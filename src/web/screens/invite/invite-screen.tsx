'use client';

import { useQuery } from '@tanstack/react-query';
import { Result, Spin } from 'antd';
import { useTranslations } from 'next-intl';
import { sessionApi, sessionKeys } from '../../entities/session';
import { AuthWizard } from '../../features/auth-wizard';

// /invite/[token] (docs/11 §11.2). An invalid or spent link gets a dedicated state, not a wizard
// that would fail on the first request.
export function InviteScreen({ token }: { token: string }) {
  const t = useTranslations();
  const { data, isPending, isError } = useQuery({
    queryKey: sessionKeys.invite(token),
    queryFn: () => sessionApi.previewInvite(token),
    retry: false,
  });

  if (isPending) return <Spin fullscreen />;

  if (isError || !data.valid) {
    return (
      <Result
        status="warning"
        title={t('auth.invite.invalidTitle')}
        subTitle={t('auth.invite.invalidDescription')}
      />
    );
  }

  return <AuthWizard mode="invite" token={token} initialEmail={data.emailHint ?? ''} />;
}
