'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Skeleton, Space, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import type { InstanceSettingDto, SettingSource } from '../../../shared/contracts/instance';
import { instanceApi, instanceKeys } from '../../entities/instance';
import { useErrorMessage } from '../../shared/lib';
import { DefinitionList, type Definition } from '../../shared/ui/definition-list';

// Where a value came from, as a tag. A secret has no source worth reporting — that it is a secret
// is the whole answer — so SET and UNSET both read as one word and the value cell carries the state.
const SOURCE_COLOR: Record<SettingSource, string> = {
  ENV: 'blue',
  DEFAULT: 'default',
  SET: 'gold',
  UNSET: 'gold',
};

// /admin/instance (docs/11 §11.13a): what this server actually resolved its configuration to,
// grouped as docs/12 §12.4 groups it. Read-only — there is nothing here to submit; a setting is
// changed in the environment and the process restarted.
export function AdminInstanceScreen() {
  const t = useTranslations();
  const describeError = useErrorMessage();

  const instance = useQuery({ queryKey: instanceKeys.effective, queryFn: instanceApi.read });

  if (instance.isPending) {
    return (
      <Card title={t('admin.instance.title')}>
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    );
  }

  if (instance.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('errors.title')}
        description={describeError(instance.error)}
      />
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          {t('admin.instance.title')}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t('admin.instance.subtitle')}
        </Typography.Paragraph>
      </div>

      {instance.data.groups.map((group) => (
        <Card key={group.key} title={t(`admin.instance.groups.${group.key}`)}>
          <DefinitionList items={group.settings.map((setting) => row(setting, t))} />
        </Card>
      ))}
    </Space>
  );
}

type Translate = (key: string) => string;

function row(setting: InstanceSettingDto, t: Translate): Definition {
  return {
    label: (
      <>
        {t(`admin.instance.keys.${setting.key}`)}{' '}
        <Typography.Text type="secondary">
          <code>{setting.key}</code>
        </Typography.Text>
      </>
    ),
    value: (
      <Space size={6}>
        {value(setting, t)}
        <Tag color={SOURCE_COLOR[setting.source]} style={{ marginInlineEnd: 0 }}>
          {t(`admin.instance.sources.${setting.source}`)}
        </Tag>
      </Space>
    ),
    // 🔒 What the blank costs, in the server's own words: it knows how the pipeline degrades, and
    // the page must not be the second place that opinion is written down.
    ...(setting.consequence === null ? {} : { note: setting.consequence }),
  };
}

// A configured secret says so and no more; anything else says what it resolved to, or that nothing
// did (docs/11 §11.13a).
function value(setting: InstanceSettingDto, t: Translate) {
  if (setting.value !== null) return <code>{setting.value}</code>;
  return (
    <Typography.Text type="secondary">
      {setting.source === 'SET'
        ? t('admin.instance.values.set')
        : t('admin.instance.values.notSet')}
    </Typography.Text>
  );
}
