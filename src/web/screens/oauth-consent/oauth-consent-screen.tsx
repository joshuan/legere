'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, App, Button, Card, Space, Spin, Typography } from 'antd';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { oauthAuthorizeSchema } from '../../../shared/contracts/oauth';
import { oauthApi } from '../../entities/oauth';
import { useCurrentUser } from '../../entities/user';
import { useErrorMessage } from '../../shared/lib';
import { QueryError, PageHeader } from '../../shared/ui';

export function OAuthConsentScreen() {
  const t = useTranslations('oauth');
  const params = useSearchParams();
  const user = useCurrentUser();
  const describe = useErrorMessage();
  const { message } = App.useApp();
  const parsed = oauthAuthorizeSchema.safeParse(Object.fromEntries(params));
  const preview = useQuery({
    queryKey: ['oauth-consent', params.toString()],
    enabled: parsed.success,
    retry: false,
    queryFn: () => {
      if (!parsed.success) throw new Error('Invalid authorization request');
      return oauthApi.preview(parsed.data);
    },
  });
  const consent = useMutation({
    mutationFn: (decision: 'approve' | 'deny') => {
      if (!parsed.success) throw new Error('Invalid authorization request');
      return oauthApi.authorize({ ...parsed.data, decision });
    },
    onSuccess: (result) => window.location.assign(result.redirectUrl),
    onError: (error: unknown) => {
      void message.error(describe(error));
    },
  });
  if (!parsed.success) return <Alert type="error" showIcon message={t('invalidRequest')} />;
  if (preview.isPending) return <Spin />;
  if (preview.isError) return <QueryError error={preview.error} retry={preview.refetch} />;
  return (
    <section style={{ maxWidth: 680, margin: '0 auto', width: '100%' }}>
      <PageHeader title={t('authorize')} />
      <Card>
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={3} style={{ marginTop: 0 }}>
              {preview.data.clientName}
            </Typography.Title>
            <Typography.Paragraph>
              {t('actingFor', { name: user.displayName })}
            </Typography.Paragraph>
          </div>
          <Alert
            type="info"
            showIcon
            message={t(preview.data.scope === 'documents:read' ? 'archiveReadScope' : 'readScope')}
            description={t(
              preview.data.scope === 'documents:read' ? 'archiveScopeDetail' : 'scopeDetail',
            )}
          />
          <div>
            <Typography.Paragraph>
              <Typography.Text strong>{t('callback')}</Typography.Text>
              <br />
              {preview.data.redirectOrigin}
            </Typography.Paragraph>
            <Typography.Paragraph
              type="secondary"
              style={{ fontSize: 12, overflowWrap: 'anywhere' }}
            >
              {t('clientId')}: {preview.data.clientId}
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary">{t('clientNameNotice')}</Typography.Paragraph>
          </div>
          <Space wrap>
            <Button
              type="primary"
              onClick={() => consent.mutate('approve')}
              loading={consent.isPending && consent.variables === 'approve'}
              disabled={consent.isPending}
            >
              {t('allow')}
            </Button>
            <Button
              onClick={() => consent.mutate('deny')}
              loading={consent.isPending && consent.variables === 'deny'}
              disabled={consent.isPending}
            >
              {t('deny')}
            </Button>
          </Space>
        </Space>
      </Card>
    </section>
  );
}
