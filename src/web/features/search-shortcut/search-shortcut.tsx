'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

// One listener for the authenticated shell. On the search page, keep the query and focus it.
export function SearchShortcut() {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (pathname === '/search') document.getElementById('document-search-input')?.focus();
      else router.push('/search');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pathname, router]);
  return null;
}
