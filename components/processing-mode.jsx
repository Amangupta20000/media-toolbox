"use client";

import Link from "next/link";
import { Laptop, Settings2 } from "lucide-react";

const labels = {
  local: ["Local agent", "Files stay on this device", Laptop],
};

export function ProcessingMode({ value, onChange, locations, compact = false }) {
  // The website currently supports Local agent processing only. Keep the
  // control geometry stable while the agent health probe completes.
  const modes = ["local"];
  const ready = (mode) => Boolean(locations?.[mode]?.connected || locations?.[mode]?.ready);
  const localUnavailable = !locations?.local?.connected;
  return <div className={`processing-mode ${compact ? "compact" : ""}`}>
    <div className="processing-mode-heading"><span><Settings2 size={16} /> Processing location</span><small>Local agent only</small></div>
    <div className="processing-mode-options">
      {modes.map((mode) => {
        const [label, detail, Icon] = labels[mode];
        const available = ready(mode);
        return <button type="button" key={mode} className={`processing-mode-option ${value === mode ? "selected" : ""} ${!available ? "unavailable" : ""}`} disabled={!available} onClick={() => onChange(mode)}>
          <Icon size={18} /><span><strong>{label}</strong><small>{available ? detail : mode === "local" ? "Start and authorize the agent" : "Not available in this deployment"}</small></span><em>{value === mode ? "Selected" : available ? "Available" : "Unavailable"}</em>
        </button>;
      })}
    </div>
    <div className="processing-mode-help" aria-live="polite">
      {localUnavailable && <><span>Local agent requires Admin login or activation. </span><Link href="/local-agent">Open Local agent setup</Link></>}
      {!localUnavailable && <span aria-hidden="true">&nbsp;</span>}
    </div>
  </div>;
}
