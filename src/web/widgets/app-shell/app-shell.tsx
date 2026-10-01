'use client';

import { AppBrand, NavigationFrame } from '@joshuan/design-system/react';

import {
  AppstoreOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  LogoutOutlined,
  SearchOutlined,
  ShoppingOutlined,
  SettingOutlined,
  TagsOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Layout, Menu, Space, Tag, Typography, theme } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import type { UserDto } from '../../../shared/contracts/auth';
import { libraryApi, libraryKeys } from '../../entities/library';
import { sessionApi } from '../../entities/session';
import { SearchShortcut, useShortcutHint } from '../../features/search-shortcut';
import { useThemePreference } from '../../shared/providers';
import { endSession, useErrorMessage } from '../../shared/lib';
import { BrandMark } from '../../shared/ui';

// Navigation stays separate from each screen’s working area (docs/16 §16.3).
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
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const shortcut = useShortcutHint();
  const setThemePreference = useThemePreference();
  useEffect(() => {
    setThemePreference(user.theme);
    return () => setThemePreference('SYSTEM');
  }, [setThemePreference, user.theme]);

  // Signing out is a POST — the CSRF check is fail-closed and a GET route would let a prefetch end
  // someone's session (docs/08 §8.4). Hence a menu action rather than a link to a page.
  const logout = useMutation({
    mutationFn: sessionApi.logout,
    onSuccess: () => {
      // 🔒 Everything cached belongs to the session that just ended; the next person to use this
      // browser must not see it flash by before their own data loads. Shared with the sessions
      // card, which ends the same session by another route (docs/10 §10.5, SEC-68).
      endSession(queryClient, router);
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
      key: '/receipts',
      icon: <ShoppingOutlined />,
      label: <Link href="/receipts">{t('nav.receipts')}</Link>,
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
    // Search is a regular page; the chord beside the link opens the same destination.
    {
      key: '/search',
      icon: <SearchOutlined />,
      label: (
        <Link href="/search">
          {t('nav.search')}
          <Typography.Text
            className="legere-search-shortcut"
            type="secondary"
            style={{ fontSize: 12, marginInlineStart: 12 }}
          >
            {shortcut}
          </Typography.Text>
        </Link>
      ),
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
                key: '/admin/processing',
                icon: <ThunderboltOutlined />,
                label: <Link href="/admin/processing">{t('nav.admin.processing')}</Link>,
              },
              // What has left a document and not been destroyed yet (docs/11 §11.13b). Beside the
              // queue, because both are about what the instance is holding on to.
              {
                key: '/admin/trash',
                icon: <DeleteOutlined />,
                label: <Link href="/admin/trash">{t('nav.admin.trash')}</Link>,
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

  const navigation = (compact: boolean) => (
    <>
      <Menu
        className="legere-navigation"
        mode="inline"
        // The deepest matching route wins, so /admin/libraries/:id keeps its parent highlighted.
        selectedKeys={[selectedKey(pathname, items)]}
        items={items}
      />
      {/* The foot of the column: who is signed in, the two things they may do about it, which
            build this is, and the way to narrow the column — in that order, ending with the
            quietest (docs/11 §11.1). Pushed to the bottom rather than following the menu, so it sits
            still while the menu grows. */}
      <div style={{ marginTop: 'auto', flexShrink: 0 }}>
        <div
          style={{
            padding: compact ? '12px 0' : '12px 20px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            textAlign: compact ? 'center' : 'start',
          }}
        >
          {compact ? (
            // Collapsed, a name would be a truncated word; an initial is still the person.
            <Typography.Text strong title={user.displayName}>
              {user.displayName.slice(0, 1).toUpperCase()}
            </Typography.Text>
          ) : (
            <Space size={8} wrap>
              <Typography.Text style={{ fontWeight: 500 }}>{user.displayName}</Typography.Text>
              {user.role === 'ADMIN' && (
                <Tag variant="filled" style={{ marginInlineEnd: 0 }}>
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
        {!compact && (
          <div style={{ padding: '4px 20px 0' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('nav.version', { version })}
            </Typography.Text>
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      <SearchShortcut />
      <a href="#main-content" className="legere-skip-link">
        {t('nav.skipContent')}
      </a>
      <NavigationFrame
        pathname={pathname}
        brand={
          <Link href="/documents" aria-label={t('common.appName')} title={t('common.appName')}>
            <AppBrand name={t('common.appName')} mark={<BrandMark />} />
          </Link>
        }
        navigation={navigation}
        labels={{
          navigation: t('nav.menu'),
          open: t('nav.openMenu'),
          close: t('nav.closeMenu'),
          collapse: t('nav.collapse'),
          expand: t('nav.expand'),
        }}
        mobileActions={
          <Button
            type="text"
            icon={<SearchOutlined />}
            aria-label={t('nav.search')}
            onClick={() => router.push('/search')}
          />
        }
      >
        <Layout.Content id="main-content" tabIndex={-1} className="legere-main">
          <div className="legere-content">{children}</div>
        </Layout.Content>
      </NavigationFrame>
    </>
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
