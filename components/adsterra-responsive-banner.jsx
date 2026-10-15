"use client";

import { useEffect, useMemo, useState } from "react";
import { useAdLifecycle } from "./ad-lifecycle.js";

const DESKTOP_BANNER = {
  id: "4dded9c08ff44c0a1065bbfc746caf0c",
  src: "https://bauval.org/22/4dded9c08ff44c0a1065bbfc746caf0c",
  options: { key: "4dded9c08ff44c0a1065bbfc746caf0c", format: "iframe", height: 60, width: 468, params: {} },
};

const MOBILE_BANNER = {
  id: "294fa97b1cd4086e19b0d065698254cb",
  src: "https://bauval.org/22/294fa97b1cd4086e19b0d065698254cb",
  options: { key: "294fa97b1cd4086e19b0d065698254cb", format: "iframe", height: 50, width: 320, params: {} },
};

export function AdsterraResponsiveBanner() {
  const [placement, setPlacement] = useState(null);
  const { slotRef, shouldRender, loading, refreshToken } = useAdLifecycle(true);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 680px)");
    const update = (event) => setPlacement(event.matches ? MOBILE_BANNER : DESKTOP_BANNER);
    update(media);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  const adDocument = useMemo(() => placement ? `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}body{width:${placement.options.width}px;height:${placement.options.height}px}</style></head><body><script>window.atOptions=${JSON.stringify(placement.options)};<\/script><script src="${placement.src}"><\/script></body></html>` : "", [placement]);

  return <aside ref={slotRef} className="adsterra-standard-ad" data-ad-type="responsive" aria-label="Advertisement">
    <span className="adsterra-standard-ad-label">Advertisement</span>
    {placement && shouldRender && <iframe key={`${placement.id}-${refreshToken}`} className="adsterra-standard-ad-frame" title="Advertisement" width={placement.options.width} height={placement.options.height} loading={loading} srcDoc={adDocument} />}
  </aside>;
}
