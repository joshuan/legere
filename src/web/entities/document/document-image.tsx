'use client';

import { FileTextOutlined } from '@ant-design/icons';
import { useTranslations } from 'next-intl';
import { useState, type CSSProperties } from 'react';

// Private artifacts stay on the authenticated browser path, including the redirect to storage.
// A finished processing step does not guarantee that storage can still return its image.
export function DocumentImage({
  src,
  alt,
  width,
  height,
  loading,
  style,
}: {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  loading?: 'eager' | 'lazy';
  style?: CSSProperties;
}) {
  const t = useTranslations('viewer');
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (failedSource === src) {
    return (
      <div
        role="img"
        aria-label={t('previewUnavailable')}
        style={{
          width,
          height,
          minHeight: height ?? 80,
          background: 'var(--legere-well)',
          ...style,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ant-color-text-tertiary)',
        }}
      >
        <FileTextOutlined aria-hidden style={{ fontSize: 24 }} />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- authenticated API redirects to private storage.
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading={loading}
      style={style}
      onError={() => setFailedSource(src)}
    />
  );
}
