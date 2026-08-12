'use client';

import {
  AppstoreOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  LeftOutlined,
  LogoutOutlined,
  SearchOutlined,
  RightOutlined,
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
export function AppShell({
  user,
  version,
  children,
}: {
  user: UserDto;
  // The build this process is (docs/11 §11.1). Read on the server from the package the image was
  // built from, so it cannot disagree with the image's own tag.
  version: string;
  children: ReactNode;
}) {
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
      // The facets first: what a document is about is how a person looks for it, and where its bytes
      // happen to live is the last thing they think of (docs/11 §11.4).
      children: [
        {
          key: '/browse/types',
          label: <Link href="/browse/types">{t('facets.types')}</Link>,
        },
        {
          key: '/browse/people',
          label: <Link href="/browse/people">{t('facets.people')}</Link>,
        },
        {
          key: '/browse/subjects',
          label: <Link href="/browse/subjects">{t('facets.subjects')}</Link>,
        },
        {
          key: '/browse/years',
          label: <Link href="/browse/years">{t('facets.years')}</Link>,
        },
        ...(libraries.data?.items ?? []).map((library) => ({
          key: `/browse/${library.id}`,
          label: <Link href={`/browse/${library.id}`}>{library.name}</Link>,
        })),
      ],
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
    // The catalogues a document is filed by. Content, not administration (docs/11 §11.12a): anyone
    // signed in reads them and adds to them, and it is the affordances that reach across documents —
    // renaming, deleting, merging — that are an admin's, not the screens.
    {
      key: '/catalogues',
      icon: <TagsOutlined />,
      label: t('nav.catalogues'),
      children: [
        {
          key: '/people',
          icon: <TeamOutlined />,
          label: <Link href="/people">{t('nav.people')}</Link>,
        },
        {
          key: '/subjects',
          icon: <TagsOutlined />,
          label: <Link href="/subjects">{t('nav.subjects')}</Link>,
        },
        {
          key: '/subject-kinds',
          icon: <TagsOutlined />,
          label: <Link href="/subject-kinds">{t('nav.subjectKinds')}</Link>,
        },
        {
          key: '/document-types',
          icon: <TagsOutlined />,
          label: <Link href="/document-types">{t('nav.documentTypes')}</Link>,
        },
      ],
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
                key: '/admin/queue',
                icon: <ThunderboltOutlined />,
                label: <Link href="/admin/queue">{t('nav.admin.queue')}</Link>,
              },
              // What this server is actually running (docs/11 §11.13a). Last, because it is the
              // page an operator opens when something else has already gone wrong.
              {
                key: '/admin/instance',
                icon: <InfoCircleOutlined />,
                label: <Link href="/admin/instance">{t('nav.admin.instance')}</Link>,
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider
        className="legere-sider"
        width={240}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        // Ant's own trigger is a 48px slab across the foot of the menu — the loudest thing in a
        // column of quiet type, for the least important control on it (docs/11 §11.15). Ours is a
        // hairline strip at the very bottom instead.
        trigger={null}
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
              fontFamily: 'var(--font-sans)',
              fontSize: collapsed ? 24 : 26,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: token.colorText,
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
        {/* The foot of the column: who is signed in, the two things they may do about it, which
            build this is, and the way to narrow the column — in that order, ending with the
            quietest (docs/11 §11.1). Pushed to the bottom rather than following the menu, so it sits
            still while the menu grows. */}
        <div style={{ marginTop: 'auto' }}>
          <div
            style={{
              padding: collapsed ? '12px 0' : '12px 20px',
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              textAlign: collapsed ? 'center' : 'start',
            }}
          >
            {collapsed ? (
              // Collapsed, a name would be a truncated word; an initial is still the person.
              <Typography.Text strong title={user.displayName}>
                {user.displayName.slice(0, 1).toUpperCase()}
              </Typography.Text>
            ) : (
              <Space size={8} wrap>
                <Typography.Text style={{ fontWeight: 500 }}>{user.displayName}</Typography.Text>
                {user.role === 'ADMIN' && (
                  <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                    {t('nav.administration')}
                  </Tag>
                )}
              </Space>
            )}
          </div>
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
          {/* Which build this is. Small and grey on purpose: nobody comes looking for it until
              something is wrong, and then it is the first thing asked for (docs/11 §11.1). */}
          {!collapsed && (
            <div style={{ padding: '4px 20px 0' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('nav.version', { version })}
              </Typography.Text>
            </div>
          )}
          <button
            type="button"
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
            className="legere-sider-trigger"
            style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}
          >
            {collapsed ? <RightOutlined /> : <LeftOutlined />}
          </button>
        </div>
      </Layout.Sider>

      <Layout>
        <Layout.Header
          style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, lineHeight: 'normal' }}
        >
          <Space style={{ width: '100%', height: '100%' }}>
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
