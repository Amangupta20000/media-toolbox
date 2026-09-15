"use client";

import Link from "next/link";
import { Laptop, Server, Settings2 } from "lucide-react";

const labels = {
  local: ["Local agent", "Files stay on this device", Laptop],
  server: ["Server", "Runs on the connected worker", Server],
};

export function ProcessingMode({ value, onChange, locations, compact = false }) {
  // Keep both controls in the DOM before the health probe completes. Hiding
  // the server option until then changes the panel height/column layout and
  // shifts all content below it during the first render.
  const modes = ["local", "server"];
  const ready = (mode) => Boolean(locations?.[mode]?.connected || locations?.[mode]?.ready);
  const localUnavailable = !locations?.local?.connected;
  const serverUnavailable = !locations?.server?.connected;
  return <div className={`processing-mode ${compact ? "compact" : ""}`}>
    <div className="processing-mode-heading"><span><Settings2 size={16} /> Processing location</span><small>Choose where this job runs</small></div>
    <div className="processing-mode-options">
      {modes.map((mode) => {
        const [label, detail, Icon] = labels[mode];
        const available = ready(mode);
        return <button type="button" key={mode} className={`processing-mode-option ${value === mode ? "selected" : ""} ${!available ? "unavailable" : ""}`} disabled={!available} onClick={() => onChange(mode)}>
          <Icon size={18} /><span><strong>{label}</strong><small>{available ? detail : mode === "local" ? "Start and authorize the agent" : "API is unavailable"}</small></span><em>{value === mode ? "Selected" : available ? "Available" : "Unavailable"}</em>
        </button>;
      })}
    </div>
    <div className="processing-mode-help" aria-live="polite">
      {localUnavailable && <><span>Local agent requires Admin login or activation. </span><Link href="/local-agent">Open Local agent setup</Link></>}
      {localUnavailable && serverUnavailable && <span> · </span>}
      {serverUnavailable && <span>Server processing is unavailable.</span>}
      {!localUnavailable && !serverUnavailable && <span aria-hidden="true">&nbsp;</span>}
    </div>
  </div>;
}
