'use client';

import { Button, Result } from 'antd';
import { useTranslations } from 'next-intl';
import { Component, type ErrorInfo, type ReactNode } from 'react';

// Wraps independently-failing blocks (viewer panel, queue dashboard) so one broken widget does not
// take the whole screen down (docs/10 §10.7 level 2).
type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console -- the browser console is the only sink on the client.
    console.error('Widget failed to render', error, info.componentStack);
  }

  private readonly reset = (): void => this.setState({ hasError: false });

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return this.props.fallback ?? <ErrorBoundaryFallback onRetry={this.reset} />;
  }
}

function ErrorBoundaryFallback({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations();
  return (
    <Result
      status="warning"
      title={t('errors.title')}
      subTitle={t('errors.unexpected')}
      extra={
        <Button type="primary" onClick={onRetry}>
          {t('common.actions.retry')}
        </Button>
      }
    />
  );
}
