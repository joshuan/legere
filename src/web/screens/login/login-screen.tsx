'use client';

import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { sessionApi, sessionKeys } from '../../entities/session';
import { LoginForm } from '../../features/login-form';

// /login (docs/11 §11.2). A brand-new instance has nobody to log in as, so the screen bounces to
// onboarding instead of showing a form that could never succeed.
export function LoginScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = params.get('returnTo') ?? undefined;

  const { data, isPending } = useQuery({
    queryKey: sessionKeys.onboarding,
    queryFn: sessionApi.onboardingStatus,
  });

  useEffect(() => {
    if (data?.required === true) router.replace('/onboarding');
  }, [data, router]);

  if (isPending || data?.required === true) {
    return <Spin fullscreen />;
  }

  return <LoginForm {...(returnTo === undefined ? {} : { returnTo })} />;
}
