"use client";

import { useMemo } from "react";

const GUTTER_BANNER = {
  src: "https://bauval.org/22/15bdc5b2743e8dd55cfed656ec94577c",
  options: { key: "15bdc5b2743e8dd55cfed656ec94577c", format: "iframe", height: 600, width: 160, params: {} },
};

export function AdsterraGutterBanner() {
  const adDocument = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}body{width:${GUTTER_BANNER.options.width}px;height:${GUTTER_BANNER.options.height}px}</style></head><body><script>window.atOptions=${JSON.stringify(GUTTER_BANNER.options)};<\/script><script src="${GUTTER_BANNER.src}"><\/script></body></html>`, []);

  return <aside className="adsterra-gutter-ad" data-ad-type="gutter" aria-label="Advertisement">
    <span className="adsterra-gutter-ad-label">Advertisement</span>
    <iframe className="adsterra-gutter-ad-frame" title="Advertisement" width={GUTTER_BANNER.options.width} height={GUTTER_BANNER.options.height} loading="lazy" srcDoc={adDocument} />
  </aside>;
}
