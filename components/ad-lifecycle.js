import { useEffect, useRef, useState } from "react";

export const AD_REFRESH_INTERVAL_MS = 60_000;

export function useAdLifecycle(enabled = true) {
  const slotRef = useRef(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [loadMode, setLoadMode] = useState("lazy");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;

    const slot = slotRef.current;
    if (!slot) return undefined;

    let ready = false;
    let observer;
    const viewportHeight = () => window.innerHeight || document.documentElement.clientHeight || 0;
    const markReady = (eager) => {
      if (ready) return;
      ready = true;
      setLoadMode(eager ? "eager" : "lazy");
      setShouldRender(true);
      observer?.disconnect();
    };
    const checkPosition = () => {
      const rect = slot.getBoundingClientRect();
      const height = viewportHeight();
      if (!rect.width || !rect.height || !height) return;
      if (rect.top < height && rect.bottom > 0) {
        markReady(true);
      } else if (rect.top <= height * 2 && rect.bottom >= 0) {
        markReady(false);
      }
    };

    checkPosition();
    if (!ready && "IntersectionObserver" in window) {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const rect = slot.getBoundingClientRect();
        markReady(rect.top < viewportHeight() && rect.bottom > 0);
      }, { rootMargin: "100vh 0px" });
      observer.observe(slot);
    }
    window.addEventListener("scroll", checkPosition, { passive: true });
    window.addEventListener("resize", checkPosition);

    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", checkPosition);
      window.removeEventListener("resize", checkPosition);
    };
  }, [enabled]);

  useEffect(() => {
    if (!shouldRender) return undefined;

    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      const slot = slotRef.current;
      if (!slot) return;
      const rect = slot.getBoundingClientRect();
      const height = window.innerHeight || document.documentElement.clientHeight || 0;
      if (rect.bottom > 0 && rect.top < height) setRefreshToken((value) => value + 1);
    };
    const timer = window.setInterval(refreshIfVisible, AD_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [shouldRender]);

  return { slotRef, shouldRender, loading: loadMode, refreshToken };
}
