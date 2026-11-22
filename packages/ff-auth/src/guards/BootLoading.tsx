import { useEffect, useState } from 'react';

/**
 * Visible placeholder while the first auth / membership answer is pending
 * (replaces the blank screen). After `slowAfterMs` it adds a hint that the
 * connection may be the problem; the hard timeout + Retry lives in
 * <AuthProvider> (`MembershipTimeoutError` -> `ProjectLoadError`).
 */
export function BootLoading({
  label = 'Loading your projects…',
  slowAfterMs = 5000,
}: {
  label?: string;
  slowAfterMs?: number;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(t);
  }, [slowAfterMs]);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="boot-loading"
      style={{
        padding: 24,
        maxWidth: 480,
        margin: '20vh auto',
        textAlign: 'center',
        fontFamily: 'var(--ff-font-stack, system-ui, sans-serif)',
        color: 'var(--ff-text-secondary, #555)',
      }}
    >
      <p style={{ fontSize: 15, margin: 0 }}>{label}</p>
      {slow ? (
        <p data-testid="boot-loading-slow" style={{ fontSize: 13, marginTop: 8 }}>
          This is taking longer than usual. Check your connection; we will keep trying.
        </p>
      ) : null}
    </div>
  );
}
