import { useEffect, useState } from "react";

/**
 * Small online/offline hook for the compose sheet's offline strip.
 * Initializes from `navigator.onLine`, then tracks the browser's
 * `online`/`offline` events. Kept in its own module so the seam test
 * can drive it via a mocked `navigator.onLine` + dispatched events.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}