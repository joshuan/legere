'use client';

import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { sessionApi, sessionKeys } from '../../entities/session';
import { AuthWizard } from '../../features/auth-wizard';

// /onboarding (docs/11 §11.2). Onboarding is a one-time route: once the instance has its first
// admin it redirects away rather than offering a wizard the API would reject.
export function OnboardingScreen() {
  const router = useRouter();
  const { data, isPending } = useQuery({
    queryKey: sessionKeys.onboarding,
    queryFn: sessionApi.onboardingStatus,
  });

  useEffect(() => {
    if (data?.required === false) router.replace('/login');
  }, [data, router]);

  if (isPending || data?.required === false) return <Spin fullscreen />;

  return <AuthWizard mode="onboarding" />;
}
