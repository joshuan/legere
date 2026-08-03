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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Input, Layout, Menu, Space, Tag, Typography, theme } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { UserDto } from '../../../shared/contracts/auth';
import { libraryApi, libraryKeys } from '../../entities/library';
import { sessionApi } from '../../entities/session';
import { useErrorMessage } from '../../shared/lib';

// The authenticated shell (docs/11 §11.1): a collapsible sider with the product's sections, and a
// top bar carrying the global search box.
export function AppShell({ user, children }: { user: UserDto; children: ReactNode }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  // Signing out is a POST — the CSRF check is fail-closed and a GET route would let a prefetch end
  // someone's session (docs/08 §8.4). Hence a menu action rather than a link to a page.
  const logout = useMutation({
    mutationFn: sessionApi.logout,
    onSuccess: () => {
      // 🔒 Everything cached belongs to the session that just ended; the next person to use this
      // browser must not see it flash by before their own data loads.
      queryClient.clear();
      router.replace('/login');
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

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
      <Layout.Sider
        width={240}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        style={{ borderInlineEnd: `1px solid ${token.colorBorderSecondary}` }}
      >
        {/* The wordmark in the display face, over a hairline — a title page, not a logo slot
            (docs/11 §11.15). Collapsed, it keeps the monogram rather than a truncated word. */}
        <div
          style={{
            padding: collapsed ? '18px 0' : '18px 20px',
            marginBottom: 8,
            textAlign: collapsed ? 'center' : 'start',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: collapsed ? 24 : 26,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: token.colorText,
              fontVariationSettings: "'SOFT' 40, 'WONK' 1",
            }}
          >
            {collapsed ? 'L' : t('common.appName')}
          </span>
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
              label: t('nav.logout'),
              disabled: logout.isPending,
              onClick: () => logout.mutate(),
            },
          ]}
        />
      </Layout.Sider>

      <Layout>
        <Layout.Header
          style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, lineHeight: 'normal' }}
        >
          <Space style={{ width: '100%', height: '100%', justifyContent: 'space-between' }}>
            <Input.Search
              allowClear
              size="large"
              placeholder={t('nav.searchPlaceholder')}
              aria-label={t('nav.searchPlaceholder')}
              style={{ width: 'min(46vw, 480px)' }}
              onSearch={(value) => {
                const q = value.trim();
                if (q !== '') router.push(`/search?q=${encodeURIComponent(q)}`);
              }}
            />
            <Space size={10}>
              {user.role === 'ADMIN' && (
                <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                  {t('nav.administration')}
                </Tag>
              )}
              <Typography.Text style={{ fontWeight: 500 }}>{user.displayName}</Typography.Text>
            </Space>
          </Space>
        </Layout.Header>

        {/* A reading column: wide enough for a six-card grid, never edge to edge on a 4K display. */}
        <Layout.Content style={{ padding: '24px 32px' }}>
          <div className="legere-enter" style={{ maxWidth: 1440, margin: '0 auto' }}>
            {children}
          </div>
        </Layout.Content>
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
