'use client';

import { useMutation } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Space, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../../shared/contracts/auth';
import type { ChangePasswordRequest } from '../../../shared/contracts/users';
import { sessionApi } from '../../entities/session';
import { useErrorMessage } from '../../shared/lib';

// The password card on /settings (docs/11 §11.9, docs/08 §8.1.6a). A rotation somebody does for
// themselves: it asks for the password being replaced, and says plainly that everywhere else this
// account is signed in gets signed out — which is the point of doing it after a leak.
export function PasswordCard() {
  const t = useTranslations();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [form] = Form.useForm<ChangePasswordRequest & { confirmPassword: string }>();

  const change = useMutation({
    mutationFn: (body: ChangePasswordRequest) => sessionApi.changePassword(body),
    onSuccess: (result) => {
      form.resetFields();
      void message.success(t('settings.password.changed', { count: result.revoked }), 4);
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  return (
    <Card title={t('settings.password.title')}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('settings.password.description')}</Typography.Text>

        <Form
          form={form}
          layout="vertical"
          onFinish={({ currentPassword, newPassword }) =>
            change.mutate({ currentPassword, newPassword })
          }
        >
          <Form.Item
            label={t('settings.password.current')}
            name="currentPassword"
            rules={[{ required: true, message: t('settings.password.currentRequired') }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>

          <Form.Item
            label={t('settings.password.next')}
            name="newPassword"
            rules={[
              { required: true, message: t('settings.password.nextRequired') },
              {
                min: PASSWORD_MIN_LENGTH,
                max: PASSWORD_MAX_LENGTH,
                message: t('settings.password.lengthHint', {
                  min: PASSWORD_MIN_LENGTH,
                  max: PASSWORD_MAX_LENGTH,
                }),
              },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>

          {/* Confirmation is the client's own idea: the server has no use for a second copy, and a
              typo in a password nobody can read back is a lockout waiting to happen. */}
          <Form.Item
            label={t('settings.password.confirm')}
            name="confirmPassword"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: t('settings.password.confirmRequired') },
              {
                validator: (_rule, value: string): Promise<void> =>
                  value === undefined || value === '' || value === form.getFieldValue('newPassword')
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('settings.password.confirmMismatch'))),
              },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>

          <Button type="primary" htmlType="submit" loading={change.isPending}>
            {t('settings.password.submit')}
          </Button>
        </Form>
      </Space>
    </Card>
  );
}
