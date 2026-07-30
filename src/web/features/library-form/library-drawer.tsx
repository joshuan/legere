'use client';

import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { LibraryVisibility } from '../../../shared/contracts/enums';
import type { LibraryAdminDto } from '../../../shared/contracts/libraries';
import { libraryApi, libraryKeys } from '../../entities/library';
import { userApi, userKeys } from '../../entities/user';
import { fieldIssuesOf } from '../../shared/api';
import { useErrorMessage } from '../../shared/lib';
import { DirectoryPicker } from './directory-picker';

type FormValues = {
  name: string;
  visibility: LibraryVisibility;
  scanIntervalMinutes: number;
  excludeGlobs: string[];
  userIds: string[];
  enabled: boolean;
};

// Server field issues arrive as arbitrary keys; only those that correspond to a real field can be
// attached to one. Anything else (rootPath, say, which lives in picker state) stays in the summary.
const FORM_FIELDS = [
  'name',
  'visibility',
  'scanIntervalMinutes',
  'excludeGlobs',
  'userIds',
  'enabled',
] as const;

type FormField = (typeof FORM_FIELDS)[number];

function isFormField(name: string): name is FormField {
  return FORM_FIELDS.some((field) => field === name);
}

// Create/edit drawer (docs/11 §11.10). The root path is chosen with the directory picker on create
// and shown read-only on edit, because it is immutable (docs/07 §7.3) — the UI states that rather
// than letting an admin try and be refused.
export function LibraryDrawer({
  open,
  library,
  onClose,
}: {
  open: boolean;
  library: LibraryAdminDto | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const [form] = Form.useForm<FormValues>();

  const isEdit = library !== null;
  const [rootPath, setRootPath] = useState(library?.rootPath ?? '');
  const [error, setError] = useState<string | null>(null);

  // Only needed to offer grantees for a RESTRICTED library.
  const users = useQuery({
    queryKey: userKeys.list,
    queryFn: () => userApi.list({ limit: 100 }),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      if (isEdit) {
        return libraryApi.update(library.id, {
          name: values.name,
          enabled: values.enabled,
          visibility: values.visibility,
          scanIntervalMinutes: values.scanIntervalMinutes,
          excludeGlobs: values.excludeGlobs,
          userIds: values.userIds,
        });
      }
      return libraryApi.create({
        name: values.name,
        rootPath,
        visibility: values.visibility,
        scanIntervalMinutes: values.scanIntervalMinutes,
        excludeGlobs: values.excludeGlobs,
        userIds: values.userIds,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: libraryKeys.admin });
      setError(null);
      onClose();
    },
    onError: (caught: unknown) => {
      // Path problems are about the field the admin just filled in, so they belong on it
      // (LIBRARY_PATH_INVALID / LIBRARY_PATH_CONFLICT, docs/11 §11.10).
      const message = describeError(caught);
      const fieldErrors = Object.entries(fieldIssuesOf(caught))
        .filter((entry): entry is [FormField, string[]] => isFormField(entry[0]))
        .map(([name, errors]) => ({ name, errors }));
      if (fieldErrors.length > 0) form.setFields(fieldErrors);
      setError(message);
    },
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      title={isEdit ? t('admin.libraries.editTitle') : t('admin.libraries.createTitle')}
    >
      {error !== null && (
        <Alert type="error" showIcon role="alert" message={error} style={{ marginBottom: 16 }} />
      )}

      <Form<FormValues>
        form={form}
        layout="vertical"
        initialValues={{
          name: library?.name ?? '',
          visibility: library?.visibility ?? 'RESTRICTED',
          scanIntervalMinutes: library?.scanIntervalMinutes ?? 15,
          excludeGlobs: library?.excludeGlobs ?? [],
          userIds: library?.userIds ?? [],
          enabled: library?.enabled ?? true,
        }}
        onFinish={(values: FormValues) => save.mutate(values)}
      >
        <Form.Item
          label={t('admin.libraries.fields.name')}
          name="name"
          rules={[{ required: true, message: t('admin.libraries.fields.nameRequired') }]}
        >
          <Input aria-label={t('admin.libraries.fields.name')} />
        </Form.Item>

        {/* Deliberately not a `name`-bound Form.Item: the path is picker state, not a form field.
            Binding it would let antd inject its own value/onChange over the picker's. */}
        <Form.Item label={t('admin.libraries.fields.rootPath')}>
          {isEdit ? (
            <Input
              value={library.rootPath}
              disabled
              aria-label={t('admin.libraries.fields.rootPath')}
            />
          ) : (
            <DirectoryPicker value={rootPath} onChange={setRootPath} />
          )}
        </Form.Item>

        {isEdit && (
          <Form.Item
            label={t('admin.libraries.fields.enabled')}
            name="enabled"
            valuePropName="checked"
          >
            <Switch aria-label={t('admin.libraries.fields.enabled')} />
          </Form.Item>
        )}

        <Form.Item label={t('admin.libraries.fields.visibility')} name="visibility">
          <Radio.Group
            options={[
              { value: 'RESTRICTED', label: t('admin.libraries.visibility.RESTRICTED') },
              { value: 'ALL_USERS', label: t('admin.libraries.visibility.ALL_USERS') },
            ]}
          />
        </Form.Item>

        <Form.Item shouldUpdate noStyle>
          {({ getFieldValue }) =>
            getFieldValue('visibility') === 'RESTRICTED' ? (
              <Form.Item label={t('admin.libraries.fields.userIds')} name="userIds">
                <Select
                  mode="multiple"
                  allowClear
                  aria-label={t('admin.libraries.fields.userIds')}
                  loading={users.isPending}
                  options={(users.data?.items ?? []).map((user) => ({
                    value: user.id,
                    label: `${user.displayName} (${user.email})`,
                  }))}
                />
              </Form.Item>
            ) : null
          }
        </Form.Item>

        <Form.Item
          label={t('admin.libraries.fields.scanInterval')}
          name="scanIntervalMinutes"
          rules={[{ required: true }]}
        >
          {/* InputNumber, not Input type=number: the contract wants a number and a text input
              would submit a string, which the server would reject as VALIDATION_FAILED. */}
          <InputNumber min={1} max={10080} aria-label={t('admin.libraries.fields.scanInterval')} />
        </Form.Item>

        <Form.Item
          label={t('admin.libraries.fields.excludeGlobs')}
          name="excludeGlobs"
          extra={t('admin.libraries.fields.excludeGlobsHint')}
        >
          <Select
            mode="tags"
            open={false}
            aria-label={t('admin.libraries.fields.excludeGlobs')}
            tokenSeparators={[',']}
          />
        </Form.Item>

        <Space>
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            {t('common.actions.save')}
          </Button>
          <Button onClick={onClose}>{t('common.actions.cancel')}</Button>
        </Space>
      </Form>
    </Drawer>
  );
}
