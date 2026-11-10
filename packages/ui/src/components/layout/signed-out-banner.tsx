import { useEffect, useSyncExternalStore } from 'react';
import { isSignedOut, reloadIfSafe, subscribeSignedOut } from '../../lib/sign-in';

export function SignedOutBanner() {
  const signedOut = useSyncExternalStore(subscribeSignedOut, isSignedOut, () => false);

  useEffect(() => {
    if (!signedOut) {
      return;
    }
    reloadIfSafe();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        reloadIfSafe();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [signedOut]);

  if (!signedOut) {
    return null;
  }

  return (
    <div
      role="alert"
      data-testid="signed-out-banner"
      className="fixed top-0 inset-x-0 z-50 flex items-center gap-2 px-4 py-2 border-b border-deleted/40 bg-bg-secondary text-xs text-text"
    >
      <span className="font-medium">Your sign-in expired. Reload to sign in again.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-2 py-0.5 rounded border border-accent/60 text-accent hover:bg-accent/15 cursor-pointer"
      >
        Reload
      </button>
    </div>
  );
}
