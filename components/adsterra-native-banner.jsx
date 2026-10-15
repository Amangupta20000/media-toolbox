"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ADSTERRA_SCRIPT_SRC = "https://bauval.org/21/52b2a9d313e02d8d8ea31a538b04248f";
const ADSTERRA_CONTAINER_ID = "container-52b2a9d313e02d8d8ea31a538b04248f";
const NATIVE_FRAME_MIN_HEIGHT = 300;

export function AdsterraNativeBanner() {
  const [mounted, setMounted] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [mobileDock, setMobileDock] = useState(null);
  const [frameHeight, setFrameHeight] = useState(NATIVE_FRAME_MIN_HEIGHT);
  const frameRef = useRef(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 680px)");
    const dock = document.getElementById("mobile-native-ad-dock");
    const update = (event) => {
      setMobile(event.matches);
      setMobileDock(dock);
      setMounted(true);
    };

    update(media);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const handleResize = (event) => {
      if (event.source !== frameRef.current?.contentWindow || event.data?.type !== "native-ad-resize") return;
      const nextHeight = Number(event.data.height);
      if (Number.isFinite(nextHeight) && nextHeight > 0) {
        const nextFrameHeight = Math.min(800, Math.max(NATIVE_FRAME_MIN_HEIGHT, Math.ceil(nextHeight)));
        setFrameHeight((currentHeight) => currentHeight === nextFrameHeight ? currentHeight : nextFrameHeight);
      }
    };

    window.addEventListener("message", handleResize);
    return () => window.removeEventListener("message", handleResize);
  }, []);

  const adDocument = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;min-height:118px;overflow:hidden;background:transparent}body{box-sizing:border-box}*{box-sizing:border-box}</style></head><body><div id="${ADSTERRA_CONTAINER_ID}"></div><script>(function(){function report(){var height=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);window.parent.postMessage({type:"native-ad-resize",height:height},"*")}if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement)}window.addEventListener("load",report);setTimeout(report,250);setTimeout(report,1000)})();<\/script><script src="${ADSTERRA_SCRIPT_SRC}" async data-cfasync="false"><\/script></body></html>`, []);

  if (!mounted) return null;

  const banner = <aside className="adsterra-native-ad" data-ad-type="native" aria-label="Advertisement">
    <span className="adsterra-native-ad-label">Advertisement</span>
    <iframe ref={frameRef} className="adsterra-native-ad-frame" title="Advertisement" width="100%" height={frameHeight} loading="lazy" srcDoc={adDocument} />
  </aside>;

  return mobile && mobileDock ? createPortal(banner, mobileDock) : banner;
}
