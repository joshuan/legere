'use client';

import { FolderOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Breadcrumb, Card, Empty, List, Space, Spin, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { libraryApi, libraryKeys } from '../../entities/library';
import { DocumentCard } from '../../widgets/document-card';

// /browse/:libraryId?path= (docs/11 §11.4): the mounted folder structure, one level at a time.
export function BrowseScreen({ libraryId }: { libraryId: string }) {
  const t = useTranslations();
  const searchParams = useSearchParams();
  // The path lives in the URL, so a folder is a link and the back button walks up the tree.
  const path = searchParams.get('path') ?? '';

  const libraries = useQuery({ queryKey: libraryKeys.visible, queryFn: libraryApi.listVisible });
  const libraryName = (libraries.data?.items ?? []).find((entry) => entry.id === libraryId)?.name;

  const view = useInfiniteQuery({
    queryKey: libraryKeys.browse(libraryId, path),
    queryFn: ({ pageParam }) =>
      libraryApi.browse(libraryId, path, pageParam === '' ? undefined : pageParam),
    initialPageParam: '',
    getNextPageParam: (last) => last.documents.nextCursor ?? undefined,
  });

  const first = view.data?.pages[0];
  const documents = useMemo(
    () => (view.data?.pages ?? []).flatMap((page) => page.documents.items),
    [view.data],
  );

  const segments = path === '' ? [] : path.split('/');

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb
        items={[
          {
            title: <Link href={`/browse/${libraryId}`}>{libraryName ?? t('browse.library')}</Link>,
          },
          ...segments.map((segment, index) => ({
            title: (
              <Link
                href={`/browse/${libraryId}?path=${encodeURIComponent(segments.slice(0, index + 1).join('/'))}`}
              >
                {segment}
              </Link>
            ),
          })),
        ]}
      />

      {view.isPending ? (
        <Spin />
      ) : (
        <>
          {(first?.folders.length ?? 0) > 0 && (
            <Card size="small" title={t('browse.folders')}>
              <List
                dataSource={first?.folders ?? []}
                renderItem={(folder) => (
                  <List.Item>
                    <Link
                      href={`/browse/${libraryId}?path=${encodeURIComponent(
                        path === '' ? folder.name : `${path}/${folder.name}`,
                      )}`}
                    >
                      <Space>
                        <FolderOutlined />
                        <Typography.Text>{folder.name}</Typography.Text>
                        <Typography.Text type="secondary">
                          {t('browse.documentCount', { count: folder.documentCount })}
                        </Typography.Text>
                      </Space>
                    </Link>
                  </List.Item>
                )}
              />
            </Card>
          )}

          {documents.length === 0 ? (
            (first?.folders.length ?? 0) === 0 && <Empty description={t('browse.empty')} />
          ) : (
            <div className="legere-card-grid">
              {documents.map((document) => (
                <div key={document.id}>
                  <DocumentCard document={document} />
                </div>
              ))}
            </div>
          )}

          {view.hasNextPage && (
            <Typography.Link onClick={() => void view.fetchNextPage()}>
              {t('browse.more')}
            </Typography.Link>
          )}
        </>
      )}
    </Space>
  );
}
