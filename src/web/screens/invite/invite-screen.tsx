'use client';

import { useQuery } from '@tanstack/react-query';
import { Result, Spin } from 'antd';
import { useTranslations } from 'next-intl';
import { sessionApi, sessionKeys } from '../../entities/session';
import { AuthWizard } from '../../features/auth-wizard';
import { useFragmentToken } from '../../shared/lib';

// /invite#token=… (docs/11 §11.2). The fragment is consumed and scrubbed before the preview request.
export function InviteScreen() {
  const token = useFragmentToken();
  if (token === undefined) return <Spin fullscreen />;
  if (token === null) return <InvalidInvite />;
  return <InviteWithToken token={token} />;
}

function InviteWithToken({ token }: { token: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: sessionKeys.invite(token),
    queryFn: () => sessionApi.previewInvite(token),
    retry: false,
  });

  if (isPending) return <Spin fullscreen />;

  if (isError || !data.valid) return <InvalidInvite />;

  return <AuthWizard mode="invite" token={token} initialEmail={data.emailHint ?? ''} />;
}

function InvalidInvite() {
  const t = useTranslations();
  return (
    <Result
      status="warning"
      title={t('auth.invite.invalidTitle')}
      subTitle={t('auth.invite.invalidDescription')}
    />
  );
}
