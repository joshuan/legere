'use client';

// The last resort: this replaces the root layout, so it cannot rely on providers or translations
// (docs/10 §10.7). Deliberately plain English and inline styles — nothing here may throw.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem', textAlign: 'center' }}>
        <h1>Something went wrong</h1>
        <p>An unexpected error occurred. Please try again.</p>
        <button type="button" onClick={reset} style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}>
          Try again
        </button>
      </body>
    </html>
  );
}
