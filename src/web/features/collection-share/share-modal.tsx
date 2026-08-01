'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, AutoComplete, Button, List, Modal, Space, Switch, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { collectionApi, collectionKeys } from '../../entities/collection';
import { useErrorMessage } from '../../shared/lib';

// The share dialog of docs/11 §11.7: pick a person, or open it to everyone, and see who has it now.
export function ShareModal({
  collectionId,
  open,
  onClose,
}: {
  collectionId: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [term, setTerm] = useState('');

  const shares = useQuery({
    queryKey: collectionKeys.shares(collectionId),
    queryFn: () => collectionApi.shares(collectionId),
    enabled: open,
  });

  const people = useQuery({
    queryKey: collectionKeys.lookup(term),
    queryFn: () => collectionApi.lookupUsers(term),
    // The lookup is a directory read; it waits until there is something to look up.
    enabled: open && term.trim().length > 0,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: collectionKeys.shares(collectionId) });
    void queryClient.invalidateQueries({ queryKey: collectionKeys.all });
  };

  const share = useMutation({
    mutationFn: (granteeUserId: string | null) => collectionApi.share(collectionId, granteeUserId),
    onSuccess: () => {
      setTerm('');
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const revoke = useMutation({
    mutationFn: (shareId: string) => collectionApi.revokeShare(collectionId, shareId),
    onSuccess: refresh,
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const everyone = (shares.data?.items ?? []).find((entry) => entry.granteeUserId === null);

  return (
    <Modal open={open} title={t('collections.share.title')} onCancel={onClose} footer={null}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <AutoComplete
          style={{ width: '100%' }}
          value={term}
          onChange={setTerm}
          placeholder={t('collections.share.findPerson')}
          aria-label={t('collections.share.findPerson')}
          options={(people.data ?? []).map((person) => ({
            value: person.id,
            label: `${person.displayName} (${person.email})`,
          }))}
          onSelect={(value: string) => share.mutate(value)}
        />

        <Space>
          <Switch
            checked={everyone !== undefined}
            aria-label={t('collections.share.everyone')}
            loading={share.isPending || revoke.isPending}
            onChange={(on) => {
              if (on) share.mutate(null);
              else if (everyone !== undefined) revoke.mutate(everyone.id);
            }}
          />
          <Typography.Text>{t('collections.share.everyone')}</Typography.Text>
        </Space>

        <List
          loading={shares.isPending}
          dataSource={shares.data?.items ?? []}
          locale={{ emptyText: t('collections.share.nobody') }}
          renderItem={(entry) => (
            <List.Item
              actions={[
                <Button key="revoke" size="small" danger onClick={() => revoke.mutate(entry.id)}>
                  {t('collections.share.revoke')}
                </Button>,
              ]}
            >
              {entry.granteeUserId === null ? (
                <Tag color="blue">{t('collections.share.everyone')}</Tag>
              ) : (
                <Typography.Text>{entry.granteeName}</Typography.Text>
              )}
            </List.Item>
          )}
        />
      </Space>
    </Modal>
  );
}
