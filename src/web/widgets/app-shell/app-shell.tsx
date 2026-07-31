'use client';

import {
  AppstoreOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  LogoutOutlined,
  SearchOutlined,
  SettingOutlined,
  TagsOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Input, Layout, Menu, Space, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { UserDto } from '../../../shared/contracts/auth';
import { libraryApi, libraryKeys } from '../../entities/library';

// The authenticated shell (docs/11 §11.1): a collapsible sider with the product's sections, and a
// top bar carrying the global search box.
export function AppShell({ user, children }: { user: UserDto; children: ReactNode }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Browse is a submenu of the libraries this user can actually see (docs/11 §11.1); an empty list
  // simply means no library has been shared with them yet.
  const libraries = useQuery({ queryKey: libraryKeys.visible, queryFn: libraryApi.listVisible });

  const items = [
    {
      key: '/documents',
      icon: <FileTextOutlined />,
      label: <Link href="/documents">{t('nav.documents')}</Link>,
    },
    {
      key: '/browse',
      icon: <FolderOpenOutlined />,
      label: t('nav.browse'),
      children: (libraries.data?.items ?? []).map((library) => ({
        key: `/browse/${library.id}`,
        label: <Link href={`/browse/${library.id}`}>{library.name}</Link>,
      })),
    },
    {
      key: '/search',
      icon: <SearchOutlined />,
      label: <Link href="/search">{t('nav.search')}</Link>,
    },
    {
      key: '/collections',
      icon: <AppstoreOutlined />,
      label: <Link href="/collections">{t('nav.collections')}</Link>,
    },
    {
      key: '/scan-sets',
      icon: <DatabaseOutlined />,
      label: <Link href="/scan-sets">{t('nav.scanSets')}</Link>,
    },
    ...(user.role === 'ADMIN'
      ? [
          {
            key: '/admin',
            icon: <ThunderboltOutlined />,
            label: t('nav.administration'),
            children: [
              {
                key: '/admin/libraries',
                icon: <DatabaseOutlined />,
                label: <Link href="/admin/libraries">{t('nav.admin.libraries')}</Link>,
              },
              {
                key: '/admin/users',
                icon: <TeamOutlined />,
                label: <Link href="/admin/users">{t('nav.admin.users')}</Link>,
              },
              {
                key: '/admin/categories',
                icon: <TagsOutlined />,
                label: <Link href="/admin/categories">{t('nav.admin.categories')}</Link>,
              },
              {
                key: '/admin/queue',
                icon: <ThunderboltOutlined />,
                label: <Link href="/admin/queue">{t('nav.admin.queue')}</Link>,
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} theme="light">
        <div style={{ padding: 16 }}>
          <Typography.Text strong>{collapsed ? 'L' : t('common.appName')}</Typography.Text>
        </div>
        <Menu
          mode="inline"
          // The deepest matching route wins, so /admin/libraries/:id keeps its parent highlighted.
          selectedKeys={[selectedKey(pathname, items)]}
          items={items}
        />
        <Menu
          mode="inline"
          selectable={false}
          items={[
            {
              key: 'settings',
              icon: <SettingOutlined />,
              label: <Link href="/settings">{t('nav.settings')}</Link>,
            },
            {
              key: 'logout',
              icon: <LogoutOutlined />,
              label: <Link href="/logout">{t('nav.logout')}</Link>,
            },
          ]}
        />
      </Layout.Sider>

      <Layout>
        <Layout.Header style={{ background: '#fff', padding: '0 16px' }}>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Input.Search
              allowClear
              placeholder={t('nav.searchPlaceholder')}
              aria-label={t('nav.searchPlaceholder')}
              style={{ maxWidth: 420 }}
              onSearch={(value) => {
                const q = value.trim();
                if (q !== '') router.push(`/search?q=${encodeURIComponent(q)}`);
              }}
            />
            <Typography.Text type="secondary">{user.displayName}</Typography.Text>
          </Space>
        </Layout.Header>

        <Layout.Content style={{ padding: 16 }}>{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}

// The longest menu key that prefixes the current path — so a nested route still lights up the
// section it belongs to.
function selectedKey(
  pathname: string,
  items: { key: string; children?: { key: string }[] }[],
): string {
  const keys = items.flatMap((item) => [item.key, ...(item.children ?? []).map((c) => c.key)]);
  return (
    keys
      .filter((key) => pathname === key || pathname.startsWith(`${key}/`))
      .sort((a, b) => b.length - a.length)[0] ?? ''
  );
}
