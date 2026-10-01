'use client';

import { Typography } from 'antd';
import { useTranslations } from 'next-intl';
import type { AgentIdentity } from '../../../shared/contracts/identity';

export function UserAttribution({
  name,
  agent,
}: {
  name: string;
  agent?: AgentIdentity | null | undefined;
}) {
  const t = useTranslations('identity');
  return (
    <span
      style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0, verticalAlign: 'top' }}
    >
      <span>{name}</span>
      {agent != null && (
        <Typography.Text
          type="secondary"
          style={{ fontSize: 12, lineHeight: '18px', overflowWrap: 'anywhere' }}
          title={`${agent.kind}: ${agent.clientId ?? agent.id}`}
        >
          {t('via', { agent: agent.name })}
        </Typography.Text>
      )}
    </span>
  );
}
